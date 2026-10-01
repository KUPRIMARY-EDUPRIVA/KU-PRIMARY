// src/pages/StudentReports.jsx
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { db } from '../firebase';
import { collection, query, where, getDocs, orderBy, limit } from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import {
    LEVEL_CLASSES, LEVEL_DISPLAY_NAMES, LEVEL_SUBJECTS, getCBCGrade,
} from '../utils/constants';
import {
    downloadTranscripts,
    downloadClassReportForms,
    downloadStudentReportForm,
} from '../services/pdf';

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

export default function StudentReports() {
    const { userData } = useAuth();

    const [selectedLevel, setSelectedLevel] = useState('');
    const [selectedClass, setSelectedClass] = useState('');
    const [selectedTerm, setSelectedTerm] = useState('2');

    const [students, setStudents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

    const [previewStudent, setPreviewStudent] = useState(null);
    const [previewAssessment, setPreviewAssessment] = useState(0);

    // ------------------------------------------------------------------
    // ALL HOOKS MUST RUN UNCONDITIONALLY, IN THE SAME ORDER, EVERY RENDER.
    // No early returns above this point.
    // ------------------------------------------------------------------
    const subjects = useMemo(() => LEVEL_SUBJECTS[selectedLevel] || [], [selectedLevel]);

  const schoolBranding = useMemo(() => ({
    schoolName: userData?.schoolName || 'EDUPRIVA',
    schoolMotto: userData?.schoolMotto || 'Powering Modern Education',
    schoolLogo: userData?.schoolLogo || '',
    schoolAddress: userData?.schoolAddress || '',
    schoolPhone: userData?.schoolPhone || '',
    schoolEmail: userData?.schoolEmail || '',
    website: userData?.website || '',
    schoolCode: userData?.schoolCode || '',
    schoolStamp: userData?.schoolStamp || '',
    principalSignature: userData?.principalSignature || '',
    principalName: userData?.principalName || '',
    classTeacherName: userData?.classTeacherName || '',
    currentTermStart: userData?.currentTermStart || '',
    currentTermEnd: userData?.currentTermEnd || '',
    nextTermStart: userData?.nextTermStart || '',
    year: new Date().getFullYear(),
}), [userData]);

    const sortedStudents = useMemo(
        () => [...students].sort((a, b) => (b.overallAverage || 0) - (a.overallAverage || 0)),
        [students]
    );

    const ready = students.length > 0;

    const showNotification = useCallback((message, type = 'info') => {
        const colors = {
            success: '#27ae60', error: '#e74c3c',
            warning: '#f39c12', info: '#3498db',
        };
        const el = document.createElement('div');
        el.style.cssText = `position:fixed;top:20px;right:20px;background:${colors[type] || colors.info};color:#fff;padding:14px 18px;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,.18);z-index:10000;max-width:420px;font-size:14px;font-weight:500;`;
        el.textContent = message;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }, []);

    const buildMeta = useCallback(() => ({
        ...schoolBranding,
        level: selectedLevel,
        levelDisplay: LEVEL_DISPLAY_NAMES[selectedLevel] || selectedLevel,
        cls: selectedClass,
        term: `Term ${selectedTerm}`,
        year: new Date().getFullYear(),
    }), [schoolBranding, selectedLevel, selectedClass, selectedTerm]);

    // ---- Load students ----
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
            const studentsSnap = await getDocs(query(
                collection(db, 'students'),
                where('schoolId', '==', schoolId),
                where('level', '==', selectedLevel),
                where('class', '==', selectedClass),
                orderBy('firstName'),
                limit(MAX_STUDENTS)
            ));
            const studentsData = studentsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

            if (studentsData.length === 0) {
                showNotification('No students found for this class', 'warning');
                setStudents([]);
                setHasLoadedOnce(true);
                return;
            }

            const termName = `Term ${selectedTerm}`;
            const scoresSnap = await getDocs(query(
                collection(db, 'student_scores'),
                where('schoolId', '==', schoolId),
                where('level', '==', selectedLevel),
                where('class', '==', selectedClass),
                where('term', '==', termName),
                limit(MAX_SCORES)
            ));

            const bucket = new Map();
            scoresSnap.forEach((d) => {
                const s = d.data();
                if (!s.studentId || !s.subject) return;
                if (!bucket.has(s.studentId)) bucket.set(s.studentId, new Map());
                const bySubj = bucket.get(s.studentId);
                if (!bySubj.has(s.subject)) bySubj.set(s.subject, []);
                bySubj.get(s.subject).push(Number(s.score) || 0);
            });

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
                    ? Math.round(sumOfAverages / assessedCount) : 0;

                return {
                    ...student, scores, averages,
                    assessedCount,
                    totalSubjects: subjects.length,
                    overallAverage: meanOfAssessed,
                };
            });

            setStudents(enriched);
            setHasLoadedOnce(true);
            showNotification(`Loaded ${enriched.length} students`, 'success');
        } catch (err) {
            console.error('loadStudents failed:', err);
            showNotification('Failed to load: ' + err.message, 'error');
        } finally {
            setLoading(false);
        }
    }, [selectedLevel, selectedClass, selectedTerm, subjects, userData?.schoolId, showNotification]);

    useEffect(() => {
        if (hasLoadedOnce && selectedLevel && selectedClass) loadStudents();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedLevel, selectedClass, selectedTerm]);

    const resetSelection = () => {
        setSelectedLevel('');
        setSelectedClass('');
        setStudents([]);
        setHasLoadedOnce(false);
    };

    // ---- Generators ----
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
                student, meta: buildMeta(), subjects, term: `Term ${selectedTerm}`,
            });
            showNotification('Report form downloaded', 'success');
        } catch (err) {
            console.error('single form failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [buildMeta, subjects, selectedTerm, showNotification]);

    const handleDownloadSingleTranscript = useCallback(async (student, assessmentIndex) => {
        setGenerating(true);
        try {
            await downloadTranscripts({
                students: [student], meta: buildMeta(), subjects,
                term: `Term ${selectedTerm}`, assessmentIndex,
            });
            showNotification('Transcript downloaded', 'success');
        } catch (err) {
            console.error('single transcript failed:', err);
            showNotification('Failed: ' + err.message, 'error');
        } finally {
            setGenerating(false);
        }
    }, [buildMeta, subjects, selectedTerm, showNotification]);

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

    // ============================================================
    // Early return — SAFE now that all hooks are above it
    // ============================================================
    if (loading && !hasLoadedOnce) {
        return <LoadingSpinner fullScreen text="Loading students..." />;
    }

    return (
        <Layout title="Student Report Forms (CBC)">
            {/* ---------- Filter bar ---------- */}
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
                        {(LEVEL_CLASSES[selectedLevel] || []).map((c) => (
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

            {/* ---------- Document actions ---------- */}
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
                    {/* Transcripts — 3 buttons */}
                    <DocButton
                        icon="fa-scissors"
                        title="Transcript — Assessment 1"
                        subtitle="4 per page"
                        disabled={!ready || generating}
                        onClick={() => handleDownloadTranscripts(0)}
                        color="#f39c12"
                    />
                    <DocButton
                        icon="fa-scissors"
                        title="Transcript — Assessment 2"
                        subtitle="4 per page"
                        disabled={!ready || generating}
                        onClick={() => handleDownloadTranscripts(1)}
                        color="#e67e22"
                    />
                    <DocButton
                        icon="fa-scissors"
                        title="Transcript — Assessment 3"
                        subtitle="4 per page"
                        disabled={!ready || generating}
                        onClick={() => handleDownloadTranscripts(2)}
                        color="#d35400"
                    />

                    {/* Report form — full page */}
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

            {/* ---------- Students grid ---------- */}
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

            {/* ---------- Preview modal ---------- */}
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
// Sub-components
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

// ============================================================
// Preview modal
// ============================================================
function PreviewModal({
    student, subjects, term, meta,
    assessmentIndex, onAssessmentChange,
    onClose, onDownloadForm, onDownloadTranscript, generating,
}) {
    const overall = getCBCGrade(student.overallAverage || 0);

    return (
        <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
            <div style={modalStyle}>
                {/* Header */}
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

                {/* Assessment tabs */}
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

                {/* Info grid */}
                <div style={infoGridStyle}>
                    <InfoCell label="Admission">{student.admissionNumber || student.studentId || '—'}</InfoCell>
                    <InfoCell label="Class">{student.class || meta.cls}</InfoCell>
                    <InfoCell label="Term">{term}</InfoCell>
                    <InfoCell label="Assessed">
                        {student.assessedCount} / {student.totalSubjects}
                    </InfoCell>
                    <InfoCell label="Overall">
                        <Pill color={gradeColor(overall.level)}>
                            {overall.code} • {overall.points != null ? overall.points.toFixed(1) : '—'} pts
                        </Pill>
                    </InfoCell>
                </div>

                {/* Table */}
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

                {/* Actions */}
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
