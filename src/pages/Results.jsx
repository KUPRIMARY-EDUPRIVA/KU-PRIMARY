// src/pages/Results.jsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { useSchool } from '../context/SchoolContext';
import {
    getStudents, getScores, saveScoresBatch, publishScoresBatch,
    saveAssessmentConfig, requireSchoolId, findStudentByAdmission
} from '../services/firestore';
import { idbGet, idbSet } from '../services/cache';
import { downloadStudentReportCardPDF, downloadStudentReportPDF, downloadRankingPDF } from '../services/pdf';
import { db } from '../firebase';
import { AuditLogService, AUDIT_ACTIONS } from '../services/auditService';
import { collection, query, where, getDocs, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import ResultsTable from '../components/Results/ResultsTable';
import ReportModal from '../components/Results/ReportsModal';
import RankingModal from '../components/Results/RankingModal';
import ScoreHistoryModal from '../components/Results/ScoreHistoryModal';
import {
    LEVEL_CLASSES, LEVEL_DISPLAY_NAMES, LEVEL_SUBJECTS, getCBCGrade, ASSESSMENT_TYPES
} from '../utils/constants';

const MAX_IMPORT_SIZE = 5 * 1024 * 1024; // 5 MB

export default function Results() {
    const navigate = useNavigate();
    const location = useLocation();
    const { currentUser, userData, userRole } = useAuth();
    const { isOnline, addToSyncQueue } = useSync();

    // Fix #5: use SchoolContext directly, no local configs state
    const {
        configs: assessmentConfigs,
        isDeadlinePassed: checkSchoolDeadline,
        getLevelClasses,
        refresh: refreshConfigs
    } = useSchool();

    // ---- School data ----
    const schoolData = {
        name: userData?.schoolName || userData?.school?.name || 'TOPLINK EDU',
        motto: userData?.schoolMotto || userData?.school?.motto || 'Powering Modern Education',
        address: userData?.schoolAddress || userData?.school?.address || '',
        phone: userData?.schoolPhone || userData?.school?.phone || '',
        email: userData?.schoolEmail || userData?.school?.email || ''
    };
    const schoolName = schoolData.name;
    const schoolMotto = schoolData.motto;

    // ---- State ----
    const [students, setStudents] = useState([]);
    const [studentScores, setStudentScores] = useState({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [usingCachedData, setUsingCachedData] = useState(false);

    const [selectedLevel, setSelectedLevel] = useState('');
    const [selectedClass, setSelectedClass] = useState('');
    const [selectedSubject, setSelectedSubject] = useState('');
    const [selectedTerm, setSelectedTerm] = useState('Term 1');
    const [assessmentType, setAssessmentType] = useState('Assessment 1');

    const [assessmentDeadline, setAssessmentDeadline] = useState('');
    const [deadlineAssessmentType, setDeadlineAssessmentType] = useState('Assessment 1');
    const [controlAssessmentType, setControlAssessmentType] = useState('Assessment 1');

    // `teacherAccess` now includes a `levels` array so multi-level teachers
    // work correctly. `level` remains as the "primary" level for backwards
    // compatibility with existing code paths.
    const [teacherAccess, setTeacherAccess] = useState({
        level: '',
        levels: [],
        subjects: [],
        classes: []
    });

    const [isAdmin, setIsAdmin] = useState(false);
    const [levelPermissions, setLevelPermissions] = useState({});
    const [showRoleAlert, setShowRoleAlert] = useState(true);

    useEffect(() => {
        const timer = setTimeout(() => {
            setShowRoleAlert(false);
        }, 10000);
        return () => clearTimeout(timer);
    }, []);

    useEffect(() => {
        async function fetchLevelPermissions() {
            const schoolId = userData?.schoolId || userData?.school?.id;
            if (!schoolId) return;
            try {
                const q = query(collection(db, 'level_permissions'), where('schoolId', '==', schoolId));
                const snap = await getDocs(q);
                const perms = {};
                snap.docs.forEach(d => {
                    const data = d.data();
                    if (data.level) {
                        if (!perms[data.level]) perms[data.level] = {};
                        const atype = data.assessmentType || 'Assessment 1';
                        perms[data.level][atype] = data.isOpen;
                    }
                });
                setLevelPermissions(perms);
            } catch (e) {
                console.error('Failed to load level permissions:', e);
            }
        }
        fetchLevelPermissions();
    }, [userData]);

    const handleToggleLevelPermission = async (level, isOpen) => {
        const schoolId = userData?.schoolId || userData?.school?.id;
        if (!schoolId) {
            showNotification('School ID missing', 'error');
            return;
        }
        try {
            const docId = `${schoolId}_${level}_${controlAssessmentType}`;
            await setDoc(doc(db, 'level_permissions', docId), {
                schoolId,
                level,
                assessmentType: controlAssessmentType,
                isOpen,
                updatedAt: serverTimestamp()
            }, { merge: true });

            setLevelPermissions(prev => ({
                ...prev,
                [level]: {
                    ...(prev[level] || {}),
                    [controlAssessmentType]: isOpen
                }
            }));
            showNotification(`${LEVEL_DISPLAY_NAMES[level] || level} (${controlAssessmentType}) entry ${isOpen ? 'opened' : 'closed'} successfully`, 'success');
        } catch (e) {
            console.error('Failed to update level permission:', e);
            showNotification('Failed to update permission', 'error');
        }
    };

    const [pendingInputs, setPendingInputs] = useState({});

    const [currentPage, setCurrentPage] = useState(1);
    const pageSize = 10;

    const [showHistoryModal, setShowHistoryModal] = useState(false);
    const [showReportModal, setShowReportModal] = useState(false);
    const [showRankingModal, setShowRankingModal] = useState(false);
    const [selectedStudent, setSelectedStudent] = useState(null);
    const [reportStudent, setReportStudent] = useState(null);

    // ---- Notifications ----
    const showNotification = useCallback((message, type = 'info') => {
        const colors = { success: '#27ae60', error: '#e74c3c', warning: '#f39c12', info: '#3498db' };
        const n = document.createElement('div');
        n.style.cssText = `position:fixed;top:20px;right:20px;background:${colors[type] || colors.info};color:#fff;padding:14px 18px;border-radius:8px;box-shadow:0 5px 15px rgba(0,0,0,.2);z-index:10000;max-width:400px;font-size:14px;`;
        n.textContent = message;
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 3500);
    }, []);

    // ---- Role setup ----
    useEffect(() => {
        const role = userRole || userData?.role || 'teacher';
        setIsAdmin(role === 'admin' || role === 'school_admin' || role === 'super-admin');
        if (role === 'teacher' && currentUser?.uid) {
            loadTeacherAccess();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userData, userRole, currentUser]);

    // Check for examId in URL params
    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const examId = params.get('examId');
        if (examId) console.log('Loading results for exam:', examId);
    }, [location]);

    // ------------------------------------------------------------
    // Teacher access resolution
    //
    // Priority order:
    //   1. Firebase Auth custom claims (if a Cloud Function has set them)
    //   2. Firestore `users/{uid}` doc, exposed via AuthContext as `userData`
    //      (this is what the Teachers page now writes to)
    //
    // The Teachers page has NO way to set custom claims — that requires
    // the Admin SDK. So in practice path #2 is what makes teachers work.
    // ------------------------------------------------------------
    const loadTeacherAccess = async () => {
        // 1) Try custom claims first (kept for forward compatibility)
        try {
            const tokenResult = await currentUser.getIdTokenResult(true);
            const c = tokenResult.claims || {};
            if (c.classes || c.subjects || c.level) {
                const claimsClasses = Array.isArray(c.classes) ? c.classes : [];
                const claimsSubjects = Array.isArray(c.subjects) ? c.subjects : [];
                const claimsLevels = Array.isArray(c.levels)
                    ? c.levels
                    : (c.level ? [c.level] : []);

                setTeacherAccess({
                    level: c.level || claimsLevels[0] || '',
                    levels: claimsLevels,
                    subjects: claimsSubjects,
                    classes: claimsClasses
                });
                if (c.level) setSelectedLevel(c.level);
                if (claimsSubjects.length === 1) setSelectedSubject(claimsSubjects[0]);
                if (claimsClasses.length === 1) setSelectedClass(claimsClasses[0]);
                return;
            }
        } catch (e) {
            console.warn('Custom claims read failed, falling back to userData:', e);
        }

        // 2) Fallback: the Firestore `users/{uid}` doc via AuthContext
        if (!userData) return;

        const assignments = Array.isArray(userData.assignments) ? userData.assignments : [];

        // Prefer the new `assignments` shape — [{ subject, classes: [...] }]
        const classesFromAssignments = [...new Set(
            assignments.flatMap(a => Array.isArray(a.classes) ? a.classes : [])
        )];
        const subjectsFromAssignments = [...new Set(
            assignments.map(a => a.subject).filter(Boolean)
        )];

        // Legacy fields (kept for older teacher docs)
        const legacyClasses = Array.isArray(userData.classes)
            ? userData.classes
            : (userData.class ? [userData.class] : []);
        const legacySubjects = Array.isArray(userData.subjects)
            ? userData.subjects
            : (userData.subject ? [userData.subject] : []);
        const legacyLevels = Array.isArray(userData.levels)
            ? userData.levels
            : (userData.level ? [userData.level] : []);

        const effectiveClasses = classesFromAssignments.length > 0
            ? classesFromAssignments
            : legacyClasses;
        const effectiveSubjects = subjectsFromAssignments.length > 0
            ? subjectsFromAssignments
            : legacySubjects;

        // Derive levels from class list if we still don't have any
        let effectiveLevels = legacyLevels;
        if (effectiveLevels.length === 0 && effectiveClasses.length > 0) {
            const set = new Set();
            effectiveClasses.forEach((cls) => {
                Object.entries(LEVEL_CLASSES).forEach(([lvl, list]) => {
                    if (list.includes(cls)) set.add(lvl);
                });
            });
            effectiveLevels = [...set];
        }

        // Primary level: explicit `userData.level` wins, else first derived
        const primaryLevel = userData.level || effectiveLevels[0] || '';

        setTeacherAccess({
            level: primaryLevel,
            levels: effectiveLevels,
            subjects: effectiveSubjects,
            classes: effectiveClasses
        });

        if (primaryLevel) setSelectedLevel(primaryLevel);
        if (effectiveSubjects.length === 1) setSelectedSubject(effectiveSubjects[0]);
        if (effectiveClasses.length === 1) setSelectedClass(effectiveClasses[0]);
    };

    // ---- Access checks ----
    const hasClassAccess = useCallback(
        (cls) => isAdmin || teacherAccess.classes.includes(cls),
        [isAdmin, teacherAccess]
    );
    const hasSubjectAccess = useCallback(
        (s) => isAdmin || teacherAccess.subjects.includes(s),
        [isAdmin, teacherAccess]
    );
    const hasLevelAccess = useCallback(
        (l) => isAdmin
            || (teacherAccess.levels && teacherAccess.levels.length
                ? teacherAccess.levels.includes(l)
                : teacherAccess.level === l),
        [isAdmin, teacherAccess]
    );

    // ---- Memoized dropdown options ----
    const availableLevels = useMemo(() => (
        isAdmin
            ? ['pre-primary', 'lower-primary', 'upper-primary', 'junior-school', 'senior-school']
            : (teacherAccess.levels && teacherAccess.levels.length
                ? teacherAccess.levels
                : [teacherAccess.level].filter(Boolean))
    ), [isAdmin, teacherAccess]);

    const availableClasses = useMemo(() => {
        const levelClasses = getLevelClasses ? getLevelClasses(selectedLevel) : (LEVEL_CLASSES[selectedLevel] || []);
        return isAdmin ? levelClasses : (teacherAccess.classes || []);
    }, [isAdmin, selectedLevel, teacherAccess.classes, getLevelClasses]);

    const availableSubjects = useMemo(() => (
        isAdmin ? (LEVEL_SUBJECTS[selectedLevel] || []) : (teacherAccess.subjects || [])
    ), [isAdmin, selectedLevel, teacherAccess.subjects]);

    // ---- Level Access / ReadOnly ----
    const isLevelOpen = selectedLevel ? (levelPermissions[selectedLevel]?.[assessmentType] !== false) : true;
    const isReadOnly = !isLevelOpen && !isAdmin;

    // ---- Filter change handlers ----
    const handleLevelChange = (e) => {
        const level = e.target.value;
        setSelectedLevel(level);
        setSelectedClass('');
        setSelectedSubject('');
        setStudents([]);
        setStudentScores({});
        setPendingInputs({});
    };

    const handleClassChange = (e) => {
        const cls = e.target.value;
        if (!hasClassAccess(cls) && !isAdmin) {
            showNotification('You do not have access to this class', 'warning');
            return;
        }
        setSelectedClass(cls);
        setStudents([]);
        setStudentScores({});
        setPendingInputs({});
    };

    const handleSubjectChange = (e) => {
        const subj = e.target.value;
        if (!hasSubjectAccess(subj) && !isAdmin) {
            showNotification('You do not have access to this subject', 'warning');
            return;
        }
        setSelectedSubject(subj);
    };

    const handleTermChange = (e) => setSelectedTerm(e.target.value);
    const handleAssessmentTypeChange = (e) => setAssessmentType(e.target.value);
    const handleDeadlineChange = (e) => setAssessmentDeadline(e.target.value);

    // ---- Load students & scores ----
    const loadStudents = async () => {
        if (!selectedLevel || !selectedClass || !selectedSubject) {
            showNotification('Please select level, class, and subject', 'warning');
            return;
        }
        if (!hasLevelAccess(selectedLevel) || !hasClassAccess(selectedClass) || !hasSubjectAccess(selectedSubject)) {
            showNotification('You do not have access to this selection', 'warning');
            return;
        }

        let schoolId;
        try {
            schoolId = requireSchoolId(userData);
        } catch (e) {
            showNotification(e.message, 'error');
            return;
        }

        setLoading(true);
        setPendingInputs({});
        setCurrentPage(1);

        try {
            // Cache-first for offline support
            const cacheKey = `students_${schoolId}_${selectedLevel}_${selectedClass}`;
            const cached = await idbGet(cacheKey);
            if (cached && cached.length) {
                setStudents(cached);
                setUsingCachedData(true);
            }

            const [studentsData, scoresMap] = await Promise.all([
                getStudents(schoolId, selectedLevel, selectedClass),
                getScores(schoolId, selectedLevel, selectedClass, selectedSubject, selectedTerm, assessmentType)
            ]);

            if (studentsData.length === 0) {
                showNotification('No students found for this class', 'warning');
                setStudents([]);
                setStudentScores({});
                setLoading(false);
                return;
            }

            const enriched = studentsData.map(s => {
                const scores = scoresMap[s.id] || [];
                const total = scores.reduce((a, sc) => a + (sc.score || 0), 0);
                const average = scores.length ? Math.round(total / scores.length) : null;
                const status = scores.some(sc => sc.status === 'published') ? 'published' : 'pending';
                return { ...s, average, status };
            });

            setStudents(enriched);
            setStudentScores(scoresMap);
            setUsingCachedData(false);
            await idbSet(cacheKey, enriched);
            showNotification(`Loaded ${enriched.length} students`, 'success');
        } catch (err) {
            console.error('loadStudents failed:', err);
            showNotification('Failed to load students', 'error');
        } finally {
            setLoading(false);
        }
    };

    // ---- Fix #1: saveAllScores (batch) ----
    const saveAllScores = async () => {
        if (isReadOnly) {
            showNotification('Deadline passed — read-only', 'warning');
            return;
        }

        const entries = Object.entries(pendingInputs)
            .map(([studentId, val]) => ({ studentId, score: parseInt(val, 10) }))
            .filter(e => !isNaN(e.score) && e.score >= 0 && e.score <= 100);

        if (entries.length === 0) {
            showNotification('No valid pending scores', 'info');
            return;
        }

        if (!window.confirm(`Save ${entries.length} scores?`)) return;

        setSaving(true);
        try {
            const schoolId = requireSchoolId(userData);
            const teacherMeta = {
                teacherId: currentUser?.uid,
                teacherName: userData?.fullName || userData?.firstName || ''
            };

            if (!isOnline) {
                for (const e of entries) {
                    await addToSyncQueue('student_scores', 'set', {
                        schoolId, level: selectedLevel, class: selectedClass,
                        subject: selectedSubject, term: selectedTerm,
                        assessmentType, studentId: e.studentId, score: e.score,
                        ...teacherMeta
                    });
                }
                showNotification(`${entries.length} scores queued offline`, 'info');
            } else {
                await saveScoresBatch(
                    schoolId, selectedLevel, selectedClass, selectedSubject,
                    selectedTerm, assessmentType, entries, teacherMeta
                );
                await AuditLogService.logAction(
                    schoolId,
                    { uid: currentUser?.uid, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
                    AUDIT_ACTIONS.SCORES_SAVED,
                    {
                        entityId: `${selectedClass}-${selectedSubject}-${assessmentType}`,
                        message: `Saved ${entries.length} ${selectedSubject} score(s) for ${selectedClass}, ${selectedTerm} ${assessmentType}.`
                    }
                );
                showNotification(`Saved ${entries.length} scores`, 'success');
            }

            // Merge into local state
            setStudentScores(prev => {
                const updated = { ...prev };
                for (const e of entries) {
                    const sid = e.studentId;
                    const filtered = (updated[sid] || []).filter(sc =>
                        sc.subject !== selectedSubject ||
                        sc.term !== selectedTerm ||
                        sc.assessmentType !== assessmentType
                    );
                    filtered.push({
                        subject: selectedSubject,
                        term: selectedTerm,
                        assessmentType,
                        score: e.score,
                        status: 'pending'
                    });
                    updated[sid] = filtered;
                }
                return updated;
            });

            // Recompute averages
            setStudents(prev => prev.map(s => {
                const scores = [
                    ...(studentScores[s.id] || []).filter(sc =>
                        sc.subject !== selectedSubject ||
                        sc.term !== selectedTerm ||
                        sc.assessmentType !== assessmentType
                    ),
                    ...entries.filter(e => e.studentId === s.id).map(e => ({
                        subject: selectedSubject,
                        term: selectedTerm,
                        assessmentType,
                        score: e.score
                    }))
                ];
                const total = scores.reduce((a, sc) => a + (sc.score || 0), 0);
                return { ...s, average: scores.length ? Math.round(total / scores.length) : null };
            }));

            setPendingInputs({});
        } catch (err) {
            console.error('saveAllScores failed:', err);
            showNotification('Failed to save scores', 'error');
        } finally {
            setSaving(false);
        }
    };

    // ---- Fix #1: saveScore — direct, no state race ----
    const saveScore = async (studentId) => {
        if (isReadOnly) {
            showNotification('Deadline passed — read-only', 'warning');
            return;
        }

        const raw = pendingInputs[studentId];
        const score = parseInt(raw, 10);
        if (isNaN(score) || score < 0 || score > 100) {
            showNotification('Please enter a valid score (0–100)', 'warning');
            return;
        }

        setSaving(true);
        try {
            const schoolId = requireSchoolId(userData);
            const teacherMeta = {
                teacherId: currentUser?.uid,
                teacherName: userData?.fullName || userData?.firstName || ''
            };

            if (!isOnline) {
                await addToSyncQueue('student_scores', 'set', {
                    schoolId, level: selectedLevel, class: selectedClass,
                    subject: selectedSubject, term: selectedTerm,
                    assessmentType, studentId, score, ...teacherMeta
                });
                showNotification('Score queued offline', 'info');
            } else {
                await saveScoresBatch(
                    schoolId, selectedLevel, selectedClass, selectedSubject,
                    selectedTerm, assessmentType,
                    [{ studentId, score }],
                    teacherMeta
                );
                await AuditLogService.logAction(
                    schoolId,
                    { uid: currentUser?.uid, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
                    AUDIT_ACTIONS.SCORES_SAVED,
                    {
                        entityId: `${studentId}-${selectedSubject}-${assessmentType}`,
                        message: `Saved ${selectedSubject} score for ${selectedClass}, ${selectedTerm} ${assessmentType}.`
                    }
                );
                showNotification('Score saved', 'success');
            }

            // Update local scores map
            const updated = { ...studentScores };
            const filtered = (updated[studentId] || []).filter(sc =>
                sc.subject !== selectedSubject ||
                sc.term !== selectedTerm ||
                sc.assessmentType !== assessmentType
            );
            filtered.push({
                subject: selectedSubject,
                term: selectedTerm,
                assessmentType,
                score,
                status: 'pending'
            });
            updated[studentId] = filtered;
            setStudentScores(updated);

            // Recompute this student's average
            setStudents(prev => prev.map(s => {
                if (s.id !== studentId) return s;
                const scores = updated[studentId] || [];
                const total = scores.reduce((a, sc) => a + (sc.score || 0), 0);
                return { ...s, average: scores.length ? Math.round(total / scores.length) : null };
            }));

            // Remove ONLY this student from pending
            setPendingInputs(prev => {
                const next = { ...prev };
                delete next[studentId];
                return next;
            });
        } catch (err) {
            console.error('saveScore failed:', err);
            showNotification('Failed to save score', 'error');
        } finally {
            setSaving(false);
        }
    };

    // ---- Publish ----
    const publishResult = async (studentId) => {
        try {
            const schoolId = requireSchoolId(userData);
            await publishScoresBatch(
                schoolId, selectedLevel, selectedClass, selectedSubject,
                selectedTerm, assessmentType, [studentId]
            );
            await AuditLogService.logAction(
                schoolId,
                { uid: currentUser?.uid, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
                AUDIT_ACTIONS.SCORES_PUBLISHED,
                {
                    entityId: `${studentId}-${selectedSubject}-${assessmentType}`,
                    message: `Published ${selectedSubject} results for ${selectedClass}, ${selectedTerm} ${assessmentType}.`
                }
            );
            showNotification('Published', 'success');
            setStudents(prev => prev.map(s => s.id === studentId ? { ...s, status: 'published' } : s));
        } catch (err) {
            console.error(err);
            showNotification('Failed to publish', 'error');
        }
    };

    // ---- Save deadline (admin) ----
    const handleSaveDeadline = async () => {
        if (!isAdmin) return;
        if (!assessmentDeadline) {
            showNotification('Please set a deadline date and time', 'warning');
            return;
        }
        if (!selectedLevel || !selectedClass || !selectedSubject) {
            showNotification('Please select level, class and subject first', 'warning');
            return;
        }
        try {
            const schoolId = requireSchoolId(userData);
            await saveAssessmentConfig(schoolId, {
                level: selectedLevel,
                cls: selectedClass,
                subject: selectedSubject,
                assessmentType: deadlineAssessmentType,
                term: selectedTerm,
                deadline: new Date(assessmentDeadline),
                createdBy: currentUser?.uid,
                isActive: true
            });
            if (refreshConfigs) refreshConfigs();
            showNotification(`Deadline set for ${deadlineAssessmentType}`, 'success');
        } catch (err) {
            console.error(err);
            showNotification('Failed to set deadline', 'error');
        }
    };

    // ------------------------------------------------------------
    // Teacher scope helpers
    //
    // When `isAdmin === false`, all ranking and score-sheet exports
    // are confined to the single `selectedSubject` in the current
    // `selectedClass`. Admin keeps the whole-class, all-subjects view.
    // ------------------------------------------------------------

    // Compute per-student subject score from the loaded `studentScores`.
    const getSubjectScoreForStudent = useCallback((studentId, subject) => {
        const scores = studentScores[studentId] || [];
        const hit = scores.find(s => s.subject === subject);
        return hit ? hit.score : null;
    }, [studentScores]);

    // Class mean in the current subject (teachers) or overall
    // (admin) across all subjects we've loaded.
    const classSubjectMean = useMemo(() => {
        if (!selectedSubject) return 0;
        const values = students
            .map(s => getSubjectScoreForStudent(s.id, selectedSubject))
            .filter(v => typeof v === 'number');
        if (values.length === 0) return 0;
        return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    }, [students, selectedSubject, getSubjectScoreForStudent]);

    // Ranking rows the modal/PDF will render.
    // Teacher: one row per student with the subject score + rank in that subject.
    // Admin: one row per student, full multi-subject aggregation as before.
    const buildRankingRows = useCallback(() => {
        const allSubjects = LEVEL_SUBJECTS[selectedLevel] || [];

        if (!isAdmin) {
            // --- Teacher scope: single subject ranking ---
            const rows = students.map((s) => {
                const score = getSubjectScoreForStudent(s.id, selectedSubject);
                const grade = getCBCGrade(score ?? 0);
                return {
                    ...s,
                    subjectScores: { [selectedSubject]: score },
                    subjectScore: score,
                    totalMarks: score ?? 0,
                    average: score ?? 0,
                    cbcGrade: grade
                };
            });

            // Rank by subject score desc, nulls last
            const sorted = [...rows].sort((a, b) => {
                const av = a.subjectScore;
                const bv = b.subjectScore;
                if (av === null && bv === null) return 0;
                if (av === null) return 1;
                if (bv === null) return -1;
                return bv - av;
            });
            return sorted;
        }

        // --- Admin scope: multi-subject ranking ---
        const rows = students.map((s) => {
            const scores = studentScores[s.id] || [];
            const subjectScores = {};
            let total = 0, count = 0;
            allSubjects.forEach(sub => {
                const sc = scores.find(x => x.subject === sub);
                subjectScores[sub] = sc ? sc.score : null;
                if (sc) { total += sc.score; count++; }
            });
            const average = count ? Math.round(total / count) : 0;
            return {
                ...s,
                subjectScores,
                totalMarks: total,
                average,
                cbcGrade: getCBCGrade(average)
            };
        });
        return [...rows].sort((a, b) => (b.average || 0) - (a.average || 0));
    }, [isAdmin, students, studentScores, selectedLevel, selectedSubject, getSubjectScoreForStudent]);

    // ---- Fix #3: PDF exports ----
    const handleDownloadReportPDF = async (student) => {
        if (!student) return;
        try {
            const scores = studentScores[student.id] || [];
            const result = await downloadStudentReportPDF(student, scores, {
                schoolName,
                schoolMotto,
                schoolLogo: userData?.schoolLogo || '',
                schoolAddress: userData?.schoolAddress || '',
                schoolPhone: userData?.schoolPhone || '',
                schoolEmail: userData?.schoolEmail || '',
                level: LEVEL_DISPLAY_NAMES[selectedLevel] || selectedLevel,
                cls: selectedClass,
                term: selectedTerm,
                year: new Date().getFullYear(),
                assessmentType,
                subjects: LEVEL_SUBJECTS[selectedLevel] || []
            });
            showNotification(`Report saved${result?.uri ? ' to Downloads/EduPriva' : ''}${result?.filename ? ` as ${result.filename}` : ''}.`, 'success');
        } catch (e) {
            console.error(e);
            showNotification('PDF generation failed', 'error');
        }
    };

    const handleDownloadRankingPDF = async () => {
        try {
            const allSubjects = LEVEL_SUBJECTS[selectedLevel] || [];
            const data = buildRankingRows();

            // For teachers, pass just the single subject so the PDF's
            // header and mean column reflect the subject scope.
            const pdfSubjects = isAdmin ? allSubjects : [selectedSubject];

            const result = await downloadRankingPDF(data, {
                schoolName,
                schoolMotto,
                level: LEVEL_DISPLAY_NAMES[selectedLevel] || selectedLevel,
                cls: selectedClass,
                term: selectedTerm,
                year: new Date().getFullYear(),
                assessmentType,
                subjects: pdfSubjects,
                // A marker so the PDF service can optionally show "Class Mean"
                // for the teacher's single subject.
                classSubjectMean: isAdmin ? undefined : classSubjectMean,
                scope: isAdmin ? 'all-subjects' : 'single-subject',
                scopeSubject: isAdmin ? undefined : selectedSubject
            });
            showNotification(
                `Ranking saved${result?.uri ? ' to Downloads/EduPriva' : ''}${result?.filename ? ` as ${result.filename}` : ''}.`,
                'success'
            );
        } catch (e) {
            console.error(e);
            showNotification('Ranking PDF failed', 'error');
        }
    };

    // ---- CSV exports ----
    const downloadCSV = (content, filename) => {
        const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    };

    // ------------------------------------------------------------
    // Score sheet export
    //
    // Teacher: rows are scoped to their subject — Score, Mean,
    //          Rank within subject, CBC Grade from that score.
    // Admin:   rows keep the multi-subject Average view.
    // ------------------------------------------------------------
    const exportResultsCSV = () => {
        if (students.length === 0) {
            showNotification('No data to export', 'warning');
            return;
        }

        if (!isAdmin) {
            // --- Teacher score sheet (single subject) ---
            const rows = students.map((s) => {
                const score = getSubjectScoreForStudent(s.id, selectedSubject);
                const grade = getCBCGrade(score ?? 0);
                return {
                    Name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
                    AdmissionNo: s.admissionNumber || s.studentId || '',
                    Subject: selectedSubject,
                    Term: selectedTerm,
                    Assessment: assessmentType,
                    Score: score ?? '',
                    Mean: classSubjectMean,
                    Grade: score != null ? grade.code : '',
                    Points: score != null ? grade.points : ''
                };
            });

            // Rank by score desc, ties keep insertion order
            const ranked = [...rows]
                .map((r, i) => ({ ...r, _orig: i }))
                .sort((a, b) => {
                    if (a.Score === '' && b.Score === '') return 0;
                    if (a.Score === '') return 1;
                    if (b.Score === '') return -1;
                    return b.Score - a.Score;
                });
            ranked.forEach((r, i) => { r.Rank = i + 1; });
            ranked.sort((a, b) => a._orig - b._orig);

            const finalRows = ranked.map(({ _orig, ...r }) => r);
            const headers = Object.keys(finalRows[0] || {});
            const csv = [headers.join(','), ...finalRows.map(row =>
                headers.map(h => `"${row[h] ?? ''}"`).join(',')
            )].join('\n');
            downloadCSV(
                csv,
                `results_${selectedSubject}_${selectedClass}_${selectedTerm}_${new Date().toISOString().slice(0,10)}.csv`
            );
            showNotification(`Exported ${finalRows.length} ${selectedSubject} score(s)`, 'success');
            return;
        }

        // --- Admin score sheet (existing multi-subject view) ---
        const rows = students.map(s => {
            const grade = getCBCGrade(s.average || 0);
            return {
                Name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
                AdmissionNo: s.admissionNumber || s.studentId || '',
                Subject: selectedSubject,
                Term: selectedTerm,
                Assessment: assessmentType,
                Average: s.average ?? '',
                Grade: grade.code,
                Points: grade.points,
                Status: s.status
            };
        });
        const headers = Object.keys(rows[0] || {});
        const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${r[h]}"`).join(','))].join('\n');
        downloadCSV(csv, `results_${selectedSubject}_${selectedClass}_${selectedTerm}_${new Date().toISOString().slice(0,10)}.csv`);
        showNotification('Results exported', 'success');
    };

    // Admin-only — teachers don't get the full ranking CSV.
    const exportRankingCSV = () => {
        if (!isAdmin) return;
        if (students.length === 0) {
            showNotification('No data to export', 'warning');
            return;
        }
        const allSubjects = LEVEL_SUBJECTS[selectedLevel] || [];
        const sortedStudents = [...students].sort((a, b) => (b.average || 0) - (a.average || 0));

        const data = sortedStudents.map((student, index) => {
            const scores = studentScores[student.id] || [];
            const subjectScores = {};
            allSubjects.forEach(subject => {
                const score = scores.find(s => s.subject === subject);
                subjectScores[subject] = score ? score.score : '-';
            });
            const avg = student.average || 0;
            const cbcGrade = getCBCGrade(avg);

            return {
                Rank: index + 1,
                Name: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                AdmNo: student.admissionNumber || student.studentId || 'N/A',
                ...subjectScores,
                Total: scores.reduce((sum, s) => sum + (s.score || 0), 0),
                Average: avg,
                Grade: cbcGrade.code
            };
        });

        const headers = Object.keys(data[0] || {});
        const csv = [headers.join(','), ...data.map(row => headers.map(h => `"${row[h]}"`).join(','))].join('\n');
        downloadCSV(csv, `ranking_${selectedLevel}_${selectedClass}_${selectedTerm}_${new Date().toISOString().slice(0,10)}.csv`);
        showNotification('Ranking exported', 'success');
    };

    // ---- Fix #7: CSV import (size guard + one read) ----
    const handleImportResults = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (file.size > MAX_IMPORT_SIZE) {
            showNotification('File too large (max 5 MB)', 'error');
            e.target.value = '';
            return;
        }

        if (!selectedLevel || !selectedClass || !selectedSubject) {
            showNotification('Select level, class, subject first', 'warning');
            e.target.value = '';
            return;
        }

        const schoolId = requireSchoolId(userData);
        const text = await file.text();
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length < 2) {
            showNotification('Invalid CSV', 'warning');
            e.target.value = '';
            return;
        }

        const header = lines[0].split(',').map(h => h.trim().toLowerCase());
        const iName = header.findIndex(h => h.includes('name'));
        const iAdm = header.findIndex(h => h.includes('adm'));
        const iScore = header.findIndex(h => h.includes('score'));

        if (iScore === -1 || (iName === -1 && iAdm === -1)) {
            showNotification('CSV must have Name or Adm No plus Score', 'error');
            e.target.value = '';
            return;
        }

        // One read: preload students into a Map
        const classStudents = students.length
            ? students
            : await getStudents(schoolId, selectedLevel, selectedClass);

        const byAdmission = new Map();
        classStudents.forEach(s => {
            const key = (s.admissionNumber || s.studentId || '').toUpperCase();
            if (key) byAdmission.set(key, s);
        });

        const entries = [];
        let errors = 0;

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim());
            const admNo = iAdm !== -1 ? (cols[iAdm] || '').toUpperCase() : '';
            const score = parseInt(cols[iScore], 10);
            if (isNaN(score) || score < 0 || score > 100) { errors++; continue; }

            const student = admNo ? byAdmission.get(admNo) : null;
            if (!student) { errors++; continue; }
            entries.push({ studentId: student.id, score });
        }

        if (entries.length === 0) {
            showNotification(`No valid rows (${errors} errors)`, 'error');
            e.target.value = '';
            return;
        }

        await saveScoresBatch(
            schoolId, selectedLevel, selectedClass, selectedSubject,
            selectedTerm, assessmentType, entries,
            { teacherId: currentUser?.uid, teacherName: userData?.fullName || '' }
        );

        showNotification(`Imported ${entries.length} scores, ${errors} errors`, 'success');
        await loadStudents();
        e.target.value = '';
    };

    // ---- Report & Ranking generators (open modals) ----
    const generateSingleReport = (studentId) => {
        const student = students.find(s => s.id === studentId);
        if (!student) {
            showNotification('Student not found', 'error');
            return;
        }
        setReportStudent(student);
        setShowReportModal(true);
    };

    const generateClassRanking = () => {
        if (students.length === 0) {
            showNotification('No students loaded. Please load students first.', 'warning');
            return;
        }
        if (!isAdmin && !selectedSubject) {
            showNotification('Please select a subject first.', 'warning');
            return;
        }
        setShowRankingModal(true);
    };

    // ---- Fix #2: view student score history (opens React modal) ----
    const viewStudentScores = (studentId) => {
        const student = students.find(s => s.id === studentId);
        if (!student) return;
        setSelectedStudent(student);
        setShowHistoryModal(true);
    };

    // ---- Mark pending input ----
    const markScorePending = (studentId, value) => {
        if (isReadOnly) {
            showNotification('Deadline passed — read-only', 'warning');
            return;
        }
        setPendingInputs(prev => ({ ...prev, [studentId]: value }));
    };

    // ---- Stats (memoized) ----
    const stats = useMemo(() => {
        const scored = students.filter(s => s.average !== null && s.average !== undefined);
        const avg = scored.length ? Math.round(scored.reduce((a, s) => a + s.average, 0) / scored.length) : 0;
        const high = scored.length ? Math.max(...scored.map(s => s.average)) : 0;
        const low = scored.length ? Math.min(...scored.map(s => s.average)) : 0;
        return {
            totalStudents: students.length,
            scored: scored.length,
            notScored: students.length - scored.length,
            avgScore: avg,
            highest: high,
            lowest: low
        };
    }, [students]);

    if (loading) return <LoadingSpinner fullScreen text="Loading results..." />;

    return (
        <Layout title="Results (CBC)">
            {/* Role indicator alert (auto-hides after 10s) */}
            {showRoleAlert && (
                <div style={{
                    background: isAdmin ? '#d4edda' : '#d1ecf1',
                    color: isAdmin ? '#155724' : '#0c5460',
                    padding: '8px 16px', borderRadius: '8px', marginBottom: '20px',
                    display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px',
                    border: `1px solid ${isAdmin ? '#c3e6cb' : '#bee5eb'}`
                }}>
                    <i className={`fas ${isAdmin ? 'fa-user-shield' : 'fa-user-tag'}`}></i>
                    <span>
                        {isAdmin
                            ? 'Admin Access - Full control over all classes and subjects'
                            : `Teacher Access - You can only view and manage ${teacherAccess.classes.join(', ') || 'no assigned'} classes and ${teacherAccess.subjects.join(', ') || 'no assigned'} subjects`}
                    </span>
                </div>
            )}

            {/* Level Closed indicator */}
            {!isLevelOpen && (
                <div style={{
                    background: '#f8d7da', color: '#721c24',
                    padding: '10px 20px', borderRadius: '8px', marginBottom: '20px',
                    display: 'flex', alignItems: 'center', gap: '10px',
                    fontSize: '14px', border: '1px solid #f5c6cb'
                }}>
                    <i className="fas fa-lock"></i>
                    <span><strong>Level Closed for Entry!</strong> Result entry is currently closed for this level. Scores are read-only.</span>
                </div>
            )}

            {/* Using cached data indicator */}
            {usingCachedData && isOnline && (
                <div style={{
                    background: '#d1ecf1', color: '#0c5460',
                    padding: '8px 16px', borderRadius: '8px', marginBottom: '20px',
                    display: 'flex', alignItems: 'center', gap: '10px',
                    fontSize: '13px', border: '1px solid #bee5eb'
                }}>
                    <i className="fas fa-database"></i>
                    <span>Showing cached data. Syncing in background...</span>
                </div>
            )}

            {/* Stats Grid */}
            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-label">Total Students</div>
                    <div className="stat-value">{stats.totalStudents}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Scored</div>
                    <div className="stat-value">{stats.scored}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Not Scored</div>
                    <div className="stat-value">{stats.notScored}</div>
                </div>
                <div className="stat-card">
                    <div className="stat-label">Average Score</div>
                    <div className="stat-value">{stats.avgScore}%</div>
                </div>
            </div>

            {/* Selection Area */}
            <div className="selection-area" style={{
                background: 'white', borderRadius: '12px', padding: '25px',
                boxShadow: '0 4px 6px rgba(0,0,0,0.07)', marginBottom: '25px',
                display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr auto',
                gap: '15px', alignItems: 'end'
            }}>
                <div className="form-group" style={{ marginBottom: '0' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--secondary)', marginBottom: '5px' }}>
                        Select Level <span style={{ color: 'var(--danger)' }}>*</span>
                    </label>
                    <select
                        value={selectedLevel}
                        onChange={handleLevelChange}
                        style={{ width: '100%', padding: '10px 15px', border: '2px solid var(--border)', borderRadius: '8px', fontSize: '14px', background: 'white' }}
                    >
                        <option value="">Select Level</option>
                        {availableLevels.map(level => (
                            <option key={level} value={level}>{LEVEL_DISPLAY_NAMES[level] || level}</option>
                        ))}
                    </select>
                    {!isAdmin && (
                        <div style={{ fontSize: '11px', color: 'var(--info)', marginTop: '3px' }}>
                            <i className="fas fa-info-circle"></i> Your assigned level
                        </div>
                    )}
                </div>

                <div className="form-group" style={{ marginBottom: '0' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--secondary)', marginBottom: '5px' }}>
                        Select Class <span style={{ color: 'var(--danger)' }}>*</span>
                    </label>
                    <select
                        value={selectedClass}
                        onChange={handleClassChange}
                        style={{ width: '100%', padding: '10px 15px', border: '2px solid var(--border)', borderRadius: '8px', fontSize: '14px', background: 'white' }}
                    >
                        <option value="">Select Class</option>
                        {availableClasses.map(cls => (
                            <option key={cls} value={cls}>{cls}</option>
                        ))}
                    </select>
                    {!isAdmin && (
                        <div style={{ fontSize: '11px', color: 'var(--info)', marginTop: '3px' }}>
                            <i className="fas fa-info-circle"></i> Your assigned classes
                        </div>
                    )}
                </div>

                <div className="form-group" style={{ marginBottom: '0' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--secondary)', marginBottom: '5px' }}>
                        Select Subject <span style={{ color: 'var(--danger)' }}>*</span>
                    </label>
                    <select
                        value={selectedSubject}
                        onChange={handleSubjectChange}
                        style={{ width: '100%', padding: '10px 15px', border: '2px solid var(--border)', borderRadius: '8px', fontSize: '14px', background: 'white' }}
                    >
                        <option value="">Select Subject</option>
                        {availableSubjects.map(subject => (
                            <option key={subject} value={subject}>{subject}</option>
                        ))}
                    </select>
                    {!isAdmin && (
                        <div style={{ fontSize: '11px', color: 'var(--info)', marginTop: '3px' }}>
                            <i className="fas fa-info-circle"></i> Your assigned subjects
                        </div>
                    )}
                </div>

                <div className="form-group" style={{ marginBottom: '0' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--secondary)', marginBottom: '5px' }}>
                        Term <span style={{ color: 'var(--danger)' }}>*</span>
                    </label>
                    <select
                        value={selectedTerm}
                        onChange={handleTermChange}
                        style={{ width: '100%', padding: '10px 15px', border: '2px solid var(--border)', borderRadius: '8px', fontSize: '14px', background: 'white' }}
                    >
                        <option value="Term 1">Term 1</option>
                        <option value="Term 2">Term 2</option>
                        <option value="Term 3">Term 3</option>
                    </select>
                </div>

                <div className="form-group" style={{ marginBottom: '0' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--secondary)', marginBottom: '5px' }}>Assessment Type</label>
                    <select
                        value={assessmentType}
                        onChange={handleAssessmentTypeChange}
                        style={{ width: '100%', padding: '10px 15px', border: '2px solid var(--border)', borderRadius: '8px', fontSize: '14px', background: 'white' }}
                    >
                        {ASSESSMENT_TYPES.map(type => (
                            <option key={type.value} value={type.value}>{type.label}</option>
                        ))}
                    </select>
                </div>

                <button
                    className="btn btn-primary"
                    style={{
                        padding: '10px 20px', border: 'none', borderRadius: '8px',
                        fontWeight: '600', cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: '8px',
                        fontSize: '14px', background: 'var(--primary)', color: 'white'
                    }}
                    onClick={loadStudents}
                    disabled={loading || !selectedLevel || !selectedClass || !selectedSubject}
                >
                    <i className="fas fa-users"></i> Load Students
                </button>
            </div>

            {/* Level Result Entry Controls - Admin Only */}
            {isAdmin && (
                <div style={{
                    background: 'white', borderRadius: '12px', padding: '20px',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.07)', marginBottom: '25px',
                    border: '2px solid var(--primary)', borderLeft: '4px solid var(--primary)'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', flexWrap: 'wrap', gap: '15px' }}>
                        <div>
                            <h4 style={{ marginBottom: '5px', color: 'var(--secondary)' }}>
                                <i className="fas fa-lock-open"></i> Level & Assessment Entry Controls
                            </h4>
                            <p style={{ fontSize: '13px', color: 'var(--gray)', margin: 0 }}>
                                Select assessment type and toggle result entry open or closed for each school level.
                            </p>
                        </div>
                        <div>
                            <select
                                value={controlAssessmentType}
                                onChange={(e) => setControlAssessmentType(e.target.value)}
                                style={{ padding: '8px 12px', border: '2px solid var(--border)', borderRadius: '8px', fontSize: '14px', background: 'white', fontWeight: '600' }}
                            >
                                {ASSESSMENT_TYPES.map(a => (
                                    <option key={a.value} value={a.value}>{a.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px' }}>
                        {['pre-primary', 'lower-primary', 'upper-primary', 'junior-school', 'senior-school'].map(lvl => {
                            const isOpen = levelPermissions[lvl]?.[controlAssessmentType] !== false; // default true
                            return (
                                <div key={lvl} style={{
                                    padding: '15px',
                                    background: isOpen ? '#f0fdf4' : '#fef2f2',
                                    borderRadius: '10px',
                                    border: `1px solid ${isOpen ? '#bbf7d0' : '#fecaca'}`,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'space-between',
                                    gap: '10px'
                                }}>
                                    <div>
                                        <div style={{ fontWeight: 'bold', fontSize: '14px', color: '#1e293b' }}>
                                            {LEVEL_DISPLAY_NAMES[lvl] || lvl}
                                        </div>
                                        <div style={{ fontSize: '12px', color: isOpen ? '#166534' : '#991b1b', marginTop: '2px' }}>
                                            Status: <strong>{isOpen ? 'OPEN FOR ENTRY' : 'CLOSED'}</strong>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleToggleLevelPermission(lvl, !isOpen)}
                                        style={{
                                            padding: '8px 12px',
                                            border: 'none',
                                            borderRadius: '6px',
                                            fontWeight: '600',
                                            fontSize: '13px',
                                            cursor: 'pointer',
                                            background: isOpen ? '#dc2626' : '#16a34a',
                                            color: 'white',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            gap: '6px'
                                        }}
                                    >
                                        <i className={isOpen ? 'fas fa-lock' : 'fas fa-lock-open'}></i>
                                        {isOpen ? 'Close Level' : 'Open Level'}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Assessment Summary */}
            {stats.totalStudents > 0 && (
                <div style={{
                    background: 'white', borderRadius: '12px', padding: '15px 20px',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.07)', marginBottom: '25px',
                    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '15px'
                }}>
                    {[
                        { label: 'Total Students', value: stats.totalStudents, color: 'var(--secondary)' },
                        { label: 'Scored', value: stats.scored, color: 'var(--success)' },
                        { label: 'Not Scored', value: stats.notScored, color: 'var(--danger)' },
                        { label: 'Average', value: `${stats.avgScore}%`, color: 'var(--secondary)' },
                        { label: 'Highest', value: `${stats.highest}%`, color: 'var(--success)' },
                        { label: 'Lowest', value: `${stats.lowest}%`, color: 'var(--danger)' }
                    ].map((item, i) => (
                        <div key={i} style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '10px', color: 'var(--gray)', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{item.label}</div>
                            <div style={{ fontSize: '18px', fontWeight: '700', color: item.color, marginTop: '2px' }}>{item.value}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
                <button
                    className="btn btn-success"
                    style={{
                        padding: '10px 20px', border: 'none', borderRadius: '8px',
                        fontWeight: '600', cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: '8px',
                        fontSize: '14px', background: 'var(--success)', color: 'white'
                    }}
                    onClick={saveAllScores}
                    disabled={saving || students.length === 0 || isReadOnly || Object.keys(pendingInputs).length === 0}
                >
                    <i className="fas fa-save"></i> {saving ? 'Saving...' : `Save All (${Object.keys(pendingInputs).length})`}
                </button>

                {/* Ranking Report — teachers get a subject-scoped ranking; admin gets full-class */}
                <button
                    className="btn btn-warning"
                    style={{
                        padding: '10px 20px', border: 'none', borderRadius: '8px',
                        fontWeight: '600', cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: '8px',
                        fontSize: '14px', background: 'var(--warning)', color: 'white'
                    }}
                    onClick={generateClassRanking}
                    disabled={students.length === 0 || (!isAdmin && !selectedSubject)}
                    title={isAdmin
                        ? 'Ranking across all subjects'
                        : `Ranking for ${selectedSubject || 'your subject'} only`}
                >
                    <i className="fas fa-trophy"></i>{' '}
                    {isAdmin ? 'Ranking Report' : `Ranking Report (${selectedSubject || 'Subject'})`}
                </button>

                {/* Ranking PDF — same scoping as the modal */}
                <button
                    className="btn btn-info"
                    style={{
                        padding: '10px 20px', border: 'none', borderRadius: '8px',
                        fontWeight: '600', cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: '8px',
                        fontSize: '14px', background: 'var(--info)', color: 'white'
                    }}
                    onClick={handleDownloadRankingPDF}
                    disabled={students.length === 0 || (!isAdmin && !selectedSubject)}
                    title={isAdmin
                        ? 'Download full ranking PDF'
                        : `Download ${selectedSubject || 'subject'} ranking PDF`}
                >
                    <i className="fas fa-file-pdf"></i>{' '}
                    {isAdmin ? 'Ranking PDF' : `Ranking PDF (${selectedSubject || 'Subject'})`}
                </button>

                {isAdmin && (
                    <button
                        className="btn btn-info"
                        style={{
                            padding: '10px 20px', border: 'none', borderRadius: '8px',
                            fontWeight: '600', cursor: 'pointer',
                            display: 'inline-flex', alignItems: 'center', gap: '8px',
                            fontSize: '14px', background: '#6c757d', color: 'white'
                        }}
                        onClick={exportRankingCSV}
                        disabled={students.length === 0}
                    >
                        <i className="fas fa-download"></i> Export Ranking CSV
                    </button>
                )}

                <button
                    className="btn btn-outline"
                    style={{
                        padding: '10px 20px', border: '2px solid var(--border)',
                        borderRadius: '8px', fontWeight: '600', cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: '8px',
                        fontSize: '14px', background: 'transparent', color: 'var(--secondary)'
                    }}
                    onClick={exportResultsCSV}
                    disabled={students.length === 0}
                    title={isAdmin
                        ? 'Export whole-class score sheet'
                        : `Export ${selectedSubject || 'subject'} score sheet`}
                >
                    <i className="fas fa-file-csv"></i>{' '}
                    {isAdmin ? 'Export Score Sheet' : `Export Score Sheet (${selectedSubject || 'Subject'})`}
                </button>

                {isAdmin && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <input
                            type="file"
                            accept=".csv"
                            id="importResults"
                            style={{ display: 'none' }}
                            onChange={handleImportResults}
                        />
                        <label
                            htmlFor="importResults"
                            style={{
                                padding: '10px 20px', border: '2px dashed var(--primary)',
                                borderRadius: '8px', fontWeight: '600', cursor: 'pointer',
                                display: 'inline-flex', alignItems: 'center', gap: '8px',
                                fontSize: '14px', background: '#f0f2ff', color: 'var(--primary)'
                            }}
                        >
                            <i className="fas fa-upload"></i> Import Results
                        </label>
                        <span style={{ fontSize: '12px', color: 'var(--gray)' }}>CSV: Name, Adm No, Score</span>
                    </div>
                )}
            </div>

            {/* Students Table — extracted component */}
            <ResultsTable
                students={students}
                pendingInputs={pendingInputs}
                setPendingInputs={setPendingInputs}
                onInputChange={markScorePending}
                isReadOnly={isReadOnly}
                saving={saving}
                currentPage={currentPage}
                setCurrentPage={setCurrentPage}
                pageSize={pageSize}
                onSave={saveScore}
                onPublish={publishResult}
                onViewScores={(s) => viewStudentScores(s.id)}
                onGenerateReport={(s) => generateSingleReport(s.id)}
                onDownloadPDF={handleDownloadReportPDF}
            />

            {/* Score History Modal — Fix #2, React-rendered */}
            {showHistoryModal && selectedStudent && (
                <ScoreHistoryModal
                    student={selectedStudent}
                    scores={studentScores[selectedStudent.id] || []}
                    context={{ cls: selectedClass, subject: selectedSubject, term: selectedTerm }}
                    onClose={() => setShowHistoryModal(false)}
                />
            )}

            {/* Report Modal — Fix #3, no innerHTML */}
            {showReportModal && reportStudent && (
                <ReportModal
                    student={reportStudent}
                    scores={studentScores[reportStudent.id] || []}
                    meta={{
                        schoolName,
                        schoolMotto,
                        level: LEVEL_DISPLAY_NAMES[selectedLevel] || selectedLevel,
                        cls: selectedClass,
                        term: selectedTerm,
                        assessmentType,
                        subjects: LEVEL_SUBJECTS[selectedLevel] || []
                    }}
                    onClose={() => setShowReportModal(false)}
                    onDownloadPDF={() => handleDownloadReportPDF(reportStudent)}
                />
            )}

            {/* Ranking Modal — scoped for teachers, full-class for admins */}
            {showRankingModal && (
                <RankingModal
                    students={buildRankingRows()}
                    studentScores={studentScores}
                    meta={{
                        schoolName,
                        schoolMotto,
                        level: LEVEL_DISPLAY_NAMES[selectedLevel] || selectedLevel,
                        cls: selectedClass,
                        term: selectedTerm,
                        assessmentType,
                        // Teachers: only their selected subject so the table
                        // shows a single column and ranks by it.
                        subjects: isAdmin
                            ? (LEVEL_SUBJECTS[selectedLevel] || [])
                            : [selectedSubject],
                        // Extra context the modal can display
                        scope: isAdmin ? 'all-subjects' : 'single-subject',
                        scopeSubject: isAdmin ? null : selectedSubject,
                        classSubjectMean: isAdmin ? null : classSubjectMean
                    }}
                    onClose={() => setShowRankingModal(false)}
                    onDownloadPDF={handleDownloadRankingPDF}
                />
            )}

            {/* Styles */}
            <style>{`
                .stat-card { transition: all 0.3s; }
                .stat-card:hover { transform: translateY(-2px); box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
                .score-input:focus {
                    outline: none;
                    border-color: var(--primary) !important;
                    box-shadow: 0 0 0 3px rgba(26, 35, 126, 0.1);
                }
                .btn-primary:hover { background: var(--primary-dark) !important; transform: translateY(-2px); }
                .btn-success:hover { opacity: 0.9; transform: translateY(-2px); }
                .btn-warning:hover { opacity: 0.9; transform: translateY(-2px); }
                .btn-info:hover { opacity: 0.9; transform: translateY(-2px); }
                .btn-outline:hover { border-color: var(--primary); color: var(--primary); }
                .modal-close:hover { background: var(--border); }
                select:focus { outline: none; border-color: var(--primary) !important; }
                @media (max-width: 1024px) {
                    .selection-area { grid-template-columns: 1fr 1fr 1fr !important; }
                }
                @media (max-width: 768px) {
                    .stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
                    .selection-area { grid-template-columns: 1fr !important; }
                }
                @media (max-width: 480px) {
                    .stats-grid { grid-template-columns: 1fr !important; }
                }
            `}</style>
        </Layout>
    );
}
