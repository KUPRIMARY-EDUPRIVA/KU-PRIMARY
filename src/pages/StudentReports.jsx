// src/pages/StudentReports.jsx
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { normalizeRole } from '../utils/roles';
import { db } from '../firebase';
import { collection, query, where, getDocs, limit } from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { showAppNotice } from '../utils/appNotice';
import {
    LEVEL_CLASSES, LEVEL_DISPLAY_NAMES, LEVEL_SUBJECTS, getCBCGrade,
} from '../utils/constants';
import {
    downloadTranscripts,
    downloadClassReportForms,
    downloadStudentReportForm,
} from '../services/pdf';
import { loadStudentRoster } from '../services/studentRosterService';
import { getAllPaperConfigsForLevel } from '../services/firestore';

const MAX_STUDENTS = 500;
const MAX_SCORES = 4000;
const ASSESSMENTS = [
    { index: 0, label: 'Assessment 1' },
    { index: 1, label: 'Assessment 2' },
    { index: 2, label: 'Assessment 3' },
];

const SAMPLE_SUBJECTS = [
    'English', 'Kiswahili', 'Mathematics', 'Integrated Science',
    'Social Studies', 'Religious Education', 'Pre-Technical Studies',
    'Agriculture & Nutrition',
];

const SAMPLE_STUDENT = {
    id: 'sample',
    firstName: 'John', lastName: 'Doe',
    admissionNumber: 'STU-2024-001', class: 'Grade 7',
    scores: {
        English: [85, 78, 92], Kiswahili: [72, 68, 75],
        Mathematics: [68, 72, 65], 'Integrated Science': [90, 85, 88],
        'Social Studies': [75, 70, 80], 'Religious Education': [80, 75, 85],
        'Pre-Technical Studies': [65, 70, 60], 'Agriculture & Nutrition': [88, 82, 90],
    },
    averages: {
        English: 85, Kiswahili: 72, Mathematics: 68, 'Integrated Science': 88,
        'Social Studies': 75, 'Religious Education': 80,
        'Pre-Technical Studies': 65, 'Agriculture & Nutrition': 87,
    },
};

const HEAD_TEACHER_ROLES = ['headteacher', 'principal'];

const resolveClassList = (level, getLevelClassesFn) => {
    if (!level) return [];
    const custom = getLevelClassesFn ? getLevelClassesFn(level) : null;
    if (Array.isArray(custom) && custom.length > 0) return custom;
    return LEVEL_CLASSES[level] || [];
};

function userDisplayName(u) {
    if (!u) return '';
    const direct = `${u.firstName || ''} ${u.lastName || ''}`.trim();
    if (direct) return direct;
    if (typeof u.fullName === 'string' && u.fullName.trim()) return u.fullName.trim();
    if (typeof u.name === 'string' && u.name.trim()) return u.name.trim();
    if (typeof u.email === 'string' && u.email.includes('@')) {
        return u.email.split('@')[0];
    }
    return '';
}

// ------------------------------------------------------------
// Resolve a student's full data set (identity + scores) for a
// given term. Used by both the admin flow and the student
// self-service flow.
// ------------------------------------------------------------
async function buildEnrichedStudents({
    schoolId,
    level,
    cls,
    termName,
    subjects,
    studentFilterIds = null, // null = all in class; otherwise array of ids
}) {
    const studentsData = (await loadStudentRoster(schoolId))
        .filter((s) => s.level === level && s.class === cls)
        .filter((s) => (studentFilterIds ? studentFilterIds.includes(s.id) : true))
        .sort((a, b) => String(a.firstName || '').localeCompare(String(b.firstName || '')))
        .slice(0, MAX_STUDENTS);

    if (studentsData.length === 0) return [];

    const scoresSnap = await getDocs(query(
        collection(db, 'student_scores'),
        where('schoolId', '==', schoolId),
        where('level', '==', level),
        where('class', '==', cls),
        where('term', '==', termName),
        limit(MAX_SCORES)
    ));

    const bucket = new Map();
    scoresSnap.forEach((d) => {
        const s = d.data();
        if (!s.studentId || !s.subject) return;
        if (!bucket.has(s.studentId)) bucket.set(s.studentId, new Map());
        const bySubj = bucket.get(s.studentId);
        if (!bySubj.has(s.subject)) {
            bySubj.set(s.subject, {
                assessmentScores: [null, null, null],
                papers: {},
            });
        }
        const entry = bySubj.get(s.subject);
        const aType = String(s.assessmentType || '');
        const match = aType.match(/Assessment\s+(\d+)/i);
        const idx = match ? parseInt(match[1], 10) - 1 : null;
        if (idx != null && idx >= 0 && idx < 3) {
            const val = s.computedPercentage != null ? s.computedPercentage : s.score;
            entry.assessmentScores[idx] = Number.isFinite(Number(val)) ? Number(val) : null;
        }
        if (s.papers && typeof s.papers === 'object') {
            Object.assign(entry.papers, s.papers);
        }
    });

    const enriched = studentsData.map((student) => {
        const bySubj = bucket.get(student.id) || new Map();
        const scores = {};
        const averages = {};
        const papersBySubject = {};
        let sumOfAverages = 0;
        let assessedCount = 0;

        subjects.forEach((subject) => {
            const entry = bySubj.get(subject);
            if (!entry) {
                scores[subject] = [null, null, null];
                averages[subject] = null;
                papersBySubject[subject] = {};
                return;
            }
            scores[subject] = entry.assessmentScores;
            papersBySubject[subject] = entry.papers || {};
            const valid = entry.assessmentScores.filter((v) => v != null);
            if (valid.length > 0) {
                const avg = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
                averages[subject] = avg;
                sumOfAverages += avg;
                assessedCount++;
            } else {
                averages[subject] = null;
            }
        });

        const meanOfAssessed = assessedCount > 0
            ? Math.round(sumOfAverages / assessedCount) : 0;

        return {
            ...student, scores, averages,
            papersBySubject,
            assessedCount,
            totalSubjects: subjects.length,
            overallAverage: meanOfAssessed,
        };
    });

    // Rank within the class (or within the single-student set).
    const ranked = [...enriched].sort(
        (a, b) => (b.overallAverage || 0) - (a.overallAverage || 0)
    );
    const rankMap = new Map();
    let lastAvg = null;
    let lastRank = 0;
    ranked.forEach((s, idx) => {
        const avg = s.overallAverage || 0;
        if (lastAvg !== null && avg === lastAvg) {
            rankMap.set(s.id, lastRank);
        } else {
            lastRank = idx + 1;
            rankMap.set(s.id, lastRank);
        }
        lastAvg = avg;
    });

    return enriched.map((s) => ({
        ...s,
        position: rankMap.get(s.id) || null,
        classSize: enriched.length,
    }));
}

