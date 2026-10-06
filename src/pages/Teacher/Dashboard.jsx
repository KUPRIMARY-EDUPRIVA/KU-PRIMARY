// src/pages/TeacherDashboard.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSync } from '../../context/SyncContext';
import { db } from '../../firebase';
import { 
    collection, query, where, getDocs, onSnapshot, 
    doc, getDoc, updateDoc, orderBy, limit, 
    serverTimestamp, writeBatch
} from 'firebase/firestore';
import Layout from '../../components/Layout/Layout';
import LoadingSpinner from '../../components/Common/LoadingSpinner';
import { LEVEL_DISPLAY_NAMES, LEVEL_CLASSES } from '../../utils/constants';

import { showAppNotice } from '../../utils/appNotice';
export default function TeacherDashboard() {
    const navigate = useNavigate();
    const { currentUser, userData } = useAuth();
    const { isOnline, saveToIndexedDB, getFromIndexedDB } = useSync();
    
    // State
    const [loading, setLoading] = useState(true);
    const [teacherProfile, setTeacherProfile] = useState(null);
    const [assignedClasses, setAssignedClasses] = useState([]);
    const [assignedSubjects, setAssignedSubjects] = useState([]);
    const [students, setStudents] = useState([]);
    const [recentActivities, setRecentActivities] = useState([]);
    const [upcomingExams, setUpcomingExams] = useState([]);
    const [stats, setStats] = useState({
        totalStudents: 0,
        activeExams: 0,
        pendingSubmissions: 0,
        resultsPublished: 0
    });
    const [activeTab, setActiveTab] = useState('overview');
    const [selectedClass, setSelectedClass] = useState('');
    const [selectedSubject, setSelectedSubject] = useState('');
    const [filteredStudents, setFilteredStudents] = useState([]);
    const [showAttendanceModal, setShowAttendanceModal] = useState(false);
    const [selectedStudent, setSelectedStudent] = useState(null);
    
    // Load teacher data
    useEffect(() => {
        if (currentUser && userData) {
            loadTeacherData();
        }
    }, [currentUser, userData, isOnline]);

    const loadTeacherData = async () => {
        setLoading(true);
        try {
            const teacherId = currentUser.uid;
            
            // Get teacher profile
            let teacherData = null;
            const teacherDoc = await getDoc(doc(db, 'teachers', teacherId));
            if (teacherDoc.exists()) {
                teacherData = teacherDoc.data();
                setTeacherProfile({ id: teacherDoc.id, ...teacherData });
                
                // Set assigned classes and subjects
                const classes = teacherData.classes || [];
                const subjects = teacherData.subjects || [];
                setAssignedClasses(Array.isArray(classes) ? classes : classes.split(',').map(c => c.trim()));
                setAssignedSubjects(Array.isArray(subjects) ? subjects : subjects.split(',').map(s => s.trim()));
                
                // Auto-select first class and subject
                if (classes.length > 0) setSelectedClass(classes[0]);
                if (subjects.length > 0) setSelectedSubject(subjects[0]);
            }

            // Load students
            await loadStudents(teacherData);
            
            // Load activities
            await loadRecentActivities();
            
            // Load upcoming exams
            await loadUpcomingExams();
            
            // Setup realtime listeners
            setupRealtimeListeners();

        } catch (error) {
            console.error('Error loading teacher data:', error);
            showNotification('Failed to load dashboard data', 'error');
        } finally {
            setLoading(false);
        }
    };

    const loadStudents = async (teacherData) => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) return;

            const classes = teacherData?.classes || [];
            if (classes.length === 0) return;

            // Get students from assigned classes
            const studentsQuery = query(
                collection(db, 'students'),
                where('schoolId', '==', schoolId),
                where('class', 'in', classes)
            );
            const snapshot = await getDocs(studentsQuery);
            const studentsData = [];
            snapshot.forEach(doc => {
                studentsData.push({ id: doc.id, ...doc.data() });
            });
            setStudents(studentsData);
            setFilteredStudents(studentsData);
            
            // Update stats
            setStats(prev => ({
                ...prev,
                totalStudents: studentsData.length
            }));

        } catch (error) {
            console.error('Error loading students:', error);
        }
    };

    const loadRecentActivities = async () => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) return;

            const q = query(
                collection(db, 'activities'),
                where('schoolId', '==', schoolId),
                where('teacherId', '==', currentUser.uid),
                orderBy('timestamp', 'desc'),
                limit(10)
            );
            const snapshot = await getDocs(q);
            const activities = [];
            snapshot.forEach(doc => {
                activities.push({ id: doc.id, ...doc.data(), timestamp: doc.data().timestamp?.toDate?.() || new Date() });
            });
            setRecentActivities(activities);
        } catch (error) {
            console.error('Error loading activities:', error);
        }
    };

    const loadUpcomingExams = async () => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) return;

            const today = new Date();
            const q = query(
                collection(db, 'exams'),
                where('schoolId', '==', schoolId),
                where('teacherId', '==', currentUser.uid),
                where('status', '==', 'active'),
                where('endDate', '>=', today),
                orderBy('startDate', 'asc'),
                limit(5)
            );
            const snapshot = await getDocs(q);
            const exams = [];
            snapshot.forEach(doc => {
                exams.push({ id: doc.id, ...doc.data() });
            });
            setUpcomingExams(exams);
            setStats(prev => ({
                ...prev,
                activeExams: exams.length
            }));
        } catch (error) {
            console.error('Error loading upcoming exams:', error);
        }
    };

    const setupRealtimeListeners = () => {
        const schoolId = userData?.schoolId;
        if (!schoolId) return;

        // Listen to student changes
        if (assignedClasses.length > 0) {
            const studentsQuery = query(
                collection(db, 'students'),
                where('schoolId', '==', schoolId),
                where('class', 'in', assignedClasses)
            );
            const unsubscribe = onSnapshot(studentsQuery, async (snapshot) => {
                const studentsData = [];
                snapshot.forEach(doc => {
                    studentsData.push({ id: doc.id, ...doc.data() });
                });
                setStudents(studentsData);
                setFilteredStudents(studentsData);
                setStats(prev => ({
                    ...prev,
                    totalStudents: studentsData.length
                }));
            }, (error) => {
                console.error('Students listener error:', error);
            });
            return () => unsubscribe();
        }
    };

    const handleFilterStudents = () => {
        const filtered = students.filter(s => {
            const matchClass = !selectedClass || s.class === selectedClass;
            const matchSubject = !selectedSubject || s.subjects?.includes(selectedSubject);
            return matchClass && matchSubject;
        });
        setFilteredStudents(filtered);
    };

    const handleQuickAction = (action) => {
        const actions = {
            'take-attendance': () => setShowAttendanceModal(true),
            'enter-results': () => navigate('/teacher-results'),
            'create-exam': () => navigate('/exams?action=create'),
            'view-students': () => navigate('/teacher-students'),
            'generate-report': () => navigate('/teacher-reports'),
            'send-notification': () => showNotification('Notifications feature coming soon!', 'info')
        };
        if (actions[action]) {
            actions[action]();
        }
    };

    const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

    // Format date
    const formatDate = (date) => {
        if (!date) return 'N/A';
        if (date.toDate) date = date.toDate();
        return new Date(date).toLocaleDateString('en-KE', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    };

    // Format time
    const formatTime = (date) => {
        if (!date) return 'N/A';
        if (date.toDate) date = date.toDate();
        return new Date(date).toLocaleTimeString('en-KE', {
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading your dashboard..." />;
    }

    return (
        <Layout title="Teacher Dashboard">
            <style>{`
                .teacher-dashboard {
                    padding: 0;
                }

                .welcome-banner {
                    background: #4f46e5;
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
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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
                    font-size: 32px;
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

                .quick-actions-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                    gap: 15px;
                    margin-bottom: 30px;
                }

                .quick-action-card {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    text-align: center;
                    box-shadow: var(--shadow);
                    cursor: pointer;
                    transition: all 0.3s;
                    border: 2px solid transparent;
                }

                .quick-action-card:hover {
                    border-color: var(--primary);
                    transform: translateY(-3px);
                    box-shadow: var(--shadow-lg);
                }

                .quick-action-card .icon {
                    font-size: 32px;
                    color: var(--primary);
                    margin-bottom: 10px;
                }

                .quick-action-card .title {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--secondary);
                }

                .quick-action-card .desc {
                    font-size: 12px;
                    color: var(--gray);
                    margin-top: 4px;
                }

                .filters-section {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                    margin-bottom: 25px;
                    display: flex;
                    flex-wrap: wrap;
                    gap: 15px;
                    align-items: center;
                }

                .filter-select {
                    padding: 10px 15px;
                    border: 2px solid var(--border);
                    border-radius: 8px;
                    font-size: 14px;
                    background: white;
                    cursor: pointer;
                    min-width: 150px;
                    color: var(--secondary);
                }

                .filter-select:focus {
                    outline: none;
                    border-color: var(--primary);
                }

                .btn {
                    padding: 10px 20px;
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

                .btn-outline {
                    background: transparent;
                    border: 2px solid var(--border);
                    color: var(--secondary);
                }

                .btn-outline:hover {
                    border-color: var(--primary);
                    color: var(--primary);
                }

                .btn-success {
                    background: var(--success);
                    color: white;
                }

                .btn-success:hover {
                    opacity: 0.9;
                    transform: translateY(-2px);
                }

                .btn-warning {
                    background: var(--warning);
                    color: white;
                }

                .btn-warning:hover {
                    opacity: 0.9;
                    transform: translateY(-2px);
                }

                .btn-sm {
                    padding: 6px 12px;
                    font-size: 12px;
                }

                .students-table-container {
                    background: white;
                    border-radius: 12px;
                    box-shadow: var(--shadow);
                    overflow: hidden;
                }

                .table-wrapper {
                    overflow-x: auto;
                }

                table {
                    width: 100%;
                    border-collapse: collapse;
                }

                thead {
                    background: var(--light);
                }

                th {
                    padding: 12px 16px;
                    text-align: left;
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--gray);
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                td {
                    padding: 12px 16px;
                    border-bottom: 1px solid var(--border);
                    font-size: 14px;
                }

                tr:hover {
                    background: var(--light);
                }

                .student-avatar {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    background: var(--primary);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 12px;
                    flex-shrink: 0;
                }

                .student-info {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .student-info .name {
                    font-weight: 600;
                    color: var(--secondary);
                }

                .student-info .email {
                    font-size: 12px;
                    color: var(--gray);
                }

                .status-badge {
                    padding: 3px 12px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 600;
                }

                .status-badge.active {
                    background: #d4edda;
                    color: #155724;
                }

                .status-badge.pending {
                    background: #fff3cd;
                    color: #856404;
                }

                .status-badge.inactive {
                    background: #f8d7da;
                    color: #721c24;
                }

                .exam-card {
                    background: white;
                    border-radius: 12px;
                    padding: 15px 20px;
                    box-shadow: var(--shadow);
                    margin-bottom: 10px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 10px;
                }

                .exam-card .exam-info .title {
                    font-weight: 600;
                    color: var(--secondary);
                }

                .exam-card .exam-info .details {
                    font-size: 12px;
                    color: var(--gray);
                }

                .exam-card .exam-status {
                    padding: 3px 12px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 600;
                }

                .exam-card .exam-status.upcoming {
                    background: #d1ecf1;
                    color: #0c5460;
                }

                .exam-card .exam-status.active {
                    background: #d4edda;
                    color: #155724;
                }

                .activity-item {
                    display: flex;
                    align-items: center;
                    padding: 12px 0;
                    border-bottom: 1px solid var(--border);
                }

                .activity-item:last-child {
                    border-bottom: none;
                }

                .activity-item .activity-icon {
                    width: 36px;
                    height: 36px;
                    border-radius: 50%;
                    background: var(--light);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin-right: 12px;
                    color: var(--primary);
                    flex-shrink: 0;
                }

                .activity-item .activity-content {
                    flex: 1;
                }

                .activity-item .activity-content .text {
                    font-size: 14px;
                    color: var(--secondary);
                }

                .activity-item .activity-content .time {
                    font-size: 12px;
                    color: var(--gray);
                }

                .empty-state {
                    text-align: center;
                    padding: 40px 20px;
                    color: var(--gray);
                }

                .empty-state i {
                    font-size: 48px;
                    color: var(--border);
                    margin-bottom: 15px;
                }

                @media (max-width: 768px) {
                    .stats-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }
                    
                    .welcome-banner {
                        flex-direction: column;
                        text-align: center;
                    }
                    
                    .filters-section {
                        flex-direction: column;
                        align-items: stretch;
                    }
                    
                    .filter-select {
                        width: 100%;
                    }
                    
                    .quick-actions-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }
                }

                @media (max-width: 480px) {
                    .stats-grid {
                        grid-template-columns: 1fr;
                    }
                    
                    .quick-actions-grid {
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

            <div className="teacher-dashboard">
                {/* Welcome Banner */}
                <div className="welcome-banner">
                    <div>
                        <h1>Welcome back, {teacherProfile?.firstName || 'Teacher'}! 👋</h1>
                        <p>Here's what's happening with your classes today.</p>
                    </div>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        <span className="badge">
                            <i className="fas fa-users"></i> {assignedClasses.length} Classes
                        </span>
                        <span className="badge">
                            <i className="fas fa-book"></i> {assignedSubjects.length} Subjects
                        </span>
                        <span className="badge">
                            <i className="fas fa-user-graduate"></i> {stats.totalStudents} Students
                        </span>
                    </div>
                </div>

                {/* Stats */}
                <div className="stats-grid">
                    <div className="stat-card">
                        <div className="stat-label">Total Students</div>
                        <div className="stat-value">{stats.totalStudents}</div>
                        <div className="stat-icon"><i className="fas fa-user-graduate"></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Active Exams</div>
                        <div className="stat-value">{stats.activeExams}</div>
                        <div className="stat-icon"><i className="fas fa-file-alt"></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Pending Submissions</div>
                        <div className="stat-value">{stats.pendingSubmissions}</div>
                        <div className="stat-icon"><i className="fas fa-clock"></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Results Published</div>
                        <div className="stat-value">{stats.resultsPublished}</div>
                        <div className="stat-icon"><i className="fas fa-check-circle"></i></div>
                    </div>
                </div>

                {/* Quick Actions */}
                <div className="section-header">
                    <h2 className="section-title">Quick Actions</h2>
                </div>
                <div className="quick-actions-grid">
                    <div className="quick-action-card" onClick={() => handleQuickAction('take-attendance')}>
                        <div className="icon"><i className="fas fa-clipboard-list"></i></div>
                        <div className="title">Take Attendance</div>
                        <div className="desc">Mark student attendance</div>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('enter-results')}>
                        <div className="icon"><i className="fas fa-pen"></i></div>
                        <div className="title">Enter Results</div>
                        <div className="desc">Record exam scores</div>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('create-exam')}>
                        <div className="icon"><i className="fas fa-plus-circle"></i></div>
                        <div className="title">Create Exam</div>
                        <div className="desc">Set up new assessment</div>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('view-students')}>
                        <div className="icon"><i className="fas fa-users"></i></div>
                        <div className="title">View Students</div>
                        <div className="desc">See all your students</div>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('generate-report')}>
                        <div className="icon"><i className="fas fa-file-alt"></i></div>
                        <div className="title">Generate Report</div>
                        <div className="desc">Create class report</div>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('send-notification')}>
                        <div className="icon"><i className="fas fa-bell"></i></div>
                        <div className="title">Send Notification</div>
                        <div className="desc">Notify students & parents</div>
                    </div>
                </div>

                {/* Students Section */}
                <div className="section-header">
                    <h2 className="section-title">My Students</h2>
                    <button className="btn btn-primary btn-sm" onClick={() => navigate('/teacher-students')}>
                        <i className="fas fa-arrow-right"></i> View All
                    </button>
                </div>

                <div className="filters-section">
                    <select 
                        className="filter-select" 
                        value={selectedClass} 
                        onChange={(e) => setSelectedClass(e.target.value)}
                    >
                        <option value="">All Classes</option>
                        {assignedClasses.map(cls => (
                            <option key={cls} value={cls}>{cls}</option>
                        ))}
                    </select>
                    <select 
                        className="filter-select" 
                        value={selectedSubject} 
                        onChange={(e) => setSelectedSubject(e.target.value)}
                    >
                        <option value="">All Subjects</option>
                        {assignedSubjects.map(subj => (
                            <option key={subj} value={subj}>{subj}</option>
                        ))}
                    </select>
                    <button className="btn btn-primary" onClick={handleFilterStudents}>
                        <i className="fas fa-filter"></i> Apply Filters
                    </button>
                    <button className="btn btn-outline" onClick={() => {
                        setSelectedClass('');
                        setSelectedSubject('');
                        setFilteredStudents(students);
                    }}>
                        <i className="fas fa-times"></i> Clear
                    </button>
                </div>

                <div className="students-table-container">
                    <div className="table-wrapper">
                        <table>
                            <thead>
                                <tr>
                                    <th>Student</th>
                                    <th>Admission No</th>
                                    <th>Class</th>
                                    <th>Level</th>
                                    <th>Status</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredStudents.length === 0 ? (
                                    <tr>
                                        <td colSpan="6">
                                            <div className="empty-state">
                                                <i className="fas fa-user-graduate"></i>
                                                <p>No students found matching the filters</p>
                                            </div>
                                        </td>
                                    </tr>
                                ) : (
                                    filteredStudents.slice(0, 10).map(student => (
                                        <tr key={student.id}>
                                            <td>
                                                <div className="student-info">
                                                    <div className="student-avatar">
                                                        {(student.firstName || 'S')[0]}
                                                    </div>
                                                    <div>
                                                        <div className="name">{student.firstName || ''} {student.lastName || ''}</div>
                                                        <div className="email">{student.email || ''}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td>{student.studentId || 'N/A'}</td>
                                            <td>{student.class || 'N/A'}</td>
                                            <td>{LEVEL_DISPLAY_NAMES[student.level] || student.level || 'N/A'}</td>
                                            <td>
                                                <span className={`status-badge ${student.status || 'pending'}`}>
                                                    {student.status ? student.status.charAt(0).toUpperCase() + student.status.slice(1) : 'Pending'}
                                                </span>
                                            </td>
                                            <td>
                                                <div style={{ display: 'flex', gap: '5px' }}>
                                                    <button 
                                                        className="btn btn-primary btn-sm"
                                                        onClick={() => navigate(`/teacher-student/${student.id}`)}
                                                    >
                                                        <i className="fas fa-eye"></i>
                                                    </button>
                                                    <button 
                                                        className="btn btn-warning btn-sm"
                                                        onClick={() => navigate(`/teacher-results?student=${student.id}`)}
                                                    >
                                                        <i className="fas fa-pen"></i>
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Upcoming Exams */}
                <div className="section-header" style={{ marginTop: '30px' }}>
                    <h2 className="section-title">Upcoming Exams</h2>
                    <button className="btn btn-primary btn-sm" onClick={() => navigate('/exams')}>
                        <i className="fas fa-arrow-right"></i> View All
                    </button>
                </div>

                {upcomingExams.length === 0 ? (
                    <div className="empty-state" style={{ background: 'white', borderRadius: '12px', padding: '30px', boxShadow: 'var(--shadow)' }}>
                        <i className="fas fa-file-alt"></i>
                        <p>No upcoming exams scheduled</p>
                    </div>
                ) : (
                    upcomingExams.map(exam => (
                        <div key={exam.id} className="exam-card">
                            <div className="exam-info">
                                <div className="title">{exam.title || 'Untitled Exam'}</div>
                                <div className="details">
                                    {exam.class || 'N/A'} • {exam.subject || 'N/A'} • 
                                    {formatDate(exam.startDate)} - {formatDate(exam.endDate)}
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                <span className="exam-status upcoming">Upcoming</span>
                                <button 
                                    className="btn btn-primary btn-sm"
                                    onClick={() => navigate(`/exams/${exam.id}`)}
                                >
                                    <i className="fas fa-eye"></i>
                                </button>
                            </div>
                        </div>
                    ))
                )}

                {/* Recent Activities */}
                <div className="section-header" style={{ marginTop: '30px' }}>
                    <h2 className="section-title">Recent Activities</h2>
                </div>

                <div style={{ background: 'white', borderRadius: '12px', padding: '20px', boxShadow: 'var(--shadow)' }}>
                    {recentActivities.length === 0 ? (
                        <div className="empty-state">
                            <i className="fas fa-clock"></i>
                            <p>No recent activities</p>
                        </div>
                    ) : (
                        recentActivities.map(activity => (
                            <div key={activity.id} className="activity-item">
                                <div className="activity-icon">
                                    <i className="fas fa-{activity.icon || 'info-circle'}"></i>
                                </div>
                                <div className="activity-content">
                                    <div className="text">{activity.description || 'Activity'}</div>
                                    <div className="time">
                                        {formatTime(activity.timestamp)} • {formatDate(activity.timestamp)}
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </Layout>
    );
}
