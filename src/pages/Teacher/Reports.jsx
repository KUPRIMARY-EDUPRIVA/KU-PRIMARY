// src/pages/TeacherReports.jsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { db } from '../../firebase';
import {
    collection, query, where, getDocs, doc, getDoc,
    orderBy, limit, startAfter
} from 'firebase/firestore';
import Layout from '../../components/Layout/Layout';
import LoadingSpinner from '../../components/Common/LoadingSpinner';
import { showAppNotice } from '../../utils/appNotice';
import {
    LEVEL_DISPLAY_NAMES,
    LEVEL_BADGE_CLASSES,
    getCBCGrade
} from '../../utils/constants';
import {
    downloadTeacherRecordPDF,
    downloadTeacherReportsAllPDF
} from '../../services/pdf';

// ---- Constants ----
const PAGE_SIZE = 15;
const QUERY_LIMIT = 500; // cap per load — avoids runaway reads
const MAX_STUDENTS_TO_FETCH = 100;

// ------------------------------------------------------------
// Does this userData describe a teacher with any assignment?
// Checks every shape the Teachers page might have written:
//   - assignments: [{ subject, classes: [...] }]   (new)
//   - classes: [...]                                (legacy)
//   - subjects: [...]                               (legacy)
//   - levels: [...]                                 (legacy)
//   - level: 'junior-school'                        (legacy)
// ------------------------------------------------------------
function userDataDescribesTeacher(ud) {
    if (!ud) return false;
    if (Array.isArray(ud.assignments) && ud.assignments.length > 0) return true;
    if (Array.isArray(ud.classes) && ud.classes.length > 0) return true;
    if (Array.isArray(ud.subjects) && ud.subjects.length > 0) return true;
    if (Array.isArray(ud.levels) && ud.levels.length > 0) return true;
    if (ud.level) return true;
    return false;
}

