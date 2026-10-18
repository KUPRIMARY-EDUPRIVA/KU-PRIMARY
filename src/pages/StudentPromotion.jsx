import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    collection, getDocs, limit, orderBy, query, where,
} from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { useSync } from '../context/SyncContext';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { db } from '../firebase';
import { loadStudentRoster } from '../services/studentRosterService';
import {
    applyStudentYearEndDecision,
    getNextCbcGrade,
    rollbackStudentYearEndDecision,
    YEAR_END_DECISIONS,
} from '../services/studentPromotionService';
import { AuditLogService } from '../services/auditService';
import { LEVEL_ORDER } from '../utils/constants';
import { isSchoolAdminRole } from '../utils/roles';
import { showAppNotice } from '../utils/appNotice';

const CLOSED_STATUSES = new Set(['archived', 'graduated', 'transferred', 'deleted']);
const DECISIONS = [
    { value: YEAR_END_DECISIONS.PROMOTE, label: 'Promote to next CBC grade' },
    { value: YEAR_END_DECISIONS.REPEAT, label: 'Repeat current grade' },
    { value: YEAR_END_DECISIONS.TRANSFER, label: 'Transfer out' },
    { value: YEAR_END_DECISIONS.GRADUATE, label: 'Graduate' },
    { value: YEAR_END_DECISIONS.ARCHIVE, label: 'Archive record' },
];

const studentName = (student) =>
    `${student.firstName || ''} ${student.lastName || ''}`.trim()
    || student.fullName
    || student.name
    || 'Unnamed student';

