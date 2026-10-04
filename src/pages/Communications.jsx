// src/pages/Communications.jsx
//
// Merged Communications page:
//   • Parent / student messages  (personalized with {{studentName}}, {{feeBalance}}, …)
//   • Teacher messages           (personalized with {{teacherName}}, {{teacherSubject}}, …)
//   • Transport routing:
//       - Android app  → native SIM bridge (deviceSms.js)
//       - Mobile web   → HTTP SMS gateway (sms_gateway config)
//       - Desktop web  → USB / GSM modem (POST /api/send-sms-modem)
//
// Requires:
//   src/services/deviceSms.js
//   src/pages/Communications.css

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, where
} from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { db } from '../firebase';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import {
    getDeviceSims, isDeviceSmsAvailable, requestSmsPermissions, sendDeviceSms
} from '../services/deviceSms';
import './Communications.css';

/* ============================================================
   Constants
   ============================================================ */

const SCHOOL_ADMIN_ROLES = new Set(['admin', 'user', 'school_admin', 'super-admin']);
const MAX_RECIPIENTS_PER_CAMPAIGN = 100;

const SMS_BATCH_SIZE = 30;
const SMS_PART_LENGTH = 160;

// Transport used to physically dispatch each SMS.
const TRANSPORT = {
    NATIVE: 'android-native',   // Android WebView bridge (device SIM)
    GATEWAY: 'http-gateway',    // Remote HTTP SMS gateway
    MODEM: 'usb-modem'          // Server-side USB / GSM modem
};

/* ============================================================
   Built-in templates — PARENTS & STUDENTS
   ============================================================ */

const PARENT_TEMPLATES = [
    { id: 'announcement',  name: 'General announcement',            category: 'General',           audience: 'parents',
      body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), {{message}}' },
    { id: 'attendance',    name: 'Attendance / absence notice',      category: 'Attendance',        audience: 'parents',
      body: 'Dear parent/guardian, {{studentName}} (Adm. {{admissionNumber}}) was marked {{attendanceStatus}} on {{date}}. Please contact the school if you need assistance.' },
    { id: 'results',       name: 'Assessment results',               category: 'Results',           audience: 'parents',
      body: 'Dear parent/guardian, results for {{studentName}} (Adm. {{admissionNumber}}) in {{assessment}} are: {{assessmentResults}}.' },
    { id: 'fees',          name: 'Fee balance reminder',             category: 'Fees',              audience: 'parents',
      body: 'Dear parent/guardian, {{studentName}} (Adm. {{admissionNumber}}) has an outstanding fee balance of KES {{feeBalance}}. Kindly contact the school to discuss payment.' },
    { id: 'meeting',       name: 'Parent meeting invitation',        category: 'Meetings',          audience: 'parents',
      body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), you are invited to a school meeting on {{date}} at {{time}}. Venue: {{venue}}.' },
    { id: 'event',         name: 'School event reminder',            category: 'Events',            audience: 'parents',
      body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), this is a reminder that {{eventName}} will take place on {{date}} at {{time}}. {{message}}' },
    { id: 'closure',       name: 'School closure / early dismissal', category: 'Notices',           audience: 'parents',
      body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), please note that {{schoolName}} will {{closureDetails}}. Kindly make the necessary arrangements.' },
    { id: 'term',          name: 'Term opening / closing',           category: 'Academic calendar', audience: 'parents',
      body: 'Dear parent/guardian, {{studentName}} (Adm. {{admissionNumber}}): {{termDetails}}. Thank you.' },
    { id: 'exam',          name: 'Examination timetable notice',     category: 'Examinations',      audience: 'parents',
      body: 'Dear parent/guardian, {{studentName}} (Adm. {{admissionNumber}}) will sit {{examName}} from {{date}}. Please ensure they are prepared.' },
    { id: 'uniform',       name: 'Uniform / supplies reminder',      category: 'Student welfare',   audience: 'parents',
      body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), please note: {{message}}' },
    { id: 'health',        name: 'Health / wellbeing update',        category: 'Student welfare',   audience: 'parents',
      body: 'Dear parent/guardian, please contact {{schoolName}} regarding an important wellbeing matter for {{studentName}} (Adm. {{admissionNumber}}).' },
    { id: 'transport',     name: 'Transport update',                 category: 'Transport',         audience: 'parents',
      body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), transport update: {{message}}' },
    { id: 'congratulations', name: 'Achievement / congratulations',  category: 'Celebrations',      audience: 'parents',
      body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), congratulations for {{achievement}}. We are proud of this achievement.' },
    { id: 'discipline',    name: 'Request for parent discussion',    category: 'Meetings',          audience: 'parents',
      body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), please contact the school to arrange a confidential discussion.' },
    { id: 'emergency',     name: 'Urgent school alert',              category: 'Urgent alerts',     audience: 'parents',
      body: 'URGENT: Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), {{message}} Please follow the instructions provided by {{schoolName}}.' },
    { id: 'parent_custom', name: 'Custom parent message',            category: 'General',           audience: 'parents',
      body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), {{message}}' }
];

/* ============================================================
   Built-in templates — TEACHERS
   ============================================================ */

const TEACHER_TEMPLATES = [
    { id: 'teacher_announcement', name: 'Staff announcement',             category: 'General',        audience: 'teachers',
      body: 'Dear {{teacherName}}, {{message}}' },
    { id: 'teacher_meeting',      name: 'Staff meeting invitation',       category: 'Meetings',       audience: 'teachers',
      body: 'Dear {{teacherName}}, you are invited to a staff meeting on {{date}} at {{time}}. Venue: {{venue}}. Agenda: {{message}}' },
    { id: 'teacher_timetable',    name: 'Timetable / duty update',        category: 'Administration', audience: 'teachers',
      body: 'Dear {{teacherName}}, please note the following update regarding your teaching timetable / duty roster: {{message}}' },
    { id: 'teacher_deadline',     name: 'Deadline reminder (marks / reports)', category: 'Administration', audience: 'teachers',
      body: 'Dear {{teacherName}}, this is a reminder that {{taskDescription}} is due on {{date}}. Kindly ensure your submission is complete. — {{schoolName}}' },
    { id: 'teacher_training',     name: 'Training / workshop notice',     category: 'Professional',   audience: 'teachers',
      body: 'Dear {{teacherName}}, you are invited to a professional development workshop on {{date}} at {{time}}. Venue: {{venue}}. Topic: {{message}}' },
    { id: 'teacher_urgent',       name: 'Urgent staff alert',             category: 'Urgent alerts',  audience: 'teachers',
      body: 'URGENT: Dear {{teacherName}}, {{message}} Please respond immediately. — {{schoolName}}' },
    { id: 'teacher_custom',       name: 'Custom teacher message',         category: 'General',        audience: 'teachers',
      body: 'Dear {{teacherName}}, {{message}}' }
];

const ALL_TEMPLATES = [...PARENT_TEMPLATES, ...TEACHER_TEMPLATES];

/* ============================================================
   Utilities
   ============================================================ */

