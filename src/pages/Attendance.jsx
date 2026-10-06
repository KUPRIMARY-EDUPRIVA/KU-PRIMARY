// src/pages/Attendance.jsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { useSync } from '../context/SyncContext';
import { db } from '../firebase';
import {
    doc, getDoc, collection, query, where, getDocs
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import {
    getAttendanceRecord, saveAttendanceRecord, listAttendanceRecords,
    getClassRoster, aggregateAttendance, todayISO,
    startOfWeek, startOfMonth, endOfMonth,
} from '../services/attendanceService';
import { LEVEL_DISPLAY_NAMES } from '../utils/constants';
import { AuditLogService, AUDIT_ACTIONS } from '../services/auditService';
import { fetchNetlifyFunction } from '../services/netlifyApi';
import { savePdfBlob } from '../services/deviceSecurity';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

import { showAppNotice } from '../utils/appNotice';
// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------
const SESSIONS = [
    { value: 'full', label: 'Full Day' },
    { value: 'morning', label: 'Morning' },
    { value: 'afternoon', label: 'Afternoon' },
];

const STATUSES = [
    { value: 'present', label: 'Present', color: '#16a34a', bg: '#dcfce7' },
    { value: 'absent',  label: 'Absent',  color: '#dc2626', bg: '#fee2e2' },
    { value: 'late',    label: 'Late',    color: '#d97706', bg: '#fef3c7' },
    { value: 'excused', label: 'Excused', color: '#2563eb', bg: '#dbeafe' },
];

const STATUS_MAP = STATUSES.reduce((acc, s) => {
    acc[s.value] = s;
    return acc;
}, {});

const REPORT_TYPES = [
    { value: 'daily',   label: 'Daily Attendance' },
    { value: 'weekly',  label: 'Weekly Summary' },
    { value: 'monthly', label: 'Monthly Summary' },
    { value: 'term',    label: 'Term Summary' },
    { value: 'perStudent', label: 'Per Student (Term)' },
    { value: 'chronic', label: 'Chronic Absentees' },
];

export default function Attendance() {
    const navigate = useNavigate();
    const { currentUser, userData, userRole } = useAuth();
    const { getLevelClasses, configs } = useSchool();
    const { isOnline, addToSyncQueue } = useSync();

    // ---- Access resolution ------------------------------------------------
    // Class teachers are stored in `schools/{schoolId}.classTeachers` as
    // { [className]: teacherUid }. We check whether the current user's
    // uid appears in that map. Only those users (and admins) can use this page.
    const [loading, setLoading] = useState(true);
    const [schoolData, setSchoolData] = useState(null);
    const [assignedClasses, setAssignedClasses] = useState([]);
    const [isAdmin, setIsAdmin] = useState(false);

    // ---- Page state -------------------------------------------------------
    const [activeTab, setActiveTab] = useState('reports');
    const [selectedClass, setSelectedClass] = useState('');
    const [selectedSession, setSelectedSession] = useState('full');
    const [selectedDate, setSelectedDate] = useState(todayISO());

    const [roster, setRoster] = useState([]);
    const [entries, setEntries] = useState({}); // studentId -> { status, note }
    const [existingRecord, setExistingRecord] = useState(null);
    const [saving, setSaving] = useState(false);

    // ---- History tab ------------------------------------------------------
    const [historyFrom, setHistoryFrom] = useState(startOfMonth());
    const [historyTo, setHistoryTo] = useState(endOfMonth());
    const [historyRecords, setHistoryRecords] = useState([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    // ---- Reports tab ------------------------------------------------------
    const [reportType, setReportType] = useState('daily');
    const [reportDate, setReportDate] = useState(todayISO());
    const [reportFrom, setReportFrom] = useState(startOfWeek());
    const [reportTo, setReportTo] = useState(todayISO());
    const [reportTerm, setReportTerm] = useState(String(new Date().getMonth() < 4 ? 1 : new Date().getMonth() < 8 ? 2 : 3));
    const [reportClass, setReportClass] = useState('');
    const [reporting, setReporting] = useState(false);
    const [classReportStats, setClassReportStats] = useState(null);

    useEffect(() => {
        if (!schoolData || reportType !== 'term') return;
        setReportTerm(String(schoolData.currentTerm || 1));
        setReportFrom(schoolData.termStart || startOfMonth());
        setReportTo(schoolData.currentTermEnd || todayISO());
    }, [schoolData, reportType]);

    useEffect(() => {
        setClassReportStats(null);
    }, [reportClass, reportType, reportDate, reportFrom, reportTo, reportTerm]);

    // ---- Notifications ----------------------------------------------------
    const showNotification = useCallback((message, type = 'info') => {
        showAppNotice(message, type);
    }, []);

    // ---- Bootstrap --------------------------------------------------------
    useEffect(() => {
        if (!currentUser || !userData) return;
        let cancelled = false;

        (async () => {
            setLoading(true);
            try {
                const schoolId = userData.schoolId;
                if (!schoolId) throw new Error('School ID missing');

                const snap = await getDoc(doc(db, 'schools', schoolId));
                if (!snap.exists()) throw new Error('School not found');
                const data = { id: snap.id, ...snap.data() };
                if (cancelled) return;
                setSchoolData(data);

                const role = String(userRole || userData?.role || 'teacher').toLowerCase().replace(/[\s_]+/g, '-');
                const admin = ['admin', 'user', 'school-admin', 'principal', 'super-admin', 'headteacher'].includes(role);
                setIsAdmin(admin);
                setActiveTab(admin ? 'reports' : 'take');

                // Resolve which classes this user is a class teacher for
                const classTeachers = data.classTeachers || {};
                const mine = Object.entries(classTeachers)
                    .filter(([, uid]) => uid && uid === currentUser.uid)
                    .map(([cls]) => cls);

                setAssignedClasses(mine);

                if (!admin && mine.length === 0) {
                    showNotification('You are not assigned as a class teacher.', 'warning');
                } else {
                    // Preselect the first available class
                    setSelectedClass(mine[0] || '');
                    setReportClass(admin ? '__all__' : (mine[0] || ''));
                }
            } catch (e) {
                console.error('Attendance bootstrap failed:', e);
                showNotification('Failed to load: ' + e.message, 'error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser?.uid, userData?.schoolId]);

    // ---- Load roster when class changes -----------------------------------
    useEffect(() => {
        if (!selectedClass || !schoolData) return;
        (async () => {
            try {
                const schoolId = schoolData.id;
                const level = findLevelForClass(selectedClass);
                const [list, existing] = await Promise.all([
                    getClassRoster(schoolId, selectedClass, level),
                    getAttendanceRecord(schoolId, selectedClass, selectedDate, selectedSession),
                ]);
                setRoster(list);
                setExistingRecord(existing);

                // Seed entries from existing record or default "present"
                const seeded = {};
                list.forEach((s) => {
                    const hit = existing?.entries?.find((e) => e.studentId === s.id);
                    seeded[s.id] = hit
                        ? { status: hit.status || 'present', note: hit.note || '' }
                        : { status: 'present', note: '' };
                });
                setEntries(seeded);
            } catch (e) {
                console.error('Roster load failed:', e);
                showNotification('Failed to load class roster', 'error');
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedClass, selectedDate, selectedSession, schoolData]);

    // ---- Helpers ----------------------------------------------------------
    const findLevelForClass = useCallback((cls) => {
        if (!cls) return '';
        // Try custom classes first (from SchoolContext.getLevelClasses)
        // else fall back to LEVEL_CLASSES lookup.
        for (const [level, list] of Object.entries(configs?.customClasses
            ? configs.customClasses.reduce((acc, c) => {
                (acc[c.level] = acc[c.level] || []).push(c.className);
                return acc;
              }, {})
            : {}
        )) {
            if (list.includes(cls)) return level;
        }
        // Fallback: use the school-context helper
        for (const lvl of ['pre-primary', 'lower-primary', 'upper-primary', 'junior-school', 'senior-school']) {
            const list = getLevelClasses ? getLevelClasses(lvl) : [];
            if (list.includes(cls)) return lvl;
        }
        return '';
    }, [configs, getLevelClasses]);

    const statusCounts = useMemo(() => {
        const counts = { present: 0, absent: 0, late: 0, excused: 0 };
        Object.values(entries).forEach((e) => {
            const s = e?.status || 'present';
            if (counts[s] !== undefined) counts[s]++;
        });
        return counts;
    }, [entries]);

    const totalStudents = roster.length;

    // ---- Take attendance handlers -----------------------------------------
    const setStudentStatus = (studentId, status) => {
        setEntries((prev) => ({
            ...prev,
            [studentId]: { ...(prev[studentId] || {}), status },
        }));
    };

    const setStudentNote = (studentId, note) => {
        setEntries((prev) => ({
            ...prev,
            [studentId]: { ...(prev[studentId] || {}), note },
        }));
    };

    const markAll = (status) => {
        setEntries((prev) => {
            const next = { ...prev };
            roster.forEach((s) => {
                next[s.id] = { ...(next[s.id] || {}), status };
            });
            return next;
        });
    };

    const handleSave = async () => {
        if (!selectedClass) return showNotification('Select a class first', 'warning');
        if (roster.length === 0) return showNotification('No students in this class', 'warning');

        setSaving(true);
        try {
            const schoolId = schoolData.id;
            const level = findLevelForClass(selectedClass);
            const payloadEntries = roster.map((s) => ({
                studentId: s.id,
                admissionNumber: s.admissionNumber || s.studentId || '',
                name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
                status: entries[s.id]?.status || 'present',
                note: entries[s.id]?.note || '',
            }));

            if (!isOnline) {
                await addToSyncQueue('attendance', 'set', {
                    schoolId, class: selectedClass, level,
                    date: selectedDate, session: selectedSession,
                    entries: payloadEntries,
                    takenBy: currentUser.uid,
                    takenByName: userData.fullName || '',
                    schoolName: schoolData.name || '',
                });
                showNotification('Attendance queued offline', 'info');
            } else {
                await saveAttendanceRecord({
                    schoolId, cls: selectedClass, level,
                    date: selectedDate, session: selectedSession,
                    entries: payloadEntries,
                    takenBy: currentUser.uid,
                    takenByName: userData.fullName || '',
                    schoolName: schoolData.name || '',
                });
                await AuditLogService.logAction(
                    schoolId,
                    {
                        uid: currentUser.uid,
                        fullName: userData.fullName,
                        email: currentUser.email,
                        role: userRole,
                    },
                    AUDIT_ACTIONS.ATTENDANCE_SAVED || 'ATTENDANCE_SAVED',
                    {
                        entityId: `${selectedClass}-${selectedDate}-${selectedSession}`,
                        message: `Attendance saved for ${selectedClass} on ${selectedDate} (${selectedSession}).`,
                    }
                );
                showNotification('Attendance saved', 'success');
            }
        } catch (e) {
            console.error('Save attendance failed:', e);
            showNotification('Failed to save attendance: ' + e.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    // ---- History ----------------------------------------------------------
    const loadHistory = async () => {
        if (!schoolData) return;
        setHistoryLoading(true);
        try {
            const recs = await listAttendanceRecords({
                schoolId: schoolData.id,
                cls: selectedClass || undefined,
                fromDate: historyFrom,
                toDate: historyTo,
            });
            setHistoryRecords(recs);
        } catch (e) {
            console.error('History load failed:', e);
            showNotification('Failed to load history', 'error');
        } finally {
            setHistoryLoading(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'history') loadHistory();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab]);

    // ---- Reports ----------------------------------------------------------
    const buildReportRequest = () => {
        const allClasses = isAdmin && reportClass === '__all__';
        const cls = allClasses ? '' : (reportClass || selectedClass);
        if (!cls && !allClasses) return null;
        const level = cls ? findLevelForClass(cls) : '';

        let from = reportFrom;
        let to = reportTo;

        if (reportType === 'daily') {
            from = reportDate;
            to = reportDate;
        }
        if (reportType === 'term') {
            from = reportFrom;
            to = reportTo;
        }

        return {
            schoolId: schoolData.id,
            cls,
            allClasses,
            level,
            reportType,
            from,
            to,
            school: {
                name: schoolData.name || '',
                motto: schoolData.motto || '',
                address: schoolData.address || '',
                phone: schoolData.phone || '',
                email: schoolData.email || '',
                logoUrl: schoolData.logoUrl || '',
                stampUrl: schoolData.stampUrl || '',
                principalSignatureUrl: schoolData.principalSignatureUrl || '',
                currentTerm: reportType === 'term' ? Number(reportTerm) : (schoolData.currentTerm || 1),
                academicYear: schoolData.academicYear || null,
            },
            classTeacher: {
                uid: currentUser.uid,
                name: userData.fullName || '',
            },
        };
    };

    const handleGenerateReport = async () => {
        const req = buildReportRequest();
        if (!req) return showNotification('Select a class first', 'warning');
        if (req.from && req.to && req.from > req.to) {
            return showNotification('The start date must be on or before the end date.', 'warning');
        }

        setReporting(true);
        try {
            if (req.allClasses) {
                const records = await listAttendanceRecords({
                    schoolId: req.schoolId,
                    fromDate: req.from,
                    toDate: req.to,
                    max: 2000,
                });
                const totalsByClass = new Map();
                records.forEach((record) => {
                    const className = record.class || 'Unassigned';
                    if (!totalsByClass.has(className)) {
                        totalsByClass.set(className, {
                            className, sessions: 0, present: 0, absent: 0, late: 0, excused: 0,
                        });
                    }
                    const row = totalsByClass.get(className);
                    row.sessions += 1;
                    for (const status of ['present', 'absent', 'late', 'excused']) {
                        const entries = Array.isArray(record.entries) ? record.entries : [];
                        const entryCount = entries.filter((entry) => (entry.status || 'present') === status).length;
                        const count = record.counts?.[status];
                        row[status] += Number.isFinite(Number(count)) ? Number(count) : entryCount;
                    }
                });
                const rows = [...totalsByClass.values()].sort((a, b) => a.className.localeCompare(b.className));
                const totals = rows.reduce((acc, row) => {
                    for (const status of ['present', 'absent', 'late', 'excused']) acc[status] += row[status];
                    acc.sessions += row.sessions;
                    return acc;
                }, { sessions: 0, present: 0, absent: 0, late: 0, excused: 0 });
                const marks = totals.present + totals.absent + totals.late + totals.excused;
                const rate = marks ? Math.round(((totals.present + totals.late) / marks) * 100) : 0;
                const classRows = rows.map((row) => {
                    const classMarks = row.present + row.absent + row.late + row.excused;
                    return {
                        ...row,
                        rate: classMarks ? Math.round(((row.present + row.late) / classMarks) * 100) : 0,
                    };
                });
                setClassReportStats({ ...totals, marks, rate, rows: classRows });

                const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
                pdf.setFontSize(18);
                pdf.setTextColor(26, 35, 126);
                pdf.text(schoolData?.name || 'School', 14, 18);
                pdf.setFontSize(13);
                pdf.text('All-Class Attendance Summary', 14, 27);
                pdf.setFontSize(9);
                pdf.setTextColor(80, 80, 80);
                pdf.text(`${reportType === 'term' ? `Term ${reportTerm}  |  ` : ''}${req.from} to ${req.to}  |  ${totals.sessions} class sessions  |  Attendance rate ${rate}%`, 14, 34);
                autoTable(pdf, {
                    startY: 40,
                    head: [['Class', 'Sessions', 'Present', 'Absent', 'Late', 'Excused', 'Attendance rate']],
                    body: [
                        ...classRows.map((row) => [
                            row.className, row.sessions, row.present, row.absent,
                            row.late, row.excused, `${row.rate}%`,
                        ]),
                        ['SCHOOL TOTAL', totals.sessions, totals.present, totals.absent, totals.late, totals.excused, `${rate}%`],
                    ],
                    styles: { fontSize: 9, cellPadding: 3 },
                    headStyles: { fillColor: [26, 35, 126] },
                    margin: { left: 14, right: 14 },
                });
                const saved = await savePdfBlob(pdf.output('blob'), `attendance_all_classes_${req.from}_to_${req.to}.pdf`);
                showNotification(`Saved ${saved.filename} to ${saved.location || 'your Downloads folder'}.`, 'success');
                return;
            }

            const res = await fetchNetlifyFunction('generate-attendance-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req),
                responseType: 'blob',
            });
            if (!res.ok) {
                const err = await res.text().catch(() => '');
                throw new Error(err || `HTTP ${res.status}`);
            }
            const blob = await res.blob();
            const saved = await savePdfBlob(blob, `attendance_${req.reportType}_${req.cls}_${req.from}_to_${req.to}.pdf`);
            showNotification(`Saved ${saved.filename} to ${saved.location || 'your Downloads folder'}.`, 'success');
        } catch (e) {
            console.error('Report failed:', e);
            showNotification('Failed to generate report: ' + e.message, 'error');
        } finally {
            setReporting(false);
        }
    };

    // ------------------------------------------------------------
    // Access denied screen
    // ------------------------------------------------------------
    if (loading) return <LoadingSpinner fullScreen text="Loading attendance…" />;

    if (!isAdmin && assignedClasses.length === 0) {
        return (
            <Layout title="Attendance">
                <div style={{
                    background: 'white', borderRadius: 12, padding: 40,
                    textAlign: 'center', boxShadow: '0 4px 6px rgba(0,0,0,0.07)',
                }}>
                    <i className="fas fa-user-lock" style={{ fontSize: 64, color: '#e0e6ed', marginBottom: 20 }}></i>
                    <h2 style={{ color: 'var(--secondary)', marginBottom: 10 }}>
                        Access Restricted
                    </h2>
                    <p style={{ color: 'var(--gray)', maxWidth: 500, margin: '0 auto' }}>
                        The Attendance page is reserved for class teachers.
                        Ask your administrator to assign you to a class under
                        <strong> School Profile → Class Teachers</strong>.
                    </p>
                </div>
            </Layout>
        );
    }

    // ------------------------------------------------------------
    // Main page
    // ------------------------------------------------------------
    return (
        <Layout title="Attendance">
            <style>{`
                .att-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:15px; margin-bottom:25px; }
                .att-stat { background:white; border-radius:12px; padding:18px; box-shadow:0 4px 6px rgba(0,0,0,0.07); }
                .att-stat-label { font-size:11px; text-transform:uppercase; color:var(--gray); letter-spacing:.5px; font-weight:600; }
                .att-stat-value { font-size:26px; font-weight:700; margin-top:4px; }
                .att-tabs { display:flex; gap:6px; border-bottom:2px solid var(--border); margin-bottom:20px; flex-wrap:wrap; }
                .att-tab { padding:10px 18px; border:none; background:transparent; font-weight:600; font-size:14px; color:var(--gray); cursor:pointer; border-bottom:3px solid transparent; margin-bottom:-2px; }
                .att-tab.active { color:var(--primary); border-bottom-color:var(--primary); }
                .att-panel { background:white; border-radius:12px; padding:22px; box-shadow:0 4px 6px rgba(0,0,0,0.07); }
                .att-row { display:flex; align-items:center; gap:10px; padding:10px 12px; border-bottom:1px solid var(--border); }
                .att-row:last-child { border-bottom:none; }
                .att-name { flex:1; font-weight:500; }
                .att-adm { font-size:12px; color:var(--gray); }
                .status-pill { padding:6px 12px; border-radius:20px; border:1px solid transparent; font-size:12px; font-weight:600; cursor:pointer; transition:all .15s; }
                .status-pill:hover { transform:translateY(-1px); }
                .status-pill.selected { box-shadow:0 0 0 2px rgba(26,35,126,.25); }
                .att-input { padding:8px 12px; border:2px solid var(--border); border-radius:8px; font-size:14px; }
                .att-btn { padding:10px 18px; border-radius:8px; font-weight:600; border:none; cursor:pointer; display:inline-flex; align-items:center; gap:8px; font-size:14px; }
                .att-btn-primary { background:var(--primary); color:white; }
                .att-btn-outline { background:transparent; border:2px solid var(--border); color:var(--secondary); }
                .att-btn-success { background:#16a34a; color:white; }
                .att-btn:disabled { opacity:.6; cursor:not-allowed; }
                .att-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:15px; margin-bottom:15px; }
                .att-field label { display:block; font-size:13px; font-weight:600; color:var(--secondary); margin-bottom:5px; }
                .att-field input, .att-field select { width:100%; padding:10px 12px; border:2px solid var(--border); border-radius:8px; font-size:14px; background:white; }
                @media(max-width:640px) {
                    .att-tab { padding:8px 12px; font-size:13px; }
                    .att-panel { padding:16px; }
                    .att-row { flex-wrap:wrap; }
                }
            `}</style>

            {/* Tabs */}
            <div className="att-tabs">
                {[
                    { key: 'take',    label: 'Take Attendance', icon: 'fa-clipboard-check' },
                    { key: 'history', label: 'History',         icon: 'fa-history' },
                    { key: 'reports', label: 'Reports',         icon: 'fa-file-pdf' },
                ].filter((tab) => !isAdmin || tab.key === 'reports').map((t) => (
                    <button
                        key={t.key}
                        className={`att-tab ${activeTab === t.key ? 'active' : ''}`}
                        onClick={() => setActiveTab(t.key)}
                    >
                        <i className={`fas ${t.icon}`} style={{ marginRight: 6 }}></i>
                        {t.label}
                    </button>
                ))}
            </div>

            {/* ================= Take Attendance ================= */}
            {activeTab === 'take' && (
                <>
                    <div className="att-grid" style={{ marginBottom: 20 }}>
                        <div className="att-field">
                            <label>Class</label>
                            <select
                                value={selectedClass}
                                onChange={(e) => setSelectedClass(e.target.value)}
                                disabled={!isAdmin && assignedClasses.length === 1}
                            >
                                <option value="">Select class</option>
                                {(isAdmin
                                    ? allClassesFromSchool(schoolData, getLevelClasses)
                                    : assignedClasses
                                ).map((cls) => (
                                    <option key={cls} value={cls}>{cls}</option>
                                ))}
                            </select>
                        </div>
                        <div className="att-field">
                            <label>Session</label>
                            <select value={selectedSession} onChange={(e) => setSelectedSession(e.target.value)}>
                                {SESSIONS.map((s) => (
                                    <option key={s.value} value={s.value}>{s.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="att-field">
                            <label>Date</label>
                            <input
                                type="date"
                                value={selectedDate}
                                onChange={(e) => setSelectedDate(e.target.value)}
                                max={todayISO()}
                            />
                        </div>
                    </div>

                    {/* Quick stats */}
                    <div className="att-stats">
                        <div className="att-stat">
                            <div className="att-stat-label">Students</div>
                            <div className="att-stat-value">{totalStudents}</div>
                        </div>
                        {STATUSES.map((s) => (
                            <div key={s.value} className="att-stat">
                                <div className="att-stat-label">{s.label}</div>
                                <div className="att-stat-value" style={{ color: s.color }}>
                                    {statusCounts[s.value]}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Quick actions */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 15, flexWrap: 'wrap' }}>
                        <button className="att-btn att-btn-outline" onClick={() => markAll('present')}>
                            <i className="fas fa-check"></i> Mark all present
                        </button>
                        <button className="att-btn att-btn-outline" onClick={() => markAll('absent')}>
                            <i className="fas fa-times"></i> Mark all absent
                        </button>
                        {existingRecord && (
                            <span style={{
                                padding: '10px 14px', background: '#dbeafe', color: '#1e40af',
                                borderRadius: 8, fontSize: 13,
                            }}>
                                <i className="fas fa-info-circle"></i>{' '}
                                Existing record from {new Date(existingRecord.updatedAtIso || Date.now()).toLocaleString()}
                            </span>
                        )}
                    </div>

                    <div className="att-panel">
                        {roster.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: 40, color: 'var(--gray)' }}>
                                <i className="fas fa-users" style={{ fontSize: 48, display: 'block', marginBottom: 12, color: '#e0e6ed' }}></i>
                                {selectedClass
                                    ? 'No students in this class.'
                                    : 'Select a class to begin.'}
                            </div>
                        ) : (
                            <>
                                {roster.map((s) => {
                                    const e = entries[s.id] || { status: 'present', note: '' };
                                    return (
                                        <div key={s.id} className="att-row">
                                            <div style={{
                                                width: 36, height: 36, borderRadius: '50%',
                                                background: '#1a237e', color: 'white',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                fontWeight: 600, fontSize: 14, flexShrink: 0,
                                            }}>
                                                {(s.firstName || 'S')[0]}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div className="att-name">
                                                    {s.firstName || ''} {s.lastName || ''}
                                                </div>
                                                <div className="att-adm">
                                                    {s.admissionNumber || s.studentId || ''}
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                {STATUSES.map((st) => (
                                                    <button
                                                        key={st.value}
                                                        type="button"
                                                        className={`status-pill ${e.status === st.value ? 'selected' : ''}`}
                                                        style={{
                                                            background: e.status === st.value ? st.bg : 'white',
                                                            color: e.status === st.value ? st.color : 'var(--gray)',
                                                            borderColor: e.status === st.value ? st.color : 'var(--border)',
                                                        }}
                                                        onClick={() => setStudentStatus(s.id, st.value)}
                                                    >
                                                        {st.label}
                                                    </button>
                                                ))}
                                            </div>
                                            <input
                                                className="att-input"
                                                placeholder="Note (optional)"
                                                value={e.note || ''}
                                                onChange={(ev) => setStudentNote(s.id, ev.target.value)}
                                                style={{ maxWidth: 200 }}
                                            />
                                        </div>
                                    );
                                })}

                                <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                    <button
                                        className="att-btn att-btn-success"
                                        onClick={handleSave}
                                        disabled={saving}
                                    >
                                        <i className="fas fa-save"></i>
                                        {saving ? 'Saving…' : 'Save Attendance'}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </>
            )}

            {/* ================= History ================= */}
            {activeTab === 'history' && (
                <>
                    <div className="att-grid" style={{ marginBottom: 15 }}>
                        <div className="att-field">
                            <label>Class (optional)</label>
                            <select
                                value={selectedClass}
                                onChange={(e) => setSelectedClass(e.target.value)}
                            >
                                <option value="" disabled={!isAdmin}>{isAdmin ? 'All classes' : 'Select class'}</option>
                                {(isAdmin
                                    ? allClassesFromSchool(schoolData, getLevelClasses)
                                    : assignedClasses
                                ).map((cls) => (
                                    <option key={cls} value={cls}>{cls}</option>
                                ))}
                            </select>
                        </div>
                        <div className="att-field">
                            <label>From</label>
                            <input type="date" value={historyFrom} onChange={(e) => setHistoryFrom(e.target.value)} />
                        </div>
                        <div className="att-field">
                            <label>To</label>
                            <input type="date" value={historyTo} onChange={(e) => setHistoryTo(e.target.value)} />
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginBottom: 15 }}>
                        <button className="att-btn att-btn-primary" onClick={loadHistory} disabled={historyLoading}>
                            <i className="fas fa-search"></i> {historyLoading ? 'Loading…' : 'Apply filter'}
                        </button>
                    </div>

                    <div className="att-panel">
                        {historyRecords.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: 40, color: 'var(--gray)' }}>
                                <i className="fas fa-inbox" style={{ fontSize: 48, display: 'block', marginBottom: 12, color: '#e0e6ed' }}></i>
                                No records found for this range.
                            </div>
                        ) : (
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ background: '#f8fafc' }}>
                                            {['Date', 'Class', 'Session', 'Present', 'Absent', 'Late', 'Excused', 'Taken By'].map((h) => (
                                                <th key={h} style={{ textAlign: 'left', padding: '10px 12px', fontSize: 12, textTransform: 'uppercase', color: 'var(--gray)' }}>{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {historyRecords.map((r) => (
                                            <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                                                <td style={{ padding: '10px 12px' }}>{r.date}</td>
                                                <td style={{ padding: '10px 12px' }}>{r.class}</td>
                                                <td style={{ padding: '10px 12px', textTransform: 'capitalize' }}>{r.session}</td>
                                                <td style={{ padding: '10px 12px', color: '#16a34a', fontWeight: 600 }}>{r.counts?.present || 0}</td>
                                                <td style={{ padding: '10px 12px', color: '#dc2626', fontWeight: 600 }}>{r.counts?.absent || 0}</td>
                                                <td style={{ padding: '10px 12px', color: '#d97706', fontWeight: 600 }}>{r.counts?.late || 0}</td>
                                                <td style={{ padding: '10px 12px', color: '#2563eb', fontWeight: 600 }}>{r.counts?.excused || 0}</td>
                                                <td style={{ padding: '10px 12px', fontSize: 13, color: 'var(--gray)' }}>{r.takenByName || '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </>
            )}

            {/* ================= Reports ================= */}
            {activeTab === 'reports' && (
                <div className="att-panel">
                    <h3 style={{ marginTop: 0, color: 'var(--secondary)' }}>
                        <i className="fas fa-file-pdf"></i> Generate Attendance Report
                    </h3>
                    <p style={{ color: 'var(--gray)', fontSize: 14, marginBottom: 20 }}>
                        Reports are generated as PDFs. The first page includes school
                        details and logo; subsequent pages start clean without repeating the header.
                    </p>

                    <div className="att-grid">
                        <div className="att-field">
                            <label>Report type</label>
                            <select value={reportType} onChange={(e) => {
                                const type = e.target.value;
                                setReportType(type);
                                if (type === 'weekly') {
                                    setReportFrom(startOfWeek(new Date(reportDate)));
                                    setReportTo(reportDate);
                                } else if (type === 'monthly') {
                                    setReportFrom(startOfMonth(new Date(reportDate)));
                                    setReportTo(endOfMonth(new Date(reportDate)));
                                } else if (type === 'term') {
                                    setReportTerm(String(schoolData?.currentTerm || 1));
                                    setReportFrom(schoolData?.termStart || startOfMonth());
                                    setReportTo(schoolData?.currentTermEnd || todayISO());
                                }
                            }}>
                                {REPORT_TYPES
                                    .filter((report) => (!isAdmin || ['daily', 'weekly', 'monthly', 'term'].includes(report.value))
                                        && (reportClass !== '__all__'
                                            || ['daily', 'weekly', 'monthly', 'term'].includes(report.value)))
                                    .map((r) => (
                                    <option key={r.value} value={r.value}>{r.label}</option>
                                ))}
                            </select>
                        </div>

                        {isAdmin ? (
                            <div className="att-field">
                                <label>Report scope</label>
                                <input type="text" value="All classes — school-wide statistics" disabled />
                            </div>
                        ) : (
                            <div className="att-field">
                                <label>Class</label>
                                <select value={reportClass} onChange={(e) => setReportClass(e.target.value)}>
                                    <option value="">Select class</option>
                                    {assignedClasses.map((cls) => (
                                        <option key={cls} value={cls}>{cls}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {reportType === 'daily' && (
                            <div className="att-field">
                                <label>Date</label>
                                <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} max={todayISO()} />
                            </div>
                        )}

                        {reportType === 'term' && (
                            <div className="att-field">
                                <label>Academic term</label>
                                <select
                                    value={reportTerm}
                                    onChange={(e) => {
                                        const term = e.target.value;
                                        setReportTerm(term);
                                        if (Number(term) === Number(schoolData?.currentTerm || 1)) {
                                            setReportFrom(schoolData?.termStart || startOfMonth());
                                            setReportTo(schoolData?.currentTermEnd || todayISO());
                                        }
                                    }}
                                >
                                    {['1', '2', '3'].map((term) => (
                                        <option key={term} value={term}>Term {term}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {(reportType !== 'daily') && (
                            <>
                                <div className="att-field">
                                    <label>From date</label>
                                    <input type="date" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} />
                                </div>
                                <div className="att-field">
                                    <label>To date</label>
                                    <input type="date" value={reportTo} onChange={(e) => setReportTo(e.target.value)} />
                                </div>
                            </>
                        )}
                    </div>
                    {reportType === 'term' && (
                        <p style={{ color: 'var(--gray)', fontSize: 13, marginTop: -4 }}>
                            Set the date range for the selected term. The current term uses dates saved in School Profile when available.
                        </p>
                    )}

                    <div style={{ marginTop: 10 }}>
                        <button
                            className="att-btn att-btn-primary"
                            onClick={handleGenerateReport}
                            disabled={reporting || (!reportClass && !selectedClass)}
                        >
                            <i className="fas fa-file-pdf"></i>
                            {reporting ? 'Generating…' : isAdmin && reportClass === '__all__' ? 'View school stats & export PDF' : 'Generate PDF'}
                        </button>
                    </div>
                    {classReportStats && reportClass === '__all__' && (
                        <div style={{ marginTop: 20 }}>
                            <div className="att-stats">
                                {[
                                    ['Class sessions', classReportStats.sessions, '#1a237e'],
                                    ['Present', classReportStats.present, '#16a34a'],
                                    ['Absent', classReportStats.absent, '#dc2626'],
                                    ['Attendance rate', `${classReportStats.rate}%`, '#2563eb'],
                                ].map(([label, value, color]) => (
                                    <div className="att-stat" key={label}>
                                        <div className="att-stat-label">{label}</div>
                                        <div className="att-stat-value" style={{ color }}>{value}</div>
                                    </div>
                                ))}
                            </div>
                            <div className="att-panel" style={{ padding: 0, overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead><tr style={{ background: '#f8fafc' }}>
                                        {['Class', 'Sessions', 'Present', 'Absent', 'Late', 'Excused', 'Rate'].map((heading) => (
                                            <th key={heading} style={{ padding: 10, textAlign: 'left', fontSize: 12 }}>{heading}</th>
                                        ))}
                                    </tr></thead>
                                    <tbody>{classReportStats.rows.map((row) => (
                                        <tr key={row.className} style={{ borderTop: '1px solid var(--border)' }}>
                                            {[row.className, row.sessions, row.present, row.absent, row.late, row.excused, `${row.rate}%`].map((value, index) => (
                                                <td key={`${row.className}-${index}`} style={{ padding: 10 }}>{value}</td>
                                            ))}
                                        </tr>
                                    ))}</tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </Layout>
    );
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function allClassesFromSchool(schoolData, getLevelClasses) {
    const custom = Array.isArray(schoolData?.customClasses) ? schoolData.customClasses : [];
    if (schoolData?.useCustomClasses && custom.length > 0) {
        return custom.map((c) => c.className);
    }
    const levels = ['pre-primary', 'lower-primary', 'upper-primary', 'junior-school', 'senior-school'];
    const out = [];
    levels.forEach((lvl) => {
        const list = getLevelClasses ? getLevelClasses(lvl) : [];
        list.forEach((c) => out.push(c));
    });
    return out;
}
