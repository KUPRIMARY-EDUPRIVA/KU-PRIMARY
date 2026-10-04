// src/pages/Student/Results.jsx
import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { db } from '../../firebase';
import { 
    collection, query, where, getDocs, 
    doc, getDoc, orderBy 
} from 'firebase/firestore';
import Layout from '../../components/Layout/Layout';
import LoadingSpinner from '../../components/Common/LoadingSpinner';
import {
    LEVEL_DISPLAY_NAMES,
    LEVEL_SUBJECTS,
    getCBCGrade
} from '../../utils/constants';

export default function StudentResults() {
    const { currentUser, userData } = useAuth();
    const [loading, setLoading] = useState(true);
    const [student, setStudent] = useState(null);
    const [results, setResults] = useState([]);
    const [subjects, setSubjects] = useState([]);
    const [selectedTerm, setSelectedTerm] = useState('Term 1');
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
    const [terms, setTerms] = useState(['Term 1', 'Term 2', 'Term 3']);
    const [years, setYears] = useState([]);
    const [stats, setStats] = useState({
        totalSubjects: 0,
        totalScore: 0,
        average: 0,
        highest: 0,
        lowest: 0,
        grade: null
    });

    useEffect(() => {
        if (currentUser) {
            loadStudentData();
        }
    }, [currentUser]);

    useEffect(() => {
        if (student) {
            loadResults();
        }
    }, [student, selectedTerm, selectedYear]);

    const loadStudentData = async () => {
        setLoading(true);
        try {
            // Try to get student from users collection first
            const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
            if (userDoc.exists()) {
                const data = userDoc.data();
                if (data.role === 'student') {
                    setStudent({
                        id: currentUser.uid,
                        firstName: data.fullName?.split(' ')[0] || 'Student',
                        lastName: data.fullName?.split(' ').slice(1).join(' ') || '',
                        level: data.level || '',
                        class: data.class || '',
                        admissionNumber: data.admissionNumber || data.studentId || '',
                        ...data
                    });
                    setLoading(false);
                    return;
                }
            }

            // Try to get from students collection
            const studentDoc = await getDoc(doc(db, 'students', currentUser.uid));
            if (studentDoc.exists()) {
                const data = studentDoc.data();
                setStudent({
                    id: currentUser.uid,
                    firstName: data.firstName || 'Student',
                    lastName: data.lastName || '',
                    level: data.level || '',
                    class: data.class || '',
                    admissionNumber: data.admissionNumber || data.studentId || '',
                    ...data
                });
            } else {
                // If no student document found, create a basic student object
                setStudent({
                    id: currentUser.uid,
                    firstName: 'Student',
                    lastName: '',
                    level: userData?.level || '',
                    class: userData?.class || '',
                    admissionNumber: userData?.admissionNumber || userData?.studentId || '',
                });
            }
        } catch (error) {
            console.error('Error loading student data:', error);
            // Set basic student info from userData
            setStudent({
                id: currentUser.uid,
                firstName: userData?.firstName || 'Student',
                lastName: userData?.lastName || '',
                level: userData?.level || '',
                class: userData?.class || '',
                admissionNumber: userData?.admissionNumber || userData?.studentId || '',
            });
        } finally {
            setLoading(false);
        }
    };

    const loadResults = async () => {
        if (!student) return;

        setLoading(true);
        try {
            const schoolId = userData?.schoolId || 'default_school';
            
            // Query results for this student
            const resultsQuery = query(
                collection(db, 'student_scores'),
                where('studentId', '==', student.id),
                where('schoolId', '==', schoolId),
                where('term', '==', selectedTerm),
                orderBy('recordedAt', 'desc')
            );
            
            const snapshot = await getDocs(resultsQuery);
            const resultsData = [];
            snapshot.forEach(doc => {
                resultsData.push({
                    id: doc.id,
                    ...doc.data()
                });
            });

            setResults(resultsData);

            // Get subjects for this student's level
            const levelSubjects = LEVEL_SUBJECTS[student.level] || [];
            setSubjects(levelSubjects);

            // Calculate stats
            calculateStats(resultsData);

            // Generate available years (last 5 years)
            const currentYear = new Date().getFullYear();
            const yearOptions = [];
            for (let i = 4; i >= 0; i--) {
                yearOptions.push(currentYear - i);
            }
            setYears(yearOptions);

        } catch (error) {
            console.error('Error loading results:', error);
        } finally {
            setLoading(false);
        }
    };

    const calculateStats = (resultsData) => {
        // Get all subjects for this level
        const levelSubjects = LEVEL_SUBJECTS[student?.level] || [];
        
        // Calculate average per subject
        const subjectScores = {};
        levelSubjects.forEach(subject => {
            const subjectResults = resultsData.filter(r => r.subject === subject);
            if (subjectResults.length > 0) {
                const total = subjectResults.reduce((sum, r) => sum + (r.score || 0), 0);
                subjectScores[subject] = Math.round(total / subjectResults.length);
            } else {
                subjectScores[subject] = null;
            }
        });

        // Calculate overall stats
        const scores = Object.values(subjectScores).filter(s => s !== null);
        const totalScore = scores.reduce((sum, s) => sum + s, 0);
        const average = scores.length > 0 ? Math.round(totalScore / scores.length) : 0;
        const highest = scores.length > 0 ? Math.max(...scores) : 0;
        const lowest = scores.length > 0 ? Math.min(...scores) : 0;
        const grade = getCBCGrade(average);

        setStats({
            totalSubjects: scores.length,
            totalScore: totalScore,
            average: average,
            highest: highest,
            lowest: lowest,
            grade: grade
        });
    };

    const getSubjectAverage = (subject) => {
        const subjectResults = results.filter(r => r.subject === subject);
        if (subjectResults.length === 0) return null;
        const total = subjectResults.reduce((sum, r) => sum + (r.score || 0), 0);
        return Math.round(total / subjectResults.length);
    };

    const getSubjectGrade = (subject) => {
        const avg = getSubjectAverage(subject);
        if (avg === null) return null;
        return getCBCGrade(avg);
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading results..." />;
    }

    const levelDisplay = student?.level ? LEVEL_DISPLAY_NAMES[student.level] || student.level : 'N/A';

    return (
        <Layout title="My Results">
            <style>{`
                .result-card {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                    transition: all 0.3s;
                }
                .result-card:hover {
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-lg);
                }
                .grade-badge {
                    display: inline-block;
                    padding: 4px 14px;
                    border-radius: 20px;
                    font-size: 14px;
                    font-weight: 700;
                }
                .grade-badge.EE {
                    background: #d4edda;
                    color: #155724;
                }
                .grade-badge.ME {
                    background: #d1ecf1;
                    color: #0c5460;
                }
                .grade-badge.AE {
                    background: #fff3cd;
                    color: #856404;
                }
                .grade-badge.BE {
                    background: #f8d7da;
                    color: #721c24;
                }
                .subject-score {
                    padding: 8px 12px;
                    border-radius: 8px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .subject-score:hover {
                    background: var(--light);
                }
                @media (max-width: 768px) {
                    .stats-grid {
                        grid-template-columns: repeat(2, 1fr) !important;
                    }
                }
                @media (max-width: 480px) {
                    .stats-grid {
                        grid-template-columns: 1fr !important;
                    }
                }
            `}</style>

            <div style={{ padding: '20px 0' }}>
                {/* Student Info Card */}
                <div className="result-card" style={{ marginBottom: '25px' }}>
                    <div style={{ 
                        display: 'grid', 
                        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
                        gap: '15px' 
                    }}>
                        <div>
                            <div style={{ fontSize: '12px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>
                                Student Name
                            </div>
                            <div style={{ fontSize: '18px', fontWeight: '600', color: 'var(--secondary)' }}>
                                {student?.firstName || ''} {student?.lastName || ''}
                            </div>
                        </div>
                        <div>
                            <div style={{ fontSize: '12px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>
                                Admission Number
                            </div>
                            <div style={{ fontSize: '16px', fontWeight: '500', color: 'var(--secondary)' }}>
                                {student?.admissionNumber || 'N/A'}
                            </div>
                        </div>
                        <div>
                            <div style={{ fontSize: '12px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>
                                Level
                            </div>
                            <div style={{ fontSize: '16px', fontWeight: '500', color: 'var(--secondary)' }}>
                                {levelDisplay}
                            </div>
                        </div>
                        <div>
                            <div style={{ fontSize: '12px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>
                                Class
                            </div>
                            <div style={{ fontSize: '16px', fontWeight: '500', color: 'var(--secondary)' }}>
                                {student?.class || 'N/A'}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Filters */}
                <div style={{
                    display: 'flex',
                    gap: '15px',
                    marginBottom: '25px',
                    flexWrap: 'wrap',
                    alignItems: 'center'
                }}>
                    <div>
                        <label style={{ 
                            display: 'block', 
                            fontSize: '12px', 
                            fontWeight: '600', 
                            color: 'var(--gray)',
                            marginBottom: '4px' 
                        }}>
                            Term
                        </label>
                        <select
                            value={selectedTerm}
                            onChange={(e) => setSelectedTerm(e.target.value)}
                            style={{
                                padding: '8px 15px',
                                border: '2px solid var(--border)',
                                borderRadius: '8px',
                                fontSize: '14px',
                                background: 'white',
                                minWidth: '150px'
                            }}
                        >
                            {terms.map(term => (
                                <option key={term} value={term}>{term}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label style={{ 
                            display: 'block', 
                            fontSize: '12px', 
                            fontWeight: '600', 
                            color: 'var(--gray)',
                            marginBottom: '4px' 
                        }}>
                            Year
                        </label>
                        <select
                            value={selectedYear}
                            onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                            style={{
                                padding: '8px 15px',
                                border: '2px solid var(--border)',
                                borderRadius: '8px',
                                fontSize: '14px',
                                background: 'white',
                                minWidth: '150px'
                            }}
                        >
                            {years.map(year => (
                                <option key={year} value={year}>{year}</option>
                            ))}
                        </select>
                    </div>
                    <button
                        onClick={loadResults}
                        style={{
                            padding: '8px 20px',
                            background: 'var(--primary)',
                            color: 'white',
                            border: 'none',
                            borderRadius: '8px',
                            fontSize: '14px',
                            fontWeight: '600',
                            cursor: 'pointer',
                            transition: 'all 0.3s',
                            marginTop: '20px'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--primary-dark)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'var(--primary)'}
                    >
                        <i className="fas fa-sync-alt"></i> Refresh
                    </button>
                </div>

                {/* Stats Summary */}
                <div className="stats-grid" style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                    gap: '15px',
                    marginBottom: '25px'
                }}>
                    <div className="result-card" style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>
                            Subjects
                        </div>
                        <div style={{ fontSize: '22px', fontWeight: '700', color: 'var(--secondary)', marginTop: '4px' }}>
                            {stats.totalSubjects}
                        </div>
                    </div>
                    <div className="result-card" style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>
                            Average Score
                        </div>
                        <div style={{ fontSize: '22px', fontWeight: '700', color: 'var(--secondary)', marginTop: '4px' }}>
                            {stats.average}%
                        </div>
                    </div>
                    <div className="result-card" style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>
                            Highest Score
                        </div>
                        <div style={{ fontSize: '22px', fontWeight: '700', color: 'var(--success)', marginTop: '4px' }}>
                            {stats.highest}%
                        </div>
                    </div>
                    <div className="result-card" style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>
                            Lowest Score
                        </div>
                        <div style={{ fontSize: '22px', fontWeight: '700', color: 'var(--danger)', marginTop: '4px' }}>
                            {stats.lowest}%
                        </div>
                    </div>
                    <div className="result-card" style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>
                            Overall Grade
                        </div>
                        <div style={{ marginTop: '4px' }}>
                            {stats.grade && (
                                <span className={`grade-badge ${stats.grade.levelClass}`}>
                                    {stats.grade.code} - {stats.grade.label}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                {/* Subject Scores */}
                <div className="result-card">
                    <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        marginBottom: '15px'
                    }}>
                        <h3 style={{ fontSize: '18px', color: 'var(--secondary)', margin: 0 }}>
                            <i className="fas fa-chart-bar"></i> Subject Scores
                        </h3>
                        <span style={{ fontSize: '13px', color: 'var(--gray)' }}>
                            {selectedTerm} - {selectedYear}
                        </span>
                    </div>

                    {subjects.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--gray)' }}>
                            <i className="fas fa-info-circle" style={{ fontSize: '48px', display: 'block', marginBottom: '15px', color: 'var(--border)' }}></i>
                            <p>No subjects found for your level.</p>
                        </div>
                    ) : (
                        <div style={{ 
                            display: 'grid', 
                            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', 
                            gap: '10px' 
                        }}>
                            {subjects.map(subject => {
                                const avg = getSubjectAverage(subject);
                                const grade = getSubjectGrade(subject);
                                const isScored = avg !== null;
                                
                                return (
                                    <div key={subject} className="subject-score" style={{
                                        background: isScored ? 'white' : 'var(--light)',
                                        border: `1px solid ${isScored ? 'var(--border)' : 'var(--border)'}`,
                                        opacity: isScored ? 1 : 0.7
                                    }}>
                                        <div>
                                            <span style={{ fontWeight: '500', color: 'var(--secondary)' }}>
                                                {subject}
                                            </span>
                                            {!isScored && (
                                                <span style={{ 
                                                    marginLeft: '10px', 
                                                    fontSize: '11px', 
                                                    color: 'var(--gray)',
                                                    fontStyle: 'italic'
                                                }}>
                                                    Not assessed yet
                                                </span>
                                            )}
                                        </div>
                                        {isScored && (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                <span style={{ 
                                                    fontWeight: '700', 
                                                    fontSize: '18px', 
                                                    color: avg >= 70 ? 'var(--success)' : avg >= 40 ? 'var(--warning)' : 'var(--danger)'
                                                }}>
                                                    {avg}%
                                                </span>
                                                {grade && (
                                                    <span className={`grade-badge ${grade.levelClass}`}>
                                                        {grade.code}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Detailed Results Table */}
                {results.length > 0 && (
                    <div className="result-card" style={{ marginTop: '25px' }}>
                        <h3 style={{ fontSize: '18px', color: 'var(--secondary)', marginBottom: '15px' }}>
                            <i className="fas fa-list"></i> Detailed Results
                        </h3>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ background: 'var(--light)' }}>
                                        <th style={{ padding: '10px 15px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>
                                            Subject
                                        </th>
                                        <th style={{ padding: '10px 15px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>
                                            Score
                                        </th>
                                        <th style={{ padding: '10px 15px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>
                                            CBC Level
                                        </th>
                                        <th style={{ padding: '10px 15px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>
                                            Points
                                        </th>
                                        <th style={{ padding: '10px 15px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>
                                            Status
                                        </th>
                                        <th style={{ padding: '10px 15px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>
                                            Assessment
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {results.map(result => {
                                        const grade = getCBCGrade(result.score);
                                        return (
                                            <tr key={result.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                                <td style={{ padding: '10px 15px', fontWeight: '500' }}>
                                                    {result.subject}
                                                </td>
                                                <td style={{ 
                                                    padding: '10px 15px', 
                                                    textAlign: 'center', 
                                                    fontWeight: '700',
                                                    color: result.score >= 70 ? 'var(--success)' : result.score >= 40 ? 'var(--warning)' : 'var(--danger)'
                                                }}>
                                                    {result.score}%
                                                </td>
                                                <td style={{ padding: '10px 15px', textAlign: 'center' }}>
                                                    <span className={`grade-badge ${grade.levelClass}`}>
                                                        {grade.code}
                                                    </span>
                                                </td>
                                                <td style={{ padding: '10px 15px', textAlign: 'center', fontWeight: '700' }}>
                                                    {grade.points.toFixed(1)}
                                                </td>
                                                <td style={{ padding: '10px 15px', textAlign: 'center' }}>
                                                    <span style={{
                                                        padding: '2px 12px',
                                                        borderRadius: '20px',
                                                        fontSize: '11px',
                                                        fontWeight: '600',
                                                        background: result.status === 'published' ? '#d4edda' : '#fff3cd',
                                                        color: result.status === 'published' ? '#155724' : '#856404'
                                                    }}>
                                                        {result.status ? result.status.charAt(0).toUpperCase() + result.status.slice(1) : 'Pending'}
                                                    </span>
                                                </td>
                                                <td style={{ padding: '10px 15px', fontSize: '13px', color: 'var(--gray)' }}>
                                                    {result.assessmentType || 'N/A'}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Official Note */}
                <div style={{
                    marginTop: '30px',
                    padding: '20px',
                    background: '#fff3e0',
                    borderRadius: '12px',
                    border: '2px dashed #ff9800',
                    textAlign: 'center'
                }}>
                    <i className="fas fa-exclamation-triangle" style={{ fontSize: '24px', color: '#e65100', marginBottom: '10px', display: 'block' }}></i>
                    <p style={{ margin: '0', fontSize: '14px', color: '#e65100', fontWeight: '600' }}>
                        This is a computer-generated document. It is not official unless signed and stamped by the school.
                    </p>
                    <div style={{ 
                        marginTop: '15px', 
                        display: 'flex', 
                        justifyContent: 'center', 
                        gap: '50px',
                        flexWrap: 'wrap'
                    }}>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ borderTop: '2px solid #333', width: '150px', marginTop: '20px' }}></div>
                            <p style={{ margin: '5px 0 0', fontSize: '12px', color: '#666' }}>Signature</p>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ borderTop: '2px solid #333', width: '150px', marginTop: '20px' }}></div>
                            <p style={{ margin: '5px 0 0', fontSize: '12px', color: '#666' }}>Date</p>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ 
                                border: '2px solid #333', 
                                width: '80px', 
                                height: '80px', 
                                margin: '0 auto', 
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '12px',
                                color: '#666',
                                fontWeight: '600'
                            }}>
                                SCHOOL<br/>STAMP
                            </div>
                            <p style={{ margin: '5px 0 0', fontSize: '12px', color: '#666' }}>School Stamp</p>
                        </div>
                    </div>
                </div>
            </div>
        </Layout>
    );
}
