import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

const SCHOOL_ADMIN_ROLES = new Set(['admin', 'user', 'school_admin']);
const MAX_RECIPIENTS_PER_CAMPAIGN = 100;

const BUILT_IN_TEMPLATES = [
    { id: 'announcement', name: 'General announcement', category: 'General', body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), {{message}}' },
    { id: 'attendance', name: 'Attendance / absence notice', category: 'Attendance', body: 'Dear parent/guardian, {{studentName}} (Adm. {{admissionNumber}}) was marked {{attendanceStatus}} on {{date}}. Please contact the school if you need assistance.' },
    { id: 'results', name: 'Assessment results', category: 'Results', body: 'Dear parent/guardian, results for {{studentName}} (Adm. {{admissionNumber}}) in {{assessment}} are: {{assessmentResults}}.' },
    { id: 'fees', name: 'Fee balance reminder', category: 'Fees', body: 'Dear parent/guardian, {{studentName}} (Adm. {{admissionNumber}}) has an outstanding fee balance of KES {{feeBalance}}. Kindly contact the school to discuss payment.' },
    { id: 'meeting', name: 'Parent meeting invitation', category: 'Meetings', body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), you are invited to a school meeting on {{date}} at {{time}}. Venue: {{venue}}.' },
    { id: 'event', name: 'School event reminder', category: 'Events', body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), this is a reminder that {{eventName}} will take place on {{date}} at {{time}}. {{message}}' },
    { id: 'closure', name: 'School closure / early dismissal', category: 'Notices', body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), please note that {{schoolName}} will {{closureDetails}}. Kindly make the necessary arrangements.' },
    { id: 'term', name: 'Term opening / closing', category: 'Academic calendar', body: 'Dear parent/guardian, {{studentName}} (Adm. {{admissionNumber}}): {{termDetails}}. Thank you.' },
    { id: 'exam', name: 'Examination timetable notice', category: 'Examinations', body: 'Dear parent/guardian, {{studentName}} (Adm. {{admissionNumber}}) will sit {{examName}} from {{date}}. Please ensure they are prepared.' },
    { id: 'uniform', name: 'Uniform / supplies reminder', category: 'Student welfare', body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), please note: {{message}}' },
    { id: 'health', name: 'Health / wellbeing update', category: 'Student welfare', body: 'Dear parent/guardian, please contact {{schoolName}} regarding an important wellbeing matter for {{studentName}} (Adm. {{admissionNumber}}).' },
    { id: 'transport', name: 'Transport update', category: 'Transport', body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), transport update: {{message}}' },
    { id: 'congratulations', name: 'Achievement / congratulations', category: 'Celebrations', body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), congratulations for {{achievement}}. We are proud of this achievement.' },
    { id: 'discipline', name: 'Request for parent discussion', category: 'Meetings', body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), please contact the school to arrange a confidential discussion.' },
    { id: 'emergency', name: 'Urgent school alert', category: 'Urgent alerts', body: 'URGENT: Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), {{message}} Please follow the instructions provided by {{schoolName}}.' },
    { id: 'custom', name: 'Custom message', category: 'General', body: 'Dear parent/guardian of {{studentName}} (Adm. {{admissionNumber}}), {{message}}' }
];

const studentName = (student) =>
    [student?.firstName, student?.lastName].filter(Boolean).join(' ') || 'Student';

const getStudentPhone = (student) =>
    student?.parentPhone || student?.parentPhoneNumber || student?.guardianPhone
    || student?.guardianPhoneNumber || student?.phoneNumber || student?.phone || '';

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

