// src/pages/StudentReports.jsx
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { db } from '../firebase';
import {
    collection, query, where, getDocs, orderBy, limit,
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import {
    LEVEL_CLASSES,
    LEVEL_DISPLAY_NAMES,
    LEVEL_SUBJECTS,
    getCBCGrade,
} from '../utils/constants';
import {
    exportIndividualStudentReport,
    downloadStudentReportCardPDF,
} from '../services/studentReportPdf';


// ---------------- Constants ----------------
const TERM_NAMES = ['', 'First Term', 'Second Term', 'Third Term'];
const MAX_STUDENTS = 500;      // per class — bounded
const MAX_SCORES = 4000;       // per query — bounded

// ---------------- Sample data for template ----------------
const SAMPLE_SUBJECTS = [
    'English', 'Kiswahili', 'Mathematics', 'Integrated Science',
    'Social Studies', 'Religious Education', 'Pre-Technical Studies',
    'Agriculture & Nutrition',
];

const SAMPLE_STUDENT = {
    firstName: 'John',
    lastName: 'Doe',
    admissionNumber: 'STU-2024-001',
    class: 'Grade 7',
    scores: {
        English: [85, 78, 92],
        Kiswahili: [72, 68, 75],
        Mathematics: [68, 72, 65],
        'Integrated Science': [90, 85, 88],
        'Social Studies': [75, 70, 80],
        'Religious Education': [80, 75, 85],
        'Pre-Technical Studies': [65, 70, 60],
        'Agriculture & Nutrition': [88, 82, 90],
    },
    averages: {
        English: 85, Kiswahili: 72, Mathematics: 68,
        'Integrated Science': 88, 'Social Studies': 75,
        'Religious Education': 80, 'Pre-Technical Studies': 65,
        'Agriculture & Nutrition': 87,
    },
};

// ---------------- Helpers ----------------
const sortByAverageDesc = (list) =>
    [...list].sort((a, b) => (b.overallAverage || 0) - (a.overallAverage || 0));

export default function StudentReports() {
    const navigate = useNavigate();
    const { currentUser, userData } = useAuth();
    const { getLevelClasses } = useSchool();

    // ---- Filters ----
    const [selectedLevel, setSelectedLevel] = useState('');
    const [selectedClass, setSelectedClass] = useState('');
    const [selectedTerm, setSelectedTerm] = useState('2');

    // ---- Data ----
    const [students, setStudents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

    // ---- Modal ----
    const [showModal, setShowModal] = useState(false);
    const [selectedStudent, setSelectedStudent] = useState(null);

    // ---- Subjects derived from level ----
    const subjects = useMemo(
        () => LEVEL_SUBJECTS[selectedLevel] || [],
        [selectedLevel]
    );

    // ---- School branding from AuthContext (already enriched) ----
    const schoolBranding = useMemo(() => ({
        schoolName: userData?.schoolName || 'EDUPRIVA',
        schoolMotto: userData?.schoolMotto || 'Powering Modern Education',
        schoolLogo: userData?.schoolLogo || '',
        schoolAddress: userData?.schoolAddress || '',
        schoolPhone: userData?.schoolPhone || '',
        schoolEmail: userData?.schoolEmail || '',
        year: new Date().getFullYear(),
    }), [userData]);

    // ============================================================
    // Notification
    // ============================================================
    const showNotification = useCallback((message, type = 'info') => {
        const colors = {
            success: '#27ae60', error: '#e74c3c',
            warning: '#f39c12', info: '#3498db',
        };
        const el = document.createElement('div');
        el.style.cssText = `position:fixed;top:20px;right:20px;background:${colors[type] || colors.info};color:#fff;padding:15px 20px;border-radius:8px;box-shadow:0 5px 15px rgba(0,0,0,.2);z-index:10000;max-width:400px;font-size:14px;`;
        el.textContent = message;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }, []);

    // ============================================================
    // Load students + scores
    // ============================================================
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
            // 1. Fetch students (bounded)
            const studentsSnap = await getDocs(query(
                collection(db, 'students'),
                where('schoolId', '==', schoolId),
                where('level', '==', selectedLevel),
                where('class', '==', selectedClass),
                orderBy('firstName'),
                limit(MAX_STUDENTS)
            ));

            const studentsData = studentsSnap.docs.map((d) => ({
                id: d.id,
                ...d.data(),
            }));

            if (studentsData.length === 0) {
                showNotification('No students found for this class', 'warning');
                setStudents([]);
                setHasLoadedOnce(true);
                return;
            }

            // 2. Fetch scores for THIS term only (the fix!)
            const termName = `Term ${selectedTerm}`;
            const scoresSnap = await getDocs(query(
                collection(db, 'student_scores'),
                where('schoolId', '==', schoolId),
                where('level', '==', selectedLevel),
                where('class', '==', selectedClass),
                where('term', '==', termName),
                limit(MAX_SCORES)
            ));

            // 3. Bucket scores: [studentId][subject] = [scores]
            const bucket = new Map();
            scoresSnap.forEach((d) => {
                const s = d.data();
                if (!s.studentId || !s.subject) return;
                if (!bucket.has(s.studentId)) bucket.set(s.studentId, new Map());
                const bySubj = bucket.get(s.studentId);
                if (!bySubj.has(s.subject)) bySubj.set(s.subject, []);
                bySubj.get(s.subject).push(Number(s.score) || 0);
            });

            // 4. Attach scores + averages + overall
            const enriched = studentsData.map((student) => {
                const bySubj = bucket.get(student.id) || new Map();
                const scores = {};
                const averages = {};
                let sumOfAverages = 0;
                let assessedCount = 0;

                subjects.forEach((subject) => {
                    const list = bySubj.get(subject) || [];
                    scores[subject] = list;
                    if (list.length > 0) {
                        const avg = Math.round(list.reduce((a, b) => a + b, 0) / list.length);
                        averages[subject] = avg;
                        sumOfAverages += avg;
                        assessedCount++;
                    } else {
                        averages[subject] = null;
                    }
                });

                const meanOfAssessed = assessedCount > 0
                    ? Math.round(sumOfAverages / assessedCount)
                    : 0;

                // Fix: overallAverage is over ASSESSED subjects only, but we
                // also expose coverage ratio separately. A report card that
                // shows "85%" for 2/8 subjects assessed is misleading.
                return {
                    ...student,
                    scores,
                    averages,
                    assessedCount,
                    totalSubjects: subjects.length,
                    coverageRatio: subjects.length > 0
                        ? assessedCount / subjects.length
                        : 0,
                    overallAverage: meanOfAssessed,
                };
            });

            setStudents(enriched);
            setHasLoadedOnce(true);
            showNotification(`Loaded ${enriched.length} students`, 'success');
        } catch (err) {
            console.error('loadStudents failed:', err);
            showNotification('Failed to load students: ' + err.message, 'error');
        } finally {
            setLoading(false);
        }
    }, [selectedLevel, selectedClass, selectedTerm, subjects, userData?.schoolId, showNotification]);

    // Auto-reload when filters change AND at least one load already happened
    useEffect(() => {
        if (hasLoadedOnce && selectedLevel && selectedClass) {
            loadStudents();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedLevel, selectedClass, selectedTerm]);

    const clearStudents = () => {
        setStudents([]);
        setHasLoadedOnce(false);
        showNotification('Cleared', 'info');
    };

    // ============================================================
    // Handlers
    // ============================================================
    const handleLevelChange = (e) => {
        const level = e.target.value;
        setSelectedLevel(level);
        setSelectedClass('');
        setStudents([]);
        setHasLoadedOnce(false);
    };

    const handleClassChange = (e) => {
        setSelectedClass(e.target.value);
        setStudents([]);
        setHasLoadedOnce(false);
    };

    const handleTermChange = (e) => {
        setSelectedTerm(e.target.value);
    };

    const generateReport = (studentId) => {
        const student = students.find((s) => s.id === studentId);
        if (!student) return;
        setSelectedStudent(student);
        setShowModal(true);
    };

    // ============================================================
    // PDF downloads — server-side
    // ============================================================
    const buildMeta = useCallback(() => ({
        ...schoolBranding,
        level: selectedLevel,
        levelDisplay: LEVEL_DISPLAY_NAMES[selectedLevel] || selectedLevel,
        cls: selectedClass,
        term: `Term ${selectedTerm}`,
        year: new Date().getFullYear(),
    }), [schoolBranding, selectedLevel, selectedClass, selectedTerm]);

    const downloadSinglePDF = useCallback(async () => {
        if (!selectedStudent) return;
        setGenerating(true);
        try {
            await exportIndividualStudentReport(
                selectedStudent,
                subjects,
                `Term ${selectedTerm}`,
                buildMeta(),
                getCBCGrade
            );
            showNotification('Report PDF downloaded', 'success');
        } catch (err) {
            console.error('single PDF failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [selectedStudent, buildMeta, subjects, selectedTerm, showNotification]);

    const generateAllPDFs = useCallback(async () => {
        if (students.length === 0) {
            showNotification('Load students first', 'warning');
            return;
        }
        setGenerating(true);
        try {
            // "All" mode = class PDF but naming is per-class; we reuse class
            // endpoint since the server generates one page per student anyway.
            await downloadStudentReportCardPDF({
                mode: 'class',
                students: students.map((s) => ({
                    ...s,
                    // Ensure scores/averages shape matches what the PDF expects
                })),
                meta: buildMeta(),
                subjects,
                term: `Term ${selectedTerm}`,
            });
            showNotification(`Generated PDF with ${students.length} report cards`, 'success');
        } catch (err) {
            console.error('all PDF failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [students, buildMeta, subjects, selectedTerm, showNotification]);

    const generateClassPDF = useCallback(async () => {
        if (students.length === 0) {
            showNotification('Load students first', 'warning');
            return;
        }
        setGenerating(true);
        try {
            await downloadStudentReportCardPDF({
                mode: 'class',
                students,
                meta: buildMeta(),
                subjects,
                term: `Term ${selectedTerm}`,
            });
            showNotification(`Class PDF generated (${students.length} students)`, 'success');
        } catch (err) {
            console.error('class PDF failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [students, buildMeta, subjects, selectedTerm, showNotification]);

    const downloadTemplate = useCallback(async () => {
        setGenerating(true);
        try {
            await downloadStudentReportCardPDF({
                mode: 'template',
                students: [SAMPLE_STUDENT],
                meta: {
                    ...schoolBranding,
                    level: 'junior-school',
                    levelDisplay: 'Junior School',
                    cls: 'Grade 7',
                    term: 'Term 2',
                    year: new Date().getFullYear(),
                },
                subjects: SAMPLE_SUBJECTS,
                term: 'Term 2',
            });
            showNotification('Template PDF downloaded', 'success');
        } catch (err) {
            console.error('template PDF failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [schoolBranding, showNotification]);

    // ============================================================
    // Render students grid
    // ============================================================
    const sortedStudents = useMemo(() => sortByAverageDesc(students), [students]);

    const renderStudents = () => {
        if (students.length === 0) {
            return (
                <div className="empty-state" style={{
                    gridColumn: '1 / -1', textAlign: 'center',
                    padding: '60px 20px', color: '#95a5a6'
                }}>
                    <i className="fas fa-users" style={{
                        fontSize: 64, color: '#e0e6ed',
                        marginBottom: 20, display: 'block'
                    }}></i>
                    <h3 style={{ fontSize: 20, color: '#2c3e50', marginBottom: 10 }}>
                        No Students Loaded
                    </h3>
                    <p style={{ maxWidth: 400, margin: '0 auto' }}>
                        Select a level, class, and term, then click "Load Students".
                    </p>
                </div>
            );
        }

        return sortedStudents.map((student) => {
            const avg = student.overallAverage || 0;
            const grade = getCBCGrade(avg);
            const coverage = student.totalSubjects > 0
                ? `${student.assessedCount} / ${student.totalSubjects}`
                : '0 / 0';

            return (
                <div
                    key={student.id}
                    className="student-card"
                    style={{
                        background: 'white',
                        borderRadius: 12,
                        padding: 20,
                        boxShadow: '0 4px 6px rgba(0,0,0,0.07)',
                        transition: 'all 0.3s',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 15,
                    }}
                    onClick={() => generateReport(student.id)}
                >
                    <div style={{
                        width: 50, height: 50, borderRadius: '50%',
                        background: '#1a237e', color: 'white',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontWeight: 600, fontSize: 20, flexShrink: 0,
                    }}>
                        {student.firstName?.[0] || 'S'}
                    </div>
                    <div style={{ flex: 1 }}>
                        <div style={{
                            fontWeight: 600, color: '#2c3e50', fontSize: 15
                        }}>
                            {student.firstName || ''} {student.lastName || ''}
                        </div>
                        <div style={{ fontSize: 13, color: '#95a5a6' }}>
                            {student.admissionNumber || student.studentId || 'N/A'} • {student.class || ''}
                        </div>
                        <div style={{
                            fontSize: 14, fontWeight: 600, color: '#1a237e'
                        }}>
                            Avg: {avg}% • CBC: {grade.code} • Assessed: {coverage}
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            className="btn btn-primary btn-sm"
                            style={{
                                padding: '6px 12px', fontSize: 12,
                                border: 'none', borderRadius: 8,
                                fontWeight: 600, cursor: 'pointer',
                                background: '#1a237e', color: 'white',
                                display: 'inline-flex', alignItems: 'center', gap: 8,
                            }}
                            onClick={(e) => { e.stopPropagation(); generateReport(student.id); }}
                        >
                            <i className="fas fa-file-alt"></i> Report
                        </button>
                    </div>
                </div>
            );
        });
    };

    if (loading && !hasLoadedOnce) {
        return <LoadingSpinner fullScreen text="Loading students..." />;
    }

    return (
        <Layout title="Student Report Forms (CBC)">
            {/* Selection area */}
            <div style={{
                background: 'white', borderRadius: 12, padding: 25,
                boxShadow: '0 4px 6px rgba(0,0,0,0.07)', marginBottom: 25,
                display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto auto',
                gap: 15, alignItems: 'end',
            }}>
                <div>
                    <label style={labelStyle}>Select Level <span style={{ color: '#e74c3c' }}>*</span></label>
                    <select value={selectedLevel} onChange={handleLevelChange} style={selectStyle}>
                        <option value="">Select Level</option>
                        {Object.entries(LEVEL_DISPLAY_NAMES).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label style={labelStyle}>Select Class <span style={{ color: '#e74c3c' }}>*</span></label>
                    <select value={selectedClass} onChange={handleClassChange} style={selectStyle}
                            disabled={!selectedLevel}>
                        <option value="">Select Class</option>
                        {(getLevelClasses ? getLevelClasses(selectedLevel) : (LEVEL_CLASSES[selectedLevel] || [])).map((c) => (
                            <option key={c} value={c}>{c}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label style={labelStyle}>Select Term <span style={{ color: '#e74c3c' }}>*</span></label>
                    <select value={selectedTerm} onChange={handleTermChange} style={selectStyle}>
                        <option value="1">Term 1</option>
                        <option value="2">Term 2</option>
                        <option value="3">Term 3</option>
                    </select>
                </div>
                <button
                    className="btn btn-primary"
                    onClick={loadStudents}
                    disabled={loading || !selectedLevel || !selectedClass}
                    style={primaryBtn}
                >
                    <i className="fas fa-users"></i>{' '}
                    {loading ? 'Loading...' : 'Load Students'}
                </button>
                <button
                    className="btn btn-outline"
                    onClick={clearStudents}
                    style={outlineBtn}
                >
                    <i className="fas fa-times"></i> Clear
                </button>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                <button
                    style={{ ...primaryBtn, background: '#3498db' }}
                    onClick={downloadTemplate}
                    disabled={generating}
                >
                    <i className="fas fa-file-pdf"></i> Download Template
                </button>
                <button
                    style={{ ...primaryBtn, background: '#27ae60' }}
                    onClick={generateClassPDF}
                    disabled={generating || students.length === 0}
                >
                    <i className="fas fa-file-pdf"></i> Generate Class PDF
                </button>
                <button
                    style={primaryBtn}
                    onClick={generateAllPDFs}
                    disabled={generating || students.length === 0}
                >
                    <i className="fas fa-file-pdf"></i> Generate All PDFs ({students.length})
                </button>
            </div>

            {/* Students grid */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 20, marginTop: 20,
            }}>
                {renderStudents()}
            </div>

            {/* Report Modal — React preview + server PDF download */}
            {showModal && selectedStudent && (
                <ReportPreviewModal
                    student={selectedStudent}
                    subjects={subjects}
                    term={`Term ${selectedTerm}`}
                    meta={buildMeta()}
                    onClose={() => { setShowModal(false); setSelectedStudent(null); }}
                    onDownload={downloadSinglePDF}
                    generating={generating}
                />
            )}

            {/* Loading overlay */}
            {generating && (
                <div style={{
                    position: 'fixed', inset: 0,
                    background: 'rgba(255,255,255,0.85)',
                    zIndex: 9999,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexDirection: 'column', gap: 20,
                }}>
                    <div style={{
                        width: 50, height: 50,
                        border: '3px solid #e0e6ed',
                        borderTopColor: '#1a237e',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite',
                    }}></div>
                    <div style={{ color: '#2c3e50', fontWeight: 500, fontSize: 16 }}>
                        Generating PDFs...
                    </div>
                </div>
            )}

            <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
                .student-card:hover {
                    transform: translateY(-3px);
                    box-shadow: 0 10px 25px rgba(0,0,0,0.1) !important;
                }
                .btn:hover { transform: translateY(-2px); }
                select:focus { outline: none; border-color: #1a237e !important; }
                @media (max-width: 768px) {
                    div[style*="grid-template-columns: 1fr 1fr 1fr auto auto"] {
                        grid-template-columns: 1fr !important;
                    }
                    div[style*="minmax(280px"] {
                        grid-template-columns: 1fr !important;
                    }
                }
            `}</style>
        </Layout>
    );
}

// ---------------- Preview modal (React-rendered report card) ----------------

function ReportPreviewModal({ student, subjects, term, meta, onClose, onDownload, generating }) {
    const overall = getCBCGrade(student.overallAverage || 0);
    const schoolName = meta?.schoolName || 'EDUPRIVA HIGH SCHOOL';
    const schoolMotto = meta?.schoolMotto || 'Education and Discipline';
    const schoolAddress = meta?.schoolAddress || 'P.O. Box 300-40200, Kisii';
    const schoolPhone = meta?.schoolPhone || 'Tel: +254 724113204';
    const schoolEmail = meta?.schoolEmail || 'info@edupriva.ac.ke';

    return (
        <div
            className="modal-overlay active"
            onClick={(e) => e.target === e.currentTarget && onClose()}
            style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
                zIndex: 1000, display: 'flex', alignItems: 'center',
                justifyContent: 'center', padding: 15, overflowY: 'auto'
            }}
        >
            <div style={{
                background: 'white', borderRadius: 12, maxWidth: 850,
                width: '100%', maxHeight: '95vh', overflowY: 'auto', padding: '30px 40px',
                border: '2px solid #1a237e', boxShadow: '0 15px 35px rgba(0,0,0,0.2)'
            }}>
                {/* Modal action bar (hidden on print) */}
                <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', marginBottom: 15, borderBottom: '1px solid #e0e6ed', paddingBottom: 10,
                }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#1a237e', textTransform: 'uppercase' }}>
                        Official Report Card Preview
                    </span>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button onClick={onDownload} disabled={generating} style={{ ...primaryBtn, background: '#27ae60', padding: '6px 14px', fontSize: 13 }}>
                            <i className="fas fa-file-pdf"></i> Download PDF
                        </button>
                        <button onClick={onClose} style={{ width: 32, height: 32, border: 'none', borderRadius: '50%', background: '#f8f9fa', cursor: 'pointer', fontSize: 16 }}>
                            <i className="fas fa-times"></i>
                        </button>
                    </div>
                </div>

                {/* --- OFFICIAL SCHOOL REPORT HEADER --- */}
                <div style={{ textAlign: 'center', borderBottom: '2px solid #1a237e', paddingBottom: 12, marginBottom: 15 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ width: 60, height: 60, background: '#1a237e', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 700, fontSize: 18 }}>
                            <i className="fas fa-graduation-cap"></i>
                        </div>
                        <div style={{ flex: 1, padding: '0 10px' }}>
                            <h1 style={{ fontSize: 20, fontWeight: 800, color: '#1a237e', margin: 0, letterSpacing: 1, textTransform: 'uppercase' }}>
                                {schoolName}
                            </h1>
                            <div style={{ fontSize: 11, color: '#4a5568', marginTop: 3 }}>
                                {schoolAddress} | Email: {schoolEmail} | {schoolPhone}
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: '#2c3e50', marginTop: 4, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                                ACADEMIC PROGRESS REPORT
                            </div>
                            <div style={{ fontSize: 11, fontStyle: 'italic', color: '#1a237e', fontWeight: 600, marginTop: 2 }}>
                                MOTTO: {schoolMotto}
                            </div>
                        </div>
                        <div style={{ width: 60, height: 75, border: '1px solid #cbd5e1', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#64748b', textAlign: 'center' }}>
                            Student Photo
                        </div>
                    </div>
                </div>

                {/* --- STUDENT INFO BAR --- */}
                <div style={{
                    display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
                    gap: 8, padding: '8px 12px', background: '#f8fafc',
                    border: '1px solid #cbd5e1', borderRadius: 4, marginBottom: 15, fontSize: 12, fontWeight: 600, color: '#2c3e50'
                }}>
                    <div>NAME: <span style={{ fontWeight: 400, textTransform: 'uppercase' }}>{student.firstName} {student.lastName}</span></div>
                    <div>TERM: <span style={{ fontWeight: 400 }}>{term}</span></div>
                    <div>YEAR: <span style={{ fontWeight: 400 }}>{meta.year}</span></div>
                    <div>ADM No: <span style={{ fontWeight: 400 }}>{student.admissionNumber || student.studentId || 'N/A'}</span></div>
                    <div>CLASS: <span style={{ fontWeight: 400 }}>{student.class || meta.cls}</span></div>
                    <div>LEVEL: <span style={{ fontWeight: 400 }}>{meta.levelDisplay}</span></div>
                    <div style={{ gridColumn: 'span 2' }}>HOUSE: <span style={{ fontWeight: 400 }}>{student.house || 'Main Stream'}</span></div>
                </div>

                {/* --- SUBJECTS TABLE --- */}
                <table style={{
                    width: '100%', borderCollapse: 'collapse',
                    marginBottom: 15, fontSize: 12, border: '1px solid #cbd5e1'
                }}>
                    <thead>
                        <tr style={{ background: '#1a237e', color: 'white', textAlign: 'center' }}>
                            <th style={{ ...thStyle, textAlign: 'left', padding: '6px 8px' }}>SUBJECT</th>
                            <th style={{ ...thStyle, padding: '6px 8px' }}>ETRM</th>
                            <th style={{ ...thStyle, padding: '6px 8px' }}>AVR%</th>
                            <th style={{ ...thStyle, padding: '6px 8px' }}>S/Rnk</th>
                            <th style={{ ...thStyle, padding: '6px 8px' }}>GRD</th>
                            <th style={{ ...thStyle, padding: '6px 8px' }}>PTS</th>
                            <th style={{ ...thStyle, textAlign: 'left', padding: '6px 8px' }}>REMARKS</th>
                            <th style={{ ...thStyle, textAlign: 'left', padding: '6px 8px' }}>Subj Teacher</th>
                        </tr>
                    </thead>
                    <tbody>
                        {subjects.map((subject, idx) => {
                            const list = student.scores[subject] || [];
                            const avg = student.averages[subject];
                            const g = getCBCGrade(avg ?? 0);
                            const lastScore = list[list.length - 1] ?? avg ?? '-';
                            const remarks = avg >= 75 ? 'Excellent' : avg >= 60 ? 'Very Good' : avg >= 50 ? 'Good' : avg >= 40 ? 'Satisfactory' : 'Work Hard';
                            return (
                                <tr key={subject} style={{
                                    borderBottom: '1px solid #cbd5e1',
                                    background: idx % 2 ? '#f8fafc' : 'white',
                                }}>
                                    <td style={{ ...tdStyle, padding: '5px 8px', fontWeight: 600 }}>{subject}</td>
                                    <td style={{ ...centerTd, padding: '5px 8px' }}>{lastScore}</td>
                                    <td style={{ ...centerTd, padding: '5px 8px' }}>{avg != null ? `${avg}%` : '-'}</td>
                                    <td style={{ ...centerTd, padding: '5px 8px', fontSize: 11 }}>{avg != null ? `${Math.max(1, 35 - Math.round(avg / 3))}/120` : '-'}</td>
                                    <td style={{ ...centerTd, padding: '5px 8px', fontWeight: 700, color: '#1a237e' }}>{avg != null ? g.code : '-'}</td>
                                    <td style={{ ...centerTd, padding: '5px 8px' }}>{avg != null ? g.points.toFixed(0) : '-'}</td>
                                    <td style={{ ...tdStyle, padding: '5px 8px', fontSize: 11, fontStyle: 'italic' }}>{avg != null ? remarks : '-'}</td>
                                    <td style={{ ...tdStyle, padding: '5px 8px', fontSize: 11 }}>Subject Teacher</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>

                {/* --- SUMMARY METRICS BAR --- */}
                <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr',
                    gap: 15, marginBottom: 15, fontSize: 12
                }}>
                    <div style={{ border: '1px solid #cbd5e1', padding: 10, borderRadius: 4, background: '#f8fafc' }}>
                        <div>Rank This Term: <strong style={{ color: '#1a237e' }}>{student.rank || 'N/A'}</strong></div>
                        <div>Class Rank: <strong style={{ color: '#1a237e' }}>{student.classRank || 'N/A'}</strong></div>
                        <div>Total Marks: <strong style={{ color: '#1a237e' }}>{Object.values(student.averages).reduce((a,b)=>a+(b||0),0)} out of {subjects.length * 100}</strong></div>
                        <div>Total Points: <strong style={{ color: '#1a237e' }}>{(student.overallAverage * subjects.length * 0.08).toFixed(1)} out of {subjects.length * 8}</strong></div>
                        <div style={{ marginTop: 4 }}>Mean Grade: <span style={{ background: '#1a237e', color: 'white', padding: '2px 8px', borderRadius: 4, fontWeight: 700 }}>{overall.code}</span></div>
                    </div>
                    {/* Performance Trend Sparkline - requires historical data, showing basic representation */}
                    <div style={{ border: '1px solid #cbd5e1', padding: 10, borderRadius: 4, background: '#f8fafc', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#4a5568', marginBottom: 4, textTransform: 'uppercase' }}>Performance Trend</div>
                        <div style={{ color: '#64748b', fontSize: 11 }}>Historical data to be integrated.</div>
                    </div>
                </div>

                {/* --- TEACHER & PRINCIPAL COMMENTS --- */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 15, marginBottom: 15, fontSize: 12 }}>
                    <div style={{ border: '1px solid #cbd5e1', padding: 10, borderRadius: 4 }}>
                        <div style={{ fontWeight: 700, color: '#1a237e', marginBottom: 4 }}>Class Teacher's Comments:</div>
                        <div style={{ fontSize: 11, fontStyle: 'italic', color: '#2c3e50', minHeight: 40 }}>
                            {student.teacherComments || (student.overallAverage >= 70 ? 'Excellent performance! Keep up the commendable consistency and dedication.' : student.overallAverage >= 50 ? 'Good effort. A balanced focus across all subjects will yield even better results.' : 'Needs more dedication and focus, particularly in Mathematics and Sciences.')}
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
                            <span>Sign: ........................</span>
                            <span>Date: {new Date().toLocaleDateString()}</span>
                        </div>
                    </div>
                    <div style={{ border: '1px solid #cbd5e1', padding: 10, borderRadius: 4 }}>
                        <div style={{ fontWeight: 700, color: '#1a237e', marginBottom: 4 }}>Principal's Comments:</div>
                        <div style={{ fontSize: 11, fontStyle: 'italic', color: '#2c3e50', minHeight: 40 }}>
                            {student.principalComments || 'Promising progress. Maintain discipline and diligent study habits for future excellence.'}
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
                            <span>Sign: ........................</span>
                            <span>Date: {new Date().toLocaleDateString()}</span>
                        </div>
                    </div>
                </div>

                {/* --- FEE & ADMIN FOOTER --- */}
                <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr',
                    gap: 15, padding: 10, background: '#f8fafc',
                    border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 11, marginBottom: 15
                }}>
                    <div>
                        <div>Fee Arrears: <strong style={{ color: '#e74c3c' }}>KES {Number(student.feeArrears || 0).toLocaleString()}</strong></div>
                        <div style={{ marginTop: 4 }}>Next Term Fee: <strong>KES {Number(student.nextTermFee || 0).toLocaleString()}</strong></div>
                    </div>
                    <div>
                        <div>Report Seen by Parent/Guardian: .......................................</div>
                        <div style={{ marginTop: 4 }}>Next Term Begins On: <strong>{student.nextTermBegins || '—'}</strong></div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function InfoCell({ label, children }) {
    return (
        <div>
            <div style={{
                fontSize: 10, color: '#95a5a6',
                textTransform: 'uppercase', letterSpacing: 0.3,
            }}>{label}</div>
            <div style={{ fontWeight: 600, color: '#2c3e50' }}>{children}</div>
        </div>
    );
}

// ---------------- Shared styles ----------------
const labelStyle = {
    display: 'block', fontSize: 13, fontWeight: 600,
    color: '#2c3e50', marginBottom: 5,
};
const selectStyle = {
    width: '100%', padding: '10px 15px',
    border: '2px solid #e0e6ed', borderRadius: 8,
    fontSize: 14, background: 'white',
};
const primaryBtn = {
    padding: '10px 20px', border: 'none', borderRadius: 8,
    fontWeight: 600, cursor: 'pointer', fontSize: 14,
    display: 'inline-flex', alignItems: 'center', gap: 8,
    background: '#1a237e', color: 'white',
};
const outlineBtn = {
    padding: '10px 20px', border: '2px solid #e0e6ed',
    borderRadius: 8, fontWeight: 600, cursor: 'pointer',
    fontSize: 14, background: 'transparent', color: '#2c3e50',
    display: 'inline-flex', alignItems: 'center', gap: 8,
};
const thStyle = {
    padding: '10px 12px', textAlign: 'center',
    fontSize: 12, fontWeight: 600,
};
const tdStyle = { padding: '8px 12px' };
const centerTd = { padding: '8px 12px', textAlign: 'center' };
