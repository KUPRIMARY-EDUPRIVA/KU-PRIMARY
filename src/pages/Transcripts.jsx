import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { normalizeAdmissionNumber } from '../services/admissionNumberService';
import { db } from '../firebase';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { downloadTranscriptPDF } from '../services/pdf';
import './Transcripts.css';

const isAdminRole = (role) =>
    ['admin', 'user', 'school_admin', 'super-admin', 'super_admin'].includes(role);

const toDate = (value) => {
    if (!value) return null;
    const date = value?.toDate?.() || new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const displayName = (student) =>
    [student?.firstName, student?.lastName].filter(Boolean).join(' ') || 'Student';

export default function Transcripts() {
    const { userData, userRole } = useAuth();
    const schoolId = userData?.schoolId;
    const isAdmin = [userRole, userData?.role].some(isAdminRole);
    const [archivedStudents, setArchivedStudents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedYear, setSelectedYear] = useState('all');
    const [selectedStudent, setSelectedStudent] = useState(null);
    const [studentScores, setStudentScores] = useState([]);
    const [loadingScores, setLoadingScores] = useState(false);
    const [allSchoolScores, setAllSchoolScores] = useState(null);
    const [exporting, setExporting] = useState(false);
    const [notice, setNotice] = useState('');

    const loadArchivedStudents = useCallback(async () => {
        if (!schoolId || !isAdmin) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setLoadError('');
        try {
            const snapshot = await getDocs(query(
                collection(db, 'archived_students'),
                where('schoolId', '==', schoolId)
            ));
            setArchivedStudents(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
        } catch (error) {
            console.error('Error loading archived students:', error);
            setLoadError(error.message || 'Could not load archived student records.');
        } finally {
            setLoading(false);
        }
    }, [schoolId, isAdmin]);

    useEffect(() => {
        loadArchivedStudents();
    }, [loadArchivedStudents]);

    useEffect(() => {
        setAllSchoolScores(null);
    }, [schoolId]);

    const years = useMemo(() => [...new Set(archivedStudents
        .map((student) => String(student.academicYear || student.year || ''))
        .filter(Boolean))]
        .sort((a, b) => Number(b) - Number(a)), [archivedStudents]);

    const filteredStudents = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        return archivedStudents
            .filter((student) => selectedYear === 'all'
                || String(student.academicYear || student.year || '') === selectedYear)
            .filter((student) => {
                const admission = String(student.admissionNumber || student.studentId || '').toLowerCase();
                return !term || displayName(student).toLowerCase().includes(term) || admission.includes(term);
            })
            .sort((a, b) => displayName(a).localeCompare(displayName(b)));
    }, [archivedStudents, searchTerm, selectedYear]);

    const handleViewTranscript = async (student) => {
        setSelectedStudent(student);
        setStudentScores([]);
        setNotice('');
        setLoadingScores(true);
        try {
            let scores = allSchoolScores;
            if (!scores) {
                const scoresQuery = query(
                    collection(db, 'student_scores'),
                    where('schoolId', '==', schoolId)
                );
                const snapshot = await getDocs(scoresQuery);
                scores = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
                setAllSchoolScores(scores);
            }
            const admission = normalizeAdmissionNumber(student.admissionNumber || student.studentId || '');
            const records = scores
                .filter((score) => score.studentId === student.studentId
                    || score.studentId === student.id
                    || (admission && normalizeAdmissionNumber(score.admissionNumber) === admission))
                .sort((a, b) => {
                    const yearDiff = Number(a.year || a.academicYear || 0) - Number(b.year || b.academicYear || 0);
                    if (yearDiff) return yearDiff;
                    return String(a.term || '').localeCompare(String(b.term || ''));
                });
            setStudentScores(records);
            if (!records.length) {
                setNotice('No academic score records were found for this student. Archived promotion history is shown below when available.');
            }
        } catch (error) {
            console.error('Transcript score lookup failed:', error);
            setNotice(`Could not load academic scores: ${error.message}`);
        } finally {
            setLoadingScores(false);
        }
    };

    const handleExport = async () => {
        if (!selectedStudent) return;
        setExporting(true);
        setNotice('');
        try {
            const result = await downloadTranscriptPDF(selectedStudent, studentScores, userData);
            setNotice(`Transcript saved${result?.filename ? ` as ${result.filename}` : ' to Downloads'}.`);
        } catch (error) {
            console.error('Transcript PDF export failed:', error);
            setNotice(`Transcript export failed: ${error.message}`);
        } finally {
            setExporting(false);
        }
    };

    if (!isAdmin) {
        return (
            <Layout title="Transcripts">
                <div className="transcripts-denied">
                    <h2>Access denied</h2>
                    <p>Student transcripts and archives are available to school administrators only.</p>
                </div>
            </Layout>
        );
    }

    if (loading) {
        return <Layout title="Transcripts"><LoadingSpinner fullScreen text="Loading student archives..." /></Layout>;
    }

    return (
        <Layout title="Student Transcripts">
            <main className="transcripts-page">
                <header className="transcripts-header">
                    <div>
                        <h1>Student Transcripts &amp; Archives</h1>
                        <p>Review historical academic results and promotion records for archived students.</p>
                    </div>
                    <button type="button" className="transcripts-button secondary" onClick={loadArchivedStudents}>
                        <i className="fas fa-sync-alt" aria-hidden="true"></i> Refresh
                    </button>
                </header>

                {loadError && <div className="transcripts-notice error" role="alert">{loadError}</div>}
                {notice && <div className="transcripts-notice" role="status">{notice}</div>}

                <section className="transcripts-toolbar" aria-label="Transcript filters">
                    <label>
                        Academic year
                        <select value={selectedYear} onChange={(event) => setSelectedYear(event.target.value)}>
                            <option value="all">All years</option>
                            {years.map((year) => <option key={year} value={year}>{year}</option>)}
                        </select>
                    </label>
                    <label className="transcripts-search">
                        Search archived students
                        <input
                            type="search"
                            value={searchTerm}
                            onChange={(event) => setSearchTerm(event.target.value)}
                            placeholder="Name or admission number"
                        />
                    </label>
                </section>

                <div className={`transcripts-content${selectedStudent ? ' has-selection' : ''}`}>
                    <section className="transcripts-card transcripts-list">
                        <h2>Archived students <span>({filteredStudents.length})</span></h2>
                        {!filteredStudents.length ? (
                            <div className="transcripts-empty">
                                <i className="fas fa-archive" aria-hidden="true"></i>
                                <strong>No archived students found</strong>
                                <p>Try another year or search term, or refresh the records.</p>
                            </div>
                        ) : (
                            <div className="transcripts-table-scroll">
                                <table>
                                    <thead><tr><th>Admission No.</th><th>Student</th><th>Class</th><th></th></tr></thead>
                                    <tbody>
                                        {filteredStudents.map((student) => (
                                            <tr key={student.id} className={selectedStudent?.id === student.id ? 'selected' : ''}>
                                                <td>{student.admissionNumber || student.studentId || '—'}</td>
                                                <td>{displayName(student)}</td>
                                                <td>{student.class || student.level || '—'}</td>
                                                <td>
                                                    <button type="button" className="transcripts-button view" onClick={() => handleViewTranscript(student)}>
                                                        View
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    {selectedStudent && (
                        <section className="transcripts-card transcripts-detail">
                            <header>
                                <div>
                                    <h2>Official academic transcript</h2>
                                    <p>{displayName(selectedStudent)} · {selectedStudent.admissionNumber || selectedStudent.studentId || '—'}</p>
                                </div>
                                <button type="button" className="transcripts-close" onClick={() => {
                                    setSelectedStudent(null);
                                    setStudentScores([]);
                                    setNotice('');
                                }} aria-label="Close transcript"><i className="fas fa-times"></i></button>
                            </header>

                            <div className="transcripts-student-facts">
                                <div><span>Academic year</span><strong>{selectedStudent.academicYear || selectedStudent.year || '—'}</strong></div>
                                <div><span>Class / level</span><strong>{[selectedStudent.class, selectedStudent.level].filter(Boolean).join(' / ') || '—'}</strong></div>
                                <div><span>Gender</span><strong>{selectedStudent.gender || '—'}</strong></div>
                                <div><span>Archived</span><strong>{toDate(selectedStudent.archivedAt)?.toLocaleDateString() || '—'}</strong></div>
                            </div>

                            <h3>Academic results</h3>
                            {loadingScores ? <LoadingSpinner text="Loading academic results..." /> : (
                                <div className="transcripts-table-scroll">
                                    <table>
                                        <thead><tr><th>Year</th><th>Term</th><th>Assessment</th><th>Subject</th><th>Score</th><th>Grade</th></tr></thead>
                                        <tbody>
                                            {studentScores.map((score) => (
                                                <tr key={score.id}>
                                                    <td>{score.year || score.academicYear || '—'}</td>
                                                    <td>{score.term || '—'}</td>
                                                    <td>{score.assessmentType || score.assessment || '—'}</td>
                                                    <td>{score.subject || score.subjectName || '—'}</td>
                                                    <td>{score.score ?? '—'}{score.outOf ? ` / ${score.outOf}` : ''}</td>
                                                    <td>{score.grade || '—'}</td>
                                                </tr>
                                            ))}
                                            {!studentScores.length && !loadingScores && (
                                                <tr><td colSpan="6" className="transcripts-no-results">No scores found for this archived student.</td></tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <h3>Promotion history</h3>
                            <div className="transcripts-table-scroll">
                                <table>
                                    <thead><tr><th>Year</th><th>Previous class</th><th>Promoted to</th><th>Date</th></tr></thead>
                                    <tbody>
                                        {(selectedStudent.historicalRecords || selectedStudent.history || [])
                                            .filter((record) => record.type === 'promotion')
                                            .map((record, index) => (
                                                <tr key={`${record.year || record.academicYear || 'promotion'}-${index}`}>
                                                    <td>{record.year || record.academicYear || '—'}</td>
                                                    <td>{[record.fromLevel, record.fromClass].filter(Boolean).join(' / ') || '—'}</td>
                                                    <td>{[record.toLevel, record.toClass].filter(Boolean).join(' / ') || '—'}</td>
                                                    <td>{toDate(record.date)?.toLocaleDateString() || '—'}</td>
                                                </tr>
                                            ))}
                                        {!(selectedStudent.historicalRecords || selectedStudent.history || []).some((record) => record.type === 'promotion')
                                            && <tr><td colSpan="4" className="transcripts-no-results">No promotion history is recorded.</td></tr>}
                                    </tbody>
                                </table>
                            </div>

                            <div className="transcripts-actions">
                                <button type="button" className="transcripts-button secondary" onClick={() => window.print()}>
                                    <i className="fas fa-print" aria-hidden="true"></i> Print
                                </button>
                                <button type="button" className="transcripts-button primary" onClick={handleExport} disabled={exporting || loadingScores}>
                                    <i className={`fas ${exporting ? 'fa-spinner fa-spin' : 'fa-file-pdf'}`} aria-hidden="true"></i>
                                    {exporting ? 'Saving PDF…' : 'Export PDF'}
                                </button>
                            </div>
                        </section>
                    )}
                </div>
            </main>
        </Layout>
    );
}