const studentName = (student) =>
    [student?.firstName, student?.lastName].filter(Boolean).join(' ') || 'Student';

const teacherName = (teacher) =>
    [teacher?.firstName, teacher?.lastName].filter(Boolean).join(' ') || 'Teacher';

const getStudentPhone = (student) =>
    student?.parentPhone || student?.parentPhoneNumber
    || student?.guardianPhone || student?.guardianPhoneNumber
    || student?.phoneNumber || student?.phone || '';

const getTeacherPhone = (teacher) =>
    teacher?.phone || teacher?.phoneNumber || teacher?.mobile || '';

const getBalance = (balance) => {
    const amount = typeof balance === 'number'
        ? balance
        : Number(balance?.balance ?? balance?.amountDue ?? balance?.outstandingBalance ?? 0);
    return Number.isFinite(amount) ? amount : 0;
};

const normalizePhone = (phone) => String(phone || '').replace(/[\s()-]/g, '');

const isValidPhone = (phone) => /^\+?\d{7,15}$/.test(normalizePhone(phone));

const formatTimestamp = (timestamp) => {
    const date = timestamp?.toDate?.() || (timestamp ? new Date(timestamp) : null);
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
};

const detectEnvironment = () => {
    if (isDeviceSmsAvailable()) return TRANSPORT.NATIVE;
    if (typeof navigator === 'undefined') return TRANSPORT.MODEM;
    const ua = navigator.userAgent || '';
    const isMobileUA = /Android|iPhone|iPad|iPod|Mobile|Windows Phone|BlackBerry|Opera Mini/i.test(ua);
    const isTouchTablet = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
    return (isMobileUA || isTouchTablet) ? TRANSPORT.GATEWAY : TRANSPORT.MODEM;
};

/* ============================================================
   Component
   ============================================================ */