export default function StudentReports() {
    const { userData, userRole } = useAuth();
    const { getLevelClasses, schoolData } = useSchool();

    const isStudent = normalizeRole(userRole || userData?.role) === 'student';

    // ---- Admin picker state ----
    const [selectedLevel, setSelectedLevel] = useState('');
    const [selectedClass, setSelectedClass] = useState('');
    const [selectedTerm, setSelectedTerm] = useState('2');

    // ---- Data ----
    const [students, setStudents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

    // ---- Student self-service ----
    const [studentRecord, setStudentRecord] = useState(null);      // student doc
    const [studentLoaded, setStudentLoaded] = useState(false);
    const [studentEnriched, setStudentEnriched] = useState(null);  // enriched single record

    // ---- Preview ----
    const [previewStudent, setPreviewStudent] = useState(null);
    const [previewAssessment, setPreviewAssessment] = useState(0);

    // ---- Branding ----
    const [paperConfigsRaw, setPaperConfigsRaw] = useState({});
    const [classTeacherName, setClassTeacherName] = useState('');
    const [headTeacherName, setHeadTeacherName] = useState('');

    // =========================================================
    // Derived values
    // =========================================================
    const subjects = useMemo(() => {
        if (isStudent) {
            return LEVEL_SUBJECTS[studentRecord?.level] || [];
        }
        return LEVEL_SUBJECTS[selectedLevel] || [];
    }, [isStudent, studentRecord?.level, selectedLevel]);

    const classOptions = useMemo(
        () => resolveClassList(selectedLevel, getLevelClasses),
        [selectedLevel, getLevelClasses]
    );

    const schoolBranding = useMemo(() => ({
        schoolName: userData?.schoolName || schoolData?.schoolName || 'EDUPRIVA',
        schoolMotto: userData?.schoolMotto || schoolData?.motto || 'Powering Modern Education',
        schoolLogo: userData?.schoolLogo || schoolData?.logoUrl || '',
        schoolAddress: userData?.schoolAddress || schoolData?.address || '',
        schoolPhone: userData?.schoolPhone || schoolData?.phone || '',
        schoolEmail: userData?.schoolEmail || schoolData?.email || '',
        website: userData?.website || schoolData?.website || '',
        schoolCode: userData?.schoolCode || schoolData?.schoolCode || '',
        schoolStamp: userData?.schoolStamp || schoolData?.stampUrl || '',
        principalSignature:
            userData?.principalSignature
            || schoolData?.principalSignatureUrl
            || '',
        principalName: userData?.principalName || schoolData?.principalName || '',
        currentTermStart: schoolData?.termStart || userData?.currentTermStart || '',
        currentTermEnd: schoolData?.currentTermEnd || userData?.currentTermEnd || '',
        nextTermStart: schoolData?.nextTermStart || userData?.nextTermStart || '',
        year: new Date().getFullYear(),
    }), [userData, schoolData]);

    const sortedStudents = useMemo(
        () => [...students].sort((a, b) => (b.overallAverage || 0) - (a.overallAverage || 0)),
        [students]
    );

    const ready = isStudent
        ? !!studentEnriched
        : students.length > 0;

    const showNotification = useCallback((message, type = 'info') => {
        showAppNotice(message, type);
    }, []);

    const paperConfigBySubject = useMemo(() => {
        const out = {};
        Object.entries(paperConfigsRaw).forEach(([subject, cfg]) => {
            if (
                cfg &&
                cfg.showBranchesOnReport &&
                Array.isArray(cfg.papers) &&
                cfg.papers.length > 0
            ) {
                out[subject] = cfg.papers;
            }
        });
        return out;
    }, [paperConfigsRaw]);

    const effectiveTerm = isStudent
        ? String(userData?.currentTerm || selectedTerm)
        : selectedTerm;

    const buildMeta = useCallback(() => ({
        ...schoolBranding,
        level: isStudent ? studentRecord?.level : selectedLevel,
        levelDisplay: LEVEL_DISPLAY_NAMES[isStudent ? studentRecord?.level : selectedLevel]
            || (isStudent ? studentRecord?.level : selectedLevel),
        cls: isStudent ? studentRecord?.class : selectedClass,
        term: `Term ${effectiveTerm}`,
        year: new Date().getFullYear(),
        classTeacherName: classTeacherName || '',
        headTeacherName: headTeacherName || schoolBranding.principalName || '',
        principalName: headTeacherName || schoolBranding.principalName || '',
        stampUrl: schoolBranding.schoolStamp || '',
        principalSignatureUrl: schoolBranding.principalSignature || '',
        paperConfigBySubject,
    }), [
        schoolBranding, isStudent, studentRecord, selectedLevel, selectedClass,
        effectiveTerm, classTeacherName, headTeacherName, paperConfigBySubject,
    ]);

    // =========================================================
    // Load paper configs
    // =========================================================
    useEffect(() => {
        let cancelled = false;
        const schoolId = userData?.schoolId;
        const levelForConfigs = isStudent ? studentRecord?.level : selectedLevel;
        if (!schoolId || !levelForConfigs) { setPaperConfigsRaw({}); return; }
        (async () => {
            try {
                const raw = (await getAllPaperConfigsForLevel(schoolId, levelForConfigs)) || {};
                const normalised = {};
                Object.entries(raw).forEach(([subject, val]) => {
                    if (Array.isArray(val)) {
                        normalised[subject] = { papers: val, showBranchesOnReport: false };
                    } else if (val && typeof val === 'object') {
                        normalised[subject] = {
                            papers: Array.isArray(val.papers) ? val.papers : [],
                            showBranchesOnReport: !!val.showBranchesOnReport,
                        };
                    }
                });
                if (!cancelled) setPaperConfigsRaw(normalised);
            } catch (e) {
                console.warn('Failed to load paper configs:', e);
                if (!cancelled) setPaperConfigsRaw({});
            }
        })();
        return () => { cancelled = true; };
    }, [userData?.schoolId, isStudent, studentRecord?.level, selectedLevel]);

    // =========================================================
    // Class teacher name
    // =========================================================
    useEffect(() => {
        let cancelled = false;
        async function resolve() {
            const schoolId = userData?.schoolId;
            const cls = isStudent ? studentRecord?.class : selectedClass;
            if (!schoolId || !cls) { setClassTeacherName(''); return; }
            try {
                const map = schoolData?.classTeachers || {};
                const teacherUid = map[cls];
                if (!teacherUid) { setClassTeacherName(''); return; }
                const snaps = await Promise.all([
                    getDocs(query(collection(db, 'users'), where('uid', '==', teacherUid), limit(1))),
                ]);
                if (cancelled) return;
                let doc = snaps[0].docs[0];
                if (!doc) {
                    const alt = await getDocs(query(collection(db, 'users'), where('id', '==', teacherUid), limit(1)));
                    if (cancelled) return;
                    doc = alt.docs[0];
                }
                setClassTeacherName(doc ? userDisplayName(doc.data()) : '');
            } catch (e) {
                console.warn('Could not resolve class teacher:', e?.message || e);
            }
        }
        resolve();
        return () => { cancelled = true; };
    }, [isStudent, studentRecord?.class, selectedClass, schoolData?.classTeachers, userData?.schoolId]);

    // =========================================================
    // Head teacher / principal
    // =========================================================
    useEffect(() => {
        let cancelled = false;
        async function resolve() {
            const schoolId = userData?.schoolId;
            if (!schoolId) { setHeadTeacherName(''); return; }
            try {
                const snap = await getDocs(query(
                    collection(db, 'users'),
                    where('schoolId', '==', schoolId),
                    where('role', 'in', HEAD_TEACHER_ROLES),
                    limit(1)
                ));
                if (cancelled) return;
                if (!snap.empty) {
                    setHeadTeacherName(userDisplayName(snap.docs[0].data()));
                } else {
                    setHeadTeacherName(schoolData?.principalName || '');
                }
            } catch (e) {
                console.warn('Could not resolve head teacher:', e?.message || e);
                if (!cancelled) setHeadTeacherName(schoolData?.principalName || '');
            }
        }
        resolve();
        return () => { cancelled = true; };
    }, [userData?.schoolId, schoolData?.principalName]);

    // =========================================================
    // STUDENT BOOTSTRAP — auto-load own record
    // =========================================================
    useEffect(() => {
        if (!isStudent) return;
        const schoolId = userData?.schoolId;
        const email = userData?.email;
        if (!schoolId || !email) return;

        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                // Find the student's own doc by email (matching login).
                const snap = await getDocs(query(
                    collection(db, 'students'),
                    where('schoolId', '==', schoolId),
                    where('email', '==', email),
                    limit(1)
                ));
                if (cancelled) return;
                if (snap.empty) {
                    showNotification('Your student record was not found. Please contact the school office.', 'error');
                    return;
                }
                const docData = snap.docs[0];
                const student = { id: docData.id, ...docData.data() };
                setStudentRecord(student);

                const termName = `Term ${userData?.currentTerm || 2}`;
                const subjectList = LEVEL_SUBJECTS[student.level] || [];
                const enriched = await buildEnrichedStudents({
                    schoolId,
                    level: student.level,
                    cls: student.class,
                    termName,
                    subjects: subjectList,
                    studentFilterIds: [student.id],
                });
                if (cancelled) return;
                if (enriched.length > 0) {
                    setStudentEnriched(enriched[0]);
                } else {
                    setStudentEnriched({
                        ...student,
                        scores: {},
                        averages: {},
                        papersBySubject: {},
                        assessedCount: 0,
                        totalSubjects: subjectList.length,
                        overallAverage: 0,
                        position: null,
                        classSize: 1,
                    });
                }
                setStudentLoaded(true);
            } catch (err) {
                console.error('Failed to load own student record:', err);
                showNotification('Failed to load your record: ' + err.message, 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isStudent, userData?.schoolId, userData?.email]);

    // =========================================================
    // ADMIN: load students for a class
    // =========================================================
    const loadStudents = useCallback(async () => {
        if (!selectedLevel || !selectedClass) {
            showNotification('Please select level and class', 'warning');
            return;
        }
        const schoolId = userData?.schoolId;
        if (!schoolId) {
            showNotification('School context missing', 'error');
            return;
        }

        setLoading(true);
        try {
            const termName = `Term ${selectedTerm}`;
            const result = await buildEnrichedStudents({
                schoolId,
                level: selectedLevel,
                cls: selectedClass,
                termName,
                subjects,
            });
            if (result.length === 0) {
                showNotification('No students found for this class', 'warning');
                setStudents([]);
                setHasLoadedOnce(true);
                return;
            }
            setStudents(result);
            setHasLoadedOnce(true);
            showNotification(`Loaded ${result.length} students`, 'success');
        } catch (err) {
            console.error('loadStudents failed:', err);
            showNotification('Failed to load: ' + err.message, 'error');
        } finally {
            setLoading(false);
        }
    }, [selectedLevel, selectedClass, selectedTerm, subjects, userData?.schoolId, showNotification]);

    useEffect(() => {
        if (!isStudent && hasLoadedOnce && selectedLevel && selectedClass) loadStudents();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedLevel, selectedClass, selectedTerm]);

    const resetSelection = () => {
        setSelectedLevel('');
        setSelectedClass('');
        setStudents([]);
        setHasLoadedOnce(false);
    };

    // =========================================================
    // Generators
    // =========================================================
    const handleDownloadTranscripts = useCallback(async (assessmentIndex) => {
        if (students.length === 0) {
            showNotification('Load students first', 'warning');
            return;
        }
        setGenerating(true);
        try {
            await downloadTranscripts({
                students, meta: buildMeta(), subjects,
                term: `Term ${selectedTerm}`, assessmentIndex,
            });
            showNotification(
                `Transcripts (Assessment ${assessmentIndex + 1}) downloaded — 4 per page`,
                'success'
            );
        } catch (err) {
            console.error('transcripts failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [students, buildMeta, subjects, selectedTerm, showNotification]);

    const handleDownloadClassReports = useCallback(async () => {
        if (students.length === 0) {
            showNotification('Load students first', 'warning');
            return;
        }
        setGenerating(true);
        try {
            await downloadClassReportForms({
                students, meta: buildMeta(), subjects, term: `Term ${selectedTerm}`,
            });
            showNotification(`Report forms generated (${students.length} pages)`, 'success');
        } catch (err) {
            console.error('class reports failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [students, buildMeta, subjects, selectedTerm, showNotification]);

    const handleDownloadSingleForm = useCallback(async (student) => {
        setGenerating(true);
        try {
            await downloadStudentReportForm({
                student, meta: buildMeta(), subjects, term: `Term ${effectiveTerm}`,
            });
            showNotification('Report form downloaded', 'success');
        } catch (err) {
            console.error('single form failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [buildMeta, subjects, effectiveTerm, showNotification]);

    const handleDownloadSingleTranscript = useCallback(async (student, assessmentIndex) => {
        setGenerating(true);
        try {
            await downloadTranscripts({
                students: [student], meta: buildMeta(), subjects,
                term: `Term ${effectiveTerm}`, assessmentIndex,
            });
            showNotification('Transcript downloaded', 'success');
        } catch (err) {
            console.error('single transcript failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [buildMeta, subjects, effectiveTerm, showNotification]);

    // ---- STUDENT: download own report form ----
    const handleDownloadMyReport = useCallback(async () => {
        if (!studentEnriched) {
            showNotification('Your record is still loading...', 'warning');
            return;
        }
        setGenerating(true);
        try {
            await downloadStudentReportForm({
                student: studentEnriched,
                meta: buildMeta(),
                subjects,
                term: `Term ${effectiveTerm}`,
            });
            showNotification('Your report form has been downloaded', 'success');
        } catch (err) {
            console.error('own report failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [studentEnriched, buildMeta, subjects, effectiveTerm, showNotification]);

    // ---- STUDENT: download own transcript ----
    const handleDownloadMyTranscript = useCallback(async (assessmentIndex) => {
        if (!studentEnriched) {
            showNotification('Your record is still loading...', 'warning');
            return;
        }
        setGenerating(true);
        try {
            await downloadTranscripts({
                students: [studentEnriched],
                meta: buildMeta(),
                subjects,
                term: `Term ${effectiveTerm}`,
                assessmentIndex,
            });
            showNotification(`Transcript (Assessment ${assessmentIndex + 1}) downloaded`, 'success');
        } catch (err) {
            console.error('own transcript failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [studentEnriched, buildMeta, subjects, effectiveTerm, showNotification]);

    const handleDownloadTemplate = useCallback(async () => {
        setGenerating(true);
        try {
            await downloadClassReportForms({
                students: [SAMPLE_STUDENT],
                meta: {
                    ...schoolBranding,
                    level: 'junior-school',
                    levelDisplay: 'Junior School',
                    cls: 'Grade 7', term: 'Term 2',
                    year: new Date().getFullYear(),
                    classTeacherName: '',
                    headTeacherName: '',
                    principalName: '',
                    stampUrl: schoolBranding.schoolStamp || '',
                    principalSignatureUrl: schoolBranding.principalSignature || '',
                    paperConfigBySubject: {},
                },
                subjects: SAMPLE_SUBJECTS,
                term: 'Term 2',
            });
            showNotification('Template downloaded', 'success');
        } catch (err) {
            console.error('template failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [schoolBranding, showNotification]);

    // =========================================================
    // Early return
    // =========================================================
    if (loading && !hasLoadedOnce && !studentLoaded) {
        return <LoadingSpinner fullScreen text="Loading..." />;
    }

    // =========================================================
    // STUDENT VIEW
    // =========================================================
    if (isStudent) {
        const me = studentEnriched;
        return (
            <Layout title="My Report Form">
                {!me ? (
                    <LoadingSpinner fullScreen text="Loading your results..." />
                ) : (
                    <>
                        {/* Header card */}
                        <div style={{
                            background: 'linear-gradient(135deg, #1a237e, #3949ab)',
                            color: 'white', borderRadius: 16, padding: 24,
                            marginBottom: 20, display: 'flex', gap: 20,
                            alignItems: 'center', flexWrap: 'wrap',
                        }}>
                            <div style={{
                                width: 64, height: 64, borderRadius: 16,
                                background: 'rgba(255,255,255,0.18)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 24, fontWeight: 700,
                            }}>
                                {`${me.firstName?.[0] || ''}${me.lastName?.[0] || ''}`.toUpperCase() || 'S'}
                            </div>
                            <div style={{ flex: 1, minWidth: 200 }}>
                                <div style={{ fontSize: 13, opacity: 0.85, letterSpacing: 0.5, fontWeight: 600 }}>
                                    MY CBC REPORT FORM
                                </div>
                                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
                                    {me.firstName} {me.lastName}
                                </div>
                                <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4 }}>
                                    {me.admissionNumber || me.studentId || '—'}
                                    {' · '}{me.class || '—'}
                                    {' · '}Term {effectiveTerm}
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{
                                    background: 'rgba(255,255,255,0.18)', padding: '6px 12px',
                                    borderRadius: 20, fontSize: 12, fontWeight: 700,
                                }}>
                                    Avg {me.overallAverage || 0}%
                                </span>
                                <span style={{
                                    background: 'rgba(255,255,255,0.18)', padding: '6px 12px',
                                    borderRadius: 20, fontSize: 12, fontWeight: 700,
                                }}>
                                    CBC {getCBCGrade(me.overallAverage || 0).code}
                                </span>
                                {me.position && (
                                    <span style={{
                                        background: 'rgba(255,255,255,0.18)', padding: '6px 12px',
                                        borderRadius: 20, fontSize: 12, fontWeight: 700,
                                    }}>
                                        Pos {me.position} / {me.classSize}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Download actions */}
                        <div style={actionsCardStyle}>
                            <div>
                                <h3 style={sectionTitleStyle}>
                                    <i className="fas fa-file-pdf" style={{ color: PRIMARY }}></i>{' '}
                                    Download My Documents
                                </h3>
                                <p style={sectionHintStyle}>
                                    Choose the format you want to print or share.
                                </p>
                            </div>

                            <div style={actionGridStyle}>
                                <DocButton
                                    icon="fa-file-pdf"
                                    title="My Full Report Form"
                                    subtitle="Full term report — best for printing"
                                    disabled={generating}
                                    onClick={handleDownloadMyReport}
                                    color="#27ae60"
                                />
                                <DocButton
                                    icon="fa-file-alt"
                                    title="Assessment 1 Transcript"
                                    subtitle="Snapshot of A1 results"
                                    disabled={generating}
                                    onClick={() => handleDownloadMyTranscript(0)}
                                    color="#f39c12"
                                />
                                <DocButton
                                    icon="fa-file-alt"
                                    title="Assessment 2 Transcript"
                                    subtitle="Snapshot of A2 results"
                                    disabled={generating}
                                    onClick={() => handleDownloadMyTranscript(1)}
                                    color="#e67e22"
                                />
                                <DocButton
                                    icon="fa-file-alt"
                                    title="Assessment 3 Transcript"
                                    subtitle="Snapshot of A3 results"
                                    disabled={generating}
                                    onClick={() => handleDownloadMyTranscript(2)}
                                    color="#d35400"
                                />
                            </div>
                        </div>

                        {/* Preview */}
                        <div style={{ marginTop: 24 }}>
                            <h3 style={{ ...sectionTitleStyle, marginBottom: 14 }}>
                                Preview
                            </h3>
                            <div style={{ ...cardStyle, cursor: 'default', flexWrap: 'wrap' }}>
                                <div style={{ flex: 1, minWidth: 240 }}>
                                    <div style={{ fontWeight: 700, fontSize: 15, color: '#2c3e50' }}>
                                        Term {effectiveTerm} Summary
                                    </div>
                                    <div style={{ fontSize: 12, color: '#95a5a6', marginTop: 2 }}>
                                        {me.assessedCount} of {me.totalSubjects} subjects assessed
                                    </div>
                                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                                        <Pill color={PRIMARY}>Avg {me.overallAverage || 0}%</Pill>
                                        <Pill color={gradeColor(getCBCGrade(me.overallAverage || 0).level)}>
                                            {getCBCGrade(me.overallAverage || 0).code}
                                        </Pill>
                                    </div>
                                </div>
                                <button
                                    onClick={() => { setPreviewStudent(me); setPreviewAssessment(0); }}
                                    style={primaryBtn}
                                >
                                    <i className="fas fa-eye"></i> Open Preview
                                </button>
                            </div>
                        </div>
                    </>
                )}

                {previewStudent && (
                    <PreviewModal
                        student={previewStudent}
                        subjects={subjects}
                        term={`Term ${effectiveTerm}`}
                        meta={buildMeta()}
                        assessmentIndex={previewAssessment}
                        onAssessmentChange={setPreviewAssessment}
                        onClose={() => setPreviewStudent(null)}
                        onDownloadForm={() => handleDownloadSingleForm(previewStudent)}
                        onDownloadTranscript={() => handleDownloadSingleTranscript(previewStudent, previewAssessment)}
                        generating={generating}
                    />
                )}

                {generating && <GeneratingOverlay />}

                <style>{`
                    @keyframes spin { to { transform: rotate(360deg); } }
                    .doc-btn:hover:not(:disabled) {
                        transform: translateY(-2px);
                        box-shadow: 0 10px 22px rgba(26,35,126,0.15);
                    }
                    .doc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
                `}</style>
            </Layout>
        );
    }

    // =========================================================
    // ADMIN VIEW (unchanged)
    // =========================================================
    return (
        <Layout title="Student Report Forms (CBC)">
            <div style={filterBarStyle}>
                <Field label="Level" required>
                    <select value={selectedLevel} onChange={(e) => {
                        setSelectedLevel(e.target.value);
                        setSelectedClass(''); setStudents([]); setHasLoadedOnce(false);
                    }} style={selectStyle}>
                        <option value="">Select Level</option>
                        {Object.entries(LEVEL_DISPLAY_NAMES).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                        ))}
                    </select>
                </Field>

                <Field label="Class" required>
                    <select value={selectedClass} disabled={!selectedLevel}
                        onChange={(e) => {
                            setSelectedClass(e.target.value); setStudents([]); setHasLoadedOnce(false);
                        }} style={selectStyle}>
                        <option value="">Select Class</option>
                        {classOptions.map((c) => (
                            <option key={c} value={c}>{c}</option>
                        ))}
                    </select>
                </Field>

                <Field label="Term" required>
                    <select value={selectedTerm}
                        onChange={(e) => setSelectedTerm(e.target.value)} style={selectStyle}>
                        <option value="1">Term 1</option>
                        <option value="2">Term 2</option>
                        <option value="3">Term 3</option>
                    </select>
                </Field>

                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                    <button onClick={loadStudents} disabled={loading || !selectedLevel || !selectedClass}
                        style={{ ...primaryBtn, opacity: (!selectedLevel || !selectedClass) ? 0.5 : 1 }}>
                        <i className="fas fa-users"></i> {loading ? 'Loading...' : 'Load Students'}
                    </button>
                    <button onClick={resetSelection} style={ghostBtn}>
                        <i className="fas fa-redo"></i> Reset
                    </button>
                </div>
            </div>

            <div style={actionsCardStyle}>
                <div>
                    <h3 style={sectionTitleStyle}>
                        <i className="fas fa-file-pdf" style={{ color: PRIMARY }}></i> Generate Documents
                    </h3>
                    <p style={sectionHintStyle}>
                        {ready
                            ? `${students.length} students ready. Choose a document type below.`
                            : 'Load students to enable generation.'}
                    </p>
                </div>

                <div style={actionGridStyle}>
                    <DocButton
                        icon="fa-file-alt"
                        title="Transcript — Assessment 1"
                        subtitle="4 per page"
                        disabled={!ready || generating}
                        onClick={() => handleDownloadTranscripts(0)}
                        color="#f39c12"
                    />
                    <DocButton
                        icon="fa-file-alt"
                        title="Transcript — Assessment 2"
                        subtitle="4 per page"
                        disabled={!ready || generating}
                        onClick={() => handleDownloadTranscripts(1)}
                        color="#e67e22"
                    />
                    <DocButton
                        icon="fa-file-alt"
                        title="Transcript — Assessment 3"
                        subtitle="4 per page"
                        disabled={!ready || generating}
                        onClick={() => handleDownloadTranscripts(2)}
                        color="#d35400"
                    />
                    <DocButton
                        icon="fa-file-alt"
                        title="Report Form — All 3 Assessments"
                        subtitle="1 student per page"
                        disabled={!ready || generating}
                        onClick={handleDownloadClassReports}
                        color={PRIMARY}
                    />
                    <DocButton
                        icon="fa-file"
                        title="Download Template"
                        subtitle="Blank sample"
                        disabled={generating}
                        onClick={handleDownloadTemplate}
                        color="#7f8c8d"
                    />
                </div>
            </div>

            <div style={{ marginTop: 24 }}>
                {students.length === 0 ? (
                    <EmptyState />
                ) : (
                    <>
                        <h3 style={{ ...sectionTitleStyle, marginBottom: 14 }}>
                            Students ({students.length})
                        </h3>
                        <div style={gridStyle}>
                            {sortedStudents.map((student) => (
                                <StudentCard
                                    key={student.id}
                                    student={student}
                                    onPreview={() => { setPreviewStudent(student); setPreviewAssessment(0); }}
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>

            {previewStudent && (
                <PreviewModal
                    student={previewStudent}
                    subjects={subjects}
                    term={`Term ${selectedTerm}`}
                    meta={buildMeta()}
                    assessmentIndex={previewAssessment}
                    onAssessmentChange={setPreviewAssessment}
                    onClose={() => setPreviewStudent(null)}
                    onDownloadForm={() => handleDownloadSingleForm(previewStudent)}
                    onDownloadTranscript={() => handleDownloadSingleTranscript(previewStudent, previewAssessment)}
                    generating={generating}
                />
            )}

            {generating && <GeneratingOverlay />}

            <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
                .student-card:hover {
                    transform: translateY(-3px);
                    box-shadow: 0 14px 30px rgba(26,35,126,0.12) !important;
                    border-color: ${PRIMARY} !important;
                }
                .doc-btn:hover:not(:disabled) {
                    transform: translateY(-2px);
                    box-shadow: 0 10px 22px rgba(26,35,126,0.15);
                }
                .doc-btn:disabled { opacity: 0.45; cursor: not-allowed; }
                select:focus { outline: none; border-color: ${PRIMARY} !important; }
            `}</style>
        </Layout>
    );
}

// ============================================================
// Sub-components (unchanged)
// ============================================================
function Field({ label, required, children }) {
    return (
        <div style={{ flex: 1, minWidth: 160 }}>
            <label style={labelStyle}>
                {label} {required && <span style={{ color: '#e74c3c' }}>*</span>}
            </label>
            {children}
        </div>
    );
}

function DocButton({ icon, title, subtitle, onClick, disabled, color }) {
    return (
        <button
            className="doc-btn"
            onClick={onClick}
            disabled={disabled}
            style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 16px',
                background: 'white',
                border: `1.5px solid ${color}22`,
                borderRadius: 12,
                cursor: disabled ? 'not-allowed' : 'pointer',
                textAlign: 'left',
                transition: 'all 0.2s',
                boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
                width: '100%',
            }}
        >
            <div style={{
                width: 38, height: 38, borderRadius: 10,
                background: `${color}15`, color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, flexShrink: 0,
            }}>
                <i className={`fas ${icon}`}></i>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#2c3e50' }}>
                    {title}
                </div>
                <div style={{ fontSize: 11, color: '#95a5a6' }}>{subtitle}</div>
            </div>
        </button>
    );
}

function StudentCard({ student, onPreview }) {
    const avg = student.overallAverage || 0;
    const grade = getCBCGrade(avg);
    const coverage = `${student.assessedCount} / ${student.totalSubjects}`;
    const initials = `${student.firstName?.[0] || ''}${student.lastName?.[0] || ''}`.toUpperCase() || 'S';

    return (
        <div className="student-card" onClick={onPreview} style={cardStyle}>
            <div style={avatarStyle}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#2c3e50',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {student.firstName} {student.lastName}
                </div>
                <div style={{ fontSize: 12, color: '#95a5a6', marginTop: 2 }}>
                    {student.admissionNumber || student.studentId || 'N/A'}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <Pill color={PRIMARY}>Avg {avg}%</Pill>
                    <Pill color={gradeColor(grade.level)}>CBC {grade.code}</Pill>
                    {student.position && (
                        <Pill color="#8e44ad">Pos {student.position}/{student.classSize}</Pill>
                    )}
                    <Pill color="#95a5a6">Assessed {coverage}</Pill>
                </div>
            </div>
            <i className="fas fa-chevron-right" style={{ color: '#bdc3c7' }}></i>
        </div>
    );
}

function Pill({ color, children }) {
    return (
        <span style={{
            fontSize: 10, fontWeight: 700, padding: '3px 8px',
            borderRadius: 10, background: `${color}15`, color,
            letterSpacing: 0.2,
        }}>{children}</span>
    );
}

function gradeColor(level) {
    return level === 'EE' ? '#1b5e20'
        : level === 'ME' ? '#0c5460'
        : level === 'AE' ? '#856404'
        : level === 'NA' ? '#95a5a6'
        : '#721c24';
}

function EmptyState() {
    return (
        <div style={{
            background: 'white', borderRadius: 16,
            padding: '60px 20px', textAlign: 'center',
            border: '2px dashed #e0e6ed',
        }}>
            <i className="fas fa-file-alt" style={{
                fontSize: 56, color: '#e0e6ed', marginBottom: 16, display: 'block',
            }}></i>
            <h3 style={{ fontSize: 18, color: '#2c3e50', marginBottom: 8 }}>
                No Students Loaded
            </h3>
            <p style={{ color: '#95a5a6', maxWidth: 420, margin: '0 auto' }}>
                Select a level, class, and term above, then click <strong>Load Students</strong>.
            </p>
        </div>
    );
}

function GeneratingOverlay() {
    return (
        <div style={{
            position: 'fixed', inset: 0, background: 'rgba(255,255,255,0.9)',
            zIndex: 9999, display: 'flex', alignItems: 'center',
            justifyContent: 'center', flexDirection: 'column', gap: 20,
        }}>
            <div style={{
                width: 54, height: 54, border: '4px solid #e0e6ed',
                borderTopColor: PRIMARY, borderRadius: '50%',
                animation: 'spin 0.9s linear infinite',
            }}></div>
            <div style={{ color: '#2c3e50', fontWeight: 600, fontSize: 15 }}>
                Generating PDF...
            </div>
        </div>
    );
}

function PreviewModal({
    student, subjects, term, meta,
    assessmentIndex, onAssessmentChange,
    onClose, onDownloadForm, onDownloadTranscript, generating,
}) {
    const overall = getCBCGrade(student.overallAverage || 0);

    return (
        <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
            <div style={modalStyle}>
                <div style={modalHeaderStyle}>
                    <div>
                        <div style={{ fontSize: 12, color: '#bdc3c7', fontWeight: 600, letterSpacing: 0.5 }}>
                            CBC REPORT PREVIEW
                        </div>
                        <h2 style={{ fontSize: 20, color: '#2c3e50', margin: '4px 0 0' }}>
                            {student.firstName} {student.lastName}
                        </h2>
                    </div>
                    <button onClick={onClose} style={closeBtnStyle}>
                        <i className="fas fa-times"></i>
                    </button>
                </div>

                <div style={tabBarStyle}>
                    {ASSESSMENTS.map((a) => (
                        <button key={a.index}
                            onClick={() => onAssessmentChange(a.index)}
                            style={{
                                ...tabStyle,
                                background: assessmentIndex === a.index ? PRIMARY : 'transparent',
                                color: assessmentIndex === a.index ? 'white' : '#666',
                            }}>
                            {a.label}
                        </button>
                    ))}
                </div>

                <div style={infoGridStyle}>
                    <InfoCell label="Admission">{student.admissionNumber || student.studentId || '—'}</InfoCell>
                    <InfoCell label="Class">{student.class || meta.cls}</InfoCell>
                    <InfoCell label="Term">{term}</InfoCell>
                    <InfoCell label="Assessed">
                        {student.assessedCount} / {student.totalSubjects}
                    </InfoCell>
                    <InfoCell label="Overall Position">
                        {student.position ? `${student.position} / ${student.classSize}` : '—'}
                    </InfoCell>
                    <InfoCell label="Overall">
                        <Pill color={gradeColor(overall.level)}>
                            {overall.code} • {overall.points != null ? overall.points.toFixed(1) : '—'} pts
                        </Pill>
                    </InfoCell>
                </div>

                <div style={{ overflowX: 'auto' }}>
                    <table style={tableStyle}>
                        <thead>
                            <tr style={{ background: PRIMARY, color: 'white' }}>
                                <th style={th}>Subject</th>
                                <th style={th}>A1</th>
                                <th style={th}>A2</th>
                                <th style={th}>A3</th>
                                <th style={th}>Avg</th>
                                <th style={th}>CBC</th>
                                <th style={th}>Pts</th>
                            </tr>
                        </thead>
                        <tbody>
                            {subjects.map((subject, idx) => {
                                const list = student.scores[subject] || [];
                                const avg = student.averages[subject];
                                const g = getCBCGrade(avg ?? 0);
                                return (
                                    <tr key={subject} style={{
                                        background: idx % 2 ? '#fafbfc' : 'white',
                                        borderBottom: '1px solid #eef1f5',
                                    }}>
                                        <td style={td}>{subject}</td>
                                        <td style={tdC}>{list[0] ?? '—'}</td>
                                        <td style={tdC}>{list[1] ?? '—'}</td>
                                        <td style={tdC}>{list[2] ?? '—'}</td>
                                        <td style={{ ...tdC, fontWeight: 700 }}>
                                            {avg != null ? avg : 'N/A'}
                                        </td>
                                        <td style={tdC}>
                                            {avg != null ? (
                                                <Pill color={gradeColor(g.level)}>{g.code}</Pill>
                                            ) : '—'}
                                        </td>
                                        <td style={{ ...tdC, fontWeight: 700, color: PRIMARY }}>
                                            {avg != null ? g.points.toFixed(1) : '—'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                <div style={modalFooterStyle}>
                    <button onClick={onClose} style={ghostBtn}>Close</button>
                    <button onClick={onDownloadTranscript} disabled={generating}
                        style={{ ...primaryBtn, background: '#e67e22' }}>
                        <i className="fas fa-scissors"></i> Transcript (A{assessmentIndex + 1})
                    </button>
                    <button onClick={onDownloadForm} disabled={generating}
                        style={{ ...primaryBtn, background: '#27ae60' }}>
                        <i className="fas fa-file-pdf"></i> Full Report Form
                    </button>
                </div>
            </div>
        </div>
    );
}

function InfoCell({ label, children }) {
    return (
        <div>
            <div style={{
                fontSize: 10, color: '#95a5a6', fontWeight: 600,
                letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 4,
            }}>{label}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#2c3e50' }}>{children}</div>
        </div>
    );
}

// ============================================================
// Styles
// ============================================================
const PRIMARY = '#1a237e';

const filterBarStyle = {
    background: 'white', borderRadius: 16, padding: 22,
    boxShadow: '0 4px 12px rgba(0,0,0,0.05)', marginBottom: 20,
    display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap',
};

const actionsCardStyle = {
    background: 'white', borderRadius: 16, padding: 22,
    boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
};

const actionGridStyle = {
    marginTop: 16,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: 12,
};

const sectionTitleStyle = {
    fontSize: 16, fontWeight: 700, color: '#2c3e50',
    margin: 0, display: 'flex', alignItems: 'center', gap: 8,
};

const sectionHintStyle = {
    fontSize: 13, color: '#95a5a6', margin: '4px 0 0',
};

const gridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: 14,
};

const cardStyle = {
    background: 'white',
    borderRadius: 14,
    padding: 16,
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
    border: '1.5px solid transparent',
    display: 'flex', alignItems: 'center', gap: 14,
    cursor: 'pointer', transition: 'all 0.2s',
};

const avatarStyle = {
    width: 46, height: 46, borderRadius: 12,
    background: `linear-gradient(135deg, ${PRIMARY}, #3949ab)`,
    color: 'white', fontWeight: 700, fontSize: 15,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, letterSpacing: 0.5,
};

const labelStyle = {
    display: 'block', fontSize: 12, fontWeight: 700,
    color: '#2c3e50', marginBottom: 6,
    textTransform: 'uppercase', letterSpacing: 0.4,
};

const selectStyle = {
    width: '100%', padding: '10px 14px',
    border: '2px solid #e0e6ed', borderRadius: 10,
    fontSize: 14, background: 'white', color: '#2c3e50',
    cursor: 'pointer', transition: 'border 0.2s',
};

const primaryBtn = {
    padding: '10px 18px', border: 'none', borderRadius: 10,
    fontWeight: 700, cursor: 'pointer', fontSize: 13,
    display: 'inline-flex', alignItems: 'center', gap: 8,
    background: PRIMARY, color: 'white',
    transition: 'all 0.2s',
};

const ghostBtn = {
    padding: '10px 18px', border: '2px solid #e0e6ed',
    borderRadius: 10, fontWeight: 700, cursor: 'pointer',
    fontSize: 13, background: 'transparent', color: '#2c3e50',
    display: 'inline-flex', alignItems: 'center', gap: 8,
};

const overlayStyle = {
    position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
    zIndex: 1000, display: 'flex', alignItems: 'center',
    justifyContent: 'center', padding: 20,
};

const modalStyle = {
    background: 'white', borderRadius: 18, maxWidth: 900,
    width: '100%', maxHeight: '92vh', overflowY: 'auto', padding: 26,
};

const modalHeaderStyle = {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 18,
};

const closeBtnStyle = {
    width: 38, height: 38, border: 'none', borderRadius: '50%',
    background: '#f5f7fb', cursor: 'pointer', fontSize: 16,
    color: '#666',
};

const tabBarStyle = {
    display: 'flex', gap: 6, padding: 4, background: '#f5f7fb',
    borderRadius: 12, marginBottom: 18,
};

const tabStyle = {
    flex: 1, padding: '8px 12px', border: 'none',
    borderRadius: 9, fontWeight: 700, fontSize: 12,
    cursor: 'pointer', transition: 'all 0.2s',
};

const infoGridStyle = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 14, padding: 16, background: '#f8f9fb',
    borderRadius: 12, marginBottom: 18,
};

const tableStyle = {
    width: '100%', borderCollapse: 'collapse', fontSize: 12.5,
    borderRadius: 10, overflow: 'hidden',
};

const th = {
    padding: '10px 12px', textAlign: 'center',
    fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
};

const td = { padding: '9px 12px', fontSize: 12.5 };
const tdC = { padding: '9px 12px', textAlign: 'center', fontSize: 12.5 };

const modalFooterStyle = {
    display: 'flex', gap: 10, justifyContent: 'flex-end',
    marginTop: 22, paddingTop: 18, borderTop: '1px solid #eef1f5',
    flexWrap: 'wrap',
};
