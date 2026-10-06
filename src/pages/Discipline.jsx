import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
    collection, doc, getDocs, limit, query, serverTimestamp, setDoc, updateDoc, where,
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { useAuth } from '../context/AuthContext';
import { normalizeRole } from '../utils/roles';
import { db } from '../firebase';
import { isDeviceSmsAvailable, requestSmsPermissions, sendDeviceSms } from '../services/deviceSms';
import { fetchNetlifyFunction } from '../services/netlifyApi';
import { savePdfBlob } from '../services/deviceSecurity';
import { AuditLogService } from '../services/auditService';
import StudentPicker from '../components/Fees/StudentPicker';

const CATEGORIES = [
    'Bullying', 'Classroom disruption', 'Dishonesty', 'Fighting',
    'Property damage', 'Safety concern', 'Uniform or attendance', 'Other',
];
const SEVERITIES = ['Low', 'Moderate', 'High', 'Critical'];
const STATUSES = ['Open', 'Under review', 'Resolved'];
const ADMIN_ROLES = new Set(['admin', 'user', 'school-admin', 'principal', 'super-admin', 'headteacher', 'deputy-headteacher']);
const isoDate = () => new Date().toISOString().slice(0, 10);

const inputStyle = {
    width: '100%', padding: '10px 12px', border: '1px solid #d7deea',
    borderRadius: 8, background: '#fff', color: '#182230', fontSize: 14,
};
const buttonStyle = (color = '#1a237e') => ({
    border: 0, borderRadius: 8, padding: '10px 14px', background: color,
    color: '#fff', fontWeight: 700, cursor: 'pointer',
});

