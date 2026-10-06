// src/pages/StudentDashboard.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSync } from '../../context/SyncContext';
import { db } from '../../firebase';
import { 
    collection, query, where, getDocs, onSnapshot, 
    doc, getDoc, orderBy, limit, serverTimestamp 
} from 'firebase/firestore';
import Layout from '../../components/Layout/Layout';
import LoadingSpinner from '../../components/Common/LoadingSpinner';
import { LEVEL_DISPLAY_NAMES } from '../../utils/constants';

import { showAppNotice } from '../../utils/appNotice';
export default function StudentDashboard() {
    const navigate = useNavigate();
    const { currentUser, userData } = useAuth();
    const { isOnline, saveToIndexedDB, getFromIndexedDB } = useSync();
    
    // State
    const [loading, setLoading] = useState(true);
    const [studentProfile, setStudentProfile] = useState(null);
    const [studentStats, setStudentStats] = useState({
        totalSubjects: 0,
        averageScore: 0,
        completedExams: 0,
        upcomingExams: 0,
        attendance: 0
    });
    const [recentResults, setRecentResults] = useState([]);
    const [upcomingExams, setUpcomingExams] = useState([]);
    const [feeSummary, setFeeSummary] = useState({
        totalDue: 0,
        totalPaid: 0,
        balance: 0,
        status: 'paid'
    });
    const [feeTransactions, setFeeTransactions] = useState([]);
    const [activeTab, setActiveTab] = useState('overview');
    const [selectedSubject, setSelectedSubject] = useState('all');
    const [termFilter, setTermFilter] = useState('all');
    const [showFeeModal, setShowFeeModal] = useState(false);

    // Load student data
    useEffect(() => {
        if (currentUser && userData) {
            loadStudentData();
        }
    }, [currentUser, userData, isOnline]);

    const loadStudentData = async () => {
        setLoading(true);
        try {
            const studentId = currentUser.uid;
            
            // Get student profile
            let studentData = null;
            const studentDoc = await getDoc(doc(db, 'students', studentId));
            if (studentDoc.exists()) {
                studentData = studentDoc.data();
                setStudentProfile({ id: studentDoc.id, ...studentData });
            }

            // Load student results
            await loadStudentResults(studentId, studentData);
            
            // Load upcoming exams
            await loadUpcomingExams(studentData);
            
            // Load fee summary
            await loadFeeSummary(studentId, studentData);
            
            // Load fee transactions
            await loadFeeTransactions(studentId);
            
            // Calculate stats
            await calculateStats(studentId, studentData);
            
            // Setup realtime listeners
            setupRealtimeListeners(studentId);

        } catch (error) {
            console.error('Error loading student data:', error);
            showNotification('Failed to load dashboard data', 'error');
        } finally {
            setLoading(false);
        }
    };

    const loadStudentResults = async (studentId, studentData) => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) return;

            const resultsQuery = query(
                collection(db, 'student_scores'),
                where('schoolId', '==', schoolId),
                where('studentId', '==', studentId),
                orderBy('recordedAt', 'desc'),
                limit(10)
            );
            const snapshot = await getDocs(resultsQuery);
            const results = [];
            snapshot.forEach(doc => {
                results.push({ id: doc.id, ...doc.data() });
            });
            setRecentResults(results);
        } catch (error) {
            console.error('Error loading results:', error);
        }
    };

    const loadUpcomingExams = async (studentData) => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId || !studentData) return;

            const today = new Date();
            const examsQuery = query(
                collection(db, 'exams'),
                where('schoolId', '==', schoolId),
                where('level', '==', studentData.level),
                where('class', '==', studentData.class),
                where('status', '==', 'active'),
                where('endDate', '>=', today),
                orderBy('startDate', 'asc'),
                limit(5)
            );
            const snapshot = await getDocs(examsQuery);
            const exams = [];
            snapshot.forEach(doc => {
                exams.push({ id: doc.id, ...doc.data() });
            });
            setUpcomingExams(exams);
        } catch (error) {
            console.error('Error loading upcoming exams:', error);
        }
    };

    const loadFeeSummary = async (studentId, studentData) => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) return;

            // Get fee transactions
            const transactionsQuery = query(
                collection(db, 'fee_transactions'),
                where('schoolId', '==', schoolId),
                where('studentId', '==', studentId)
            );
            const snapshot = await getDocs(transactionsQuery);
            
            let totalPaid = 0;
            let totalDue = studentData?.feeAmount || 0;
            
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.type === 'payment' && (data.status === 'completed' || data.status === 'success')) {
                    totalPaid += data.amount || 0;
                }
            });

            const balance = totalDue - totalPaid;
            const status = balance <= 0 ? 'paid' : (balance < totalDue * 0.5 ? 'partial' : 'pending');

            setFeeSummary({
                totalDue,
                totalPaid,
                balance,
                status
            });
        } catch (error) {
            console.error('Error loading fee summary:', error);
        }
    };

    const loadFeeTransactions = async (studentId) => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) return;

            const transactionsQuery = query(
                collection(db, 'fee_transactions'),
                where('schoolId', '==', schoolId),
                where('studentId', '==', studentId),
                orderBy('createdAt', 'desc'),
                limit(5)
            );
            const snapshot = await getDocs(transactionsQuery);
            const transactions = [];
            snapshot.forEach(doc => {
                transactions.push({ id: doc.id, ...doc.data() });
            });
            setFeeTransactions(transactions);
        } catch (error) {
            console.error('Error loading fee transactions:', error);
        }
    };

    const calculateStats = async (studentId, studentData) => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) return;

            // Get all results
            const resultsQuery = query(
                collection(db, 'student_scores'),
                where('schoolId', '==', schoolId),
                where('studentId', '==', studentId)
            );
            const snapshot = await getDocs(resultsQuery);
            
            let totalScore = 0;
            let count = 0;
            let completed = 0;
            
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.score) {
                    totalScore += data.score;
                    count++;
                    if (data.status === 'published') completed++;
                }
            });

            const average = count > 0 ? Math.round(totalScore / count) : 0;

            // Get upcoming exams count
            const today = new Date();
            const examsQuery = query(
                collection(db, 'exams'),
                where('schoolId', '==', schoolId),
                where('level', '==', studentData?.level),
                where('class', '==', studentData?.class),
                where('status', '==', 'active'),
                where('endDate', '>=', today)
            );
            const examsSnapshot = await getDocs(examsQuery);

            setStudentStats({
                totalSubjects: count,
                averageScore: average,
                completedExams: completed,
                upcomingExams: examsSnapshot.size,
                attendance: 85 // This would come from attendance tracking
            });
        } catch (error) {
            console.error('Error calculating stats:', error);
        }
    };

    const setupRealtimeListeners = (studentId) => {
        const schoolId = userData?.schoolId;
        if (!schoolId) return;

        // Listen to results updates
        const resultsQuery = query(
            collection(db, 'student_scores'),
            where('schoolId', '==', schoolId),
            where('studentId', '==', studentId),
            orderBy('recordedAt', 'desc'),
            limit(10)
        );
        const unsubscribeResults = onSnapshot(resultsQuery, async (snapshot) => {
            const results = [];
            snapshot.forEach(doc => {
                results.push({ id: doc.id, ...doc.data() });
            });
            setRecentResults(results);
        }, (error) => {
            console.error('Results listener error:', error);
        });

        // Listen to fee updates
        const feeQuery = query(
            collection(db, 'fee_transactions'),
            where('schoolId', '==', schoolId),
            where('studentId', '==', studentId),
            orderBy('createdAt', 'desc'),
            limit(5)
        );
        const unsubscribeFee = onSnapshot(feeQuery, async (snapshot) => {
            const transactions = [];
            snapshot.forEach(doc => {
                transactions.push({ id: doc.id, ...doc.data() });
            });
            setFeeTransactions(transactions);
        }, (error) => {
            console.error('Fee listener error:', error);
        });

        return () => {
            unsubscribeResults();
            unsubscribeFee();
        };
    };

    const formatDate = (date) => {
        if (!date) return 'N/A';
        if (date.toDate) date = date.toDate();
        return new Date(date).toLocaleDateString('en-KE', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    };

    const formatDateTime = (date) => {
        if (!date) return 'N/A';
        if (date.toDate) date = date.toDate();
        return new Date(date).toLocaleString('en-KE', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const getGrade = (score) => {
        if (score >= 80) return { label: 'Excellent', color: '#27ae60' };
        if (score >= 65) return { label: 'Good', color: '#2ecc71' };
        if (score >= 50) return { label: 'Average', color: '#f39c12' };
        if (score >= 35) return { label: 'Below Average', color: '#e67e22' };
        return { label: 'Needs Improvement', color: '#e74c3c' };
    };

    const getFeeStatusColor = () => {
        switch (feeSummary.status) {
            case 'paid': return '#27ae60';
            case 'partial': return '#f39c12';
            default: return '#e74c3c';
        }
    };

    const getFeeStatusLabel = () => {
        switch (feeSummary.status) {
            case 'paid': return '✅ Fully Paid';
            case 'partial': return '⚠️ Partially Paid';
            default: return '❌ Pending';
        }
    };

    const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading your dashboard..." />;
    }

    return (
        <Layout title="Student Dashboard">
            <style>{`
                .student-dashboard {
                    padding: 0;
                }

                .welcome-banner {
                    background: #0d9488;
                    border-radius: 16px;
                    padding: 25px 30px;
                    color: white;
                    margin-bottom: 30px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 20px;
                }

                .welcome-banner h1 {
                    font-size: 24px;
                    margin-bottom: 5px;
                }

                .welcome-banner p {
                    opacity: 0.9;
                    font-size: 14px;
                }

                .welcome-banner .badge {
                    display: inline-block;
                    padding: 4px 16px;
                    background: rgba(255,255,255,0.2);
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 600;
                }

                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }

                .stat-card {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                    transition: all 0.3s;
                }

                .stat-card:hover {
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-lg);
                }

                .stat-card .stat-label {
                    font-size: 13px;
                    color: var(--gray);
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .stat-card .stat-value {
                    font-size: 28px;
                    font-weight: 700;
                    color: var(--secondary);
                    margin-top: 5px;
                }

                .stat-card .stat-icon {
                    float: right;
                    font-size: 28px;
                    opacity: 0.2;
                    color: var(--primary);
                }

                .section-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                    flex-wrap: wrap;
                    gap: 10px;
                }

                .section-title {
                    font-size: 18px;
                    font-weight: 700;
                    color: var(--secondary);
                }

                .btn {
                    padding: 8px 16px;
                    border: none;
                    border-radius: 8px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 14px;
                }

                .btn-primary {
                    background: var(--primary);
                    color: white;
                }

                .btn-primary:hover {
                    background: var(--primary-dark);
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-lg);
                }

                .btn-success {
                    background: var(--success);
                    color: white;
                }

                .btn-success:hover {
                    opacity: 0.9;
                    transform: translateY(-2px);
                }

                .btn-outline {
                    background: transparent;
                    border: 2px solid var(--border);
                    color: var(--secondary);
                }

                .btn-outline:hover {
                    border-color: var(--primary);
                    color: var(--primary);
                }

                .btn-sm {
                    padding: 6px 12px;
                    font-size: 12px;
                }

                .card {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                    margin-bottom: 20px;
                }

                .result-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px 0;
                    border-bottom: 1px solid var(--border);
                }

                .result-item:last-child {
                    border-bottom: none;
                }

                .result-item .subject {
                    font-weight: 600;
                    color: var(--secondary);
                }

                .result-item .score {
                    font-weight: 700;
                    font-size: 18px;
                }

                .result-item .date {
                    font-size: 12px;
                    color: var(--gray);
                }

                .exam-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px 0;
                    border-bottom: 1px solid var(--border);
                }

                .exam-item:last-child {
                    border-bottom: none;
                }

                .exam-item .exam-title {
                    font-weight: 600;
                    color: var(--secondary);
                }

                .exam-item .exam-date {
                    font-size: 12px;
                    color: var(--gray);
                }

                .fee-summary {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 15px;
                    margin-top: 15px;
                }

                .fee-item {
                    text-align: center;
                    padding: 15px;
                    background: var(--light);
                    border-radius: 8px;
                }

                .fee-item .amount {
                    font-size: 24px;
                    font-weight: 700;
                    color: var(--secondary);
                }

                .fee-item .label {
                    font-size: 12px;
                    color: var(--gray);
                    margin-top: 4px;
                }

                .fee-status {
                    display: inline-block;
                    padding: 4px 16px;
                    border-radius: 20px;
                    font-size: 14px;
                    font-weight: 600;
                }

                .fee-status.paid {
                    background: #d4edda;
                    color: #155724;
                }

                .fee-status.partial {
                    background: #fff3cd;
                    color: #856404;
                }

                .fee-status.pending {
                    background: #f8d7da;
                    color: #721c24;
                }

                .transaction-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 0;
                    border-bottom: 1px solid var(--border);
                }

                .transaction-item:last-child {
                    border-bottom: none;
                }

                .transaction-item .amount {
                    font-weight: 700;
                }

                .transaction-item .amount.positive {
                    color: var(--success);
                }

                .transaction-item .amount.negative {
                    color: var(--danger);
                }

                .grade-badge {
                    display: inline-block;
                    padding: 2px 12px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: 600;
                }

                .empty-state {
                    text-align: center;
                    padding: 30px 20px;
                    color: var(--gray);
                }

                .empty-state i {
                    font-size: 36px;
                    color: var(--border);
                    margin-bottom: 10px;
                }

                @media (max-width: 768px) {
                    .stats-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }
                    
                    .welcome-banner {
                        flex-direction: column;
                        text-align: center;
                    }
                    
                    .fee-summary {
                        grid-template-columns: 1fr 1fr;
                    }
                }

                @media (max-width: 480px) {
                    .stats-grid {
                        grid-template-columns: 1fr;
                    }
                    
                    .fee-summary {
                        grid-template-columns: 1fr;
                    }
                }

                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }

                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
            `}</style>

            <div className="student-dashboard">
                {/* Welcome Banner */}
                <div className="welcome-banner">
                    <div>
                        <h1>Welcome back, {studentProfile?.firstName || 'Student'}! </h1>
                        <p>Track your academic progress, upcoming exams, and fee status.</p>
                    </div>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        <span className="badge">
                            <i className="fas fa-graduation-cap"></i> {studentProfile?.class || 'N/A'}
                        </span>
                        <span className="badge">
                            <i className="fas fa-book"></i> {LEVEL_DISPLAY_NAMES[studentProfile?.level] || 'N/A'}
                        </span>
                        <span className="badge">
                            <i className="fas fa-id-card"></i> {studentProfile?.studentId || 'N/A'}
                        </span>
                    </div>
                </div>

                {/* Stats */}
                <div className="stats-grid">
                    <div className="stat-card">
                        <div className="stat-label">Average Score</div>
                        <div className="stat-value">{studentStats.averageScore}%</div>
                        <div className="stat-icon"><i className="fas fa-chart-line"></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Completed Exams</div>
                        <div className="stat-value">{studentStats.completedExams}</div>
                        <div className="stat-icon"><i className="fas fa-check-circle"></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Upcoming Exams</div>
                        <div className="stat-value">{studentStats.upcomingExams}</div>
                        <div className="stat-icon"><i className="fas fa-clock"></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Attendance</div>
                        <div className="stat-value">{studentStats.attendance}%</div>
                        <div className="stat-icon"><i className="fas fa-calendar-check"></i></div>
                    </div>
                </div>

                {/* Recent Results */}
                <div className="card">
                    <div className="section-header">
                        <h2 className="section-title">Recent Results</h2>
                        <button className="btn btn-primary btn-sm" onClick={() => navigate('/student-results')}>
                            <i className="fas fa-arrow-right"></i> View All
                        </button>
                    </div>
                    {recentResults.length === 0 ? (
                        <div className="empty-state">
                            <i className="fas fa-chart-line"></i>
                            <p>No results available yet</p>
                        </div>
                    ) : (
                        recentResults.map(result => {
                            const grade = getGrade(result.score);
                            return (
                                <div key={result.id} className="result-item">
                                    <div>
                                        <div className="subject">{result.subject || 'N/A'}</div>
                                        <div className="date">{formatDate(result.recordedAt)}</div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <div className="score" style={{ color: grade.color }}>
                                            {result.score || 0}%
                                        </div>
                                        <span className="grade-badge" style={{ background: grade.color + '20', color: grade.color }}>
                                            {grade.label}
                                        </span>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Upcoming Exams */}
                <div className="card">
                    <div className="section-header">
                        <h2 className="section-title">Upcoming Exams</h2>
                        <button className="btn btn-primary btn-sm" onClick={() => navigate('/student-exams')}>
                            <i className="fas fa-arrow-right"></i> View All
                        </button>
                    </div>
                    {upcomingExams.length === 0 ? (
                        <div className="empty-state">
                            <i className="fas fa-file-alt"></i>
                            <p>No upcoming exams scheduled</p>
                        </div>
                    ) : (
                        upcomingExams.map(exam => (
                            <div key={exam.id} className="exam-item">
                                <div>
                                    <div className="exam-title">{exam.title || 'Untitled Exam'}</div>
                                    <div className="exam-date">
                                        <i className="far fa-calendar-alt"></i> {formatDate(exam.startDate)} - {formatDate(exam.endDate)}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                    <span className="grade-badge" style={{ background: '#d1ecf1', color: '#0c5460' }}>
                                        {exam.subject || 'N/A'}
                                    </span>
                                    <button 
                                        className="btn btn-primary btn-sm"
                                        onClick={() => navigate(`/student-exam/${exam.id}`)}
                                    >
                                        <i className="fas fa-eye"></i>
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Fee Summary */}
                <div className="card">
                    <div className="section-header">
                        <h2 className="section-title">Fee Status</h2>
                        <button className="btn btn-primary btn-sm" onClick={() => navigate('/student-fees')}>
                            <i className="fas fa-arrow-right"></i> View Details
                        </button>
                    </div>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
                        <span className={`fee-status ${feeSummary.status}`}>
                            {getFeeStatusLabel()}
                        </span>
                        <span style={{ fontSize: '14px', color: 'var(--gray)' }}>
                            Last updated: {formatDateTime(new Date())}
                        </span>
                    </div>

                    <div className="fee-summary">
                        <div className="fee-item">
                            <div className="amount">KES {feeSummary.totalDue.toLocaleString()}</div>
                            <div className="label">Total Due</div>
                        </div>
                        <div className="fee-item">
                            <div className="amount" style={{ color: 'var(--success)' }}>
                                KES {feeSummary.totalPaid.toLocaleString()}
                            </div>
                            <div className="label">Total Paid</div>
                        </div>
                        <div className="fee-item">
                            <div className="amount" style={{ color: feeSummary.balance > 0 ? 'var(--danger)' : 'var(--success)' }}>
                                KES {feeSummary.balance.toLocaleString()}
                            </div>
                            <div className="label">Balance</div>
                        </div>
                    </div>

                    {/* Recent Fee Transactions */}
                    {feeTransactions.length > 0 && (
                        <div style={{ marginTop: '15px' }}>
                            <h4 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--secondary)', marginBottom: '10px' }}>
                                Recent Payments
                            </h4>
                            {feeTransactions.map(transaction => (
                                <div key={transaction.id} className="transaction-item">
                                    <div>
                                        <div style={{ fontWeight: '500', color: 'var(--secondary)' }}>
                                            {transaction.description || 'Fee Payment'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                                            {formatDate(transaction.createdAt)} • {transaction.paymentMethod || 'N/A'}
                                        </div>
                                    </div>
                                    <div>
                                        <div className={`amount positive`}>
                                            +KES {transaction.amount?.toLocaleString() || 0}
                                        </div>
                                        <div style={{ fontSize: '11px', color: 'var(--gray)', textAlign: 'right' }}>
                                            {transaction.status || 'N/A'}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Quick Actions */}
                <div className="card">
                    <div className="section-header">
                        <h2 className="section-title">Quick Actions</h2>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px' }}>
                        <button className="btn btn-primary" onClick={() => navigate('/student-results')}>
                            <i className="fas fa-chart-line"></i> View Results
                        </button>
                        <button className="btn btn-success" onClick={() => navigate('/student-fees')}>
                            <i className="fas fa-coins"></i> Pay Fees
                        </button>
                        <button className="btn btn-primary" onClick={() => navigate('/student-exams')}>
                            <i className="fas fa-file-alt"></i> View Exams
                        </button>
                        <button className="btn btn-outline" onClick={() => navigate('/student-profile')}>
                            <i className="fas fa-user"></i> My Profile
                        </button>
                    </div>
                </div>
            </div>
        </Layout>
    );
}