export default function Communications() {
    const { currentUser, userData, userRole } = useAuth();
    const schoolId = userData?.schoolId;
    const isAdmin = SCHOOL_ADMIN_ROLES.has(userRole || userData?.role);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [activeTab, setActiveTab] = useState('compose');
    const [students, setStudents] = useState([]);
    const [balances, setBalances] = useState({});
    const [scores, setScores] = useState([]);
    const [school, setSchool] = useState({ name: '', phone: '' });
    const [history, setHistory] = useState([]);
    const [templates, setTemplates] = useState([]);
    const [sims, setSims] = useState([]);
    const [selectedSimId, setSelectedSimId] = useState('');
    const [simMessage, setSimMessage] = useState('');
    const [detectingSims, setDetectingSims] = useState(false);
    const [sending, setSending] = useState(false);
    const [sendProgress, setSendProgress] = useState({ done: 0, total: 0 });
    const [notice, setNotice] = useState({ text: '', type: '' });
    const [search, setSearch] = useState('');
    const [levelFilter, setLevelFilter] = useState('');
    const [classFilter, setClassFilter] = useState('');
    const [selectedIds, setSelectedIds] = useState([]);
    const [selectedTemplateId, setSelectedTemplateId] = useState('announcement');
    const [messageBody, setMessageBody] = useState(BUILT_IN_TEMPLATES[0].body);
    const [adminPhone, setAdminPhone] = useState('');
    const [assessmentKey, setAssessmentKey] = useState('');
    const [extraFields, setExtraFields] = useState({
        message: '', date: '', time: '', venue: '', eventName: '',
        closureDetails: '', termDetails: '', examName: '', achievement: '',
        attendanceStatus: ''
    });

    const notify = useCallback((text, type = 'info') => {
        setNotice({ text, type });
    }, []);

    const loadData = useCallback(async () => {
        if (!schoolId || !isAdmin) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setLoadError('');
        try {
            const [schoolSnap, studentSnap, balanceSnap, scoreSnap, historySnap, templateSnap] =
                await Promise.all([
                    getDoc(doc(db, 'schools', schoolId)),
                    getDocs(query(collection(db, 'students'), where('schoolId', '==', schoolId))),
                    getDocs(query(collection(db, 'student_balances'), where('schoolId', '==', schoolId))),
                    getDocs(query(collection(db, 'student_scores'), where('schoolId', '==', schoolId))),
                    getDocs(query(collection(db, 'sms_history'), where('schoolId', '==', schoolId))),
                    getDocs(query(collection(db, 'sms_templates'), where('schoolId', '==', schoolId)))
                ]);

            const schoolData = schoolSnap.exists() ? schoolSnap.data() : {};
            const activeStudents = studentSnap.docs
                .map((item) => ({ id: item.id, ...item.data() }))
                .filter((student) => student.status !== 'archived' && student.isDeleted !== true);
            const balanceMap = {};
            balanceSnap.forEach((item) => {
                const data = item.data();
                balanceMap[data.studentId] = (balanceMap[data.studentId] || 0) + getBalance(data);
            });

            setSchool({ name: schoolData.name || userData?.schoolName || '', phone: schoolData.phone || '' });
            setAdminPhone(userData?.phone || userData?.phoneNumber || schoolData.adminPhone || schoolData.phone || '');
            setStudents(activeStudents);
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
            setTemplates(templateSnap.docs
                .map((item) => ({ id: item.id, ...item.data() }))
                .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))));
        } catch (error) {
            console.error('[Communications] load failed:', error);
            setLoadError(error?.message || 'Unable to load school communication data.');
        } finally {
            setLoading(false);
        }
    }, [schoolId, isAdmin, userData]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const assessments = useMemo(() => {
        const unique = new Map();
        scores.forEach((score) => {
            if (!score.assessmentType) return;
            const key = `${score.term || ''}::${score.assessmentType}`;
            unique.set(key, { key, term: score.term || '', type: score.assessmentType });
        });
        return [...unique.values()].sort((a, b) =>
            `${a.term} ${a.type}`.localeCompare(`${b.term} ${b.type}`)
        );
    }, [scores]);

    useEffect(() => {
        if (!assessmentKey && assessments.length) setAssessmentKey(assessments[0].key);
    }, [assessmentKey, assessments]);

    const selectedAssessment = assessments.find((item) => item.key === assessmentKey);
    const selectedTemplate = BUILT_IN_TEMPLATES.find((item) => item.id === selectedTemplateId)
        || templates.find((item) => item.id === selectedTemplateId);

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

    const selectedStudents = students.filter((student) => selectedIds.includes(student.id));
    const selectedSim = sims.find((sim) => String(sim.subscriptionId) === selectedSimId);

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
            setSimMessage(available.length ? `${available.length} active SIM${available.length === 1 ? '' : 's'} detected.` : 'No active SIM cards found.');
        } catch (error) {
            console.error('[Communications] SIM detection failed:', error);
            setSims([]);
            setSelectedSimId('');
            setSimMessage(error.message || 'Unable to detect SIM cards.');
        } finally {
            setDetectingSims(false);
        }
    };

    const fillTemplate = (student) => {
        const assessmentScores = selectedAssessment
            ? scores.filter((score) =>
                score.studentId === student.id
                && (score.term || '') === selectedAssessment.term
                && score.assessmentType === selectedAssessment.type
            )
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
        const body = String(messageBody || '').replace(/\{\{([A-Za-z]+)\}\}/g, (_, key) => values[key] ?? '');
        const footer = `${school.name || 'School'}. For more information contact the school via ${adminPhone.trim()}.`;
        return `${body.trim()}\n\n${footer}`;
    };

    const handleTemplateChange = (templateId) => {
        setSelectedTemplateId(templateId);
        const template = BUILT_IN_TEMPLATES.find((item) => item.id === templateId)
            || templates.find((item) => item.id === templateId);
        if (template) setMessageBody(template.body || template.content || '');
    };

    const toggleStudent = (id) => {
        setSelectedIds((current) => current.includes(id)
            ? current.filter((item) => item !== id)
            : current.length >= MAX_RECIPIENTS_PER_CAMPAIGN
                ? current
                : [...current, id]);
    };

    const selectVisibleStudents = (checked) => {
        setSelectedIds((current) => {
            const visible = filteredStudents.map((student) => student.id);
            if (!checked) return current.filter((id) => !visible.includes(id));
            const next = [...current];
            visible.forEach((id) => {
                if (next.length < MAX_RECIPIENTS_PER_CAMPAIGN && !next.includes(id)) next.push(id);
            });
            return next;
        });
    };

    const handleSend = async () => {
        if (!selectedStudents.length) return notify('Select at least one student.', 'error');
        if (!messageBody.trim()) return notify('Enter a message before sending.', 'error');
        if (!isValidPhone(adminPhone)) return notify('Enter a valid school contact phone number for the message footer.', 'error');
        if (!isDeviceSmsAvailable()) return notify('SIM-based SMS can be sent only from the installed Android app.', 'error');
        if (!selectedSim) return notify('Detect and select an active SIM before sending.', 'error');

        const missingPhone = selectedStudents.filter((student) => !isValidPhone(getStudentPhone(student)));
        const recipients = selectedStudents.filter((student) => isValidPhone(getStudentPhone(student)));
        if (!recipients.length) return notify('The selected students do not have valid parent or guardian phone numbers.', 'error');
        if (missingPhone.length && !window.confirm(
            `${missingPhone.length} selected student(s) have no valid phone number and will be skipped. Send to the remaining ${recipients.length}?`
        )) return;
        if (!window.confirm(`Send ${recipients.length} personalized SMS message(s) using ${selectedSim.displayName}? SMS charges may apply.`)) return;

        setSending(true);
        setNotice({ text: '', type: '' });
        setSendProgress({ done: 0, total: recipients.length });
        const outcomes = [];
        try {
            await requestSmsPermissions();
            for (const student of recipients) {
                const phoneNumber = normalizePhone(getStudentPhone(student));
                try {
                    await sendDeviceSms({
                        phoneNumber,
                        message: fillTemplate(student),
                        subscriptionId: Number(selectedSim.subscriptionId)
                    });
                    outcomes.push({ studentId: student.id, admissionNumber: student.admissionNumber || student.studentId || '', status: 'submitted' });
                } catch (error) {
                    console.error(`[Communications] SMS submission failed for ${student.id}:`, error);
                    outcomes.push({ studentId: student.id, admissionNumber: student.admissionNumber || student.studentId || '', status: 'failed' });
                }
                setSendProgress((progress) => ({ ...progress, done: progress.done + 1 }));
            }

            const submitted = outcomes.filter((item) => item.status === 'submitted').length;
            const failed = outcomes.length - submitted;
            const historyEntry = {
                schoolId,
                createdAt: serverTimestamp(),
                createdBy: currentUser?.uid || '',
                createdByName: userData?.fullName || userData?.firstName || currentUser?.email || 'School admin',
                simName: selectedSim.displayName,
                simSlot: selectedSim.slotIndex + 1,
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
                console.error('[Communications] SMS history could not be saved:', historyError);
                setHistory((current) => [{ id: `local-${Date.now()}`, ...localEntry }, ...current].slice(0, 100));
                notify(`Submitted ${submitted} message(s) to Android, but campaign history could not be saved. Check Firestore permissions.${failed ? ` ${failed} failed.` : ''}`, 'warning');
                return;
            }
            notify(`Submitted ${submitted} message(s) to Android${failed ? `; ${failed} failed` : ''}${missingPhone.length ? `; ${missingPhone.length} skipped` : ''}.`, failed ? 'warning' : 'success');
        } catch (error) {
            console.error('[Communications] send campaign failed:', error);
            notify(`Could not finish SMS campaign: ${error.message}`, 'error');
        } finally {
            setSending(false);
        }
    };

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

    if (loading) return <Layout title="Communications"><LoadingSpinner fullScreen text="Loading communications..." /></Layout>;

    return (
        <Layout title="Communications">
            <main className="communications-page">
                <header className="communications-header">
                    <div>
                        <h1>Communications</h1>
                        <p>Send personalized school SMS messages using an active SIM in this Android device.</p>
                    </div>
                    <button type="button" className="btn btn-outline" onClick={loadData}>
                        <i className="fas fa-sync-alt" aria-hidden="true"></i> Refresh
                    </button>
                </header>

                {loadError && <div className="communications-alert error" role="alert">{loadError}</div>}
                {notice.text && <div className={`communications-alert ${notice.type}`} role="status">{notice.text}</div>}

                <nav className="communications-tabs" aria-label="Communications sections">
                    <button type="button" className={activeTab === 'compose' ? 'active' : ''} onClick={() => setActiveTab('compose')}>
                        <i className="fas fa-pen" aria-hidden="true"></i> Compose
                    </button>
                    <button type="button" className={activeTab === 'templates' ? 'active' : ''} onClick={() => setActiveTab('templates')}>
                        <i className="fas fa-file-alt" aria-hidden="true"></i> Templates
                    </button>
                    <button type="button" className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')}>
                        <i className="fas fa-history" aria-hidden="true"></i> History ({history.length})
                    </button>
                </nav>

                {activeTab === 'compose' && (
                    <div className="communications-layout">
                        <section className="communications-card communications-compose">
                            <h2>Compose personalized message</h2>
                            <div className="communications-form-grid">
                                <label>
                                    Message template
                                    <select value={selectedTemplateId} onChange={(event) => handleTemplateChange(event.target.value)}>
                                        {BUILT_IN_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                                        {templates.length > 0 && <optgroup label="Saved templates">
                                            {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                                        </optgroup>}
                                    </select>
                                </label>
                                <label>
                                    Contact phone in footer
                                    <input value={adminPhone} onChange={(event) => setAdminPhone(event.target.value)} inputMode="tel" placeholder="e.g. +2547..." />
                                </label>
                                <label>
                                    SIM card
                                    <div className="communications-sim-select">
                                        <select value={selectedSimId} onChange={(event) => setSelectedSimId(event.target.value)} disabled={!sims.length}>
                                            {!sims.length && <option value="">Detect SIM cards first</option>}
                                            {sims.map((sim) => <option key={sim.subscriptionId} value={sim.subscriptionId}>
                                                {sim.displayName}{sim.carrierName ? ` — ${sim.carrierName}` : ''}
                                            </option>)}
                                        </select>
                                        <button type="button" className="btn btn-outline" onClick={refreshSims} disabled={detectingSims}>
                                            {detectingSims ? 'Checking…' : 'Detect SIMs'}
                                        </button>
                                    </div>
                                    {simMessage && <small>{simMessage}</small>}
                                </label>
                                {selectedTemplateId === 'results' && (
                                    <label>
                                        Assessment results to include
                                        <select value={assessmentKey} onChange={(event) => setAssessmentKey(event.target.value)}>
                                            {!assessments.length && <option value="">No recorded assessments</option>}
                                            {assessments.map((assessment) => <option key={assessment.key} value={assessment.key}>
                                                {assessment.term} {assessment.type}
                                            </option>)}
                                        </select>
                                    </label>
                                )}
                            </div>

                            {['announcement', 'attendance', 'meeting', 'event', 'closure', 'term', 'exam', 'uniform', 'health', 'transport', 'congratulations', 'discipline', 'emergency', 'custom'].includes(selectedTemplateId) && (
                                <div className="communications-extra-fields">
                                    {selectedTemplateId === 'attendance' && <label>Attendance status<input value={extraFields.attendanceStatus} onChange={(e) => setExtraFields({ ...extraFields, attendanceStatus: e.target.value })} placeholder="absent / late" /></label>}
                                    {['attendance', 'meeting', 'event', 'exam'].includes(selectedTemplateId) && <label>Date<input type="date" value={extraFields.date} onChange={(e) => setExtraFields({ ...extraFields, date: e.target.value })} /></label>}
                                    {['meeting', 'event'].includes(selectedTemplateId) && <label>Time<input type="time" value={extraFields.time} onChange={(e) => setExtraFields({ ...extraFields, time: e.target.value })} /></label>}
                                    {selectedTemplateId === 'meeting' && <label>Venue<input value={extraFields.venue} onChange={(e) => setExtraFields({ ...extraFields, venue: e.target.value })} /></label>}
                                    {selectedTemplateId === 'event' && <label>Event name<input value={extraFields.eventName} onChange={(e) => setExtraFields({ ...extraFields, eventName: e.target.value })} /></label>}
                                    {selectedTemplateId === 'closure' && <label>Closure details<input value={extraFields.closureDetails} onChange={(e) => setExtraFields({ ...extraFields, closureDetails: e.target.value })} /></label>}
                                    {selectedTemplateId === 'term' && <label>Term details<input value={extraFields.termDetails} onChange={(e) => setExtraFields({ ...extraFields, termDetails: e.target.value })} /></label>}
                                    {selectedTemplateId === 'exam' && <label>Assessment / exam<input value={extraFields.examName} onChange={(e) => setExtraFields({ ...extraFields, examName: e.target.value })} /></label>}
                                    {selectedTemplateId === 'congratulations' && <label>Achievement<input value={extraFields.achievement} onChange={(e) => setExtraFields({ ...extraFields, achievement: e.target.value })} /></label>}
                                    {['announcement', 'event', 'uniform', 'transport', 'emergency', 'custom'].includes(selectedTemplateId) && <label className="wide">Message details<textarea value={extraFields.message} onChange={(e) => setExtraFields({ ...extraFields, message: e.target.value })} rows="2" /></label>}
                                </div>
                            )}

                            <label className="communications-message-label">
                                Message body
                                <textarea value={messageBody} onChange={(event) => setMessageBody(event.target.value)} rows="7" />
                            </label>
                            <div className="communications-variables">
                                <strong>Personalized fields:</strong>
                                <span>{'{{studentName}}'}</span><span>{'{{admissionNumber}}'}</span>
                                <span>{'{{feeBalance}}'}</span><span>{'{{assessmentResults}}'}</span>
                            </div>

                            <div className="communications-preview">
                                <strong>Preview</strong>
                                <p>{selectedStudents.length ? fillTemplate(selectedStudents[0]) : 'Select a student to preview the personalized message and school contact footer.'}</p>
                            </div>
                            <div className="communications-send-row">
                                <span>{sending ? `Sending ${sendProgress.done} of ${sendProgress.total}…` : `${selectedIds.length}/${MAX_RECIPIENTS_PER_CAMPAIGN} recipients selected`}</span>
                                <button type="button" className="btn btn-primary" onClick={handleSend} disabled={sending || !selectedIds.length}>
                                    <i className={`fas ${sending ? 'fa-spinner fa-spin' : 'fa-paper-plane'}`} aria-hidden="true"></i>
                                    {sending ? 'Sending…' : 'Send SMS'}
                                </button>
                            </div>
                        </section>

                        <section className="communications-card communications-recipients">
                            <h2>Recipients</h2>
                            <div className="communications-recipient-filters">
                                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or admission number" />
                                <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value)}>
                                    <option value="">All levels</option>
                                    {[...new Set(students.map((student) => student.level).filter(Boolean))].sort().map((level) => <option key={level}>{level}</option>)}
                                </select>
                                <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)}>
                                    <option value="">All classes</option>
                                    {[...new Set(students.map((student) => student.class).filter(Boolean))].sort().map((cls) => <option key={cls}>{cls}</option>)}
                                </select>
                            </div>
                            <label className="communications-select-all">
                                <input type="checkbox" checked={filteredStudents.length > 0 && filteredStudents.every((student) => selectedIds.includes(student.id))} onChange={(event) => selectVisibleStudents(event.target.checked)} />
                                Select visible ({filteredStudents.length})
                            </label>
                            <div className="communications-student-list">
                                {filteredStudents.map((student) => (
                                    <label className="communications-student" key={student.id}>
                                        <input type="checkbox" checked={selectedIds.includes(student.id)} onChange={() => toggleStudent(student.id)} />
                                        <span>
                                            <strong>{studentName(student)}</strong>
                                            <small>{student.admissionNumber || student.studentId || 'No admission number'} · {student.class || student.level || '—'}</small>
                                            <small>{getStudentPhone(student) || 'No parent/guardian phone'} · Fee balance KES {getBalance(balances[student.id]).toLocaleString()}</small>
                                        </span>
                                    </label>
                                ))}
                                {!filteredStudents.length && <p className="communications-no-students">No students match your search.</p>}
                            </div>
                            <small>Each student receives an individually personalized message. A maximum of {MAX_RECIPIENTS_PER_CAMPAIGN} students can be sent per campaign.</small>
                        </section>
                    </div>
                )}

                {activeTab === 'templates' && (
                    <section className="communications-card communications-template-list">
                        <h2>School communication templates</h2>
                        <p>Choose a template in Compose, then customize its text and details before sending.</p>
                        <div className="communications-template-grid">
                            {BUILT_IN_TEMPLATES.map((template) => (
                                <article key={template.id}>
                                    <span>{template.category}</span>
                                    <h3>{template.name}</h3>
                                    <p>{template.body}</p>
                                    <button type="button" className="btn btn-outline" onClick={() => {
                                        handleTemplateChange(template.id);
                                        setActiveTab('compose');
                                    }}>Use template</button>
                                </article>
                            ))}
                        </div>
                    </section>
                )}

                {activeTab === 'history' && (
                    <section className="communications-card communications-history">
                        <h2>SMS history</h2>
                        {!history.length ? <p className="communications-empty-history">No SMS campaigns recorded yet.</p> : (
                            <div className="communications-history-scroll">
                                <table>
                                    <thead><tr><th>Date</th><th>Template</th><th>Assessment</th><th>SIM</th><th>Recipients</th><th>Outcome</th><th>Message preview</th></tr></thead>
                                    <tbody>{history.map((item) => (
                                        <tr key={item.id}>
                                            <td>{formatTimestamp(item.createdAt)}</td>
                                            <td>{item.templateName || 'Custom message'}</td>
                                            <td>{item.assessment || '—'}</td>
                                            <td>{item.simName || `SIM ${item.simSlot || 1}`}</td>
                                            <td>{item.recipientCount ?? item.totalMessages ?? 0}</td>
                                            <td>{item.submitted ?? item.sent ?? 0} submitted · {item.failed ?? 0} failed</td>
                                            <td>{item.message || item.template || '—'}</td>
                                        </tr>
                                    ))}</tbody>
                                </table>
                            </div>
                        )}
                    </section>
                )}
            </main>
        </Layout>
    );
}