export default function Discipline() {
    const { currentUser, userData, userRole } = useAuth();
    const schoolId = userData?.schoolId;
    const isAdmin = ADMIN_ROLES.has(normalizeRole(userRole || userData?.role));
    const [students, setStudents] = useState([]);
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [sendingId, setSendingId] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [search, setSearch] = useState('');
    const [classFilter, setClassFilter] = useState('');
    const [severityFilter, setSeverityFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [fromDate, setFromDate] = useState('');
    const [toDate, setToDate] = useState('');
    const [form, setForm] = useState({
        studentId: '', incidentDate: isoDate(), category: CATEGORIES[0],
        severity: 'Moderate', summary: '', actionTaken: '', followUpDate: '',
    });

    const loadData = useCallback(async () => {
        if (!schoolId) {
            setError('Your account is not linked to a school.');
            setLoading(false);
            return;
        }
        setLoading(true);
        setError('');
        try {
            const [studentSnapshot, recordSnapshot] = await Promise.all([
                getDocs(query(
                    collection(db, 'students'),
                    where('schoolId', '==', schoolId),
                    limit(2000)
                )),
                getDocs(query(
                    collection(db, 'discipline_records'),
                    where('schoolId', '==', schoolId),
                    limit(2000)
                )),
            ]);
            setStudents(studentSnapshot.docs
                .map((item) => ({ id: item.id, ...item.data() }))
                .filter((student) => !student.isDeleted)
                .sort((a, b) => studentLabel(a).localeCompare(studentLabel(b))));
            setRecords(recordSnapshot.docs
                .map((item) => ({ id: item.id, ...item.data() }))
                .sort((a, b) => String(b.incidentDate || '').localeCompare(String(a.incidentDate || ''))));
        } catch (loadError) {
            console.error('Discipline data load failed:', loadError);
            setError(`Could not load discipline records: ${loadError.message}`);
        } finally {
            setLoading(false);
        }
    }, [schoolId]);

    useEffect(() => { loadData(); }, [loadData]);

    const classes = useMemo(() => [...new Set(students.map((student) => student.class).filter(Boolean))].sort(), [students]);
    const filteredRecords = useMemo(() => {
        const term = search.trim().toLowerCase();
        return records.filter((record) => {
            const matchesSearch = !term || [
                record.studentName, record.admissionNumber, record.category, record.summary,
            ].some((value) => String(value || '').toLowerCase().includes(term));
            return matchesSearch
                && (!classFilter || record.className === classFilter)
                && (!severityFilter || record.severity === severityFilter)
                && (!statusFilter || record.status === statusFilter)
                && (!fromDate || record.incidentDate >= fromDate)
                && (!toDate || record.incidentDate <= toDate);
        });
    }, [records, search, classFilter, severityFilter, statusFilter, fromDate, toDate]);

    const stats = useMemo(() => filteredRecords.reduce((result, record) => {
        result.total += 1;
        result[record.status === 'Resolved' ? 'resolved' : 'open'] += 1;
        if (record.severity === 'High' || record.severity === 'Critical') result.serious += 1;
        return result;
    }, { total: 0, open: 0, resolved: 0, serious: 0 }), [filteredRecords]);

    const selectedStudent = students.find((student) => student.id === form.studentId) || null;

    const saveRecord = async (event) => {
        event.preventDefault();
        setError('');
        setNotice('');
        const student = students.find((item) => item.id === form.studentId);
        if (!student || !form.incidentDate || !form.summary.trim() || !form.actionTaken.trim()) {
            setError('Choose a student and provide the incident details and action taken.');
            return;
        }
        if (!isAdmin) {
            setError('Only school administrators can record discipline cases.');
            return;
        }

        setSaving(true);
        try {
            const recordRef = doc(collection(db, 'discipline_records'));
            const record = {
                schoolId,
                studentId: student.id,
                studentName: studentLabel(student),
                admissionNumber: student.admissionNumber || student.studentId || '',
                className: student.class || '',
                level: student.level || '',
                parentPhone: student.parentPhone || student.parentPhoneNumber
                    || student.guardianPhone || student.guardianPhoneNumber || '',
                incidentDate: form.incidentDate,
                category: form.category,
                severity: form.severity,
                summary: form.summary.trim(),
                actionTaken: form.actionTaken.trim(),
                followUpDate: form.followUpDate || '',
                status: 'Open',
                parentNotified: false,
                recordedBy: currentUser.uid,
                recordedByName: userData?.fullName || userData?.firstName || currentUser.email || '',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            };
            await setDoc(recordRef, record);
            await AuditLogService.logAction(
                schoolId,
                { uid: currentUser.uid, fullName: record.recordedByName, email: currentUser.email, role: userRole },
                'DISCIPLINE_RECORD_CREATED',
                { entityId: recordRef.id, studentId: student.id, severity: form.severity }
            );
            setForm({
                studentId: '', incidentDate: isoDate(), category: CATEGORIES[0],
                severity: 'Moderate', summary: '', actionTaken: '', followUpDate: '',
            });
            setNotice('Discipline record saved.');
            await loadData();
        } catch (saveError) {
            console.error('Discipline record save failed:', saveError);
            setError(`Could not save the discipline record: ${saveError.message}`);
        } finally {
            setSaving(false);
        }
    };

    const notifyParent = async (record) => {
        if (!record.parentPhone) {
            setError('No parent or guardian phone number is saved for this student.');
            return;
        }
        if (!window.confirm(`Send a confidential school follow-up SMS to the parent/guardian of ${record.studentName}? The incident details will not be included.`)) {
            return;
        }
        setSendingId(record.id);
        setError('');
        setNotice('');
        try {
            const message = `Dear parent/guardian, please contact ${userData?.schoolName || 'the school'} regarding a matter involving ${record.studentName}. Kindly speak with the school administration.`;
            if (isDeviceSmsAvailable()) {
                await requestSmsPermissions();
                await sendDeviceSms({ phoneNumber: record.parentPhone, message, subscriptionId: -1 });
            } else {
                const token = await currentUser.getIdToken();
                const response = await fetchNetlifyFunction('send-sms', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({ phoneNumber: record.parentPhone, message }),
                });
                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.error || `SMS service returned ${response.status}.`);
                }
            }

            await setDoc(doc(db, 'discipline_records', record.id), {
                parentNotified: true,
                parentNotifiedAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            }, { merge: true });
            setNotice('Parent/guardian communication sent.');
            await loadData();
        } catch (sendError) {
            console.error('Discipline parent SMS failed:', sendError);
            setError(`Could not send the SMS: ${sendError.message}`);
        } finally {
            setSendingId('');
        }
    };

    const updateRecordStatus = async (record, status) => {
        try {
            await updateDoc(doc(db, 'discipline_records', record.id), {
                status,
                updatedAt: serverTimestamp(),
            });
            setRecords((previous) => previous.map((item) => (
                item.id === record.id ? { ...item, status } : item
            )));
        } catch (updateError) {
            console.error('Discipline status update failed:', updateError);
            setError(`Could not update the record status: ${updateError.message}`);
        }
    };

    const exportReport = async () => {
        if (!filteredRecords.length) {
            setError('There are no discipline records in the selected report range.');
            return;
        }
        try {
            const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
            pdf.setFontSize(18);
            pdf.setTextColor(26, 35, 126);
            pdf.text(userData?.schoolName || 'School', 14, 18);
            pdf.setFontSize(13);
            pdf.text('Student Discipline Report', 14, 27);
            pdf.setFontSize(9);
            pdf.setTextColor(80, 80, 80);
            const range = [fromDate || 'All dates', toDate || 'Today'].join(' to ');
            pdf.text(`Period: ${range}  |  Generated: ${new Date().toLocaleString()}`, 14, 34);
            pdf.text(`Cases: ${stats.total}  |  Open: ${stats.open}  |  Resolved: ${stats.resolved}  |  High/Critical: ${stats.serious}`, 14, 40);
            autoTable(pdf, {
                startY: 46,
                head: [['Date', 'Student', 'Adm. no.', 'Class', 'Category', 'Severity', 'Status', 'Action / follow-up']],
                body: filteredRecords.map((record) => [
                    record.incidentDate || '',
                    record.studentName || '',
                    record.admissionNumber || '',
                    record.className || '',
                    record.category || '',
                    record.severity || '',
                    record.status || '',
                    [record.actionTaken, record.followUpDate ? `Follow-up: ${record.followUpDate}` : '']
                        .filter(Boolean).join(' '),
                ]),
                styles: { fontSize: 7, cellPadding: 2.2, overflow: 'linebreak' },
                headStyles: { fillColor: [26, 35, 126] },
                margin: { left: 12, right: 12 },
            });
            const saved = await savePdfBlob(pdf.output('blob'), `discipline_report_${isoDate()}.pdf`);
            setNotice(`Saved ${saved.filename} to ${saved.location || 'your Downloads folder'}.`);
        } catch (exportError) {
            console.error('Discipline report export failed:', exportError);
            setError(`Could not export the report: ${exportError.message}`);
        }
    };

    if (loading) return <LoadingSpinner fullScreen text="Loading discipline records..." />;
    if (!isAdmin) {
        return (
            <Layout title="Discipline">
                <div role="alert" style={{ background: '#fff', borderRadius: 12, padding: 24 }}>
                    Administrator access is required to view or manage student discipline records.
                </div>
            </Layout>
        );
    }

    return (
        <Layout title="Discipline">
            <style>{`
                .discipline-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:0 0 22px}
                .discipline-card{background:#fff;padding:18px;border-radius:12px;box-shadow:0 2px 10px #172b4d12}
                .discipline-card small{display:block;color:#64748b;text-transform:uppercase;font-size:11px;font-weight:700;letter-spacing:.05em}
                .discipline-card strong{display:block;color:#172554;font-size:26px;margin-top:6px}
                .discipline-form,.discipline-table{background:#fff;padding:20px;border-radius:12px;box-shadow:0 2px 10px #172b4d12;margin-bottom:20px}
                .discipline-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
                .discipline-fields label{display:grid;gap:6px;color:#334155;font-weight:600;font-size:13px}
                .discipline-fields textarea{min-height:88px;resize:vertical}
                .discipline-scroll{overflow:auto}
                .discipline-scroll table{width:100%;border-collapse:collapse;min-width:850px}
                .discipline-scroll th,.discipline-scroll td{padding:11px 9px;border-bottom:1px solid #e8edf4;text-align:left;vertical-align:top;font-size:13px}
                .discipline-scroll th{font-size:11px;color:#64748b;text-transform:uppercase}
                @media(max-width:640px){.discipline-form,.discipline-table{padding:14px}}
            `}</style>
            <section className="discipline-grid" aria-label="Discipline statistics">
                {[
                    ['Cases in view', stats.total, '#172554'],
                    ['Open', stats.open, '#b45309'],
                    ['Resolved', stats.resolved, '#15803d'],
                    ['High / Critical', stats.serious, '#b91c1c'],
                ].map(([label, value, color]) => (
                    <div className="discipline-card" key={label}><small>{label}</small><strong style={{ color }}>{value}</strong></div>
                ))}
            </section>

            {error && <div role="alert" style={{ background: '#fee2e2', color: '#991b1b', padding: 12, borderRadius: 8, marginBottom: 16 }}>{error}</div>}
            {notice && <div role="status" style={{ background: '#dcfce7', color: '#166534', padding: 12, borderRadius: 8, marginBottom: 16 }}>{notice}</div>}

            <form className="discipline-form" onSubmit={saveRecord}>
                <h2 style={{ marginTop: 0, color: '#172554' }}>Record an incident</h2>
                <div className="discipline-fields">
                    <label style={{ gridColumn: '1 / -1' }}>Student (admission number first)
                        <StudentPicker
                            schoolId={schoolId}
                            value={selectedStudent}
                            admissionFirst
                            placeholder="Enter admission number, or at least 2 letters of the student's name..."
                            onChange={(student) => setForm((previous) => ({
                                ...previous,
                                studentId: student?.id || '',
                            }))}
                        />
                    </label>
                    <label>Incident date
                        <input required type="date" max={isoDate()} style={inputStyle} value={form.incidentDate} onChange={(event) => setForm({ ...form, incidentDate: event.target.value })} />
                    </label>
                    <label>Category
                        <select style={inputStyle} value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
                            {CATEGORIES.map((category) => <option key={category}>{category}</option>)}
                        </select>
                    </label>
                    <label>Severity
                        <select style={inputStyle} value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value })}>
                            {SEVERITIES.map((severity) => <option key={severity}>{severity}</option>)}
                        </select>
                    </label>
                    <label style={{ gridColumn: '1 / -1' }}>Private incident summary
                        <textarea required maxLength={3000} style={inputStyle} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} />
                    </label>
                    <label style={{ gridColumn: '1 / -1' }}>Action taken / support provided
                        <textarea required maxLength={3000} style={inputStyle} value={form.actionTaken} onChange={(event) => setForm({ ...form, actionTaken: event.target.value })} />
                    </label>
                    <label>Follow-up date (optional)
                        <input type="date" style={inputStyle} value={form.followUpDate} onChange={(event) => setForm({ ...form, followUpDate: event.target.value })} />
                    </label>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
                    <button type="submit" style={buttonStyle()} disabled={saving}>{saving ? 'Saving…' : 'Save record'}</button>
                    <span style={{ color: '#64748b', fontSize: 12 }}>Incident details are kept in the school record and are not included in SMS messages.</span>
                </div>
            </form>

            <section className="discipline-table">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
                    <h2 style={{ margin: 0, color: '#172554' }}>Records & reports</h2>
                    <button type="button" style={buttonStyle('#166534')} onClick={exportReport}>Export PDF</button>
                </div>
                <div className="discipline-fields" style={{ marginBottom: 16 }}>
                    <label>Search
                        <input style={inputStyle} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Student, admission no. or incident" />
                    </label>
                    <label>Class
                        <select style={inputStyle} value={classFilter} onChange={(event) => setClassFilter(event.target.value)}>
                            <option value="">All classes</option>{classes.map((className) => <option key={className}>{className}</option>)}
                        </select>
                    </label>
                    <label>Severity
                        <select style={inputStyle} value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}>
                            <option value="">All severities</option>{SEVERITIES.map((severity) => <option key={severity}>{severity}</option>)}
                        </select>
                    </label>
                    <label>Status
                        <select style={inputStyle} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                            <option value="">All statuses</option>{STATUSES.map((status) => <option key={status}>{status}</option>)}
                        </select>
                    </label>
                    <label>From date<input type="date" style={inputStyle} value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
                    <label>To date<input type="date" style={inputStyle} value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
                </div>
                {records.length >= 2000 && <p role="status" style={{ color: '#9a3412' }}>Showing the 2,000 most recently loaded records. Narrow the date range to export a smaller report.</p>}
                <div className="discipline-scroll">
                    <table>
                        <thead><tr>{['Date', 'Student', 'Class', 'Incident', 'Severity', 'Status', 'Parent', 'Actions'].map((label) => <th key={label}>{label}</th>)}</tr></thead>
                        <tbody>{filteredRecords.map((record) => (
                            <tr key={record.id}>
                                <td>{record.incidentDate}</td>
                                <td><strong>{record.studentName}</strong><br /><span style={{ color: '#64748b' }}>{record.admissionNumber}</span></td>
                                <td>{record.className || '—'}</td>
                                <td><strong>{record.category}</strong><br />{record.summary}</td>
                                <td>{record.severity}</td>
                                <td>
                                    <select aria-label={`Status for ${record.studentName}`} style={{ ...inputStyle, minWidth: 120 }} value={record.status || 'Open'} onChange={(event) => updateRecordStatus(record, event.target.value)}>
                                        {STATUSES.map((status) => <option key={status}>{status}</option>)}
                                    </select>
                                </td>
                                <td>{record.parentNotified ? 'Contacted' : 'Not contacted'}</td>
                                <td><button type="button" style={buttonStyle('#0f766e')} disabled={sendingId === record.id} onClick={() => notifyParent(record)}>{sendingId === record.id ? 'Sending…' : 'SMS parent'}</button></td>
                            </tr>
                        ))}</tbody>
                    </table>
                    {!filteredRecords.length && <p style={{ color: '#64748b', textAlign: 'center', padding: 24 }}>No discipline records match these filters.</p>}
                </div>
            </section>
        </Layout>
    );
}

function studentLabel(student) {
    return [student.firstName, student.lastName].filter(Boolean).join(' ')
        || student.fullName || student.name || 'Student';
}