export default function StudentPromotion() {
    const { currentUser, userData, userRole } = useAuth();
    const { getLevelClasses } = useSchool();
    const { isOnline } = useSync();
    const schoolId = userData?.schoolId;
    const allowed = isSchoolAdminRole(userRole || userData?.role);
    const [students, setStudents] = useState([]);
    const [operations, setOperations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0 });
    const [error, setError] = useState('');
    const [decisionFailures, setDecisionFailures] = useState([]);
    const [selectedIds, setSelectedIds] = useState([]);
    const [levelFilter, setLevelFilter] = useState('');
    const [classFilter, setClassFilter] = useState('');
    const [decision, setDecision] = useState(YEAR_END_DECISIONS.PROMOTE);
    const [academicYear, setAcademicYear] = useState(String(new Date().getFullYear()));
    const [destinationSchool, setDestinationSchool] = useState('');
    const [archiveReason, setArchiveReason] = useState('');
    const [notes, setNotes] = useState('');

    const levelClasses = useMemo(() => Object.fromEntries(
        LEVEL_ORDER.map((level) => [level, getLevelClasses(level) || []])
    ), [getLevelClasses]);

    const loadOperations = useCallback(async () => {
        if (!schoolId || !academicYear) {
            setOperations([]);
            return;
        }
        const snapshot = await getDocs(query(
            collection(db, 'student_promotion_operations'),
            where('schoolId', '==', schoolId),
            where('academicYear', '==', academicYear),
            orderBy('createdAt', 'desc'),
            limit(500)
        ));
        setOperations(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
    }, [schoolId, academicYear]);

    const reload = useCallback(async () => {
        if (!schoolId) {
            setLoading(false);
            setError('This account is not linked to a school.');
            return;
        }
        if (!isOnline) {
            setLoading(false);
            setError('Connect to the internet to review or change year-end student records.');
            return;
        }
        setLoading(true);
        setError('');
        try {
            const [roster] = await Promise.all([
                loadStudentRoster(schoolId, { refresh: true }),
                loadOperations(),
            ]);
            setStudents(roster);
        } catch (loadError) {
            console.error('[StudentPromotion] load failed:', loadError);
            setError(loadError.message || 'Could not load year-end records.');
        } finally {
            setLoading(false);
        }
    }, [schoolId, isOnline, loadOperations]);

    useEffect(() => { reload(); }, [reload]);

    const visibleStudents = useMemo(() => students.filter((student) =>
        !student.isDeleted
        && student.isActive !== false
        && !CLOSED_STATUSES.has(String(student.status || '').toLowerCase())
        && (!levelFilter || student.level === levelFilter)
        && (!classFilter || student.class === classFilter)
    ), [students, levelFilter, classFilter]);

    const classes = useMemo(() => [...new Set(students
        .filter((student) => !levelFilter || student.level === levelFilter)
        .map((student) => student.class)
        .filter(Boolean))]
        .sort((left, right) => String(left).localeCompare(String(right))),
    [students, levelFilter]);

    const rosterById = useMemo(() => new Map(students.map((student) => [student.id, student])), [students]);
    const toggleStudent = (id) => setSelectedIds((previous) =>
        previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id]
    );
    const selectVisible = (checked) => setSelectedIds((previous) => {
        const visible = new Set(visibleStudents.map((student) => student.id));
        return checked
            ? [...new Set([...previous, ...visible])]
            : previous.filter((id) => !visible.has(id));
    });

    const applyDecision = async () => {
        if (!isOnline || busy || selectedIds.length === 0) return;
        if (decision === YEAR_END_DECISIONS.TRANSFER && !destinationSchool.trim()) {
            showAppNotice('Enter the destination school before transferring students.', 'warning');
            return;
        }
        if (decision === YEAR_END_DECISIONS.ARCHIVE && !archiveReason.trim()) {
            showAppNotice('Enter a reason before archiving student records.', 'warning');
            return;
        }
        const selected = visibleStudents.filter((student) => selectedIds.includes(student.id));
        if (!selected.length) {
            showAppNotice('The selected students are no longer in the active roster.', 'warning');
            return;
        }
        const label = DECISIONS.find((item) => item.value === decision)?.label || decision;
        if (!window.confirm(`Apply "${label}" for ${selected.length} student(s) for academic year ${academicYear}?`)) return;

        setBusy(true);
        setProgress({ current: 0, total: selected.length });
        setDecisionFailures([]);
        const outcomes = [];
        try {
            for (const [index, student] of selected.entries()) {
                const next = decision === YEAR_END_DECISIONS.PROMOTE
                    ? getNextCbcGrade(student.level, student.class, levelClasses)
                    : null;
                try {
                    const result = await applyStudentYearEndDecision({
                        schoolId,
                        studentId: student.id,
                        academicYear,
                        decision,
                        ...(next ? { targetLevel: next.level, targetClass: next.class } : {}),
                        destinationSchool,
                        archiveReason,
                        notes,
                        recordedBy: currentUser?.uid,
                        levelClasses,
                    });
                    outcomes.push({ student, ...result });
                } catch (operationError) {
                    outcomes.push({ student, status: 'failed', error: operationError.message });
                }
                setProgress({ current: index + 1, total: selected.length });
            }
            const succeeded = outcomes.filter((item) => item.status === 'applied').length;
            const failed = outcomes.filter((item) => item.status === 'failed');
            setDecisionFailures(failed);
            if (succeeded) {
                const auditAction = {
                    promote: 'STUDENT_PROMOTED',
                    repeat: 'STUDENT_REPEATED',
                    transfer: 'STUDENT_TRANSFERRED',
                    graduate: 'STUDENT_GRADUATED',
                    archive: 'STUDENT_ARCHIVED',
                }[decision];
                await AuditLogService.logAction(
                    schoolId,
                    {
                        uid: currentUser?.uid,
                        fullName: userData?.fullName,
                        email: currentUser?.email,
                        role: userRole,
                    },
                    auditAction,
                    {
                        message: `${label}: ${succeeded} student(s), academic year ${academicYear}`,
                        decision,
                        academicYear,
                        count: succeeded,
                    }
                );
            }
            showAppNotice(
                failed.length
                    ? `${succeeded} student(s) updated; ${failed.length} need review.`
                    : `Year-end decision applied to ${succeeded} student(s).`,
                failed.length ? 'warning' : 'success'
            );
            setSelectedIds([]);
            await reload();
        } catch (operationError) {
            console.error('[StudentPromotion] decision failed:', operationError);
            showAppNotice(operationError.message || 'Could not apply year-end decisions.', 'error');
        } finally {
            setBusy(false);
            setProgress({ current: 0, total: 0 });
        }
    };

    const rollback = async (operation) => {
        if (busy || !isOnline) return;
        if (!window.confirm(
            `Rollback the ${operation.action} decision for ${studentName(rosterById.get(operation.studentId) || {})}? ` +
            'Rollback will be refused if the student has changed since the decision.'
        )) return;
        setBusy(true);
        try {
            const result = await rollbackStudentYearEndDecision({
                schoolId,
                studentId: operation.studentId,
                academicYear: operation.academicYear,
                reversedBy: currentUser?.uid,
            });
            await AuditLogService.logAction(
                schoolId,
                {
                    uid: currentUser?.uid,
                    fullName: userData?.fullName,
                    email: currentUser?.email,
                    role: userRole,
                },
                'STUDENT_YEAR_END_ROLLED_BACK',
                {
                    entityId: rosterById.get(operation.studentId)?.admissionNumber || operation.studentId,
                    decision: operation.action,
                    academicYear: operation.academicYear,
                    operationId: result.operationId,
                }
            );
            showAppNotice('Decision rolled back. The archive and audit trail were retained.', 'success');
            await reload();
        } catch (rollbackError) {
            console.error('[StudentPromotion] rollback refused:', rollbackError);
            showAppNotice(rollbackError.message || 'Rollback was refused.', 'error');
        } finally {
            setBusy(false);
        }
    };

    if (!allowed) {
        return (
            <Layout title="Promotion & Archive">
                <div className="alert alert-error">Only authorized school administrators can manage year-end student records.</div>
            </Layout>
        );
    }

    if (loading) {
        return <Layout title="Promotion & Archive"><LoadingSpinner fullScreen text="Loading student cohort..." /></Layout>;
    }

    return (
        <Layout title="Promotion & Archive">
            <main className="page-container">
                <header className="page-header">
                    <div>
                        <h1>Student Promotion & Year-End Records</h1>
                        <p>Review each cohort, record CBC progression, repeats, transfers, graduation, or archival, and retain reversible history.</p>
                    </div>
                    <button type="button" className="btn btn-outline" onClick={reload} disabled={busy}>
                        <i className="fas fa-sync-alt" aria-hidden="true" /> Refresh
                    </button>
                </header>

                {error && <div className="alert alert-error" role="alert">{error}</div>}
                {!isOnline && <div className="alert alert-warning">Year-end changes require an active internet connection.</div>}

                <section className="card" aria-label="Year-end decision controls">
                    <div className="form-row">
                        <div className="form-group">
                            <label htmlFor="promotion-year">Academic year</label>
                            <input id="promotion-year" value={academicYear} maxLength={32}
                                onChange={(event) => setAcademicYear(event.target.value.trim())} />
                        </div>
                        <div className="form-group">
                            <label htmlFor="promotion-decision">Decision</label>
                            <select id="promotion-decision" value={decision} onChange={(event) => setDecision(event.target.value)}>
                                {DECISIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                            </select>
                        </div>
                        <div className="form-group">
                            <label htmlFor="promotion-level">Filter level</label>
                            <select id="promotion-level" value={levelFilter} onChange={(event) => {
                                setLevelFilter(event.target.value);
                                setClassFilter('');
                                setSelectedIds([]);
                            }}>
                                <option value="">All levels</option>
                                {LEVEL_ORDER.map((level) => <option key={level} value={level}>{level.replace(/-/g, ' ')}</option>)}
                            </select>
                        </div>
                        <div className="form-group">
                            <label htmlFor="promotion-class">Filter class</label>
                            <select id="promotion-class" value={classFilter} onChange={(event) => {
                                setClassFilter(event.target.value);
                                setSelectedIds([]);
                            }}>
                                <option value="">All classes</option>
                                {classes.map((studentClass) => <option key={studentClass} value={studentClass}>{studentClass}</option>)}
                            </select>
                        </div>
                    </div>
                    {decision === YEAR_END_DECISIONS.TRANSFER && (
                        <div className="form-group">
                            <label htmlFor="destination-school">Destination school</label>
                            <input id="destination-school" value={destinationSchool} maxLength={256}
                                onChange={(event) => setDestinationSchool(event.target.value)} />
                        </div>
                    )}
                    {decision === YEAR_END_DECISIONS.ARCHIVE && (
                        <div className="form-group">
                            <label htmlFor="archive-reason">Archive reason</label>
                            <input id="archive-reason" value={archiveReason} maxLength={256}
                                onChange={(event) => setArchiveReason(event.target.value)} />
                        </div>
                    )}
                    <div className="form-group">
                        <label htmlFor="year-end-notes">Decision notes (optional)</label>
                        <input id="year-end-notes" value={notes} maxLength={500}
                            onChange={(event) => setNotes(event.target.value)} />
                    </div>
                    <button type="button" className="btn btn-primary" onClick={applyDecision}
                        disabled={busy || !isOnline || selectedIds.length === 0 || !academicYear}>
                        {busy ? `Saving decisions ${progress.current}/${progress.total}...` : `${DECISIONS.find((item) => item.value === decision)?.label} (${selectedIds.length})`}
                    </button>
                    {decisionFailures.length > 0 && (
                        <div className="alert alert-warning" role="status">
                            <strong>Some students need review:</strong>
                            <ul>
                                {decisionFailures.map(({ student, error: reason }) => (
                                    <li key={student.id}>{studentName(student)} — {reason}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </section>

                <section className="card">
                    <div className="table-responsive">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th><input type="checkbox" aria-label="Select visible students"
                                        checked={visibleStudents.length > 0 && visibleStudents.every((student) => selectedIds.includes(student.id))}
                                        onChange={(event) => selectVisible(event.target.checked)} /></th>
                                    <th>Student / Admission No.</th>
                                    <th>Current CBC grade</th>
                                    <th>Next grade</th>
                                    <th>Prior repeats</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibleStudents.map((student) => {
                                    const next = getNextCbcGrade(student.level, student.class, levelClasses);
                                    return (
                                        <tr key={student.id}>
                                            <td><input type="checkbox" checked={selectedIds.includes(student.id)}
                                                onChange={() => toggleStudent(student.id)} aria-label={`Select ${studentName(student)}`} /></td>
                                            <td>{studentName(student)}<br /><small>{student.admissionNumber || student.studentId || 'No admission number'}</small></td>
                                            <td>{student.level} · {student.class}</td>
                                            <td>{next ? `${next.level} · ${next.class}` : 'Final configured grade'}</td>
                                            <td>{Number(student.repeatCount) || 0}</td>
                                        </tr>
                                    );
                                })}
                                {visibleStudents.length === 0 && <tr><td colSpan="5">No active students match these filters.</td></tr>}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section className="card">
                    <h2>Recorded decisions · {academicYear}</h2>
                    {operations.length === 0 ? <p>No year-end decisions are recorded for this year.</p> : (
                        <div className="table-responsive">
                            <table className="data-table">
                                <thead><tr><th>Student</th><th>Decision</th><th>Status</th><th>Recorded</th><th>Action</th></tr></thead>
                                <tbody>
                                    {operations.map((operation) => (
                                        <tr key={operation.id}>
                                            <td>{studentName(rosterById.get(operation.studentId) || {})}<br />
                                                <small>{rosterById.get(operation.studentId)?.admissionNumber || operation.studentId}</small></td>
                                            <td>{operation.action}</td>
                                            <td>{operation.status}</td>
                                            <td>{operation.createdAt?.toDate?.().toLocaleString?.() || '—'}</td>
                                            <td>{operation.status === 'applied' && (
                                                <button type="button" className="btn btn-outline btn-sm" disabled={busy || !isOnline}
                                                    onClick={() => rollback(operation)}>Rollback</button>
                                            )}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>
            </main>
        </Layout>
    );
}
