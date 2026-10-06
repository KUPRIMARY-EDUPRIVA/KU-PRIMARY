// src/pages/Reports.jsx
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { db } from '../firebase';
import {
    collection, query, where, getDocs, limit
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { LEVEL_DISPLAY_NAMES, getCBCGrade } from '../utils/constants';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    PieChart, Pie, Cell, Legend, LineChart, Line
} from 'recharts';
import { downloadExecutiveReportsPDF } from '../services/pdf';

// ---------- constants ----------
const LEVEL_ORDER = ['pre-primary', 'lower-primary', 'upper-primary', 'junior-school', 'senior-school'];
const LEVEL_COLORS = {
    'pre-primary':    '#f59e0b',
    'lower-primary':  '#3b82f6',
    'upper-primary':  '#8b5cf6',
    'junior-school':  '#ec4899',
    'senior-school':  '#10b981'
};
const CHART_COLORS = ['#4f46e5', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6'];

const TERMS = ['Term 1', 'Term 2', 'Term 3'];
const currentYear = new Date().getFullYear();
const YEARS = [currentYear, currentYear - 1, currentYear - 2];

// ---------- helpers ----------
function fmtPct(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return `${Number(n).toFixed(1)}%`;
}
function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function normalizeScore(score, outOf = 100) {
    if (score === null || score === undefined) return null;
    const n = Number(score);
    if (Number.isNaN(n)) return null;
    return outOf === 100 ? n : (n / outOf) * 100;
}
function gradeBand(avg) {
    if (avg === null || avg === undefined) return { label: 'No Data', cls: 'rp-band rp-band-na' };
    if (avg >= 75) return { label: 'Exceeding Expectation', cls: 'rp-band rp-band-ee' };
    if (avg >= 58) return { label: 'Meeting Expectation',   cls: 'rp-band rp-band-me' };
    if (avg >= 31) return { label: 'Approaching Expectation', cls: 'rp-band rp-band-ae' };
    return { label: 'Below Expectation', cls: 'rp-band rp-band-be' };
}

export default function Reports() {
    const { currentUser, userData } = useAuth();
    const { getLevelClasses } = useSchool();
    const schoolId = userData?.schoolId;

    // ---------- state ----------
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [exporting, setExporting] = useState(false);
    const [feedback, setFeedback] = useState({ message: '', type: '' });

    const [students, setStudents] = useState([]);
    const [scores, setScores] = useState([]);
    const [exams, setExams] = useState([]);

    // filters
    const [term, setTerm] = useState('Term 1');
    const [year, setYear] = useState(currentYear);
    const [levelFilter, setLevelFilter] = useState('');
    const [classFilter, setClassFilter] = useState('');

    // ---------- notifications ----------
    const notify = useCallback((message, type = 'success') => {
        setFeedback({ message, type });
    }, []);

    // ---------- data loading ----------
    const loadData = useCallback(async () => {
        if (!schoolId) return;
        setLoading(true);
        setError(null);
        try {
            const studentsSnap = await getDocs(query(
                collection(db, 'students'),
                where('schoolId', '==', schoolId),
                limit(2000)
            ));
            const studentList = studentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            setStudents(studentList);

            const examsSnap = await getDocs(query(
                collection(db, 'exams'),
                where('schoolId', '==', schoolId),
                where('term', '==', term),
                where('year', '==', Number(year)),
                limit(500)
            ));
            setExams(examsSnap.docs.map(d => ({ id: d.id, ...d.data() })));

            const scoresSnap = await getDocs(query(
                collection(db, 'student_scores'),
                where('schoolId', '==', schoolId),
                where('term', '==', term),
                where('year', '==', Number(year)),
                limit(5000)
            ));
            setScores(scoresSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        } catch (err) {
            console.error('Reports.loadData:', err);
            setError(err.message);
            notify('Failed to load reports: ' + err.message, 'error');
        } finally {
            setLoading(false);
        }
    }, [schoolId, term, year, notify]);

    useEffect(() => {
        if (currentUser && schoolId) loadData();
    }, [currentUser, schoolId, loadData]);

    // ---------- filters ----------
    const classesForLevel = useMemo(() => {
        if (!levelFilter) return [];
        const set = new Set();
        students.forEach(s => {
            if (s.level === levelFilter && s.class) set.add(s.class);
        });
        return [...set].sort();
    }, [students, levelFilter]);

    const filteredStudents = useMemo(() => students.filter(s => {
        if (levelFilter && s.level !== levelFilter) return false;
        if (classFilter && s.class !== classFilter) return false;
        return true;
    }), [students, levelFilter, classFilter]);

    const filteredStudentIds = useMemo(
        () => new Set(filteredStudents.map(s => s.id)),
        [filteredStudents]
    );

    const filteredScores = useMemo(
        () => scores.filter(sc => filteredStudentIds.has(sc.studentId)),
        [scores, filteredStudentIds]
    );

    // ---------- KPIs ----------
    const kpis = useMemo(() => {
        const byStudent = new Map();
        for (const sc of filteredScores) {
            const pct = normalizeScore(sc.score, sc.outOf || 100);
            if (pct === null) continue;
            if (!byStudent.has(sc.studentId)) byStudent.set(sc.studentId, []);
            byStudent.get(sc.studentId).push(pct);
        }

        const studentAverages = new Map();
        for (const [sid, arr] of byStudent.entries()) studentAverages.set(sid, mean(arr));

        const allAverages = [...studentAverages.values()];
        const avgScore = allAverages.length ? mean(allAverages) : null;

        const passCount = allAverages.filter(v => v >= 58).length;
        const passRate = allAverages.length ? (passCount / allAverages.length) * 100 : null;

        const allScorePcts = [...byStudent.values()].flat();
        const masteryCount = allScorePcts.filter(v => v >= 58).length;
        const competencyMastery = allScorePcts.length ? (masteryCount / allScorePcts.length) * 100 : null;

        return {
            totalStudents: filteredStudents.length,
            studentsWithScores: studentAverages.size,
            avgScore,
            passRate,
            competencyMastery,
            totalScores: allScorePcts.length
        };
    }, [filteredStudents, filteredScores]);

    // ---------- per level ----------
    const levelChartData = useMemo(() => {
        const byLevel = new Map();
        for (const level of LEVEL_ORDER) {
            byLevel.set(level, { scores: [], students: new Set() });
        }
        for (const s of filteredStudents) {
            if (!s.level || !byLevel.has(s.level)) continue;
            byLevel.get(s.level).students.add(s.id);
        }
        const studentLevel = new Map(filteredStudents.map(s => [s.id, s.level]));
        for (const sc of filteredScores) {
            const pct = normalizeScore(sc.score, sc.outOf || 100);
            if (pct === null) continue;
            const lvl = studentLevel.get(sc.studentId);
            if (!lvl || !byLevel.has(lvl)) continue;
            byLevel.get(lvl).scores.push(pct);
        }
        return LEVEL_ORDER.map(level => {
            const entry = byLevel.get(level);
            return {
                levelKey: level,
                name: LEVEL_DISPLAY_NAMES[level] || level,
                averageScore: entry.scores.length ? Number(mean(entry.scores).toFixed(1)) : 0,
                studentsCount: entry.students.size,
                color: LEVEL_COLORS[level] || '#4f46e5',
                hasData: entry.scores.length > 0
            };
        });
    }, [filteredStudents, filteredScores]);

    // ---------- per subject ----------
    const subjectChartData = useMemo(() => {
        const bySubject = new Map();
        for (const sc of filteredScores) {
            const subj = sc.subject || sc.subjectName || 'Unknown';
            const pct = normalizeScore(sc.score, sc.outOf || 100);
            if (pct === null) continue;
            if (!bySubject.has(subj)) bySubject.set(subj, []);
            bySubject.get(subj).push(pct);
        }
        return [...bySubject.entries()]
            .map(([subject, arr]) => ({
                subject,
                average: Number(mean(arr).toFixed(1)),
                count: arr.length
            }))
            .sort((a, b) => b.average - a.average);
    }, [filteredScores]);

    // ---------- class leaderboard ----------
    const classRanksData = useMemo(() => {
        const byClass = new Map();
        for (const s of filteredStudents) {
            const cls = s.class || 'Unassigned';
            if (!byClass.has(cls)) {
                byClass.set(cls, {
                    className: cls,
                    level: s.level || '',
                    studentIds: new Set(),
                    scores: []
                });
            }
            byClass.get(cls).studentIds.add(s.id);
        }
        const studentClass = new Map(filteredStudents.map(s => [s.id, s.class || 'Unassigned']));
        for (const sc of filteredScores) {
            const cls = studentClass.get(sc.studentId);
            if (!cls || !byClass.has(cls)) continue;
            const pct = normalizeScore(sc.score, sc.outOf || 100);
            if (pct === null) continue;
            byClass.get(cls).scores.push(pct);
        }
        return [...byClass.values()]
            .map(c => ({
                className: c.className,
                level: c.level,
                meanScore: c.scores.length ? Number(mean(c.scores).toFixed(1)) : null,
                studentCount: c.studentIds.size,
                scoreCount: c.scores.length
            }))
            .filter(c => c.studentCount > 0)
            .sort((a, b) => {
                if (a.meanScore === null && b.meanScore === null) return 0;
                if (a.meanScore === null) return 1;
                if (b.meanScore === null) return -1;
                return b.meanScore - a.meanScore;
            });
    }, [filteredStudents, filteredScores]);

    const highestMeanClass = useMemo(() => {
        const withScores = classRanksData.filter(c => c.meanScore !== null);
        return withScores[0] || null;
    }, [classRanksData]);

    // ---------- CBC grade distribution ----------
    const gradeDistribution = useMemo(() => {
        const counts = { EE: 0, ME: 0, AE: 0, BE: 0 };
        for (const sc of filteredScores) {
            const pct = normalizeScore(sc.score, sc.outOf || 100);
            if (pct === null) continue;
            const g = getCBCGrade(pct);
            if (counts[g.level] !== undefined) counts[g.level]++;
        }
        const total = Object.values(counts).reduce((s, v) => s + v, 0);
        const labels = { EE: 'Exceeding', ME: 'Meeting', AE: 'Approaching', BE: 'Below' };
        return Object.entries(counts)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => ({
                name: labels[k] || k,
                value: v,
                percentage: total ? Number(((v / total) * 100).toFixed(1)) : 0
            }));
    }, [filteredScores]);

    // ---------- top performers ----------
    const topPerformers = useMemo(() => {
        const byStudent = new Map();
        for (const sc of filteredScores) {
            const pct = normalizeScore(sc.score, sc.outOf || 100);
            if (pct === null) continue;
            if (!byStudent.has(sc.studentId)) byStudent.set(sc.studentId, []);
            byStudent.get(sc.studentId).push(pct);
        }
        const list = [];
        for (const [studentId, arr] of byStudent.entries()) {
            const student = filteredStudents.find(s => s.id === studentId);
            if (!student) continue;
            list.push({
                studentId,
                name: `${student.firstName || ''} ${student.lastName || ''}`.trim() || student.admissionNumber || 'Unknown',
                className: student.class || '—',
                level: student.level || '—',
                admissionNumber: student.admissionNumber || student.studentId || '—',
                average: Number(mean(arr).toFixed(1)),
                scoreCount: arr.length
            });
        }
        list.sort((a, b) => b.average - a.average);
        return list;
    }, [filteredStudents, filteredScores]);

    // ---------- term trend ----------
    const [trendData, setTrendData] = useState([]);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!schoolId || !filteredStudentIds.size) {
                setTrendData([]);
                return;
            }
            try {
                const snap = await getDocs(query(
                    collection(db, 'student_scores'),
                    where('schoolId', '==', schoolId),
                    where('year', '==', Number(year)),
                    limit(5000)
                ));
                if (cancelled) return;
                const byTerm = new Map();
                for (const d of snap.docs) {
                    const sc = d.data();
                    if (!filteredStudentIds.has(sc.studentId)) continue;
                    const t = sc.term || 'Unknown';
                    const pct = normalizeScore(sc.score, sc.outOf || 100);
                    if (pct === null) continue;
                    if (!byTerm.has(t)) byTerm.set(t, []);
                    byTerm.get(t).push(pct);
                }
                const points = TERMS.map(t => ({
                    term: t,
                    average: byTerm.has(t) && byTerm.get(t).length
                        ? Number(mean(byTerm.get(t)).toFixed(1))
                        : null
                }));
                setTrendData(points);
            } catch (err) {
                console.warn('Trend fetch failed:', err);
                if (!cancelled) setTrendData([]);
            }
        })();
        return () => { cancelled = true; };
    }, [schoolId, year, filteredStudentIds]);

    // ---------- PDF export ----------
    const handleExportPDF = async () => {
        setExporting(true);
        try {
            const result = await downloadExecutiveReportsPDF(kpis, userData, term, year);
            notify(`Executive report saved${result?.uri ? ' to Downloads/EduPriva' : ''}${result?.filename ? ` as ${result.filename}` : ''}.`, 'success');
        } catch (err) {
            console.error('PDF export failed:', err);
            notify('Export failed: ' + err.message, 'error');
        } finally {
            setExporting(false);
        }
    };

    if (loading) return <LoadingSpinner fullScreen text="Loading school performance analytics..." />;

    const noData = kpis.totalScores === 0;

    return (
        <Layout title="School Performance Reports">
            <div className="rp-page">

                {/* Header */}
                <div className="rp-page-header">
                    <div>
                        <div className="rp-header-badges">
                            <span className="rp-badge-primary">Performance Analytics</span>
                            <span className="rp-header-sub">{term} · {year}</span>
                        </div>
                        <h1 className="rp-page-title">School Performance Reports</h1>
                        <p className="rp-page-sub">
                            Aggregated from {kpis.totalScores.toLocaleString()} score records across {kpis.studentsWithScores} students.
                        </p>
                    </div>
                    <div className="rp-header-actions">
                        <button className="btn btn-outline" onClick={loadData}>
                            <i className="fas fa-sync-alt"></i> Refresh
                        </button>
                        <button className="btn btn-primary" onClick={handleExportPDF} disabled={exporting || noData}>
                            <i className={`fas ${exporting ? 'fa-spinner fa-spin' : 'fa-file-pdf'}`}></i>
                            {exporting ? 'Generating…' : 'Export PDF'}
                        </button>
                    </div>
                </div>

                {/* Feedback */}
                {feedback.message && (
                    <div className={`rp-feedback rp-feedback-${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>
                        <i className={`fas ${
                            feedback.type === 'error' ? 'fa-circle-exclamation' :
                            feedback.type === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-check'
                        }`}></i>
                        <span>{feedback.message}</span>
                        <button type="button" aria-label="Dismiss message" onClick={() => setFeedback({ message: '', type: '' })}>×</button>
                    </div>
                )}

                {error && (
                    <div className="rp-feedback rp-feedback-error">
                        <i className="fas fa-circle-exclamation"></i>
                        <span>{error}</span>
                    </div>
                )}

                {/* Filters */}
                <div className="rp-filters">
                    <div className="rp-filter-group">
                        <label>Term</label>
                        <select value={term} onChange={e => setTerm(e.target.value)}>
                            {TERMS.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                    </div>
                    <div className="rp-filter-group">
                        <label>Year</label>
                        <select value={year} onChange={e => setYear(Number(e.target.value))}>
                            {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                        </select>
                    </div>
                    <div className="rp-filter-group">
                        <label>Level</label>
                        <select value={levelFilter} onChange={e => { setLevelFilter(e.target.value); setClassFilter(''); }}>
                            <option value="">All Levels</option>
                            {LEVEL_ORDER.map(l => (
                                <option key={l} value={l}>{LEVEL_DISPLAY_NAMES[l] || l}</option>
                            ))}
                        </select>
                    </div>
                    <div className="rp-filter-group">
                        <label>Class</label>
                        <select value={classFilter} onChange={e => setClassFilter(e.target.value)} disabled={!levelFilter}>
                            <option value="">All Classes</option>
                            {classesForLevel.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                    </div>
                    {(levelFilter || classFilter) && (
                        <button className="btn btn-outline rp-clear-btn" onClick={() => { setLevelFilter(''); setClassFilter(''); }}>
                            <i className="fas fa-times"></i> Clear
                        </button>
                    )}
                </div>

                {/* Empty state */}
                {noData && (
                    <div className="rp-empty-banner">
                        <i className="fas fa-info-circle"></i>
                        <div>
                            <strong>No performance data for the selected filters</strong>
                            <p>
                                No scores found for {term} {year}
                                {levelFilter ? ` in ${LEVEL_DISPLAY_NAMES[levelFilter] || levelFilter}` : ''}
                                {classFilter ? ` · ${classFilter}` : ''}.
                                Change the filters above or ask teachers to enter exam scores first.
                            </p>
                        </div>
                    </div>
                )}

                {/* Printable body */}
                <div id="rp-print-root" className="rp-print-root">

                    {/* Branded header (only shows for PDF) */}
                    <div className="rp-branded-header">
                        <div className="rp-branded-left">
                            <div className="rp-branded-logo">
                                {userData?.schoolLogo ? (
                                    <img src={userData.schoolLogo} alt="School" />
                                ) : (
                                    <i className="fas fa-graduation-cap"></i>
                                )}
                            </div>
                            <div className="rp-branded-text">
                                <h2>{userData?.schoolName || 'School Name'}</h2>
                                <p>{[userData?.schoolAddress, userData?.schoolPhone, userData?.schoolEmail].filter(Boolean).join(' · ')}</p>
                                {userData?.schoolMotto && <p className="rp-branded-motto">{userData.schoolMotto}</p>}
                            </div>
                        </div>
                        <div className="rp-branded-right">
                            <div className="rp-branded-title">Performance Report</div>
                            <div className="rp-branded-sub">{term} {year}{levelFilter ? ` · ${LEVEL_DISPLAY_NAMES[levelFilter] || levelFilter}` : ''}{classFilter ? ` · ${classFilter}` : ''}</div>
                        </div>
                    </div>

                    {/* KPI cards */}
                    <div className="rp-kpi-grid">
                        <div className="rp-kpi">
                            <div>
                                <div className="rp-kpi-label">School Mean Score</div>
                                <div className="rp-kpi-value">{fmtPct(kpis.avgScore)}</div>
                                <div className="rp-kpi-sub">{kpis.studentsWithScores} students assessed</div>
                            </div>
                            <div className="rp-kpi-icon tone-indigo"><i className="fas fa-chart-line"></i></div>
                        </div>
                        <div className="rp-kpi">
                            <div>
                                <div className="rp-kpi-label">Pass Rate</div>
                                <div className="rp-kpi-value">{fmtPct(kpis.passRate)}</div>
                                <div className="rp-kpi-sub">Students at Meeting or above</div>
                            </div>
                            <div className="rp-kpi-icon tone-emerald"><i className="fas fa-circle-check"></i></div>
                        </div>
                        <div className="rp-kpi">
                            <div>
                                <div className="rp-kpi-label">Competency Mastery</div>
                                <div className="rp-kpi-value">{fmtPct(kpis.competencyMastery)}</div>
                                <div className="rp-kpi-sub">Scores at Meeting or above</div>
                            </div>
                            <div className="rp-kpi-icon tone-purple"><i className="fas fa-award"></i></div>
                        </div>
                        <div className="rp-kpi">
                            <div>
                                <div className="rp-kpi-label">Score Records</div>
                                <div className="rp-kpi-value">{kpis.totalScores.toLocaleString()}</div>
                                <div className="rp-kpi-sub">{exams.length} exam{exams.length === 1 ? '' : 's'} in {term}</div>
                            </div>
                            <div className="rp-kpi-icon tone-amber"><i className="fas fa-database"></i></div>
                        </div>
                    </div>

                    {/* Highest class highlight */}
                    {highestMeanClass && (
                        <div className="rp-highlight">
                            <div className="rp-highlight-left">
                                <div className="rp-highlight-icon"><i className="fas fa-trophy"></i></div>
                                <div>
                                    <div className="rp-highlight-label">Highest Performing Class · {term} {year}</div>
                                    <div className="rp-highlight-title">{highestMeanClass.className}</div>
                                    <div className="rp-highlight-sub">
                                        {highestMeanClass.studentCount} students · {highestMeanClass.scoreCount} scores
                                    </div>
                                </div>
                            </div>
                            <div className="rp-highlight-right">
                                <div className="rp-highlight-label">Mean Score</div>
                                <div className="rp-highlight-value">{highestMeanClass.meanScore}%</div>
                            </div>
                        </div>
                    )}

                    {/* Charts row */}
                    <div className="rp-charts-row">
                        <div className="rp-chart-card">
                            <div className="rp-chart-header">
                                <div>
                                    <h3>Performance by Level</h3>
                                    <p className="rp-chart-sub">Mean score per level</p>
                                </div>
                                <span className="rp-chart-badge">Levels</span>
                            </div>
                            {levelChartData.some(d => d.hasData) ? (
                                <div className="rp-chart-body">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={levelChartData} margin={{ top: 10, right: 10, left: -20, bottom: 25 }}>
                                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                                            <XAxis dataKey="name" angle={-15} textAnchor="end" tick={{ fontSize: 11 }} />
                                            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                                            <Tooltip contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 10px 25px rgba(0,0,0,0.1)' }} />
                                            <Bar dataKey="averageScore" radius={[8, 8, 0, 0]} name="Average (%)">
                                                {levelChartData.map((d, i) => <Cell key={i} fill={d.color} />)}
                                            </Bar>
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                            ) : (
                                <div className="rp-chart-empty">
                                    <i className="fas fa-chart-simple"></i>
                                    <p>No level data for the selected filters.</p>
                                </div>
                            )}
                        </div>

                        <div className="rp-chart-card">
                            <div className="rp-chart-header">
                                <div>
                                    <h3>Subject Averages</h3>
                                    <p className="rp-chart-sub">Mean score per learning area</p>
                                </div>
                                <span className="rp-chart-badge">CBC</span>
                            </div>
                            {subjectChartData.length ? (
                                <div className="rp-chart-body">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={subjectChartData} layout="vertical" margin={{ top: 10, right: 20, left: 40, bottom: 10 }}>
                                            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                                            <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} />
                                            <YAxis type="category" dataKey="subject" tick={{ fontSize: 11 }} width={120} />
                                            <Tooltip contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 10px 25px rgba(0,0,0,0.1)' }} />
                                            <Bar dataKey="average" fill="#10b981" radius={[0, 8, 8, 0]} name="Average (%)" />
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                            ) : (
                                <div className="rp-chart-empty">
                                    <i className="fas fa-chart-simple"></i>
                                    <p>No subject scores for the selected filters.</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Trend + distribution */}
                    <div className="rp-charts-row-3">
                        <div className="rp-chart-card rp-chart-card-wide">
                            <div className="rp-chart-header">
                                <div>
                                    <h3>Term-on-Term Trend</h3>
                                    <p className="rp-chart-sub">Mean score across terms · {year}</p>
                                </div>
                                <span className="rp-chart-badge">{year}</span>
                            </div>
                            {trendData.some(p => p.average !== null) ? (
                                <div className="rp-chart-body">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart data={trendData} margin={{ top: 10, right: 20, left: -20, bottom: 5 }}>
                                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                                            <XAxis dataKey="term" tick={{ fontSize: 11 }} />
                                            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                                            <Tooltip contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 10px 25px rgba(0,0,0,0.1)' }} />
                                            <Line type="monotone" dataKey="average" stroke="#4f46e5" strokeWidth={3} dot={{ r: 6, fill: '#4f46e5' }} name="Average (%)" />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            ) : (
                                <div className="rp-chart-empty">
                                    <i className="fas fa-chart-line"></i>
                                    <p>Trend data not available for the selected year.</p>
                                </div>
                            )}
                        </div>

                        <div className="rp-chart-card">
                            <div className="rp-chart-header">
                                <div>
                                    <h3>Grade Distribution</h3>
                                    <p className="rp-chart-sub">CBC performance bands</p>
                                </div>
                                <span className="rp-chart-badge">CBC</span>
                            </div>
                            {gradeDistribution.length ? (
                                <div className="rp-chart-body">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <PieChart>
                                            <Pie
                                                data={gradeDistribution}
                                                dataKey="value"
                                                nameKey="name"
                                                cx="50%"
                                                cy="50%"
                                                outerRadius={80}
                                                label={(e) => `${e.name} ${e.percentage}%`}
                                                labelLine={false}
                                            >
                                                {gradeDistribution.map((_, i) => (
                                                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                                                ))}
                                            </Pie>
                                            <Tooltip contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 10px 25px rgba(0,0,0,0.1)' }} />
                                            <Legend wrapperStyle={{ fontSize: 11 }} />
                                        </PieChart>
                                    </ResponsiveContainer>
                                </div>
                            ) : (
                                <div className="rp-chart-empty">
                                    <i className="fas fa-chart-pie"></i>
                                    <p>No grade data to display.</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Class leaderboard */}
                    <div className="rp-card">
                        <div className="rp-card-header">
                            <div>
                                <h3>Class Leaderboard</h3>
                                <p className="rp-card-sub">
                                    Ranked by mean score · {classRanksData.filter(c => c.meanScore !== null).length} of {classRanksData.length} classes with scores
                                </p>
                            </div>
                            <span className="rp-chart-badge">{term} {year}</span>
                        </div>
                        {classRanksData.length ? (
                            <div className="rp-table-wrap">
                                <table className="rp-table">
                                    <thead>
                                        <tr>
                                            <th className="rp-center" style={{ width: 80 }}>Rank</th>
                                            <th>Class</th>
                                            <th>Level</th>
                                            <th className="rp-center">Students</th>
                                            <th className="rp-center">Scores</th>
                                            <th className="rp-center">Mean Score</th>
                                            <th className="rp-center">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {classRanksData.map((cls, idx) => {
                                            const ranked = cls.meanScore !== null;
                                            const rank = ranked
                                                ? classRanksData.filter(c => c.meanScore !== null).findIndex(c => c.className === cls.className) + 1
                                                : null;
                                            const band = gradeBand(cls.meanScore);
                                            return (
                                                <tr key={cls.className}>
                                                    <td className="rp-center">
                                                        {rank === 1 ? <span className="rp-rank-medal rank-1">🏆</span> :
                                                         rank === 2 ? <span className="rp-rank-medal rank-2">🥈</span> :
                                                         rank === 3 ? <span className="rp-rank-medal rank-3">🥉</span> :
                                                         rank ? <span className="rp-rank-plain">#{rank}</span> :
                                                         <span className="rp-muted">—</span>}
                                                    </td>
                                                    <td className="rp-bold">{cls.className}</td>
                                                    <td className="rp-capitalize">{(LEVEL_DISPLAY_NAMES[cls.level] || cls.level || '—').replace(/-/g, ' ')}</td>
                                                    <td className="rp-center">{cls.studentCount}</td>
                                                    <td className="rp-center rp-muted">{cls.scoreCount}</td>
                                                    <td className="rp-center rp-bold rp-primary">{cls.meanScore !== null ? `${cls.meanScore}%` : '—'}</td>
                                                    <td className="rp-center">
                                                        <span className={band.cls}>{band.label}</span>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <div className="rp-empty">
                                <i className="fas fa-users-slash"></i>
                                <p>No classes match the selected filters.</p>
                            </div>
                        )}
                    </div>

                    {/* Top performers */}
                    <div className="rp-card">
                        <div className="rp-card-header">
                            <div>
                                <h3>Top Performers</h3>
                                <p className="rp-card-sub">Students ranked by average score across all subjects in {term}</p>
                            </div>
                        </div>
                        {topPerformers.length ? (
                            <>
                                <div className="rp-table-wrap">
                                    <table className="rp-table">
                                        <thead>
                                            <tr>
                                                <th className="rp-center" style={{ width: 80 }}>Rank</th>
                                                <th>Student</th>
                                                <th>Admission No</th>
                                                <th>Class</th>
                                                <th className="rp-center">Subjects</th>
                                                <th className="rp-center">Average</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {topPerformers.slice(0, 20).map((s, idx) => (
                                                <tr key={s.studentId}>
                                                    <td className="rp-center rp-muted rp-bold">#{idx + 1}</td>
                                                    <td className="rp-bold">{s.name}</td>
                                                    <td className="rp-mono">{s.admissionNumber}</td>
                                                    <td>{s.className}</td>
                                                    <td className="rp-center rp-muted">{s.scoreCount}</td>
                                                    <td className="rp-center rp-bold rp-primary">{s.average}%</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                {topPerformers.length > 20 && (
                                    <div className="rp-table-footer">Showing top 20 of {topPerformers.length} students</div>
                                )}
                            </>
                        ) : (
                            <div className="rp-empty">
                                <i className="fas fa-user-graduate"></i>
                                <p>No student scores to rank yet.</p>
                            </div>
                        )}
                    </div>

                    {/* Branded footer */}
                    <div className="rp-branded-footer">
                        <div>© {new Date().getFullYear()} {userData?.schoolName || 'School'}. All rights reserved.</div>
                        {userData?.schoolMotto && <div className="rp-branded-footer-motto">{userData.schoolMotto}</div>}
                        <div>Generated {new Date().toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                    </div>
                </div>
            </div>

            <style>{RP_STYLES}</style>
        </Layout>
    );
}

// ---------- styles ----------
const RP_STYLES = `
.rp-page { padding: 0; }
.rp-page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; }
.rp-header-badges { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rp-badge-primary { padding: 4px 12px; background: #eef2ff; color: var(--primary); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; border-radius: 20px; border: 1px solid #c7d2fe; }
.rp-header-sub { font-size: 12px; color: var(--gray); font-weight: 500; }
.rp-page-title { font-size: 26px; font-weight: 700; color: var(--secondary); margin: 6px 0 4px; }
.rp-page-sub { font-size: 14px; color: var(--gray); margin: 0; }
.rp-header-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.rp-header-actions .btn { padding: 10px 18px; font-size: 13px; }

.rp-feedback { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 10px; font-size: 13px; font-weight: 500; margin-bottom: 16px; border: 1px solid; }
.rp-feedback-success { background: #f0fdf4; border-color: #a7f3d0; color: #166534; }
.rp-feedback-error { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
.rp-feedback-warning { background: #fffbeb; border-color: #fde68a; color: #92400e; }

.rp-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)) auto; gap: 14px; background: white; border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin-bottom: 20px; align-items: end; }
.rp-filter-group { display: flex; flex-direction: column; gap: 6px; }
.rp-filter-group label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--gray); }
.rp-filter-group select { padding: 9px 12px; border: 2px solid var(--border); border-radius: 10px; background: var(--light); font-size: 13px; font-weight: 500; color: var(--secondary); }
.rp-filter-group select:focus { outline: none; border-color: var(--primary); }
.rp-clear-btn { align-self: end; padding: 9px 16px; font-size: 13px; }

.rp-empty-banner { display: flex; gap: 12px; padding: 16px 20px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; color: #92400e; margin-bottom: 20px; }
.rp-empty-banner i { font-size: 20px; margin-top: 2px; }
.rp-empty-banner strong { font-size: 14px; display: block; margin-bottom: 4px; }
.rp-empty-banner p { margin: 0; font-size: 13px; }

/* Print root */
.rp-print-root { display: flex; flex-direction: column; gap: 20px; }

/* Branded header (for PDF) */
.rp-branded-header { display: none; }
@media print {
    .rp-branded-header { display: flex !important; justify-content: space-between; align-items: center; gap: 20px; border-bottom: 2px solid #1e293b; padding-bottom: 16px; margin-bottom: 20px; flex-wrap: wrap; }
}

/* KPI grid */
.rp-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.rp-kpi { background: white; border: 1px solid var(--border); border-radius: 16px; padding: 22px; display: flex; align-items: center; justify-content: space-between; gap: 16px; box-shadow: var(--shadow); }
.rp-kpi > div:first-child { min-width: 0; }
.rp-kpi-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--gray); }
.rp-kpi-value { font-size: 28px; font-weight: 800; color: var(--secondary); margin: 6px 0 3px; line-height: 1.1; }
.rp-kpi-sub { font-size: 12px; color: var(--gray); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rp-kpi-icon { width: 54px; height: 54px; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; }
.rp-kpi-icon.tone-indigo  { background: #eef2ff; color: #4f46e5; }
.rp-kpi-icon.tone-emerald { background: #ecfdf5; color: #059669; }
.rp-kpi-icon.tone-purple  { background: #faf5ff; color: #7c3aed; }
.rp-kpi-icon.tone-amber   { background: #fffbeb; color: #d97706; }

/* Highlight banner */
.rp-highlight { background: #4f46e5; color: white; border-radius: 16px; padding: 22px 26px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; box-shadow: var(--shadow-lg); }
.rp-highlight-left { display: flex; align-items: center; gap: 16px; }
.rp-highlight-icon { width: 54px; height: 54px; border-radius: 16px; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; }
.rp-highlight-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255,255,255,0.8); }
.rp-highlight-title { font-size: 22px; font-weight: 800; margin-top: 3px; }
.rp-highlight-sub { font-size: 12px; color: rgba(255,255,255,0.85); margin-top: 3px; }
.rp-highlight-right { text-align: right; }
.rp-highlight-value { font-size: 30px; font-weight: 800; margin-top: 2px; }

/* Charts */
.rp-charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.rp-charts-row-3 { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
@media (max-width: 1000px) {
    .rp-charts-row, .rp-charts-row-3 { grid-template-columns: 1fr; }
}

.rp-chart-card { background: white; border: 1px solid var(--border); border-radius: 16px; padding: 22px; box-shadow: var(--shadow); display: flex; flex-direction: column; }
.rp-chart-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
.rp-chart-header h3 { font-size: 15px; font-weight: 700; color: var(--secondary); margin: 0; }
.rp-chart-sub { font-size: 11px; color: var(--gray); margin: 2px 0 0; }
.rp-chart-badge { padding: 4px 12px; background: #f1f5f9; color: var(--secondary); font-size: 11px; font-weight: 700; border-radius: 8px; white-space: nowrap; }
.rp-chart-body { height: 300px; width: 100%; }
.rp-chart-empty { height: 300px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #94a3b8; gap: 10px; }
.rp-chart-empty i { font-size: 40px; color: #cbd5e1; }
.rp-chart-empty p { font-size: 13px; margin: 0; }

/* Cards with tables */
.rp-card { background: white; border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); overflow: hidden; }
.rp-card-header { padding: 20px 22px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; background: #f8fafc; }
.rp-card-header h3 { font-size: 15px; font-weight: 700; color: var(--secondary); margin: 0; }
.rp-card-sub { font-size: 11px; color: var(--gray); margin: 2px 0 0; }
.rp-table-wrap { overflow-x: auto; }
.rp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rp-table thead th { background: #f1f5f9; color: var(--gray); padding: 12px 16px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; text-align: left; border-bottom: 1px solid var(--border); }
.rp-table tbody td { padding: 13px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.rp-table tbody tr:last-child td { border-bottom: none; }
.rp-table tbody tr:hover td { background: #f8fafc; }
.rp-bold { font-weight: 700; }
.rp-primary { color: var(--primary); }
.rp-muted { color: var(--gray); font-size: 12px; }
.rp-mono { font-family: 'Courier New', monospace; font-size: 12px; color: var(--secondary); }
.rp-center { text-align: center !important; }
.rp-capitalize { text-transform: capitalize; }
.rp-table-footer { padding: 12px 22px; background: #f8fafc; font-size: 12px; color: var(--gray); text-align: center; border-top: 1px solid var(--border); }

/* Rank medals */
.rp-rank-medal { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; font-weight: 800; font-size: 14px; }
.rp-rank-medal.rank-1 { background: #fef3c7; }
.rp-rank-medal.rank-2 { background: #e2e8f0; }
.rp-rank-medal.rank-3 { background: #ffedd5; }
.rp-rank-plain { font-weight: 700; color: var(--gray); }

/* CBC band pills */
.rp-band { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; border: 1px solid; white-space: nowrap; }
.rp-band-ee { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.rp-band-me { background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe; }
.rp-band-ae { background: #fffbeb; color: #b45309; border-color: #fde68a; }
.rp-band-be { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
.rp-band-na { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }

/* Empty state */
.rp-empty { padding: 60px 20px; text-align: center; color: var(--gray); }
.rp-empty i { font-size: 44px; color: var(--border); display: block; margin-bottom: 12px; }
.rp-empty p { font-size: 13px; margin: 0; }

/* Branded footer */
.rp-branded-footer { display: none; margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--border); justify-content: space-between; align-items: center; font-size: 10px; color: var(--gray); gap: 12px; flex-wrap: wrap; }
.rp-branded-footer-motto { font-style: italic; color: var(--primary); }
@media print {
    .rp-branded-footer { display: flex !important; }
}

/* Print overrides */
@media print {
    .rp-page-header, .rp-filters, .rp-feedback, .rp-empty-banner { display: none !important; }
    .rp-chart-card, .rp-card, .rp-kpi, .rp-highlight { break-inside: avoid; page-break-inside: avoid; box-shadow: none !important; }
    .rp-chart-body { height: 220px !important; }
    .rp-kpi-grid { grid-template-columns: repeat(4, 1fr); gap: 10px; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
`;