export default function TeacherReports() {
    const navigate = useNavigate();
    const { currentUser, userData, userRole } = useAuth();

    const [loading, setLoading] = useState(true);
    const [exporting, setExporting] = useState(false);

    const [teacherData, setTeacherData] = useState(null);
    const [students, setStudents] = useState([]);
    const [allScores, setAllScores] = useState([]);

    const [filters, setFilters] = useState({
        level: '',
        subject: '',
        studentId: ''
    });

    const [currentPage, setCurrentPage] = useState(1);

    // ---- Filtered scores (memoized) ----
    const filteredScores = useMemo(() => {
        const { level, subject, studentId } = filters;
        return allScores.filter((s) => {
            if (level && s.level !== level) return false;
            if (subject && s.subject !== subject) return false;
            if (studentId && s.studentId !== studentId) return false;
            return true;
        });
    }, [allScores, filters]);

    // ---- Stats (memoized) ----
    const stats = useMemo(() => {
        if (allScores.length === 0) {
            return { totalAssessments: 0, studentsAssessed: 0, subjectsTaught: 0, avgScore: 0 };
        }
        const studentIds = new Set();
        const subjects = new Set();
        let total = 0;
        let count = 0;
        for (const s of allScores) {
            if (s.studentId) studentIds.add(s.studentId);
            if (s.subject) subjects.add(s.subject);
            if (typeof s.score === 'number') {
                total += s.score;
                count++;
            }
        }
        return {
            totalAssessments: allScores.length,
            studentsAssessed: studentIds.size,
            subjectsTaught: subjects.size,
            avgScore: count > 0 ? Math.round(total / count) : 0
        };
    }, [allScores]);

    // ---- Dropdown options (memoized) ----
    const availableSubjects = useMemo(() => {
        const set = new Set();
        allScores.forEach((s) => { if (s.subject) set.add(s.subject); });
        return [...set].sort();
    }, [allScores]);

    const availableStudents = useMemo(() => {
        return students
            .slice()
            .sort((a, b) => (a.firstName || '').localeCompare(b.firstName || ''))
            .map((s) => ({
                id: s.id,
                name: `${s.firstName || ''} ${s.lastName || ''}`.trim() || 'Unknown'
            }));
    }, [students]);

    // ---- Notification ----
    const showNotification = useCallback((message, type = 'info') => {
        showAppNotice(message, type);
    }, []);

    // ------------------------------------------------------------
    // Resolve the teacher record.
    //
    // Priority:
    //   1. `userData` (Firestore `users/{uid}` via AuthContext) —
    //      the source the Teachers page now writes to.
    //   2. `teachers` collection lookup by email (legacy).
    //   3. Minimal object built from `currentUser` + `userData` — so
    //      the page never crashes and PDFs still render a header.
    // ------------------------------------------------------------
    const resolveTeacherData = useCallback(async (schoolId) => {
        // 1) Prefer userData when it describes a teacher
        if (userDataDescribesTeacher(userData)) {
            const fullName = userData.fullName
                || `${userData.firstName || ''} ${userData.lastName || ''}`.trim()
                || currentUser?.displayName
                || 'Teacher';
            const parts = fullName.split(/\s+/);
            return {
                id: currentUser.uid,
                firstName: userData.firstName || parts[0] || 'Teacher',
                lastName: userData.lastName || parts.slice(1).join(' ') || '',
                fullName,
                email: userData.email || currentUser.email,
                schoolId,
                profileImageUrl: userData.profileImageUrl || userData.schoolLogo || '',
                // Carry assignments through in case PDFs want them
                assignments: Array.isArray(userData.assignments) ? userData.assignments : [],
                classes: Array.isArray(userData.classes) ? userData.classes : [],
                subjects: Array.isArray(userData.subjects) ? userData.subjects : [],
                level: userData.level || ''
            };
        }

        // 2) Fall back to the teachers collection by email
        try {
            const teacherQ = query(
                collection(db, 'teachers'),
                where('email', '==', currentUser.email),
                limit(1)
            );
            const tSnap = await getDocs(teacherQ);
            if (!tSnap.empty) {
                return { id: tSnap.docs[0].id, ...tSnap.docs[0].data() };
            }
        } catch (err) {
            console.warn('teachers collection lookup failed:', err);
        }

        // 3) Last resort: minimal object from currentUser + userData
        if (currentUser) {
            const fullName = userData?.fullName
                || currentUser.displayName
                || (userData?.email || currentUser.email || '').split('@')[0];
            const parts = fullName.split(/\s+/);
            return {
                id: currentUser.uid,
                firstName: userData?.firstName || parts[0] || 'Teacher',
                lastName: userData?.lastName || parts.slice(1).join(' ') || '',
                fullName,
                email: userData?.email || currentUser.email,
                schoolId
            };
        }

        return null;
    }, [currentUser, userData]);

    // ---- Load teacher + scores ----
    const loadTeacherData = useCallback(async () => {
        setLoading(true);
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) {
                showNotification('School ID not found', 'error');
                setLoading(false);
                return;
            }

            // 1. Resolve teacher (userData first, then teachers, then minimal)
            const teacher = await resolveTeacherData(schoolId);
            setTeacherData(teacher);

            // 2. Load scores — bounded, one query
            const scoresQ = query(
                collection(db, 'student_scores'),
                where('schoolId', '==', schoolId),
                where('teacherId', '==', currentUser.uid),
                orderBy('recordedAt', 'desc'),
                limit(QUERY_LIMIT)
            );
            const scoresSnap = await getDocs(scoresQ);

            const rawScores = scoresSnap.docs.map((d) => {
                const data = d.data();
                const ts = data.recordedAt?.toDate?.()
                    || (data.recordedAt ? new Date(data.recordedAt) : null);
                return {
                    id: d.id,
                    ...data,
                    _recordedAt: ts,
                    recordedAtDisplay: ts && !isNaN(ts) ? ts.toLocaleDateString() : 'N/A'
                };
            });

            setAllScores(rawScores);

            // 3. Load unique students — ONE batched read (no N+1)
            const uniqueIds = [...new Set(rawScores.map((s) => s.studentId).filter(Boolean))];

            // Firestore 'in' operator supports max 10 at a time; chunk if needed
            const studentsMap = new Map();
            if (uniqueIds.length > 0) {
                const chunks = [];
                for (let i = 0; i < uniqueIds.length; i += 10) {
                    chunks.push(uniqueIds.slice(i, i + 10));
                }
                // Cap the number of chunks to avoid runaway reads
                const limitedChunks = chunks.slice(0, Math.ceil(MAX_STUDENTS_TO_FETCH / 10));

                const results = await Promise.all(
                    limitedChunks.map((chunk) =>
                        getDocs(
                            query(
                                collection(db, 'students'),
                                where('__name__', 'in', chunk)
                            )
                        ).catch(() => ({ docs: [] }))
                    )
                );

                results.forEach((snap) => {
                    snap.docs.forEach((d) => {
                        studentsMap.set(d.id, { id: d.id, ...d.data() });
                    });
                });
            }

            setStudents([...studentsMap.values()]);
        } catch (error) {
            console.error('loadTeacherData failed:', error);
            showNotification('Failed to load reports: ' + error.message, 'error');
        } finally {
            setLoading(false);
        }
    }, [currentUser, userData, showNotification, resolveTeacherData]);

    useEffect(() => {
        if (currentUser && userData) loadTeacherData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser?.uid, userData?.schoolId]);

    // ---- Filter handlers ----
    const handleFilterChange = (e) => {
        const key = e.target.name || e.target.id.replace('filter', '').toLowerCase();
        setFilters((prev) => ({
            ...prev,
            [key === 'filterlevel' ? 'level'
                : key === 'filtersubject' ? 'subject'
                : key === 'filterstudent' ? 'studentId'
                : key]: e.target.value
        }));
        setCurrentPage(1);
    };

    const clearFilters = () => {
        setFilters({ level: '', subject: '', studentId: '' });
        setCurrentPage(1);
    };

    const refreshData = () => {
        if (userData?.schoolId) {
            loadTeacherData();
            showNotification('Data refreshed', 'success');
        }
    };

    // ---- View record (still an alert; a modal would be nicer but keep scope tight) ----
    const viewRecord = (id) => {
        const score = allScores.find((s) => s.id === id);
        if (!score) return showNotification('Record not found', 'error');
        const student = students.find((s) => s.id === score.studentId);
        const studentName = student
            ? `${student.firstName || ''} ${student.lastName || ''}`.trim()
            : 'Unknown Student';
        const grade = getCBCGrade(score.score || 0);
        alert(
            `📊 Assessment Record\n` +
            `────────────────────\n` +
            `Student: ${studentName}\n` +
            `Subject: ${score.subject || 'N/A'}\n` +
            `Level: ${LEVEL_DISPLAY_NAMES[score.level] || score.level || 'N/A'}\n` +
            `Class: ${score.class || 'N/A'}\n` +
            `Score: ${score.score || 0}%\n` +
            `CBC Level: ${grade.code} (${grade.label})\n` +
            `Points: ${grade.points.toFixed(1)}\n` +
            `Assessment: ${score.assessmentType || 'N/A'}\n` +
            `Date: ${score.recordedAtDisplay || 'N/A'}\n` +
            `Teacher: ${teacherData?.firstName || ''} ${teacherData?.lastName || ''}`
        );
    };

    // ---- Build meta for PDFs ----
    const buildMeta = () => ({
        schoolName: userData?.schoolName || 'EDUPRIVA',
        schoolMotto: userData?.schoolMotto || 'Powering Modern Education',
        schoolLogo: userData?.schoolLogo || '',
        schoolAddress: userData?.schoolAddress || '',
        schoolPhone: userData?.schoolPhone || '',
        schoolEmail: userData?.schoolEmail || '',
        year: new Date().getFullYear()
    });

    const buildRecordForPDF = (score) => {
        const student = students.find((s) => s.id === score.studentId);
        const studentName = student
            ? `${student.firstName || ''} ${student.lastName || ''}`.trim()
            : 'Unknown Student';
        return {
            studentName,
            admissionNumber: student?.admissionNumber || student?.studentId || 'N/A',
            subject: score.subject || 'N/A',
            level: score.level || 'N/A',
            levelDisplay: LEVEL_DISPLAY_NAMES[score.level] || score.level || 'N/A',
            class: score.class || 'N/A',
            score: score.score || 0,
            assessmentType: score.assessmentType || 'N/A',
            recordedAtDisplay: score.recordedAtDisplay || 'N/A',
            remarks: score.remarks || ''
        };
    };

    // ---- Export single ----
    const exportRecord = async (id) => {
        const score = allScores.find((s) => s.id === id);
        if (!score) return showNotification('Record not found', 'error');
        setExporting(true);
        try {
            const result = await downloadTeacherRecordPDF(buildRecordForPDF(score), buildMeta(), teacherData);
            showNotification(`PDF saved${result?.location ? ` to ${result.location}` : ''}${result?.filename ? ` as ${result.filename}` : ''}.`, 'success');
        } catch (err) {
            console.error('Export error:', err);
            showNotification('Failed to export PDF: ' + err.message, 'error');
        } finally {
            setExporting(false);
        }
    };

    // ---- Export all ----
    const exportAllReports = async () => {
        if (filteredScores.length === 0) {
            return showNotification('No records to export', 'warning');
        }
        setExporting(true);
        try {
            const records = filteredScores.map(buildRecordForPDF);
            const result = await downloadTeacherReportsAllPDF(records, buildMeta(), teacherData);
            showNotification(`Reports saved${result?.uri ? ' to Downloads/EduPriva' : ''}${result?.filename ? ` as ${result.filename}` : ''}.`, 'success');
        } catch (err) {
            console.error('Export all error:', err);
            showNotification('Failed to export reports: ' + err.message, 'error');
        } finally {
            setExporting(false);
        }
    };

    // ---- Pagination helper ----
    const pagedScores = useMemo(() => {
        const start = (currentPage - 1) * PAGE_SIZE;
        return filteredScores.slice(start, start + PAGE_SIZE);
    }, [filteredScores, currentPage]);

    // ---- Render table row ----
    const renderRow = (score, index) => {
        const student = students.find((s) => s.id === score.studentId);
        const studentName = student
            ? `${student.firstName || ''} ${student.lastName || ''}`.trim()
            : 'Unknown Student';
        const grade = getCBCGrade(score.score || 0);
        const levelDisplay = LEVEL_DISPLAY_NAMES[score.level] || score.level || 'N/A';

        const levelColors = {
            'pre-primary': '#ffeaa7',
            'lower-primary': '#74b9ff',
            'upper-primary': '#a29bfe',
            'junior-school': '#fd79a8',
            'senior-school': '#00b894'
        };

        const globalIndex = (currentPage - 1) * PAGE_SIZE + index + 1;

        return (
            <tr key={score.id}>
                <td>{globalIndex}</td>
                <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{
                            width: 36, height: 36, borderRadius: '50%',
                            background: '#1a237e', color: 'white',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontWeight: 600, fontSize: 14, flexShrink: 0
                        }}>
                            {studentName.charAt(0) || 'S'}
                        </div>
                        <div>
                            <div style={{ fontWeight: 500, color: '#2c3e50' }}>{studentName}</div>
                            <div style={{ fontSize: 12, color: '#95a5a6' }}>{student?.email || ''}</div>
                        </div>
                    </div>
                </td>
                <td>
                    <span style={{
                        display: 'inline-block', padding: '3px 12px', borderRadius: 12,
                        fontSize: 12, fontWeight: 600,
                        background: levelColors[score.level] || '#95a5a6',
                        color: ['pre-primary', 'lower-primary', 'upper-primary'].includes(score.level)
                            ? '#2d3436' : 'white'
                    }}>
                        {levelDisplay}
                    </span>
                </td>
                <td>{score.subject || 'N/A'}</td>
                <td style={{ fontWeight: 600 }}>{score.score || 0}%</td>
                <td>
                    <span style={{
                        display: 'inline-block', padding: '2px 10px', borderRadius: 12,
                        fontSize: 11, fontWeight: 700, minWidth: 35,
                        background: grade.level === 'EE' ? '#d4edda'
                            : grade.level === 'ME' ? '#d1ecf1'
                            : grade.level === 'AE' ? '#fff3cd' : '#f8d7da',
                        color: grade.level === 'EE' ? '#155724'
                            : grade.level === 'ME' ? '#0c5460'
                            : grade.level === 'AE' ? '#856404' : '#721c24',
                        border: `1px solid ${
                            grade.level === 'EE' ? '#27ae60'
                            : grade.level === 'ME' ? '#2ecc71'
                            : grade.level === 'AE' ? '#f39c12' : '#e74c3c'
                        }`
                    }}>
                        {grade.code}
                    </span>
                </td>
                <td style={{ textAlign: 'center', fontWeight: 700 }}>
                    {grade.points.toFixed(1)}
                </td>
                <td>
                    <span style={{
                        fontSize: 11, padding: '2px 10px',
                        background: '#f8f9fa', borderRadius: 10, display: 'inline-block'
                    }}>
                        {score.assessmentType || 'N/A'}
                    </span>
                </td>
                <td>{score.recordedAtDisplay || 'N/A'}</td>
                <td>
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        <button onClick={() => viewRecord(score.id)} style={btn('#3498db')}>
                            <i className="fas fa-eye"></i>
                        </button>
                        <button
                            onClick={() => exportRecord(score.id)}
                            disabled={exporting}
                            style={btn('#27ae60')}
                        >
                            <i className="fas fa-file-pdf"></i>
                        </button>
                    </div>
                </td>
            </tr>
        );
    };

    // ---- Render pagination ----
    const totalPages = Math.ceil(filteredScores.length / PAGE_SIZE);

    if (loading) return <LoadingSpinner fullScreen text="Loading reports..." />;

    return (
        <Layout title="My Reports">
            {/* Stats */}
            <div className="stats-grid" style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 20, marginBottom: 30
            }}>
                {[
                    { label: 'Total Assessments', value: stats.totalAssessments },
                    { label: 'Students Assessed', value: stats.studentsAssessed },
                    { label: 'Subjects Taught', value: stats.subjectsTaught },
                    { label: 'Average Score', value: `${stats.avgScore}%` }
                ].map((s, i) => (
                    <div key={i} className="stat-card" style={{
                        background: 'white', borderRadius: 12, padding: 20,
                        boxShadow: '0 4px 6px rgba(0,0,0,0.07)'
                    }}>
                        <div style={{
                            fontSize: 13, color: '#95a5a6', fontWeight: 500,
                            textTransform: 'uppercase', letterSpacing: '0.5px'
                        }}>{s.label}</div>
                        <div style={{
                            fontSize: 28, fontWeight: 700, color: '#2c3e50', marginTop: 5
                        }}>{s.value}</div>
                    </div>
                ))}
            </div>

            {/* Filters */}
            <div className="filters-section" style={{
                background: 'white', borderRadius: 12, padding: 20,
                boxShadow: '0 4px 6px rgba(0,0,0,0.07)', marginBottom: 25,
                display: 'flex', flexWrap: 'wrap', gap: 15, alignItems: 'flex-end'
            }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                    <label style={labelStyle}>Level</label>
                    <select name="level" value={filters.level} onChange={handleFilterChange} style={selectStyle}>
                        <option value="">All Levels</option>
                        <option value="pre-primary">Pre-Primary</option>
                        <option value="lower-primary">Lower Primary</option>
                        <option value="upper-primary">Upper Primary</option>
                        <option value="junior-school">Junior School</option>
                        <option value="senior-school">Senior School</option>
                    </select>
                </div>
                <div style={{ flex: 1, minWidth: 150 }}>
                    <label style={labelStyle}>Subject</label>
                    <select name="subject" value={filters.subject} onChange={handleFilterChange} style={selectStyle}>
                        <option value="">All Subjects</option>
                        {availableSubjects.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                </div>
                <div style={{ flex: 1, minWidth: 150 }}>
                    <label style={labelStyle}>Student</label>
                    <select name="studentId" value={filters.studentId} onChange={handleFilterChange} style={selectStyle}>
                        <option value="">All Students</option>
                        {availableStudents.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                </div>
                <button onClick={clearFilters} style={btnOutline}>
                    <i className="fas fa-times"></i> Clear
                </button>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                <button
                    onClick={exportAllReports}
                    disabled={exporting || filteredScores.length === 0}
                    style={btn('#27ae60')}
                >
                    <i className="fas fa-file-pdf"></i>{' '}
                    {exporting ? 'Exporting...' : `Export All Reports (${filteredScores.length})`}
                </button>
                <button onClick={refreshData} disabled={loading} style={btnOutline}>
                    <i className="fas fa-sync-alt"></i> Refresh
                </button>
            </div>

            {/* Table */}
            <div className="table-container" style={{
                background: 'white', borderRadius: 12,
                boxShadow: '0 4px 6px rgba(0,0,0,0.07)', overflow: 'hidden'
            }}>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ background: '#1a237e', color: 'white' }}>
                                {['#', 'Student', 'Level', 'Subject', 'Score', 'CBC Level', 'Points', 'Assessment', 'Date', 'Actions'].map((h) => (
                                    <th key={h} style={thStyle}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {pagedScores.length === 0 ? (
                                <tr>
                                    <td colSpan="10">
                                        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
                                            <i className="fas fa-file-alt" style={{
                                                fontSize: 64, color: '#e0e6ed', marginBottom: 20
                                            }}></i>
                                            <h3 style={{ fontSize: 20, color: '#2c3e50', marginBottom: 10 }}>
                                                No Records Found
                                            </h3>
                                            <p style={{ color: '#95a5a6' }}>
                                                No assessment records match your filters.
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                pagedScores.map(renderRow)
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Pagination */}
                <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '15px 20px', background: 'white', borderTop: '1px solid #e0e6ed',
                    flexWrap: 'wrap', gap: 10
                }}>
                    <div style={{ fontSize: 14, color: '#95a5a6' }}>
                        {filteredScores.length === 0
                            ? 'Showing 0 of 0 records'
                            : `Showing ${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filteredScores.length)} of ${filteredScores.length} records`}
                    </div>
                    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        <button
                            disabled={currentPage === 1}
                            onClick={() => setCurrentPage(currentPage - 1)}
                            style={pageBtn(currentPage === 1)}
                        >
                            <i className="fas fa-chevron-left"></i>
                        </button>
                        <span style={{ padding: '0 10px', fontSize: 14 }}>
                            {currentPage} / {totalPages || 1}
                        </span>
                        <button
                            disabled={currentPage >= totalPages}
                            onClick={() => setCurrentPage(currentPage + 1)}
                            style={pageBtn(currentPage >= totalPages)}
                        >
                            <i className="fas fa-chevron-right"></i>
                        </button>
                    </div>
                </div>
            </div>

            <style>{`
                .stat-card { transition: all 0.3s; }
                .stat-card:hover { transform: translateY(-2px); box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
                @media (max-width: 768px) {
                    .filters-section { flex-direction: column; align-items: stretch !important; }
                }
            `}</style>
        </Layout>
    );
}

// ---- Styles ----
const labelStyle = {
    display: 'block', fontSize: 13, fontWeight: 600, color: '#2c3e50', marginBottom: 5
};
const selectStyle = {
    width: '100%', padding: '10px 15px', border: '2px solid #e0e6ed',
    borderRadius: 8, fontSize: 14, background: 'white'
};
const btn = (bg) => ({
    padding: '10px 20px', border: 'none', borderRadius: 8,
    fontWeight: 600, cursor: 'pointer', display: 'inline-flex',
    alignItems: 'center', gap: 8, fontSize: 14, background: bg, color: 'white'
});
const btnOutline = {
    padding: '10px 20px', border: '2px solid #e0e6ed', borderRadius: 8,
    fontWeight: 600, cursor: 'pointer', display: 'inline-flex',
    alignItems: 'center', gap: 8, fontSize: 14, background: 'transparent', color: '#2c3e50'
};
const thStyle = {
    padding: '15px 20px', textAlign: 'left', fontSize: 13,
    fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px'
};
const pageBtn = (disabled) => ({
    padding: '8px 14px', border: '1px solid #e0e6ed', borderRadius: 6,
    background: 'white', cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1
});
