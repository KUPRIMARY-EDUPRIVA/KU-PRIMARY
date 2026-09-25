// src/pages/Students.jsx
import React, {
    useState, useEffect, useRef, useMemo, useCallback
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { db } from '../firebase';
import { doc, getDoc, updateDoc, serverTimestamp, collection, setDoc } from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { useSync } from '../context/SyncContext';
import { parseCSV, rowsToObjects } from '../services/csvService';
import {
    reserveAdmissionNumbers,
    checkAdmissionNumberCollisions,
    ensureSchoolCounterAtLeast,
    maxNumericId,
    formatAdmissionNumber,
} from '../services/admissionNumberService';
import {
    loadAllStudents,
    createStudent,
    updateStudent,
    softDeleteStudent,
    restoreStudent,
    bulkUpdateStudents,
} from '../services/studentService';

// ============================================================
// Constants
// ============================================================
const LEVEL_CLASSES = {
    'pre-primary': ['PP1', 'PP2'],
    'lower-primary': ['Grade 1', 'Grade 2', 'Grade 3'],
    'upper-primary': ['Grade 4', 'Grade 5', 'Grade 6'],
    'junior-school': ['Grade 7', 'Grade 8', 'Grade 9'],
    'senior-school': ['Grade 10', 'Grade 11', 'Grade 12'],
};

const LEVEL_DISPLAY_NAMES = {
    'pre-primary': 'Pre-Primary',
    'lower-primary': 'Lower Primary',
    'upper-primary': 'Upper Primary',
    'junior-school': 'Junior School',
    'senior-school': 'Senior School',
};

const LEVEL_BADGE_CLASSES = {
    'pre-primary': 'pre-primary',
    'lower-primary': 'lower-primary',
    'upper-primary': 'upper-primary',
    'junior-school': 'lower-secondary',
    'senior-school': 'senior',
};

const LEVEL_ORDER = [
    'pre-primary', 'lower-primary', 'upper-primary',
    'junior-school', 'senior-school',
];

const STATUS_OPTIONS = [
    { value: 'active', label: 'Active' },
    { value: 'inactive', label: 'Inactive' },
    { value: 'pending', label: 'Pending' },
    { value: 'promoted', label: 'Promoted' },
    { value: 'graduated', label: 'Graduated' },
    { value: 'transferred', label: 'Transferred' },
    { value: 'archived', label: 'Archived' },
];

const PAGE_SIZE_UI = 10;
const PAGE_SIZE_FETCH = 9999;
const MAX_IMPORT_SIZE = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 1000;

// ============================================================
// Helpers
// ============================================================
const normalizeText = (t) =>
    !t ? '' : String(t).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Resolve the class list for a level, preferring the school's custom
 * list from SchoolContext, falling back to the built-in constant.
 * ALL call sites must pass `getLevelClassesFn` when available.
 */
// ← PATCHED: single source of truth for "which classes does this level have"
const resolveClassList = (level, getLevelClassesFn) => {
    if (!level) return [];
    const custom = getLevelClassesFn ? getLevelClassesFn(level) : null;
    if (Array.isArray(custom) && custom.length > 0) return custom;
    return LEVEL_CLASSES[level] || [];
};

const getValidLevel = (input) => {
    if (!input) return null;
    const n = normalizeText(input);
    for (const key of Object.keys(LEVEL_DISPLAY_NAMES)) {
        if (n === key || n === normalizeText(LEVEL_DISPLAY_NAMES[key])) return key;
    }
    return null;
};

// ← PATCHED: uses resolveClassList so custom classes are honoured
const getValidClass = (input, level, getLevelClassesFn) => {
    if (!input || !level) return null;
    const n = normalizeText(input);
    const list = resolveClassList(level, getLevelClassesFn);
    for (const c of list) if (n === normalizeText(c)) return c;
    return null;
};

const getLevelDisplayName = (level) =>
    LEVEL_DISPLAY_NAMES[level] || level || 'N/A';

const getLevelBadgeClass = (level) => LEVEL_BADGE_CLASSES[level] || '';

// ← PATCHED: getClassOptions now REQUIRES getLevelClassesFn (no silent fallback)
const getClassOptions = (level, getLevelClassesFn) =>
    resolveClassList(level, getLevelClassesFn);

// ← PATCHED: uses resolveClassList so custom classes are honoured
const getNextClass = (level, currentClass, getLevelClassesFn) => {
    const list = resolveClassList(level, getLevelClassesFn);
    const i = list.indexOf(currentClass);
    if (i === -1 || i === list.length - 1) return null;
    return list[i + 1];
};

const getNextLevel = (currentLevel) => {
    const i = LEVEL_ORDER.indexOf(currentLevel);
    if (i === -1 || i === LEVEL_ORDER.length - 1) return null;
    return LEVEL_ORDER[i + 1];
};

// ← PATCHED: uses resolveClassList so custom terminal classes are detected
const isInTerminalClass = (level, studentClass, schoolHighestLevel, getLevelClassesFn) => {
    if (!schoolHighestLevel || level !== schoolHighestLevel) return false;
    const list = resolveClassList(level, getLevelClassesFn);
    if (list.length === 0) return false;
    return studentClass === list[list.length - 1];
};

const sortStudentsByAdmission = (list) => {
    return [...list].sort((a, b) => {
        const idA = String(a.studentId || '');
        const idB = String(b.studentId || '');
        const numA = /^\d+$/.test(idA);
        const numB = /^\d+$/.test(idB);
        if (numA && numB) return parseInt(idA, 10) - parseInt(idB, 10);
        if (numA) return -1;
        if (numB) return 1;
        const nA = `${a.firstName || ''} ${a.lastName || ''}`.toLowerCase();
        const nB = `${b.firstName || ''} ${b.lastName || ''}`.toLowerCase();
        return nA.localeCompare(nB);
    });
};

// ============================================================
// Component
// ============================================================
export default function Students() {
    const navigate = useNavigate();
    const {
        isOnline,
        pendingCount,
        saveToIndexedDB,
        getFromIndexedDB,
        addToSyncQueue,
    } = useSync();
    const { currentUser, userData } = useAuth();
    const { getLevelClasses } = useSchool();

    // ---- School context ----
    const [schoolId, setSchoolId] = useState(null);
    const [schoolDomain, setSchoolDomain] = useState('school');
    const [schoolHighestLevel, setSchoolHighestLevel] = useState('senior-school');
    const [schoolReady, setSchoolReady] = useState(false);

    // ---- Students (paginated) ----
    const [students, setStudents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [usingCachedData, setUsingCachedData] = useState(false);

    // ---- Teacher access ----
    const [isTeacher, setIsTeacher] = useState(false);
    const [teacherLevels, setTeacherLevels] = useState([]);
    const [teacherClasses, setTeacherClasses] = useState([]);

    // ---- UI state ----
    const [currentPage, setCurrentPage] = useState(1);
    const [showDeleted, setShowDeleted] = useState(false);

    const [searchTerm, setSearchTerm] = useState('');
    const [levelFilter, setLevelFilter] = useState('');
    const [classFilter, setClassFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [yearFilter, setYearFilter] = useState('');

    // ← PATCHED: filter bar class dropdown reads from SchoolContext
    const classOptions = useMemo(() => {
        if (!levelFilter) return [];
        return getClassOptions(levelFilter, getLevelClasses);
    }, [levelFilter, getLevelClasses]);

    const [showStudentModal, setShowStudentModal] = useState(false);
    const [showHistoryModal, setShowHistoryModal] = useState(false);
    const [showPromoteModal, setShowPromoteModal] = useState(false);
    const [showBulkPromoteModal, setShowBulkPromoteModal] = useState(false);
    const [showImportResults, setShowImportResults] = useState(false);

    const [editingStudent, setEditingStudent] = useState(null);
    const [selectedStudent, setSelectedStudent] = useState(null);
    const [promotingStudent, setPromotingStudent] = useState(null);

    const [historyYearFilter, setHistoryYearFilter] = useState('');
    const [historyClassFilter, setHistoryClassFilter] = useState('');

    const [bulkPromoteLevel, setBulkPromoteLevel] = useState('');
    const [bulkPromoteClass, setBulkPromoteClass] = useState('');

    const [importResults, setImportResults] = useState(null);
    const [importing, setImporting] = useState(false);

    const [formData, setFormData] = useState({
        firstName: '', lastName: '', email: '',
        level: '', class: '', status: 'active',
        phone: '', address: '', guardian: '', guardianPhone: '',
        gender: '', birthCertNo: '', dateOfBirth: '',
        admissionYear: new Date().getFullYear().toString(),
        reserveIdNow: false,
        manualStudentId: '',
    });

    const [promoteData, setPromoteData] = useState({
        targetKey: '',
        promotionYear: new Date().getFullYear().toString(),
    });

    const fileInputRef = useRef(null);

    // ============================================================
    // Notification
    // ============================================================
    const showNotification = useCallback((message, type = 'info') => {
        const colors = {
            success: '#27ae60', error: '#e74c3c',
            warning: '#f39c12', info: '#3498db',
        };
        const icons = {
            success: 'check-circle', error: 'exclamation-circle',
            warning: 'exclamation-triangle', info: 'info-circle',
        };
        const el = document.createElement('div');
        el.className = 'custom-notification';
        el.style.backgroundColor = colors[type] || colors.info;
        el.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}"></i><span>${message}</span>`;
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => el.parentNode && el.parentNode.removeChild(el), 300);
        }, 4000);
    }, []);

    // ============================================================
    // Bootstrap: load school + first page of students
    // ============================================================
    useEffect(() => {
        if (!currentUser || !userData?.schoolId) return;
        let cancelled = false;

        (async () => {
            setLoading(true);
            try {
                const sid = userData.schoolId;
                setSchoolId(sid);

                const role = userData.role || 'user';
                const teacher = role === 'teacher';
                setIsTeacher(teacher);

                if (teacher) {
                    setTeacherLevels(
                        Array.isArray(userData.levels) ? userData.levels
                            : userData.level ? [userData.level] : []
                    );
                    setTeacherClasses(
                        Array.isArray(userData.classes) ? userData.classes
                            : userData.class ? [userData.class] : []
                    );
                }

                let school = await getFromIndexedDB(`school_data_${sid}`);
                if (!school && isOnline) {
                    const snap = await getDoc(doc(db, 'schools', sid));
                    if (snap.exists()) {
                        school = { id: snap.id, ...snap.data() };
                        await saveToIndexedDB(`school_data_${sid}`, school);
                    }
                }
                if (cancelled) return;

                if (school) {
                    const fullName = school.name || school.schoolName || 'School';
                    const firstWord = fullName.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
                    setSchoolDomain(firstWord ? `${firstWord}school` : 'school');
                    if (school.highestLevel) setSchoolHighestLevel(school.highestLevel);
                }

                setSchoolReady(true);
                await loadFirstPage(sid);
            } catch (e) {
                console.error('bootstrap failed:', e);
                showNotification('Failed to load: ' + e.message, 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser?.uid, userData?.schoolId, isOnline]);

    // ============================================================
    // Pagination loaders
    // ============================================================
    const loadFirstPage = useCallback(async (sid) => {
        const cached = await getFromIndexedDB(`students_${sid}`);
        if (cached && cached.length > 0) {
            setStudents(sortStudentsByAdmission(cached));
            setUsingCachedData(true);
        }

        if (!isOnline) return;

        const page = await loadAllStudents(sid, isTeacher ? teacherClasses : []);

        const sorted = sortStudentsByAdmission(page);
        setStudents(sorted);
        setUsingCachedData(false);
        await saveToIndexedDB(`students_${sid}`, sorted);
    }, [isOnline, getFromIndexedDB, saveToIndexedDB, isTeacher, teacherClasses]);

    const refresh = useCallback(async () => {
        if (!schoolId) return;
        await loadFirstPage(schoolId);
        showNotification('Refreshed', 'success');
    }, [schoolId, loadFirstPage, showNotification]);

    // ============================================================
    // Derived lists (memoized)
    // ============================================================
    const accessibleStudents = useMemo(() => {
        const base = showDeleted
            ? students
            : students.filter((s) => !s.isDeleted);
        if (!isTeacher) return base;
        if (teacherClasses.length) return base.filter((s) => teacherClasses.includes(s.class));
        if (teacherLevels.length) return base.filter((s) => teacherLevels.includes(s.level));
        return base;
    }, [students, showDeleted, isTeacher, teacherClasses, teacherLevels]);

    const filteredStudents = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        return accessibleStudents.filter((s) => {
            if (levelFilter && s.level !== levelFilter) return false;
            if (classFilter && s.class !== classFilter) return false;
            if (statusFilter && s.status !== statusFilter) return false;
            if (yearFilter && s.admissionYear !== yearFilter && s.promotionYear !== yearFilter) return false;
            if (term) {
                const hay = `${s.firstName || ''} ${s.lastName || ''} ${s.email || ''} ${s.studentId || ''}`.toLowerCase();
                if (!hay.includes(term)) return false;
            }
            return true;
        });
    }, [accessibleStudents, searchTerm, levelFilter, classFilter, statusFilter, yearFilter]);

    const stats = useMemo(() => ({
        total: accessibleStudents.length,
        active: accessibleStudents.filter((s) => s.status === 'active').length,
        promoted: accessibleStudents.filter((s) => s.status === 'promoted').length,
        archived: accessibleStudents.filter((s) => s.status === 'archived' || s.status === 'graduated').length,
        deleted: students.filter((s) => s.isDeleted).length,
    }), [accessibleStudents, students]);

    const uniqueClasses = useMemo(() => {
        const set = new Set();
        accessibleStudents.forEach((s) => { if (s.class) set.add(s.class); });
        return [...set].sort();
    }, [accessibleStudents]);

    const uniqueLevels = useMemo(() => {
        const set = new Set();
        accessibleStudents.forEach((s) => { if (s.level) set.add(s.level); });
        return [...set];
    }, [accessibleStudents]);

    const uniqueYears = useMemo(() => {
        const set = new Set();
        students.forEach((s) => {
            if (s.admissionYear) set.add(s.admissionYear);
            if (s.promotionYear) set.add(s.promotionYear);
        });
        return [...set].sort().reverse();
    }, [students]);

    const totalUiPages = Math.max(1, Math.ceil(filteredStudents.length / PAGE_SIZE_UI));

    const pagedStudents = useMemo(() => {
        const start = (currentPage - 1) * PAGE_SIZE_UI;
        return filteredStudents.slice(start, start + PAGE_SIZE_UI);
    }, [filteredStudents, currentPage]);

    useEffect(() => { setCurrentPage(1); },
        [searchTerm, levelFilter, classFilter, statusFilter, yearFilter, showDeleted]);

    // ============================================================
    // Email generator
    // ============================================================
    const generateEmail = useCallback((first, last) => {
        const f = (first || '').trim().toLowerCase().replace(/\s/g, '');
        const l = (last || '').trim().toLowerCase().replace(/\s/g, '');
        if (!f && !l) return `student${Date.now()}@${schoolDomain}.com`;
        return `${f}${l ? '.' + l : ''}@${schoolDomain}.com`;
    }, [schoolDomain]);

    // ============================================================
    // Create / Update
    // ============================================================
    const handleAddStudent = () => {
        setEditingStudent(null);
        setFormData({
            firstName: '', lastName: '', email: '',
            level: '', class: '', status: 'active',
            phone: '', address: '', guardian: '', guardianPhone: '',
            gender: '', birthCertNo: '', dateOfBirth: '',
            admissionYear: new Date().getFullYear().toString(),
            reserveIdNow: false,
            manualStudentId: '',
        });
        setShowStudentModal(true);
    };

    const handleEditStudent = (student) => {
        setEditingStudent(student);
        setFormData({
            firstName: student.firstName || '',
            lastName: student.lastName || '',
            email: student.email || '',
            level: student.level || '',
            class: student.class || '',
            status: student.status || 'active',
            phone: student.phone || '',
            address: student.address || '',
            guardian: student.guardian || '',
            guardianPhone: student.guardianPhone || '',
            gender: student.gender || '',
            birthCertNo: student.birthCertNo || '',
            dateOfBirth: student.dateOfBirth || '',
            admissionYear: student.admissionYear || new Date().getFullYear().toString(),
            reserveIdNow: false,
            manualStudentId: '',
        });
        setShowStudentModal(true);
    };

    const handleFormSubmit = async (e) => {
        e.preventDefault();

        const base = {
            firstName: formData.firstName.trim(),
            lastName: formData.lastName.trim(),
            email: formData.email?.trim() || generateEmail(formData.firstName, formData.lastName),
            level: formData.level,
            class: formData.class,
            status: formData.status,
            phone: formData.phone.trim(),
            address: formData.address.trim(),
            guardian: formData.guardian.trim(),
            guardianPhone: formData.guardianPhone.trim(),
            gender: formData.gender,
            birthCertNo: formData.birthCertNo.trim(),
            dateOfBirth: formData.dateOfBirth,
            schoolId,
            admissionYear: formData.admissionYear || new Date().getFullYear().toString(),
        };

        // ---------------------------------------------
        // Edit path
        // ---------------------------------------------
        if (editingStudent) {
            try {
                if (isOnline) {
                    await updateStudent(editingStudent.id, base, currentUser);
                } else {
                    await addToSyncQueue('students', 'update', { id: editingStudent.id, ...base });
                }
                setStudents((prev) => sortStudentsByAdmission(prev.map((s) =>
                    s.id === editingStudent.id ? { ...s, ...base } : s
                )));
                await saveToIndexedDB(`students_${schoolId}`,
                    sortStudentsByAdmission(students.map((s) =>
                        s.id === editingStudent.id ? { ...s, ...base } : s
                    )));
                showNotification('Student updated', 'success');
                setShowStudentModal(false);
            } catch (err) {
                console.error('update failed:', err);
                showNotification('Failed to update: ' + err.message, 'error');
            }
            return;
        }

        // ---------------------------------------------
        // Create path — requires online for atomic ID reservation
        // ---------------------------------------------
        if (!isOnline) {
            showNotification(
                'Adding new students requires an internet connection so admission numbers stay unique. ' +
                'Editing existing students still works offline.',
                'warning'
            );
            return;
        }

        try {
            let studentId;

            if (formData.manualStudentId) {
                const cleaned = String(formData.manualStudentId).trim();
                if (!/^\d+$/.test(cleaned)) {
                    showNotification('Manual ID must be numeric', 'error');
                    return;
                }
                const formatted = formatAdmissionNumber(parseInt(cleaned, 10));
                const { duplicates } = await checkAdmissionNumberCollisions(schoolId, [formatted]);
                if (duplicates.length > 0) {
                    showNotification(`ID ${formatted} is already in use`, 'error');
                    return;
                }
                studentId = formatted;
                await ensureSchoolCounterAtLeast(schoolId, parseInt(cleaned, 10) + 1);
            } else {
                const [reserved] = await reserveAdmissionNumbers(schoolId, 1);
                studentId = reserved;
            }

            const payload = { ...base, studentId, history: [], isDeleted: false };
            const created = await createStudent(payload);

            setStudents((prev) => sortStudentsByAdmission([created, ...prev]));
            await saveToIndexedDB(`students_${schoolId}`,
                sortStudentsByAdmission([created, ...students]));

            showNotification(`Student added — Admission No ${studentId}`, 'success');
            setShowStudentModal(false);
        } catch (err) {
            console.error('create failed:', err);
            showNotification('Failed to create: ' + err.message, 'error');
        }
    };

    // ============================================================
    // Soft delete / restore
    // ============================================================
    const handleDeleteStudent = async (student) => {
        const ok = window.confirm(
            `Archive ${student.firstName || ''} ${student.lastName || ''}?\n\n` +
            `Their record is kept (scores, fees, history) but they'll be hidden from active lists. ` +
            `You can restore them later.`
        );
        if (!ok) return;

        try {
            if (isOnline) {
                await softDeleteStudent(student.id, currentUser?.uid);
            } else {
                await addToSyncQueue('students', 'update', {
                    id: student.id,
                    isDeleted: true,
                    status: 'deleted',
                    deletedAt: new Date().toISOString(),
                    deletedBy: currentUser?.uid || null,
                });
            }
            setStudents((prev) => prev.map((s) =>
                s.id === student.id
                    ? { ...s, isDeleted: true, status: 'deleted', deletedAt: new Date().toISOString() }
                    : s
            ));
            showNotification('Student archived (restorable)', 'success');
        } catch (err) {
            console.error('delete failed:', err);
            showNotification('Failed to archive: ' + err.message, 'error');
        }
    };

    const handleRestoreStudent = async (student) => {
        try {
            if (isOnline) {
                await restoreStudent(student.id);
            } else {
                await addToSyncQueue('students', 'update', {
                    id: student.id,
                    isDeleted: false,
                    status: 'active',
                    deletedAt: null,
                    deletedBy: null,
                });
            }
            setStudents((prev) => prev.map((s) =>
                s.id === student.id
                    ? { ...s, isDeleted: false, status: 'active', deletedAt: null, deletedBy: null }
                    : s
            ));
            showNotification('Student restored', 'success');
        } catch (err) {
            console.error('restore failed:', err);
            showNotification('Failed to restore: ' + err.message, 'error');
        }
    };

    // ============================================================
    // Promotion
    // ============================================================
    // ← PATCHED: getLevelClasses threaded through every helper + dependency array
    const getPromotionTargets = useCallback((student) => {
        if (!student) return [];
        const targets = [];

        if (isInTerminalClass(student.level, student.class, schoolHighestLevel, getLevelClasses)) {
            targets.push({
                key: `graduate`,
                level: student.level,
                class: student.class,
                type: 'graduate',
                label: `Graduate from ${getLevelDisplayName(student.level)}`,
            });
            return targets;
        }

        const nextClass = getNextClass(student.level, student.class, getLevelClasses);
        if (nextClass) {
            targets.push({
                key: `${student.level}|${nextClass}`,
                level: student.level,
                class: nextClass,
                type: 'same-level',
                label: `${getLevelDisplayName(student.level)} — ${nextClass}`,
            });
        }
        const nextLevel = getNextLevel(student.level);
        if (nextLevel && (!schoolHighestLevel || LEVEL_ORDER.indexOf(nextLevel) <= LEVEL_ORDER.indexOf(schoolHighestLevel))) {
            // ← PATCHED: use getClassOptions(...) instead of LEVEL_CLASSES[...] directly
            const first = getClassOptions(nextLevel, getLevelClasses)[0];
            if (first) {
                targets.push({
                    key: `${nextLevel}|${first}`,
                    level: nextLevel,
                    class: first,
                    type: 'next-level',
                    label: `${getLevelDisplayName(nextLevel)} — ${first} (transition)`,
                });
            }
        }
        return targets;
    }, [schoolHighestLevel, getLevelClasses]);

    const canPromote = useCallback((student) => {
        if (!student || student.isDeleted) return false;
        if (student.status === 'archived' || student.status === 'graduated') return false;
        return getPromotionTargets(student).length > 0;
    }, [getPromotionTargets]);

    const handleOpenPromote = (student) => {
        const targets = getPromotionTargets(student);
        if (targets.length === 0) {
            showNotification('No promotion targets for this student.', 'warning');
            return;
        }
        setPromotingStudent(student);
        setPromoteData({
            targetKey: targets[0].key,
            promotionYear: new Date().getFullYear().toString(),
        });
        setShowPromoteModal(true);
    };

    const handlePromoteSubmit = async () => {
        const student = promotingStudent;
        if (!student) return;

        const targets = getPromotionTargets(student);
        const chosen = targets.find((t) => t.key === promoteData.targetKey);
        if (!chosen) {
            showNotification('Please choose a valid promotion target.', 'warning');
            return;
        }

        const year = promoteData.promotionYear;
        const alreadyPromotedThisYear = (student.history || []).some(
            (h) => h.type === 'promotion' && h.year === year
        );
        if (alreadyPromotedThisYear) {
            showNotification(`This student was already promoted in ${year}.`, 'warning');
            return;
        }

        const ok = window.confirm(
            `Promote ${student.firstName || ''} ${student.lastName || ''} to ${chosen.label} for ${year}?`
        );
        if (!ok) return;

        // ← PATCHED: pass getLevelClasses
        const terminal = isInTerminalClass(chosen.level, chosen.class, schoolHighestLevel, getLevelClasses);

        const historyEntry = {
            type: 'promotion',
            fromLevel: student.level,
            fromClass: student.class,
            toLevel: chosen.level,
            toClass: chosen.class,
            date: new Date().toISOString(),
            year,
            academicYear: year,
        };
        const history = [...(student.history || []), historyEntry];

        const updateData = {
            level: chosen.level,
            class: chosen.class,
            status: terminal ? 'graduated' : 'promoted',
            promotedAt: new Date().toISOString(),
            promotionYear: year,
            history,
            updatedAt: new Date().toISOString(),
            ...(terminal ? { graduatedAt: new Date().toISOString(), graduationYear: year } : {}),
        };

        try {
            if (isOnline) {
                await updateStudent(student.id, updateData);
            } else {
                await addToSyncQueue('students', 'update', { id: student.id, ...updateData });
            }
            const next = sortStudentsByAdmission(students.map((s) =>
                s.id === student.id ? { ...s, ...updateData } : s
            ));
            setStudents(next);
            await saveToIndexedDB(`students_${schoolId}`, next);
            showNotification(
                terminal
                    ? `Promoted to ${chosen.label}. Marked as graduated.`
                    : `Promoted to ${chosen.label}.`,
                'success'
            );
            setShowPromoteModal(false);
            setPromotingStudent(null);
        } catch (err) {
            console.error('promote failed:', err);
            showNotification('Failed to promote: ' + err.message, 'error');
        }
    };

    // ============================================================
    // Bulk promote
    // ============================================================
    const computeBulkPromoteTargets = useCallback(() => {
        if (!bulkPromoteLevel || !bulkPromoteClass) return [];
        const year = new Date().getFullYear().toString();
        return students.filter((s) => {
            if (s.isDeleted) return false;
            if (s.status === 'archived' || s.status === 'graduated') return false;
            const already = (s.history || []).some(
                (h) => h.type === 'promotion'
                    && h.year === year
                    && h.toLevel === bulkPromoteLevel
                    && h.toClass === bulkPromoteClass
            );
            if (already) return false;
            return getPromotionTargets(s).some(
                (t) => t.level === bulkPromoteLevel && t.class === bulkPromoteClass
            );
        });
    }, [bulkPromoteLevel, bulkPromoteClass, students, getPromotionTargets]);

    const confirmBulkPromote = async () => {
        const targets = computeBulkPromoteTargets();
        if (targets.length === 0) {
            showNotification('No students eligible for this promotion.', 'warning');
            return;
        }
        // ← PATCHED: pass getLevelClasses
        const terminal = isInTerminalClass(bulkPromoteLevel, bulkPromoteClass, schoolHighestLevel, getLevelClasses);
        const year = new Date().getFullYear().toString();

        const ok = window.confirm(
            `Promote ${targets.length} students to ${getLevelDisplayName(bulkPromoteLevel)} ${bulkPromoteClass} for ${year}?` +
            (terminal ? `\n\nThey will be marked as graduated.` : '')
        );
        if (!ok) return;

        const updates = targets.map((student) => {
            const history = [...(student.history || []), {
                type: 'promotion',
                fromLevel: student.level,
                fromClass: student.class,
                toLevel: bulkPromoteLevel,
                toClass: bulkPromoteClass,
                date: new Date().toISOString(),
                year,
                academicYear: year,
            }];
            return {
                id: student.id,
                data: {
                    level: bulkPromoteLevel,
                    class: bulkPromoteClass,
                    status: terminal ? 'graduated' : 'promoted',
                    promotedAt: new Date().toISOString(),
                    promotionYear: year,
                    history,
                    ...(terminal ? { graduatedAt: new Date().toISOString(), graduationYear: year } : {}),
                },
            };
        });

        try {
            if (isOnline) {
                await bulkUpdateStudents(updates);
                for (const student of targets) {
                    try {
                        const archiveRef = doc(collection(db, 'archived_students'));
                        await setDoc(archiveRef, {
                            schoolId: userData.schoolId,
                            studentId: student.id,
                            admissionNumber: student.admissionNumber || student.studentId || '',
                            firstName: student.firstName || '',
                            lastName: student.lastName || '',
                            gender: student.gender || '',
                            level: student.level,
                            class: student.class,
                            academicYear: year,
                            historicalRecords: student.history || [],
                            archivedAt: new Date().toISOString()
                        });
                    } catch (archiveErr) {
                        console.error('Error archiving student:', archiveErr);
                    }
                }
            } else {
                for (const u of updates) {
                    await addToSyncQueue('students', 'update', { id: u.id, ...u.data });
                }
            }
            const byId = new Map(updates.map((u) => [u.id, u.data]));
            const next = sortStudentsByAdmission(students.map((s) =>
                byId.has(s.id) ? { ...s, ...byId.get(s.id) } : s
            ));
            setStudents(next);
            await saveToIndexedDB(`students_${schoolId}`, next);
            showNotification(`Promoted ${updates.length} students.`, 'success');
            setShowBulkPromoteModal(false);
        } catch (err) {
            console.error('bulk promote failed:', err);
            showNotification('Failed to bulk promote: ' + err.message, 'error');
        }
    };

    // ============================================================
    // CSV Export
    // ============================================================
    const handleExportCSV = () => {
        if (filteredStudents.length === 0) {
            showNotification('No students to export', 'warning');
            return;
        }
        const headers = [
            'student id', 'first name', 'last name', 'email', 'level', 'class',
            'status', 'phone', 'guardian', 'guardian phone', 'admission year'
        ];
        const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lines = [headers.map(quote).join(',')];
        filteredStudents.forEach((s) => {
            lines.push([
                s.studentId || '', s.firstName || '', s.lastName || '', s.email || '',
                s.level || '', s.class || '', s.status || 'active', s.phone || '',
                s.guardian || '', s.guardianPhone || '', s.admissionYear || ''
            ].map(quote).join(','));
        });

        const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `students_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showNotification(`Exported ${filteredStudents.length} students`, 'success');
    };

    // ============================================================
    // CSV Import
    // ============================================================
    const handleImportCSV = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';

        if (!file.name.toLowerCase().endsWith('.csv')) {
            showNotification('Please select a .csv file', 'error');
            return;
        }
        if (file.size > MAX_IMPORT_SIZE) {
            showNotification('File too large (max 5 MB)', 'error');
            return;
        }
        if (!isOnline) {
            showNotification(
                'Importing students requires an internet connection so admission numbers stay unique.',
                'warning'
            );
            return;
        }

        setImporting(true);
        const errors = [];
        let added = 0;

        try {
            const text = await file.text();
            const rows = parseCSV(text);

            if (rows.length < 2) {
                showNotification('CSV is empty or missing data rows', 'error');
                return;
            }
            if (rows.length - 1 > MAX_IMPORT_ROWS) {
                showNotification(`CSV has too many rows (max ${MAX_IMPORT_ROWS})`, 'error');
                return;
            }

            const { headers, objects } = rowsToObjects(rows);

            const HEADER_ALIASES = {
                'student id': 'studentId', 'admission number': 'studentId',
                'student number': 'studentId', 'id': 'studentId',
                'first name': 'firstName', 'firstname': 'firstName',
                'last name': 'lastName', 'lastname': 'lastName',
                'email': 'email', 'level': 'level', 'class': 'class',
                'status': 'status', 'phone': 'phone',
                'guardian': 'guardian', 'guardian phone': 'guardianPhone',
                'admission year': 'admissionYear',
            };

            const recognizedColumns = headers
                .map((h) => HEADER_ALIASES[h])
                .filter(Boolean);

            if (recognizedColumns.length === 0) {
                showNotification('No recognized columns in CSV', 'error');
                return;
            }

            // Pass 1: Normalize + validate every row
            const parsedRows = [];
            const idsInFile = new Map();

            for (let i = 0; i < objects.length; i++) {
                const src = objects[i];
                const rowNum = i + 2;

                const student = {
                    firstName: (src.firstname || src['first name'] || '').trim(),
                    lastName: (src.lastname || src['last name'] || '').trim(),
                    email: (src.email || '').trim(),
                    level: (src.level || '').trim(),
                    class: (src.class || '').trim(),
                    status: (src.status || 'active').trim(),
                    phone: (src.phone || '').trim(),
                    guardian: (src.guardian || '').trim(),
                    guardianPhone: (src['guardian phone'] || '').trim(),
                    admissionYear: (src['admission year'] || new Date().getFullYear().toString()).trim(),
                };

                const providedId = (src.studentid || src['student id'] || src['admission number'] || src.id || '').trim();

                if (!student.firstName || !student.lastName) {
                    errors.push(`Row ${rowNum}: missing first or last name`);
                    continue;
                }

                const validLevel = getValidLevel(student.level);
                if (!validLevel) {
                    errors.push(`Row ${rowNum}: invalid level "${student.level}"`);
                    continue;
                }
                student.level = validLevel;

                // ← PATCHED: pass getLevelClasses so custom classes validate
                const validClass = getValidClass(student.class, validLevel, getLevelClasses);
                if (!validClass) {
                    errors.push(`Row ${rowNum}: invalid class "${student.class}" for ${validLevel}`);
                    continue;
                }
                student.class = validClass;

                let reservedId = null;
                if (providedId) {
                    if (!/^\d+$/.test(providedId)) {
                        errors.push(`Row ${rowNum}: ID "${providedId}" must be numeric`);
                        continue;
                    }
                    const normalizedId = formatAdmissionNumber(parseInt(providedId, 10));
                    if (idsInFile.has(normalizedId)) {
                        errors.push(`Row ${rowNum}: duplicate ID ${normalizedId} (already used on row ${idsInFile.get(normalizedId)})`);
                        continue;
                    }
                    idsInFile.set(normalizedId, rowNum);
                    reservedId = normalizedId;
                }

                parsedRows.push({ rowNum, student, reservedId });
            }

            // Pass 2: Pre-flight collision check
            const suppliedIds = parsedRows
                .filter((r) => r.reservedId)
                .map((r) => r.reservedId);

            if (suppliedIds.length > 0) {
                const { duplicates } = await checkAdmissionNumberCollisions(schoolId, suppliedIds);
                if (duplicates.length > 0) {
                    const dupSet = new Set(duplicates);
                    const kept = [];
                    for (const r of parsedRows) {
                        if (r.reservedId && dupSet.has(r.reservedId)) {
                            errors.push(`Row ${r.rowNum}: ID ${r.reservedId} already exists in this school`);
                        } else {
                            kept.push(r);
                        }
                    }
                    parsedRows.length = 0;
                    parsedRows.push(...kept);
                }
            }

            if (parsedRows.length === 0) {
                setImportResults({ added: 0, errors });
                setShowImportResults(true);
                showNotification('No rows to import', 'error');
                return;
            }

            // Pass 3: Reserve IDs for rows WITHOUT supplied IDs
            const needReservation = parsedRows.filter((r) => !r.reservedId);
            let reservedPool = [];
            if (needReservation.length > 0) {
                reservedPool = await reserveAdmissionNumbers(schoolId, needReservation.length);
            }
            let poolIdx = 0;

            // Pass 4: Write each student
            const created = [];
            for (const r of parsedRows) {
                const studentId = r.reservedId || reservedPool[poolIdx++];
                const payload = {
                    ...r.student,
                    studentId,
                    schoolId,
                    history: [],
                    isDeleted: false,
                };
                try {
                    const doc = await createStudent(payload);
                    created.push(doc);
                    added++;
                } catch (err) {
                    errors.push(`Row ${r.rowNum}: save failed — ${err.message}`);
                }
            }

            // Pass 5: Advance counter
            const highestSupplied = maxNumericId(parsedRows.map((r) => r.reservedId).filter(Boolean));
            if (highestSupplied > 0) {
                await ensureSchoolCounterAtLeast(schoolId, highestSupplied + 1);
            }

            const next = sortStudentsByAdmission([...created, ...students]);
            setStudents(next);
            await saveToIndexedDB(`students_${schoolId}`, next);

            setImportResults({ added, errors });
            setShowImportResults(true);
            showNotification(
                `Imported ${added} students${errors.length ? ` (${errors.length} skipped)` : ''}`,
                errors.length ? 'warning' : 'success'
            );
        } catch (err) {
            console.error('import failed:', err);
            showNotification('Import failed: ' + err.message, 'error');
        } finally {
            setImporting(false);
        }
    };

    // ============================================================
    // History modal content
    // ============================================================
    const historyContent = useMemo(() => {
        if (!selectedStudent) return [];
        let h = [...(selectedStudent.history || [])];
        if (historyYearFilter) {
            h = h.filter((x) => x.year === historyYearFilter || x.academicYear === historyYearFilter);
        }
        if (historyClassFilter) {
            h = h.filter((x) => x.toClass === historyClassFilter || x.fromClass === historyClassFilter);
        }
        return h.sort((a, b) => new Date(b.date) - new Date(a.date));
    }, [selectedStudent, historyYearFilter, historyClassFilter]);

    const historyClassOptions = useMemo(() => {
        if (!selectedStudent) return [];
        const set = new Set();
        (selectedStudent.history || []).forEach((h) => {
            if (h.toClass) set.add(h.toClass);
            if (h.fromClass) set.add(h.fromClass);
        });
        return [...set].sort();
    }, [selectedStudent]);

    // ============================================================
    // Pagination buttons
    // ============================================================
    const paginationButtons = useMemo(() => {
        const btns = [];
        btns.push(
            <button key="prev" disabled={currentPage === 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>
                <i className="fas fa-chevron-left"></i>
            </button>
        );
        const showDotsAfter = new Set();
        const showDotsBefore = new Set();
        for (let i = 1; i <= totalUiPages; i++) {
            if (i === 1 || i === totalUiPages || Math.abs(i - currentPage) <= 2) {
                btns.push(
                    <button key={i} className={i === currentPage ? 'active' : ''}
                            onClick={() => setCurrentPage(i)}>{i}</button>
                );
            } else if (i === currentPage - 3) {
                showDotsBefore.add(i);
            } else if (i === currentPage + 3) {
                showDotsAfter.add(i);
            }
        }
        if (showDotsBefore.size) {
            btns.splice(1, 0, <span key="dots-before" style={{ padding: '0 10px', color: 'var(--gray)' }}>…</span>);
        }
        if (showDotsAfter.size) {
            btns.splice(btns.length - 1, 0, <span key="dots-after" style={{ padding: '0 10px', color: 'var(--gray)' }}>…</span>);
        }
        btns.push(
            <button key="next" disabled={currentPage === totalUiPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalUiPages, p + 1))}>
                <i className="fas fa-chevron-right"></i>
            </button>
        );
        return btns;
    }, [currentPage, totalUiPages]);

    // ============================================================
    // Render table rows
    // ============================================================
    const renderTable = () => {
        if (pagedStudents.length === 0) {
            return (
                <tr>
                    <td colSpan={isTeacher ? 6 : 7}>
                        <div className="empty-state">
                            <i className="fas fa-user-graduate"></i>
                            <h3>No Students Found</h3>
                            <p>
                                {isTeacher
                                    ? 'No students in your assigned levels/classes.'
                                    : 'Add a student or import from CSV.'}
                            </p>
                            {!isTeacher && (
                                <>
                                <button className="btn btn-outline" onClick={() => navigate('/student-analytics')} title="Analytics">
                            <i className="fas fa-chart-line"></i> Analytics
                        </button>
                        <button className="btn btn-primary" onClick={handleAddStudent}>
                                    <i className="fas fa-plus"></i> Add Student
                                </button>
                                </>
                            )}
                        </div>
                    </td>
                </tr>
            );
        }
        return pagedStudents.map((s) => {
            const levelDisplay = getLevelDisplayName(s.level);
            const badge = getLevelBadgeClass(s.level);
            const canPromoteFlag = canPromote(s);
            const isDeleted = !!s.isDeleted;

            return (
                <tr key={s.id} style={isDeleted ? { opacity: 0.6 } : undefined}>
                    <td>
                        <div className="student-info">
                            <div className="student-avatar">{(s.firstName || 'S')[0]}</div>
                            <div>
                                <div className="name">
                                    {s.firstName || ''} {s.lastName || ''}
                                    {isDeleted && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--danger)' }}>(deleted)</span>}
                                </div>
                                <div className="email">{s.email || ''}</div>
                            </div>
                        </div>
                    </td>
                    <td>{s.studentId || 'N/A'}</td>
                    <td>
                        <div style={{ fontSize: '12px' }}>
                            {s.gender || 'N/A'}{s.dateOfBirth ? ` • ${Math.floor((new Date() - new Date(s.dateOfBirth).getTime()) / 3.15576e+10)} yrs` : ''}
                        </div>
                    </td>
                    <td><span className={`level-badge ${badge}`}>{levelDisplay}</span></td>
                    <td>{s.class || 'N/A'}</td>
                    <td>
                        {(() => {
                            const promotedTime = s.promotedAt ? new Date(s.promotedAt).getTime() : 0;
                            const hoursSincePromotion = promotedTime ? (Date.now() - promotedTime) / (1000 * 60 * 60) : 99999;
                            const isPromotedBadge = s.status === 'promoted' && hoursSincePromotion <= 72;
                            const badgeStatus = isPromotedBadge ? 'promoted' : 'active';
                            return (
                                <span className={`status-badge ${badgeStatus}`}>
                                    {isPromotedBadge ? 'Promoted' : 'Active'}
                                </span>
                            );
                        })()}
                    </td>
                    {!isTeacher && (
                        <td>
                            <div className="action-btns">
                                {!isDeleted && (
                                    <>
                                        <button className="action-btn edit" onClick={() => handleEditStudent(s)} title="Edit">
                                            <i className="fas fa-edit"></i>
                                        </button>
                                        {canPromoteFlag && (
                                            <button className="action-btn promote" onClick={() => handleOpenPromote(s)} title="Promote">
                                                <i className="fas fa-arrow-up"></i>
                                            </button>
                                        )}
                                        <button className="action-btn history" onClick={() => { setSelectedStudent(s); setShowHistoryModal(true); }} title="History">
                                            <i className="fas fa-history"></i>
                                        </button>
                                        <button className="action-btn delete" onClick={() => handleDeleteStudent(s)} title="Archive">
                                            <i className="fas fa-archive"></i>
                                        </button>
                                    </>
                                )}
                                {isDeleted && (
                                    <button className="action-btn restore" onClick={() => handleRestoreStudent(s)} title="Restore">
                                        <i className="fas fa-undo"></i>
                                    </button>
                                )}
                            </div>
                        </td>
                    )}
                </tr>
            );
        });
    };

    // ============================================================
    // Main render
    // ============================================================
    if (loading || !schoolReady) {
        return <LoadingSpinner fullScreen text="Loading students..." />;
    }

    return (
        <Layout title="Students Management">
            <style>{`
                .history-item { display:flex; justify-content:space-between; padding:10px 15px; border-bottom:1px solid var(--border); font-size:13px; }
                .history-item .level-info { font-weight:600; color:var(--secondary); }
                .history-item .date-info { color:var(--gray); font-size:12px; }
                .modal { max-width:700px; }
                .action-btn.restore { background:#16a085; color:white; }
                .action-btn.restore:hover { opacity:0.9; }
                @media (max-width:768px) { .history-item { flex-direction:column; gap:5px; } }
            `}</style>

            {/* Offline banner */}
            {!isOnline && (
                <div style={{
                    background:'#fff3cd', color:'#856404', padding:'10px 20px',
                    borderRadius:8, marginBottom:20, display:'flex',
                    alignItems:'center', gap:10, fontSize:14, border:'1px solid #ffc107'
                }}>
                    <i className="fas fa-wifi-slash"></i>
                    <span>
                        You are offline. Editing existing students still works, but new students
                        can only be added online so admission numbers stay unique.
                    </span>
                    {pendingCount > 0 && (
                        <span style={{
                            background:'#ffc107', color:'#856404', padding:'2px 10px',
                            borderRadius:12, fontSize:12, fontWeight:600
                        }}>{pendingCount} pending</span>
                    )}
                </div>
            )}

            {usingCachedData && isOnline && (
                <div style={{
                    background:'#d1ecf1', color:'#0c5460', padding:'8px 16px',
                    borderRadius:8, marginBottom:20, display:'flex',
                    alignItems:'center', gap:10, fontSize:13, border:'1px solid #bee5eb'
                }}>
                    <i className="fas fa-database"></i>
                    <span>Cached view — click Refresh to sync.</span>
                </div>
            )}

            {isTeacher && (
                <div className="teacher-access-badge">
                    <i className="fas fa-user-graduate"></i> Teacher view — showing your assigned levels/classes
                </div>
            )}

            {/* Stats */}
            <div className="stats-grid">
                <div className="stat-card"><div className="stat-label">Total</div><div className="stat-value">{stats.total}</div></div>
                <div className="stat-card"><div className="stat-label">Active</div><div className="stat-value">{stats.active}</div></div>
                <div className="stat-card"><div className="stat-label">Promoted</div><div className="stat-value">{stats.promoted}</div></div>
                <div className="stat-card"><div className="stat-label">Archived/Grad</div><div className="stat-value">{stats.archived}</div></div>
                {stats.deleted > 0 && (
                    <div className="stat-card">
                        <div className="stat-label">Deleted</div>
                        <div className="stat-value">{stats.deleted}</div>
                    </div>
                )}
            </div>

            {/* Filters */}
            <div className="filters-section">
                <input
                    type="text" className="search-input"
                    placeholder="Search by name, email, or ID..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                />
                <select className="filter-select" value={levelFilter}
                        onChange={(e) => { setLevelFilter(e.target.value); setClassFilter(''); }}>
                    <option value="">All Levels</option>
                    {uniqueLevels.map((l) => <option key={l} value={l}>{getLevelDisplayName(l)}</option>)}
                </select>
                <select className="filter-select" value={classFilter}
                        onChange={(e) => setClassFilter(e.target.value)}>
                    <option value="">All Classes</option>
                    {classOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select className="filter-select" value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="">All Status</option>
                    {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select className="filter-select" value={yearFilter}
                        onChange={(e) => setYearFilter(e.target.value)}>
                    <option value="">All Years</option>
                    {uniqueYears.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>

                <label style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontSize: 13, color: 'var(--gray)', cursor: 'pointer'
                }}>
                    <input type="checkbox" checked={showDeleted}
                           onChange={(e) => setShowDeleted(e.target.checked)} />
                    Show deleted
                </label>

                <button className="btn btn-outline" onClick={() => {
                    setSearchTerm(''); setLevelFilter(''); setClassFilter('');
                    setStatusFilter(''); setYearFilter('');
                }}>
                    <i className="fas fa-times"></i> Clear
                </button>
                <button className="btn btn-outline" onClick={refresh}>
                    <i className="fas fa-sync-alt"></i> Refresh
                </button>

                {!isTeacher && (
                    <>
                        <button className="btn btn-primary" onClick={handleAddStudent}>
                            <i className="fas fa-plus"></i> Add Student
                        </button>
                        <button className="btn btn-success" onClick={handleExportCSV}>
                            <i className="fas fa-download"></i> Export
                        </button>
                        <button className="btn btn-warning" onClick={() => {
                            setBulkPromoteLevel('');
                            setBulkPromoteClass('');
                            setShowBulkPromoteModal(true);
                        }}>
                            <i className="fas fa-arrow-up"></i> Bulk Promote
                        </button>
                        <div className="file-upload-wrapper">
                            <input
                                type="file" ref={fileInputRef} accept=".csv"
                                onChange={handleImportCSV} id="csvFileInput"
                                disabled={importing}
                            />
                            <label htmlFor="csvFileInput" className="file-upload-label">
                                <i className="fas fa-upload"></i>{' '}
                                {importing ? 'Importing…' : 'Import CSV'}
                            </label>
                        </div>
                    </>
                )}
            </div>

            {/* Table */}
            <div className="table-container">
                <div className="table-wrapper">
                    <table>
                        <thead>
                            <tr>
                                <th>Student</th>
                                <th>ID</th>
                                <th>Age / Gender</th>
                                <th>Level</th>
                                <th>Class</th>
                                <th>Status</th>
                                {!isTeacher && <th>Actions</th>}
                            </tr>
                        </thead>
                        <tbody>{renderTable()}</tbody>
                    </table>
                </div>

                <div className="pagination">
                    <div className="info">
                        Showing {filteredStudents.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE_UI + 1}–
                        {Math.min(currentPage * PAGE_SIZE_UI, filteredStudents.length)} of {filteredStudents.length}
                        {students.length < stats.total + stats.deleted && (
                            <span style={{ marginLeft: 10, color: 'var(--gray)' }}>
                                (only first {students.length} loaded)
                            </span>
                        )}
                    </div>
                    <div className="pagination-btns">{paginationButtons}</div>
                </div>
            </div>

            {/* Add/Edit Modal */}
            {!isTeacher && showStudentModal && (
                <div className="modal-overlay active">
                    <div className="modal">
                        <div className="modal-header">
                            <h2>{editingStudent ? 'Edit Student' : 'Add Student'}</h2>
                            <button className="modal-close" onClick={() => setShowStudentModal(false)}>
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <form onSubmit={handleFormSubmit}>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>First Name <span className="required">*</span></label>
                                    <input type="text" required value={formData.firstName}
                                           onChange={(e) => setFormData({ ...formData, firstName: e.target.value })} />
                                </div>
                                <div className="form-group">
                                    <label>Last Name <span className="required">*</span></label>
                                    <input type="text" required value={formData.lastName}
                                           onChange={(e) => setFormData({ ...formData, lastName: e.target.value })} />
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Email Preview</label>
                                <div style={{ padding:'10px 15px', background:'var(--light)', borderRadius:8, fontSize:14 }}>
                                    {formData.firstName || formData.lastName
                                        ? <strong>{generateEmail(formData.firstName, formData.lastName)}</strong>
                                        : <span style={{ color:'var(--gray)' }}>Enter name to preview</span>}
                                </div>
                            </div>

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Level <span className="required">*</span></label>
                                    <select required value={formData.level}
                                            onChange={(e) => setFormData({ ...formData, level: e.target.value, class: '' })}>
                                        <option value="">Select Level</option>
                                        {LEVEL_ORDER.map((l) => <option key={l} value={l}>{getLevelDisplayName(l)}</option>)}
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>Class <span className="required">*</span></label>
                                    <select required value={formData.class}
                                            onChange={(e) => setFormData({ ...formData, class: e.target.value })}>
                                        <option value="">Select Class</option>
                                        {/* ← PATCHED: pass getLevelClasses */}
                                        {getClassOptions(formData.level, getLevelClasses).map((c) => (
                                            <option key={c} value={c}>{c}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Gender</label>
                                    <select value={formData.gender} onChange={(e) => setFormData({ ...formData, gender: e.target.value })}>
                                        <option value="">Select Gender</option>
                                        <option value="Male">Male</option>
                                        <option value="Female">Female</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>Date of Birth</label>
                                    <input type="date" value={formData.dateOfBirth} onChange={(e) => setFormData({ ...formData, dateOfBirth: e.target.value })} />
                                </div>
                                <div className="form-group">
                                    <label>Birth Cert No.</label>
                                    <input type="text" value={formData.birthCertNo} onChange={(e) => setFormData({ ...formData, birthCertNo: e.target.value })} />
                                </div>
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Admission Year</label>
                                    <input type="number" min="2000" max={new Date().getFullYear() + 1}
                                           value={formData.admissionYear}
                                           onChange={(e) => setFormData({ ...formData, admissionYear: e.target.value })} />
                                </div>
                                <div className="form-group">
                                    <label>Status</label>
                                    <select value={formData.status}
                                            onChange={(e) => setFormData({ ...formData, status: e.target.value })}>
                                        {STATUS_OPTIONS
                                            .filter((o) => !['promoted', 'archived', 'graduated', 'deleted'].includes(o.value))
                                            .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                </div>
                            </div>

                            {!editingStudent && (
                                <div className="form-group">
                                    <label>Admission Number</label>
                                    <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                                        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, cursor:'pointer' }}>
                                            <input type="checkbox" checked={formData.reserveIdNow}
                                                   onChange={(e) => setFormData({ ...formData, reserveIdNow: e.target.checked })} />
                                            Use automatic number
                                        </label>
                                        <input
                                            type="text" placeholder="or enter manually (numeric)"
                                            value={formData.manualStudentId}
                                            onChange={(e) => setFormData({
                                                ...formData,
                                                manualStudentId: e.target.value.replace(/\D/g, ''),
                                                reserveIdNow: e.target.value ? false : formData.reserveIdNow,
                                            })}
                                            style={{ flex: 1, minWidth: 150 }}
                                        />
                                    </div>
                                    <div style={{ fontSize:11, color:'var(--gray)', marginTop:4 }}>
                                        Numbers are reserved atomically on the server to prevent collisions.
                                    </div>
                                </div>
                            )}

                            <div className="form-group">
                                <label>Phone Number</label>
                                <input type="tel" value={formData.phone}
                                       onChange={(e) => setFormData({ ...formData, phone: e.target.value })} />
                            </div>
                            <div className="form-group">
                                <label>Address</label>
                                <textarea rows="2" value={formData.address}
                                          onChange={(e) => setFormData({ ...formData, address: e.target.value })} />
                            </div>
                            <div className="form-group">
                                <label>Guardian Name</label>
                                <input type="text" value={formData.guardian}
                                       onChange={(e) => setFormData({ ...formData, guardian: e.target.value })} />
                            </div>
                            <div className="form-group">
                                <label>Guardian Phone</label>
                                <input type="tel" value={formData.guardianPhone}
                                       onChange={(e) => setFormData({ ...formData, guardianPhone: e.target.value })} />
                            </div>

                            <div className="modal-footer">
                                <button type="button" className="btn btn-outline"
                                        onClick={() => setShowStudentModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary">
                                    {editingStudent ? 'Update' : 'Save'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* History Modal */}
            {showHistoryModal && selectedStudent && (
                <div className="modal-overlay active">
                    <div className="modal" style={{ maxWidth:520 }}>
                        <div className="modal-header">
                            <h2>History — {selectedStudent.firstName} {selectedStudent.lastName}</h2>
                            <button className="modal-close" onClick={() => setShowHistoryModal(false)}>
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <div style={{ marginBottom:15, display:'flex', gap:10, flexWrap:'wrap' }}>
                            <select value={historyYearFilter}
                                    onChange={(e) => setHistoryYearFilter(e.target.value)}
                                    style={{ padding:'8px 12px', border:'2px solid var(--border)', borderRadius:6 }}>
                                <option value="">All Years</option>
                                {uniqueYears.map((y) => <option key={y} value={y}>{y}</option>)}
                            </select>
                            <select value={historyClassFilter}
                                    onChange={(e) => setHistoryClassFilter(e.target.value)}
                                    style={{ padding:'8px 12px', border:'2px solid var(--border)', borderRadius:6 }}>
                                <option value="">All Classes</option>
                                {historyClassOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <button onClick={() => { setHistoryYearFilter(''); setHistoryClassFilter(''); }}
                                    style={{ padding:'8px 12px', border:'1px solid var(--border)', borderRadius:6, background:'var(--light)', cursor:'pointer' }}>
                                Clear
                            </button>
                        </div>

                        {historyContent.length === 0 ? (
                            <div style={{ textAlign:'center', padding:30, color:'var(--gray)' }}>
                                <i className="fas fa-info-circle" style={{ fontSize:24, display:'block', marginBottom:10 }}></i>
                                No history records.
                            </div>
                        ) : (
                            historyContent.map((h, i) => (
                                <div key={i} className="history-item">
                                    <div>
                                        <span className="level-info">
                                            {getLevelDisplayName(h.fromLevel) || h.fromLevel} → {getLevelDisplayName(h.toLevel) || h.toLevel}
                                        </span>
                                        <div style={{ fontSize:12, color:'var(--gray)' }}>
                                            {h.fromClass} → {h.toClass}
                                            {h.year && <span style={{ marginLeft:8 }}>📅 {h.year}</span>}
                                            {h.type && <span style={{ marginLeft:8, textTransform:'capitalize' }}>· {h.type}</span>}
                                        </div>
                                    </div>
                                    <div className="date-info">{h.date ? new Date(h.date).toLocaleDateString() : 'N/A'}</div>
                                </div>
                            ))
                        )}
                        <div className="modal-footer">
                            <button className="btn btn-outline" onClick={() => setShowHistoryModal(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Promote Modal */}
            {!isTeacher && showPromoteModal && promotingStudent && (() => {
                const targets = getPromotionTargets(promotingStudent);
                const chosen = targets.find((t) => t.key === promoteData.targetKey);
                // ← PATCHED: pass getLevelClasses
                const terminal = chosen
                    ? isInTerminalClass(chosen.level, chosen.class, schoolHighestLevel, getLevelClasses)
                    : false;
                return (
                    <div className="modal-overlay active">
                        <div className="modal" style={{ maxWidth:520 }}>
                            <div className="modal-header">
                                <h2>Promote Student</h2>
                                <button className="modal-close" onClick={() => setShowPromoteModal(false)}>
                                    <i className="fas fa-times"></i>
                                </button>
                            </div>
                            <form onSubmit={(e) => { e.preventDefault(); handlePromoteSubmit(); }}>
                                <div className="form-group">
                                    <label>Student</label>
                                    <p style={{ fontWeight:600 }}>
                                        {promotingStudent.firstName} {promotingStudent.lastName}
                                    </p>
                                </div>
                                <div className="form-group">
                                    <label>Current</label>
                                    <p style={{ color:'var(--gray)' }}>
                                        {getLevelDisplayName(promotingStudent.level)} / {promotingStudent.class}
                                    </p>
                                </div>
                                <div className="form-group">
                                    <label>Promote To <span className="required">*</span></label>
                                    <select required value={promoteData.targetKey}
                                            onChange={(e) => setPromoteData({
                                                ...promoteData, targetKey: e.target.value
                                            })}>
                                        <option value="">Select target</option>
                                        {targets.map((t) => (
                                            <option key={t.key} value={t.key}>{t.label}</option>
                                        ))}
                                    </select>
                                    <div style={{ fontSize:11, color:'var(--gray)', marginTop:4 }}>
                                        Only valid progressions for this student are shown.
                                    </div>
                                </div>
                                <div className="form-group">
                                    <label>Promotion Year</label>
                                    <input type="number" min="2000" max={new Date().getFullYear() + 1}
                                           value={promoteData.promotionYear}
                                           onChange={(e) => setPromoteData({ ...promoteData, promotionYear: e.target.value })} />
                                </div>

                                {terminal && (
                                    <div style={{
                                        padding:12, background:'#e8f5e9', border:'1px solid #81c784',
                                        borderRadius:8, marginBottom:15, color:'#1b5e20'
                                    }}>
                                        <i className="fas fa-graduation-cap"></i>{' '}
                                        This is the school's terminal class. The student will be marked as
                                        <strong> graduated</strong> (a distinct status from archived).
                                    </div>
                                )}

                                <div className="modal-footer">
                                    <button type="button" className="btn btn-outline"
                                            onClick={() => setShowPromoteModal(false)}>Cancel</button>
                                    <button type="submit" className="btn btn-success">Promote</button>
                                </div>
                            </form>
                        </div>
                    </div>
                );
            })()}

            {/* Bulk Promote Modal */}
            {!isTeacher && showBulkPromoteModal && (
                <div className="modal-overlay active">
                    <div className="modal" style={{ maxWidth:600 }}>
                        <div className="modal-header">
                            <h2>Bulk Promote</h2>
                            <button className="modal-close" onClick={() => setShowBulkPromoteModal(false)}>
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <div className="form-group">
                            <label>Target Level</label>
                            <select value={bulkPromoteLevel}
                                    onChange={(e) => {
                                        setBulkPromoteLevel(e.target.value);
                                        // ← PATCHED: pass getLevelClasses
                                        setBulkPromoteClass(getClassOptions(e.target.value, getLevelClasses)?.[0] || '');
                                    }}>
                                <option value="">Select Level</option>
                                {LEVEL_ORDER.map((l) => <option key={l} value={l}>{getLevelDisplayName(l)}</option>)}
                            </select>
                        </div>
                        <div className="form-group">
                            <label>Target Class</label>
                            <select value={bulkPromoteClass}
                                    onChange={(e) => setBulkPromoteClass(e.target.value)}>
                                <option value="">Select Class</option>
                                {/* ← PATCHED: pass getLevelClasses */}
                                {getClassOptions(bulkPromoteLevel, getLevelClasses).map((c) => (
                                    <option key={c} value={c}>{c}</option>
                                ))}
                            </select>
                        </div>

                        {bulkPromoteLevel && bulkPromoteClass && (
                            <div style={{ padding:12, background:'var(--light)', borderRadius:8, marginBottom:15 }}>
                                <strong>{computeBulkPromoteTargets().length}</strong> students eligible.
                            </div>
                        )}

                        {/* ← PATCHED: pass getLevelClasses */}
                        {isInTerminalClass(bulkPromoteLevel, bulkPromoteClass, schoolHighestLevel, getLevelClasses) && (
                            <div style={{
                                padding:12, background:'#e8f5e9', border:'1px solid #81c784',
                                borderRadius:8, marginBottom:15, color:'#1b5e20'
                            }}>
                                <i className="fas fa-graduation-cap"></i> These students will be marked as <strong>graduated</strong>.
                            </div>
                        )}

                        <div className="modal-footer">
                            <button type="button" className="btn btn-outline"
                                    onClick={() => setShowBulkPromoteModal(false)}>Cancel</button>
                            <button type="button" className="btn btn-success"
                                    onClick={confirmBulkPromote}
                                    disabled={!bulkPromoteLevel || !bulkPromoteClass}>
                                Confirm Bulk Promotion
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Import Results */}
            {showImportResults && importResults && (
                <div className="modal-overlay active">
                    <div className="modal" style={{ maxWidth:600 }}>
                        <div className="modal-header">
                            <h2>Import Results</h2>
                            <button className="modal-close" onClick={() => setShowImportResults(false)}>
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <p><strong>Imported:</strong> {importResults.added}</p>
                        <p><strong>Skipped (errors):</strong> {importResults.errors.length}</p>
                        {importResults.errors.length > 0 && (
                            <div style={{
                                maxHeight:300, overflowY:'auto', background:'#f8f9fa',
                                padding:10, borderRadius:8, fontSize:13
                            }}>
                                {importResults.errors.map((e, i) => <div key={i}>{e}</div>)}
                            </div>
                        )}
                        <div className="modal-footer">
                            <button className="btn btn-outline" onClick={() => setShowImportResults(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