export default function Communication() {
    const { currentUser, userData, userRole } = useAuth();
    const schoolId = userData?.schoolId;
    const isAdmin = SCHOOL_ADMIN_ROLES.has(userRole || userData?.role);

    /* ---------- Core state ---------- */
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [activeTab, setActiveTab] = useState('compose');

    /* ---------- Data ---------- */
    const [students, setStudents] = useState([]);
    const [teachers, setTeachers] = useState([]);
    const [balances, setBalances] = useState({});
    const [scores, setScores] = useState([]);
    const [school, setSchool] = useState({ name: '', phone: '' });
    const [history, setHistory] = useState([]);
    const [savedTemplates, setSavedTemplates] = useState([]);

    /* ---------- Transport: SIM (Android) ---------- */
    const [sims, setSims] = useState([]);
    const [selectedSimId, setSelectedSimId] = useState('');
    const [simMessage, setSimMessage] = useState('');
    const [detectingSims, setDetectingSims] = useState(false);

    /* ---------- Transport: modem (desktop) ---------- */
    const [modemStatus, setModemStatus] = useState({
        available: false, port: '', signal: 0, checked: false
    });

    /* ---------- Transport: HTTP gateway ---------- */
    const [gatewayStatus, setGatewayStatus] = useState('disconnected');
    const [gatewayConfig, setGatewayConfig] = useState({
        apiUrl: '', apiKey: '', deviceId: '', defaultSender: ''
    });

    /* ---------- Send state ---------- */
    const [sending, setSending] = useState(false);
    const [sendProgress, setSendProgress] = useState({ done: 0, total: 0, ok: 0, failed: 0 });
    const [notice, setNotice] = useState({ text: '', type: '' });

    /* ---------- Recipient selection ---------- */
    const [recipientKind, setRecipientKind] = useState('parents');   // 'parents' | 'teachers'
    const [search, setSearch] = useState('');
    const [levelFilter, setLevelFilter] = useState('');
    const [classFilter, setClassFilter] = useState('');
    const [subjectFilter, setSubjectFilter] = useState('');
    const [selectedStudentIds, setSelectedStudentIds] = useState([]);
    const [selectedTeacherIds, setSelectedTeacherIds] = useState([]);

    /* ---------- Compose ---------- */
    const [selectedTemplateId, setSelectedTemplateId] = useState('announcement');
    const [messageBody, setMessageBody] = useState(PARENT_TEMPLATES[0].body);
    const [adminPhone, setAdminPhone] = useState('');
    const [assessmentKey, setAssessmentKey] = useState('');
    const [extraFields, setExtraFields] = useState({
        message: '', date: '', time: '', venue: '', eventName: '',
        closureDetails: '', termDetails: '', examName: '', achievement: '',
        attendanceStatus: '', taskDescription: ''
    });

    /* ---------- Refs ---------- */
    const detectedTransport = useRef(detectEnvironment());

    const notify = useCallback((text, type = 'info') => {
        setNotice({ text, type });
    }, []);

    /* ============================================================
       Load data
       ============================================================ */

    const loadData = useCallback(async () => {
        if (!schoolId || !isAdmin) { setLoading(false); return; }
        setLoading(true);
        setLoadError('');
        try {
            const [
                schoolSnap, studentSnap, teacherSnap,
                balanceSnap, scoreSnap, historySnap,
                templateSnap, gatewaySnap
            ] = await Promise.all([
                getDoc(doc(db, 'schools', schoolId)),
                getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolId))),
                getDocs(query(collection(db, 'teachers'), where('schoolId', '==', schoolId))),
                getDocs(query(collection(db, 'student_balances'), where('schoolId', '==', schoolId))),
                getDocs(query(collection(db, 'student_scores'), where('schoolId', '==', schoolId))),
                getDocs(query(collection(db, 'sms_history'), where('schoolId', '==', schoolId))),
                getDocs(query(collection(db, 'sms_templates'), where('schoolId', '==', schoolId))),
                getDoc(doc(db, 'sms_gateway', schoolId)).catch(() => null)
            ]);

            const schoolData = schoolSnap.exists() ? schoolSnap.data() : {};
            const activeStudents = studentSnap.docs
                .map((item) => ({ id: item.id, ...item.data() }))
                .filter((s) => s.status !== 'archived' && s.isDeleted !== true);
            const activeTeachers = teacherSnap.docs
                .map((item) => ({ id: item.id, ...item.data() }))
                .filter((t) => t.status !== 'inactive' && t.isDeleted !== true);

            const balanceMap = {};
            balanceSnap.forEach((item) => {
                const data = item.data();
                balanceMap[data.studentId] = (balanceMap[data.studentId] || 0) + getBalance(data);
            });

            setSchool({
                name: schoolData.name || userData?.schoolName || 'School',
                phone: schoolData.phone || ''
            });
            setAdminPhone(
                userData?.phone || userData?.phoneNumber
                || schoolData.adminPhone || schoolData.phone || ''
            );

            setStudents(activeStudents);
            setTeachers(activeTeachers);
            setBalances(balanceMap);
            setScores(scoreSnap.docs.map((item) => ({ id: item.id, ...item.data() })));

            setHistory(historySnap.docs
                .map((item) => ({ id: item.id, ...item.data() }))
                .sort((a, b) => {
                    const aTime = a.createdAt?.toMillis?.() || 0;
                    const bTime = b.createdAt?.toMillis?.() || 0;
                    return bTime - aTime;
                })
                .slice(0, 100));

            setSavedTemplates(templateSnap.docs
                .map((item) => ({ id: item.id, ...item.data() }))
                .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))));

            if (gatewaySnap && gatewaySnap.exists()) {
                const g = gatewaySnap.data();
                setGatewayStatus(g.status || (g.apiUrl ? 'connected' : 'disconnected'));
                setGatewayConfig({
                    apiUrl: g.apiUrl || '',
                    apiKey: g.apiKey || '',
                    deviceId: g.deviceId || '',
                    defaultSender: g.defaultSender || ''
                });
            }
        } catch (error) {
            console.error('[Communications] load failed:', error);
            setLoadError(error?.message || 'Unable to load school communication data.');
        } finally {
            setLoading(false);
        }
    }, [schoolId, isAdmin, userData]);

    useEffect(() => { loadData(); }, [loadData]);

    /* Modem status check (desktop only) */
    useEffect(() => {
        if (detectedTransport.current !== TRANSPORT.MODEM) return;
        checkModemStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const checkModemStatus = async () => {
        try {
            const res = await fetch('/api/send-sms-modem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'status' })
            });
            const data = await res.json().catch(() => ({}));
            setModemStatus({
                available: !!data.connected,
                port: data.port || '',
                signal: data.signal || 0,
                checked: true
            });
        } catch {
            setModemStatus({ available: false, port: '', signal: 0, checked: true });
        }
    };

    /* ============================================================
       Derived
       ============================================================ */

    const assessments = useMemo(() => {
        const unique = new Map();
        scores.forEach((score) => {
            if (!score.assessmentType) return;
            const key = `${score.term || ''}::${score.assessmentType}`;
            unique.set(key, { key, term: score.term || '', type: score.assessmentType });
        });
        return [...unique.values()].sort((a, b) =>
            `${a.term} ${a.type}`.localeCompare(`${b.term} ${b.type}`));
    }, [scores]);

    useEffect(() => {
        if (!assessmentKey && assessments.length) setAssessmentKey(assessments[0].key);
    }, [assessmentKey, assessments]);

    const selectedAssessment = assessments.find((item) => item.key === assessmentKey);

    const availableTemplates = useMemo(() => {
        const audience = recipientKind === 'teachers' ? 'teachers' : 'parents';
        const builtIn = ALL_TEMPLATES.filter((t) => t.audience === audience);
        const saved = savedTemplates.map((t) => ({
            id: t.id,
            name: t.name || 'Saved template',
            category: t.category || 'Saved',
            audience: t.audience || audience,
            body: t.body || t.content || '',
            saved: true
        }));
        return [...builtIn, ...saved];
    }, [recipientKind, savedTemplates]);

    const selectedTemplate = availableTemplates.find((t) => t.id === selectedTemplateId)
        || availableTemplates[0];

    const filteredStudents = useMemo(() => {
        const term = search.trim().toLowerCase();
        return students.filter((student) => {
            const name = studentName(student).toLowerCase();
            const admission = String(student.admissionNumber || student.studentId || '').toLowerCase();
            return (!term || name.includes(term) || admission.includes(term))
                && (!levelFilter || student.level === levelFilter)
                && (!classFilter || student.class === classFilter);
        });
    }, [students, search, levelFilter, classFilter]);

    const filteredTeachers = useMemo(() => {
        const term = search.trim().toLowerCase();
        return teachers.filter((teacher) => {
            const name = teacherName(teacher).toLowerCase();
            const email = String(teacher.email || '').toLowerCase();
            const subs = Array.isArray(teacher.subjects)
                ? teacher.subjects
                : (typeof teacher.subjects === 'string' ? teacher.subjects.split(',').map((x) => x.trim()) : []);
            const levels = Array.isArray(teacher.levels)
                ? teacher.levels
                : (teacher.level ? [teacher.level] : []);
            return (!term || name.includes(term) || email.includes(term) || subs.join(' ').toLowerCase().includes(term))
                && (!levelFilter || levels.includes(levelFilter))
                && (!subjectFilter || subs.includes(subjectFilter));
        });
    }, [teachers, search, levelFilter, subjectFilter]);

    const availableLevels = useMemo(() => {
        const set = new Set();
        if (recipientKind === 'teachers') {
            teachers.forEach((t) => {
                const levels = Array.isArray(t.levels) ? t.levels : (t.level ? [t.level] : []);
                levels.forEach((l) => l && set.add(l));
            });
        } else {
            students.forEach((s) => s.level && set.add(s.level));
        }
        return [...set].sort();
    }, [recipientKind, students, teachers]);

    const availableClasses = useMemo(() => {
        const set = new Set();
        students.forEach((s) => s.class && set.add(s.class));
        return [...set].sort();
    }, [students]);

    const availableSubjects = useMemo(() => {
        const set = new Set();
        teachers.forEach((t) => {
            const subs = Array.isArray(t.subjects)
                ? t.subjects
                : (typeof t.subjects === 'string' ? t.subjects.split(',').map((x) => x.trim()) : []);
            subs.filter(Boolean).forEach((s) => set.add(s));
        });
        return [...set].sort();
    }, [teachers]);

    const selectedStudents = students.filter((s) => selectedStudentIds.includes(s.id));
    const selectedTeachers = teachers.filter((t) => selectedTeacherIds.includes(t.id));
    const selectedCount = recipientKind === 'teachers'
        ? selectedTeacherIds.length
        : selectedStudentIds.length;

    const selectedSim = sims.find((sim) => String(sim.subscriptionId) === selectedSimId);

    /* ============================================================
       SIM detection
       ============================================================ */

    const refreshSims = async () => {
        setDetectingSims(true);
        setSimMessage('');
        try {
            await requestSmsPermissions();
            const result = await getDeviceSims();
            const available = result.sims || [];
            setSims(available);
            setSelectedSimId((current) => (
                available.some((sim) => String(sim.subscriptionId) === current)
                    ? current
                    : String(available[0]?.subscriptionId ?? '')
            ));
            setSimMessage(available.length
                ? `${available.length} active SIM${available.length === 1 ? '' : 's'} detected.`
                : 'No active SIM cards found.');
        } catch (error) {
            console.error('[Communications] SIM detection failed:', error);
            setSims([]);
            setSelectedSimId('');
            setSimMessage(error.message || 'Unable to detect SIM cards.');
        } finally {
            setDetectingSims(false);
        }
    };

    /* ============================================================
       Template fill
       ============================================================ */

    const buildMessageForStudent = (student) => {
        const assessmentScores = selectedAssessment
            ? scores.filter((score) =>
                score.studentId === student.id
                && (score.term || '') === selectedAssessment.term
                && score.assessmentType === selectedAssessment.type)
            : [];
        const assessmentResults = assessmentScores.length
            ? assessmentScores.map((score) =>
                `${score.subject || 'Subject'}: ${score.score ?? '—'}${score.grade ? ` (${score.grade})` : ''}`
            ).join(', ')
            : 'No results have been recorded for this assessment.';
        const values = {
            studentName: studentName(student),
            admissionNumber: student.admissionNumber || student.studentId || 'N/A',
            parentName: student.parentName || student.guardianName || student.guardian || 'Parent/guardian',
            feeBalance: getBalance(balances[student.id]).toLocaleString(),
            assessment: selectedAssessment
                ? `${selectedAssessment.term} ${selectedAssessment.type}`
                : 'selected assessment',
            assessmentResults,
            schoolName: school.name || 'School',
            adminPhone,
            ...extraFields
        };
        return applyVariables(messageBody, values);
    };

    const buildMessageForTeacher = (teacher) => {
        const subs = Array.isArray(teacher.subjects)
            ? teacher.subjects
            : (typeof teacher.subjects === 'string' ? teacher.subjects.split(',').map((x) => x.trim()) : []);
        const classes = Array.isArray(teacher.classes) ? teacher.classes : [];
        const levels = Array.isArray(teacher.levels) ? teacher.levels : (teacher.level ? [teacher.level] : []);
        const values = {
            teacherName: teacherName(teacher),
            teacherSubject: subs.join(', ') || 'N/A',
            teacherClasses: classes.join(', ') || 'N/A',
            teacherLevel: levels.join(', ') || 'N/A',
            teacherPhone: getTeacherPhone(teacher) || 'N/A',
            schoolName: school.name || 'School',
            adminPhone,
            ...extraFields
        };
        return applyVariables(messageBody, values);
    };

    const applyVariables = (template, values) => {
        const body = String(template || '').replace(
            /\{\{([A-Za-z]+)\}\}/g,
            (_, key) => values[key] ?? ''
        );
        const footer = `${school.name || 'School'}. For more information contact the school via ${(adminPhone || '').trim()}.`;
        return `${body.trim()}\n\n${footer}`;
    };

    const handleTemplateChange = (templateId) => {
        setSelectedTemplateId(templateId);
        const template = availableTemplates.find((t) => t.id === templateId);
        if (template) setMessageBody(template.body || '');
    };

    useEffect(() => {
        // When switching between parents and teachers, reset to the first
        // template of the correct audience.
        const first = availableTemplates[0];
        if (first && !availableTemplates.some((t) => t.id === selectedTemplateId)) {
            setSelectedTemplateId(first.id);
            setMessageBody(first.body || '');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recipientKind]);

    /* ============================================================
       Recipient toggles
       ============================================================ */

    const toggleStudent = (id) => {
        setSelectedStudentIds((current) => current.includes(id)
            ? current.filter((x) => x !== id)
            : current.length >= MAX_RECIPIENTS_PER_CAMPAIGN
                ? current
                : [...current, id]);
    };

    const toggleTeacher = (id) => {
        setSelectedTeacherIds((current) => current.includes(id)
            ? current.filter((x) => x !== id)
            : current.length >= MAX_RECIPIENTS_PER_CAMPAIGN
                ? current
                : [...current, id]);
    };

    const selectVisibleStudents = (checked) => {
        setSelectedStudentIds((current) => {
            const visible = filteredStudents.map((s) => s.id);
            if (!checked) return current.filter((id) => !visible.includes(id));
            const next = [...current];
            visible.forEach((id) => {
                if (next.length < MAX_RECIPIENTS_PER_CAMPAIGN && !next.includes(id)) next.push(id);
            });
            return next;
        });
    };

    const selectVisibleTeachers = (checked) => {
        setSelectedTeacherIds((current) => {
            const visible = filteredTeachers.map((t) => t.id);
            if (!checked) return current.filter((id) => !visible.includes(id));
            const next = [...current];
            visible.forEach((id) => {
                if (next.length < MAX_RECIPIENTS_PER_CAMPAIGN && !next.includes(id)) next.push(id);
            });
            return next;
        });
    };

    /* ============================================================
       Sending — dispatches to whichever transport is active
       ============================================================ */

    const sendBatchViaNative = async (items) => {
        const results = [];
        for (const item of items) {
            try {
                await sendDeviceSms({
                    phoneNumber: normalizePhone(item.phone),
                    message: item.message,
                    subscriptionId: Number(selectedSim?.subscriptionId) || -1
                });
                results.push({ ...item, success: true });
            } catch (error) {
                results.push({ ...item, success: false, error: error.message });
            }
        }
        return results;
    };

    const sendBatchViaModem = async (items) => {
        const res = await fetch('/api/send-sms-modem', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'send',
                numbers: items.map((i) => normalizePhone(i.phone)),
                message: items[0]?.message || '',
                schoolId,
                sender: gatewayConfig.defaultSender || school.name || ''
            })
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Modem endpoint ${res.status}: ${text || 'unknown'}`);
        }
        const data = await res.json().catch(() => ({}));
        // data.results: [{ number, success, error? }] — merge by index.
        if (Array.isArray(data.results)) {
            return items.map((item, i) => {
                const r = data.results[i] || {};
                return { ...item, success: r.success !== false, error: r.error };
            });
        }
        return items.map((item) => ({ ...item, success: data.success !== false }));
    };

    const sendBatchViaGateway = async (items) => {
        const endpoint = gatewayConfig.apiUrl || '/.netlify/functions/send-sms';
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(gatewayConfig.apiKey ? { Authorization: `Bearer ${gatewayConfig.apiKey}` } : {})
            },
            body: JSON.stringify({
                numbers: items.map((i) => normalizePhone(i.phone)),
                phoneNumber: normalizePhone(items[0]?.phone),
                message: items[0]?.message || '',
                subject: selectedTemplate?.name || 'School message',
                deviceId: gatewayConfig.deviceId,
                sender: gatewayConfig.defaultSender || school.name || ''
            })
        });
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.results)) {
            return items.map((item, i) => {
                const r = data.results[i] || {};
                return { ...item, success: r.success !== false, error: r.error };
            });
        }
        return items.map((item) => ({ ...item, success: data.success !== false, error: data.error }));
    };

    const dispatchBatch = async (items) => {
        switch (detectedTransport.current) {
            case TRANSPORT.NATIVE:  return sendBatchViaNative(items);
            case TRANSPORT.MODEM:   return sendBatchViaModem(items);
            case TRANSPORT.GATEWAY:
            default:                return sendBatchViaGateway(items);
        }
    };

    /* ============================================================
       Send handler
       ============================================================ */

    const handleSend = async () => {
        const transport = detectedTransport.current;

        /* Validation */
        if (!selectedCount) {
            return notify(`Select at least one ${recipientKind === 'teachers' ? 'teacher' : 'student'}.`, 'error');
        }
        if (!messageBody.trim()) return notify('Enter a message before sending.', 'error');
        if (!isValidPhone(adminPhone)) {
            return notify('Enter a valid school contact phone number for the message footer.', 'error');
        }

        if (transport === TRANSPORT.NATIVE && !selectedSim) {
            return notify('Detect and select an active SIM before sending.', 'error');
        }
        if (transport === TRANSPORT.MODEM && !modemStatus.available) {
            return notify('Modem not detected. Connect a USB / GSM modem and refresh.', 'error');
        }
        if (transport === TRANSPORT.GATEWAY && gatewayStatus !== 'connected') {
            return notify('SMS gateway is not connected. Check the gateway settings.', 'error');
        }

        /* Build recipient list */
        const isTeacher = recipientKind === 'teachers';
        const chosen = isTeacher ? selectedTeachers : selectedStudents;
        const phoneOf = isTeacher ? getTeacherPhone : getStudentPhone;
        const buildMessage = isTeacher ? buildMessageForTeacher : buildMessageForStudent;

        const missingPhone = chosen.filter((r) => !isValidPhone(phoneOf(r)));
        const recipients = chosen.filter((r) => isValidPhone(phoneOf(r)));
        if (!recipients.length) {
            return notify(
                `The selected ${isTeacher ? 'teachers' : 'students'} do not have valid phone numbers.`,
                'error'
            );
        }
        if (missingPhone.length && !window.confirm(
            `${missingPhone.length} selected ${isTeacher ? 'teacher(s)' : 'student(s)'} have no valid phone number and will be skipped. Send to the remaining ${recipients.length}?`
        )) return;

        const transportLabel = transport === TRANSPORT.NATIVE
            ? `this Android device's SIM (${selectedSim?.displayName || 'SIM'})`
            : transport === TRANSPORT.MODEM
                ? `the attached modem${modemStatus.port ? ` (${modemStatus.port})` : ''}`
                : 'the SMS gateway';
        if (!window.confirm(
            `Send ${recipients.length} personalized SMS message(s) via ${transportLabel}? SMS charges may apply.`
        )) return;

        setSending(true);
        setNotice({ text: '', type: '' });
        setSendProgress({ done: 0, total: recipients.length, ok: 0, failed: 0 });

        const outcomes = [];
        try {
            if (transport === TRANSMIT_PERMISSION_REQUEST) { /* not reachable */ }

            if (transport === TRANSPORT.NATIVE) {
                // Native path sends one at a time (as the Android bridge requires).
                for (const r of recipients) {
                    const [result] = await sendBatchViaNative([{
                        id: r.id,
                        phone: phoneOf(r),
                        message: buildMessage(r)
                    }]);
                    outcomes.push({
                        id: r.id,
                        admissionNumber: r.admissionNumber || r.studentId || '',
                        status: result.success ? 'submitted' : 'failed',
                        error: result.error
                    });
                    setSendProgress((p) => ({
                        ...p,
                        done: p.done + 1,
                        ok: outcomes.filter((o) => o.status === 'submitted').length,
                        failed: outcomes.filter((o) => o.status === 'failed').length
                    }));
                }
            } else {
                // Gateway / modem: chunk into batches.
                for (let i = 0; i < recipients.length; i += SMS_BATCH_SIZE) {
                    const chunk = recipients.slice(i, i + SMS_BATCH_SIZE);
                    const payload = chunk.map((r) => ({
                        id: r.id,
                        phone: phoneOf(r),
                        message: buildMessage(r)
                    }));
                    const batchResults = await dispatchBatch(payload);
                    batchResults.forEach((br) => outcomes.push({
                        id: br.id,
                        admissionNumber: br.admissionNumber || br.studentId || '',
                        status: br.success ? 'submitted' : 'failed',
                        error: br.error
                    }));
                    setSendProgress((p) => ({
                        ...p,
                        done: Math.min(p.done + chunk.length, recipients.length),
                        ok: outcomes.filter((o) => o.status === 'submitted').length,
                        failed: outcomes.filter((o) => o.status === 'failed').length
                    }));
                    if (i + SMS_BATCH_SIZE < recipients.length) {
                        await new Promise((r) => setTimeout(r, transport === TRANSPORT.MODEM ? 1500 : 800));
                    }
                }
            }

            const submitted = outcomes.filter((o) => o.status === 'submitted').length;
            const failed = outcomes.length - submitted;

            const historyEntry = {
                schoolId,
                createdAt: serverTimestamp(),
                createdBy: currentUser?.uid || '',
                createdByName: userData?.fullName || userData?.firstName || currentUser?.email || 'School admin',
                transport,
                recipientKind,
                simName: transport === TRANSPORT.NATIVE ? (selectedSim?.displayName || '') : '',
                simSlot: transport === TRANSPORT.NATIVE ? (selectedSim?.slotIndex ?? null) : null,
                assessment: selectedAssessment ? `${selectedAssessment.term} ${selectedAssessment.type}` : '',
                templateName: selectedTemplate?.name || 'Custom message',
                message: messageBody.trim(),
                recipientCount: recipients.length,
                submitted,
                failed,
                skipped: missingPhone.length,
                status: failed ? (submitted ? 'partial' : 'failed') : 'submitted',
                outcomes
            };
            const localEntry = { ...historyEntry, createdAt: new Date() };

            try {
                await addDoc(collection(db, 'sms_history'), historyEntry);
                setHistory((current) => [{ id: `local-${Date.now()}`, ...localEntry }, ...current].slice(0, 100));
            } catch (historyError) {
                console.error('[Communications] history save failed:', historyError);
                setHistory((current) => [{ id: `local-${Date.now()}`, ...localEntry }, ...current].slice(0, 100));
                notify(
                    `Submitted ${submitted} message(s), but campaign history could not be saved. Check Firestore permissions.${failed ? ` ${failed} failed.` : ''}`,
                    'warning'
                );
                return;
            }

            notify(
                `Submitted ${submitted} message(s)${failed ? `; ${failed} failed` : ''}${missingPhone.length ? `; ${missingPhone.length} skipped` : ''}.`,
                failed ? 'warning' : 'success'
            );
        } catch (error) {
            console.error('[Communications] send campaign failed:', error);
            notify(`Could not finish SMS campaign: ${error.message}`, 'error');
        } finally {
            setSending(false);
        }
    };

    /* ============================================================
       Access guard
       ============================================================ */

    if (!isAdmin) {
        return (
            <Layout title="Communications">
                <div className="communications-denied">
                    <i className="fas fa-lock" aria-hidden="true"></i>
                    <h2>Access denied</h2>
                    <p>Communications is available to school administrators only.</p>
                </div>
            </Layout>
        );
    }

    if (loading) {
        return (
            <Layout title="Communications">
                <LoadingSpinner fullScreen text="Loading communications..." />
            </Layout>
        );
    }

    const transport = detectedTransport.current;

    /* ============================================================
       Render
       ============================================================ */

    return (
        <Layout title="Communications">
            <main className="communications-page">
                <header className="communications-header">
                    <div>
                        <h1>Communications</h1>
                        <p>Send personalized SMS messages to parents, guardians, and teachers.</p>
                    </div>
                    <div className="communications-header-actions">
                        <span className={`communications-env-badge ${transport === TRANSPORT.NATIVE ? 'gateway' : transport === TRANSPORT.MODEM ? 'modem' : 'gateway'}`}>
                            <i className={`fas ${transport === TRANSPORT.NATIVE ? 'fa-mobile-alt' : transport === TRANSPORT.MODEM ? 'fa-plug' : 'fa-globe'}`} aria-hidden="true" />
                            {transport === TRANSPORT.NATIVE ? 'Android device SIM'
                                : transport === TRANSPORT.MODEM ? 'USB / GSM modem'
                                : 'HTTP SMS gateway'}
                        </span>
                        <button type="button" className="btn btn-outline" onClick={loadData}>
                            <i className="fas fa-sync-alt" aria-hidden="true" /> Refresh
                        </button>
                    </div>
                </header>

                {loadError && <div className="communications-alert error" role="alert">{loadError}</div>}
                {notice.text && <div className={`communications-alert ${notice.type}`} role="status">{notice.text}</div>}

                <nav className="communications-tabs" aria-label="Communications sections">
                    <button type="button" className={activeTab === 'compose' ? 'active' : ''} onClick={() => setActiveTab('compose')}>
                        <i className="fas fa-pen" aria-hidden="true" /> Compose
                    </button>
                    <button type="button" className={activeTab === 'templates' ? 'active' : ''} onClick={() => setActiveTab('templates')}>
                        <i className="fas fa-file-alt" aria-hidden="true" /> Templates
                    </button>
                    <button type="button" className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')}>
                        <i className="fas fa-history" aria-hidden="true" /> History ({history.length})
                    </button>
                </nav>

                {activeTab === 'compose' && (
                    <div className="communications-layout">
                        <section className="communications-card communications-compose">
                            <h2>Compose personalized message</h2>

                            {/* Recipient audience toggle */}
                            <div className="communications-audience-toggle" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                                <button type="button"
                                    className={`btn ${recipientKind === 'parents' ? 'btn-primary' : 'btn-outline'}`}
                                    onClick={() => {
                                        setRecipientKind('parents');
                                        setSelectedTeacherIds([]);
                                        setLevelFilter('');
                                        setSubjectFilter('');
                                    }}>
                                    <i className="fas fa-users" aria-hidden="true" /> Parents / Students
                                </button>
                                <button type="button"
                                    className={`btn ${recipientKind === 'teachers' ? 'btn-primary' : 'btn-outline'}`}
                                    onClick={() => {
                                        setRecipientKind('teachers');
                                        setSelectedStudentIds([]);
                                        setClassFilter('');
                                    }}>
                                    <i className="fas fa-chalkboard-user" aria-hidden="true" /> Teachers
                                </button>
                            </div>

                            <div className="communications-form-grid">
                                <label>
                                    Message template
                                    <select value={selectedTemplateId} onChange={(e) => handleTemplateChange(e.target.value)}>
                                        {availableTemplates.map((template) => (
                                            <option key={template.id} value={template.id}>{template.name}</option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    Contact phone in footer
                                    <input
                                        value={adminPhone}
                                        onChange={(e) => setAdminPhone(e.target.value)}
                                        inputMode="tel"
                                        placeholder="e.g. +2547..."
                                    />
                                </label>

                                {transport === TRANSPORT.NATIVE && (
                                    <label>
                                        SIM card
                                        <div className="communications-sim-select">
                                            <select
                                                value={selectedSimId}
                                                onChange={(e) => setSelectedSimId(e.target.value)}
                                                disabled={!sims.length}>
                                                {!sims.length && <option value="">Detect SIM cards first</option>}
                                                {sims.map((sim) => (
                                                    <option key={sim.subscriptionId} value={sim.subscriptionId}>
                                                        {sim.displayName}{sim.carrierName ? ` — ${sim.carrierName}` : ''}
                                                    </option>
                                                ))}
                                            </select>
                                            <button type="button" className="btn btn-outline"
                                                onClick={refreshSims} disabled={detectingSims}>
                                                {detectingSims ? 'Checking…' : 'Detect SIMs'}
                                            </button>
                                        </div>
                                        {simMessage && <small>{simMessage}</small>}
                                    </label>
                                )}

                                {transport === TRANSPORT.MODEM && (
                                    <label>
                                        Modem status
                                        <div className="communications-sim-select">
                                            <span className={`communications-env-badge ${modemStatus.available ? 'gateway' : 'modem'}`}>
                                                <i className={`fas ${modemStatus.available ? 'fa-check-circle' : 'fa-times-circle'}`} aria-hidden="true" />
                                                {modemStatus.available
                                                    ? `Connected${modemStatus.port ? ` (${modemStatus.port})` : ''}`
                                                    : 'Not detected'}
                                            </span>
                                            <button type="button" className="btn btn-outline"
                                                onClick={checkModemStatus}>
                                                <i className="fas fa-sync" aria-hidden="true" /> Refresh
                                            </button>
                                        </div>
                                    </label>
                                )}

                                {selectedTemplateId === 'results' && (
                                    <label>
                                        Assessment results to include
                                        <select value={assessmentKey} onChange={(e) => setAssessmentKey(e.target.value)}>
                                            {!assessments.length && <option value="">No recorded assessments</option>}
                                            {assessments.map((assessment) => (
                                                <option key={assessment.key} value={assessment.key}>
                                                    {assessment.term} {assessment.type}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                )}
                            </div>

                            {/* Template-specific extra fields */}
                            {(recipientKind === 'parents' || recipientKind === 'teachers') && (
                                <div className="communications-extra-fields">
                                    {selectedTemplateId === 'attendance' && (
                                        <label>Attendance status
                                            <input value={extraFields.attendanceStatus}
                                                onChange={(e) => setExtraFields({ ...extraFields, attendanceStatus: e.target.value })}
                                                placeholder="absent / late" /></label>
                                    )}
                                    {['attendance', 'meeting', 'event', 'exam', 'teacher_meeting', 'teacher_deadline', 'teacher_training'].includes(selectedTemplateId) && (
                                        <label>Date
                                            <input type="date" value={extraFields.date}
                                                onChange={(e) => setExtraFields({ ...extraFields, date: e.target.value })} /></label>
                                    )}
                                    {['meeting', 'event', 'teacher_meeting', 'teacher_training'].includes(selectedTemplateId) && (
                                        <label>Time
                                            <input type="time" value={extraFields.time}
                                                onChange={(e) => setExtraFields({ ...extraFields, time: e.target.value })} /></label>
                                    )}
                                    {['meeting', 'teacher_meeting', 'teacher_training'].includes(selectedTemplateId) && (
                                        <label>Venue
                                            <input value={extraFields.venue}
                                                onChange={(e) => setExtraFields({ ...extraFields, venue: e.target.value })} /></label>
                                    )}
                                    {selectedTemplateId === 'event' && (
                                        <label>Event name
                                            <input value={extraFields.eventName}
                                                onChange={(e) => setExtraFields({ ...extraFields, eventName: e.target.value })} /></label>
                                    )}
                                    {selectedTemplateId === 'closure' && (
                                        <label>Closure details
                                            <input value={extraFields.closureDetails}
                                                onChange={(e) => setExtraFields({ ...extraFields, closureDetails: e.target.value })} /></label>
                                    )}
                                    {selectedTemplateId === 'term' && (
                                        <label>Term details
                                            <input value={extraFields.termDetails}
                                                onChange={(e) => setExtraFields({ ...extraFields, termDetails: e.target.value })} /></label>
                                    )}
                                    {selectedTemplateId === 'exam' && (
                                        <label>Assessment / exam
                                            <input value={extraFields.examName}
                                                onChange={(e) => setExtraFields({ ...extraFields, examName: e.target.value })} /></label>
                                    )}
                                    {selectedTemplateId === 'congratulations' && (
                                        <label>Achievement
                                            <input value={extraFields.achievement}
                                                onChange={(e) => setExtraFields({ ...extraFields, achievement: e.target.value })} /></label>
                                    )}
                                    {selectedTemplateId === 'teacher_deadline' && (
                                        <label>Task description
                                            <input value={extraFields.taskDescription}
                                                onChange={(e) => setExtraFields({ ...extraFields, taskDescription: e.target.value })}
                                                placeholder="e.g. Term 2 marks upload" /></label>
                                    )}
                                    {['announcement', 'event', 'uniform', 'transport', 'emergency',
                                      'parent_custom', 'teacher_announcement', 'teacher_meeting',
                                      'teacher_timetable', 'teacher_training', 'teacher_urgent',
                                      'teacher_custom'].includes(selectedTemplateId) && (
                                        <label className="wide">Message details
                                            <textarea value={extraFields.message}
                                                onChange={(e) => setExtraFields({ ...extraFields, message: e.target.value })}
                                                rows="2" /></label>
                                    )}
                                </div>
                            )}

                            <label className="communications-message-label">
                                Message body
                                <textarea value={messageBody}
                                    onChange={(e) => setMessageBody(e.target.value)} rows="7" />
                            </label>

                            <div className="communications-variables">
                                <strong>Personalized fields:</strong>
                                {recipientKind === 'teachers' ? (
                                    <>
                                        <span>{'{{teacherName}}'}</span>
                                        <span>{'{{teacherSubject}}'}</span>
                                        <span>{'{{teacherClasses}}'}</span>
                                        <span>{'{{teacherLevel}}'}</span>
                                        <span>{'{{teacherPhone}}'}</span>
                                    </>
                                ) : (
                                    <>
                                        <span>{'{{studentName}}'}</span>
                                        <span>{'{{admissionNumber}}'}</span>
                                        <span>{'{{feeBalance}}'}</span>
                                        <span>{'{{assessmentResults}}'}</span>
                                    </>
                                )}
                            </div>

                            <div className="communications-preview">
                                <strong>Preview</strong>
                                <p>
                                    {recipientKind === 'teachers'
                                        ? (selectedTeachers.length
                                            ? buildMessageForTeacher(selectedTeachers[0])
                                            : 'Select a teacher to preview the personalized message.')
                                        : (selectedStudents.length
                                            ? buildMessageForStudent(selectedStudents[0])
                                            : 'Select a student to preview the personalized message.')}
                                </p>
                            </div>

                            {sending && (
                                <div className="communications-progress">
                                    <div className="communications-progress-bar">
                                        <div className="communications-progress-fill"
                                            style={{ width: `${(sendProgress.done / Math.max(sendProgress.total, 1)) * 100}%` }} />
                                    </div>
                                    <div className="communications-progress-text">
                                        <span>
                                            Sending {sendProgress.done} of {sendProgress.total}
                                            {sendProgress.ok > 0 && ` • ✓ ${sendProgress.ok}`}
                                            {sendProgress.failed > 0 && ` • ✗ ${sendProgress.failed}`}
                                        </span>
                                        <span>{Math.round((sendProgress.done / Math.max(sendProgress.total, 1)) * 100)}%</span>
                                    </div>
                                </div>
                            )}

                            <div className="communications-send-row">
                                <span>
                                    {sending
                                        ? `Sending ${sendProgress.done} of ${sendProgress.total}…`
                                        : `${selectedCount}/${MAX_RECIPIENTS_PER_CAMPAIGN} ${recipientKind === 'teachers' ? 'teachers' : 'students'} selected`}
                                </span>
                                <div className="communications-send-actions">
                                    <button type="button" className="btn btn-outline"
                                        onClick={() => {
                                            setSelectedStudentIds([]);
                                            setSelectedTeacherIds([]);
                                            setExtraFields({
                                                message: '', date: '', time: '', venue: '', eventName: '',
                                                closureDetails: '', termDetails: '', examName: '',
                                                achievement: '', attendanceStatus: '', taskDescription: ''
                                            });
                                        }}>
                                        <i className="fas fa-undo" aria-hidden="true" /> Reset
                                    </button>
                                    <button type="button" className="btn btn-primary"
                                        onClick={handleSend}
                                        disabled={sending || !selectedCount}>
                                        <i className={`fas ${sending ? 'fa-spinner fa-spin' : 'fa-paper-plane'}`} aria-hidden="true" />
                                        {sending ? 'Sending…' : 'Send SMS'}
                                    </button>
                                </div>
                            </div>

                            {/* Transport readiness warnings */}
                            {transport === TRANSPORT.MODEM && !modemStatus.available && (
                                <div className="communications-alert warning" style={{ marginTop: 12 }}>
                                    <i className="fas fa-plug" aria-hidden="true" />
                                    <span>No USB / GSM modem detected on this machine. Connect the modem and refresh.</span>
                                </div>
                            )}
                            {transport === TRANSPORT.GATEWAY && gatewayStatus !== 'connected' && (
                                <div className="communications-alert warning" style={{ marginTop: 12 }}>
                                    <i className="fas fa-exclamation-triangle" aria-hidden="true" />
                                    <span>SMS gateway is not connected. Check the gateway settings in Firestore (<code>sms_gateway/{schoolId}</code>).</span>
                                </div>
                            )}
                        </section>

                        {/* Recipients panel */}
                        <section className="communications-card communications-recipients">
                            <h2>
                                Recipients — {recipientKind === 'teachers' ? 'Teachers' : 'Parents / Students'}
                            </h2>

                            <div className="communications-recipient-filters">
                                <input value={search} onChange={(e) => setSearch(e.target.value)}
                                    placeholder={`Search ${recipientKind === 'teachers' ? 'name, email, or subject' : 'name or admission number'}`} />

                                <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
                                    <option value="">All levels</option>
                                    {availableLevels.map((level) => <option key={level}>{level}</option>)}
                                </select>

                                {recipientKind === 'parents' && (
                                    <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
                                        <option value="">All classes</option>
                                        {availableClasses.map((cls) => <option key={cls}>{cls}</option>)}
                                    </select>
                                )}

                                {recipientKind === 'teachers' && (
                                    <select value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)}>
                                        <option value="">All subjects</option>
                                        {availableSubjects.map((sub) => <option key={sub}>{sub}</option>)}
                                    </select>
                                )}
                            </div>

                            {recipientKind === 'parents' ? (
                                <>
                                    <label className="communications-select-all">
                                        <input type="checkbox"
                                            checked={filteredStudents.length > 0 && filteredStudents.every((s) => selectedStudentIds.includes(s.id))}
                                            onChange={(e) => selectVisibleStudents(e.target.checked)} />
                                        Select visible ({filteredStudents.length})
                                    </label>
                                    <div className="communications-student-list">
                                        {filteredStudents.map((student) => (
                                            <label className="communications-student" key={student.id}>
                                                <input type="checkbox"
                                                    checked={selectedStudentIds.includes(student.id)}
                                                    onChange={() => toggleStudent(student.id)} />
                                                <span>
                                                    <strong>{studentName(student)}</strong>
                                                    <small>
                                                        {student.admissionNumber || student.studentId || 'No admission number'}
                                                        {' · '}
                                                        {student.class || student.level || '—'}
                                                    </small>
                                                    <small>
                                                        {getStudentPhone(student) || 'No parent/guardian phone'}
                                                        {' · Fee balance KES '}
                                                        {getBalance(balances[student.id]).toLocaleString()}
                                                    </small>
                                                </span>
                                            </label>
                                        ))}
                                        {!filteredStudents.length && (
                                            <p className="communications-no-students">No students match your search.</p>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <label className="communications-select-all">
                                        <input type="checkbox"
                                            checked={filteredTeachers.length > 0 && filteredTeachers.every((t) => selectedTeacherIds.includes(t.id))}
                                            onChange={(e) => selectVisibleTeachers(e.target.checked)} />
                                        Select visible ({filteredTeachers.length})
                                    </label>
                                    <div className="communications-teacher-picker">
                                        {filteredTeachers.map((teacher) => {
                                            const phone = getTeacherPhone(teacher);
                                            const missing = !isValidPhone(phone);
                                            return (
                                                <label
                                                    key={teacher.id}
                                                    className={`communications-teacher-item ${missing ? 'disabled' : ''}`}>
                                                    <input type="checkbox"
                                                        disabled={missing}
                                                        checked={selectedTeacherIds.includes(teacher.id)}
                                                        onChange={() => toggleTeacher(teacher.id)} />
                                                    <span className="teacher-meta">
                                                        <strong>{teacherName(teacher)}</strong>
                                                        <small>{phone || 'No phone on profile'}</small>
                                                        {Array.isArray(teacher.subjects) && teacher.subjects.length > 0 && (
                                                            <small>{teacher.subjects.join(', ')}</small>
                                                        )}
                                                    </span>
                                                </label>
                                            );
                                        })}
                                        {!filteredTeachers.length && (
                                            <p className="communications-no-students">No teachers match your search.</p>
                                        )}
                                    </div>
                                </>
                            )}

                            <small>
                                Each recipient receives an individually personalized message.
                                Maximum of {MAX_RECIPIENTS_PER_CAMPAIGN} per campaign.
                            </small>
                        </section>
                    </div>
                )}

                {activeTab === 'templates' && (
                    <section className="communications-card communications-template-list">
                        <h2>School communication templates</h2>
                        <p>Choose a template in Compose, then customize its text and details before sending.</p>

                        <h3 style={{ marginTop: 20, marginBottom: 10, fontSize: 15 }}>Parents &amp; Students</h3>
                        <div className="communications-template-grid">
                            {PARENT_TEMPLATES.map((template) => (
                                <article key={template.id}>
                                    <span>{template.category}</span>
                                    <h3>{template.name}</h3>
                                    <p>{template.body}</p>
                                    <button type="button" className="btn btn-outline"
                                        onClick={() => {
                                            setRecipientKind('parents');
                                            handleTemplateChange(template.id);
                                            setActiveTab('compose');
                                        }}>
                                        Use template
                                    </button>
                                </article>
                            ))}
                        </div>

                        <h3 style={{ marginTop: 28, marginBottom: 10, fontSize: 15 }}>Teachers</h3>
                        <div className="communications-template-grid">
                            {TEACHER_TEMPLATES.map((template) => (
                                <article key={template.id}>
                                    <span>{template.category}</span>
                                    <h3>{template.name}</h3>
                                    <p>{template.body}</p>
                                    <button type="button" className="btn btn-outline"
                                        onClick={() => {
                                            setRecipientKind('teachers');
                                            handleTemplateChange(template.id);
                                            setActiveTab('compose');
                                        }}>
                                        Use template
                                    </button>
                                </article>
                            ))}
                        </div>

                        {savedTemplates.length > 0 && (
                            <>
                                <h3 style={{ marginTop: 28, marginBottom: 10, fontSize: 15 }}>Saved templates</h3>
                                <div className="communications-template-grid">
                                    {savedTemplates.map((template) => (
                                        <article key={template.id}>
                                            <span>{template.category || 'Saved'}</span>
                                            <h3>{template.name}</h3>
                                            <p>{template.body || template.content}</p>
                                            <button type="button" className="btn btn-outline"
                                                onClick={() => {
                                                    handleTemplateChange(template.id);
                                                    setActiveTab('compose');
                                                }}>
                                                Use template
                                            </button>
                                        </article>
                                    ))}
                                </div>
                            </>
                        )}
                    </section>
                )}

                {activeTab === 'history' && (
                    <section className="communications-card communications-history">
                        <h2>SMS history</h2>
                        {!history.length ? (
                            <p className="communications-empty-history">No SMS campaigns recorded yet.</p>
                        ) : (
                            <div className="communications-history-scroll">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Audience</th>
                                            <th>Template</th>
                                            <th>Assessment</th>
                                            <th>Transport</th>
                                            <th>Recipients</th>
                                            <th>Outcome</th>
                                            <th>Message preview</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {history.map((item) => (
                                            <tr key={item.id}>
                                                <td>{formatTimestamp(item.createdAt)}</td>
                                                <td style={{ textTransform: 'capitalize' }}>
                                                    {item.recipientKind || 'parents'}
                                                </td>
                                                <td>{item.templateName || 'Custom message'}</td>
                                                <td>{item.assessment || '—'}</td>
                                                <td>
                                                    <span className="transport-pill">
                                                        {item.transport === TRANSPORT.NATIVE
                                                            ? `SIM · ${item.simName || ''}`
                                                            : item.transport === TRANSPORT.MODEM
                                                                ? 'MODEM'
                                                                : 'GATEWAY'}
                                                    </span>
                                                </td>
                                                <td>{item.recipientCount ?? item.totalMessages ?? 0}</td>
                                                <td>
                                                    <span className={`status-badge ${item.status || 'sent'}`}>
                                                        {item.submitted ?? item.sent ?? 0} submitted
                                                        {item.failed ? ` · ${item.failed} failed` : ''}
                                                    </span>
                                                </td>
                                                <td>{item.message || '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                )}
            </main>
        </Layout>
    );
}
