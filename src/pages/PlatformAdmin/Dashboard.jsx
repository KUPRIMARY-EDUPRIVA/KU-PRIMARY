// src/pages/PlatformAdmin/Dashboard.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSync } from '../../context/SyncContext';
import { db } from '../../firebase';
import { 
    collection, query, getDocs, onSnapshot, 
    doc, getDoc, updateDoc, deleteDoc, 
    orderBy, limit, where, serverTimestamp,
    writeBatch
} from 'firebase/firestore';
import Layout from '../../components/Layout/Layout';
import LoadingSpinner from '../../components/Common/LoadingSpinner';

import { showAppNotice } from '../../utils/appNotice';
export default function PlatformAdminDashboard() {
    const navigate = useNavigate();
    const { currentUser, userData } = useAuth();
    const { isOnline } = useSync();

    // State
    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState({
        totalSchools: 0,
        activeSchools: 0,
        pendingSchools: 0,
        totalAdmins: 0,
        totalStudents: 0,
        totalTeachers: 0,
        totalRevenue: 0,
        newSchoolsThisMonth: 0
    });
    const [firestoreStats, setFirestoreStats] = useState({
        readsToday: 0,
        writesToday: 0,
        deletesToday: 0,
        totalReads: 0,
        totalWrites: 0,
        storageBytes: 0,
        storageMB: 0,
        storageGB: 0,
        dailyReadQuota: 50000,
        dailyWriteQuota: 20000,
        readPercentage: 0,
        writePercentage: 0,
        lastUpdated: null,
        isLoading: true
    });
    const [recentSchools, setRecentSchools] = useState([]);
    const [recentActivities, setRecentActivities] = useState([]);
    const [schools, setSchools] = useState([]);
    const [activeTab, setActiveTab] = useState('overview');
    const [selectedSchool, setSelectedSchool] = useState(null);
    const [showSchoolModal, setShowSchoolModal] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [usageHistory, setUsageHistory] = useState([]);

    // Load data
    useEffect(() => {
        if (currentUser) {
            loadDashboardData();
            setupRealtimeListeners();
            loadFirestoreStats();
            
            // Refresh Firestore stats every 5 minutes
            const interval = setInterval(() => {
                loadFirestoreStats();
            }, 300000);
            
            return () => clearInterval(interval);
        }
    }, [currentUser]);

    // Load Firestore usage stats
    const loadFirestoreStats = async () => {
        try {
            // Get today's date for reset tracking
            const today = new Date().toISOString().split('T')[0];
            const todayStr = today.replace(/-/g, '');
            
            // Method 1: Track usage through a dedicated collection
            const usageDoc = await getDoc(doc(db, '_usage_stats', 'daily_usage'));
            
            if (usageDoc.exists()) {
                const data = usageDoc.data();
                const todayData = data[todayStr] || { reads: 0, writes: 0, deletes: 0 };
                
                // Calculate storage size
                let totalBytes = 0;
                try {
                    const storageStats = await getDoc(doc(db, '_usage_stats', 'storage'));
                    if (storageStats.exists()) {
                        totalBytes = storageStats.data().totalBytes || 0;
                    }
                } catch (e) {
                    console.warn('Storage stats not available:', e);
                }
                
                const storageMB = totalBytes / (1024 * 1024);
                const storageGB = storageMB / 1024;
                
                const readQuota = 50000; // Free tier: 50K reads/day
                const writeQuota = 20000; // Free tier: 20K writes/day
                const reads = todayData.reads || 0;
                const writes = todayData.writes || 0;
                
                // Calculate usage as percentage of daily quota
                const readPercentage = Math.min((reads / readQuota) * 100, 100);
                const writePercentage = Math.min((writes / writeQuota) * 100, 100);
                
                setFirestoreStats({
                    readsToday: reads,
                    writesToday: writes,
                    deletesToday: todayData.deletes || 0,
                    totalReads: data.totalReads || 0,
                    totalWrites: data.totalWrites || 0,
                    storageBytes: totalBytes,
                    storageMB: storageMB,
                    storageGB: storageGB,
                    dailyReadQuota: readQuota,
                    dailyWriteQuota: writeQuota,
                    readPercentage: readPercentage,
                    writePercentage: writePercentage,
                    lastUpdated: new Date(),
                    isLoading: false
                });
                
                // Load usage history for chart
                const history = [];
                const keys = Object.keys(data).filter(k => k !== 'totalReads' && k !== 'totalWrites');
                keys.slice(-30).forEach(key => {
                    history.push({
                        date: key,
                        reads: data[key]?.reads || 0,
                        writes: data[key]?.writes || 0
                    });
                });
                setUsageHistory(history);
            } else {
                // If no stats exist yet, initialize with zeros
                setFirestoreStats(prev => ({
                    ...prev,
                    readsToday: 0,
                    writesToday: 0,
                    deletesToday: 0,
                    storageMB: 0,
                    storageGB: 0,
                    readPercentage: 0,
                    writePercentage: 0,
                    isLoading: false,
                    lastUpdated: new Date()
                }));
            }
        } catch (error) {
            console.error('Error loading Firestore stats:', error);
            setFirestoreStats(prev => ({
                ...prev,
                isLoading: false,
                lastUpdated: new Date()
            }));
        }
    };

    // Track Firestore operations (call this whenever you perform Firestore operations)
    const trackFirestoreOperation = async (operationType, count = 1) => {
        try {
            if (!isOnline) return;
            
            const today = new Date().toISOString().split('T')[0];
            const usageDoc = doc(db, '_usage_stats', 'daily_usage');
            
            await updateDoc(usageDoc, {
                [`${today}.${operationType}s`]: (await getDoc(usageDoc)).data()?.[today]?.[`${operationType}s`] + count || count,
                [`${today}.lastUpdated`]: serverTimestamp(),
                [`total${operationType.charAt(0).toUpperCase() + operationType.slice(1)}s`]: (await getDoc(usageDoc)).data()?.[`total${operationType.charAt(0).toUpperCase() + operationType.slice(1)}s`] + count || count
            }, { merge: true });
        } catch (error) {
            console.warn('Failed to track Firestore operation:', error);
        }
    };

    // Get today's date string for display
    const getTodayString = () => {
        return new Date().toLocaleDateString('en-KE', {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    };

    // Get quota status color
    const getQuotaColor = (percentage) => {
        if (percentage < 50) return '#27ae60';
        if (percentage < 80) return '#f39c12';
        return '#e74c3c';
    };

    // Format bytes
    const formatBytes = (bytes) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const loadDashboardData = async () => {
        setLoading(true);
        try {
            // Load all schools
            const schoolsQuery = query(
                collection(db, 'schools'),
                orderBy('createdAt', 'desc')
            );
            const schoolsSnapshot = await getDocs(schoolsQuery);
            const schoolsData = [];
            schoolsSnapshot.forEach(doc => {
                schoolsData.push({ id: doc.id, ...doc.data() });
            });
            setSchools(schoolsData);

            // Calculate stats
            const total = schoolsData.length;
            const active = schoolsData.filter(s => s.subscriptionStatus === 'active' || s.subscriptionStatus === 'trial').length;
            const pending = schoolsData.filter(s => s.subscriptionStatus === 'pending' || s.subscriptionStatus === 'inactive').length;

            // Get this month's schools
            const now = new Date();
            const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const newThisMonth = schoolsData.filter(s => {
                const createdAt = s.createdAt?.toDate?.() || new Date(s.createdAt);
                return createdAt >= firstDayOfMonth;
            }).length;

            // Load recent schools (last 5)
            setRecentSchools(schoolsData.slice(0, 5));

            // Load admins count
            const adminsCount = await getAdminsCount();

            // Track these reads
            await trackFirestoreOperation('read', 2);

            setStats({
                totalSchools: total,
                activeSchools: active,
                pendingSchools: pending,
                totalAdmins: adminsCount,
                totalStudents: 0,
                totalTeachers: 0,
                totalRevenue: 0,
                newSchoolsThisMonth: newThisMonth
            });

            // Load recent activities
            await loadRecentActivities();

        } catch (error) {
            console.error('Error loading dashboard data:', error);
            showNotification('Failed to load dashboard data', 'error');
        } finally {
            setLoading(false);
        }
    };

    const getAdminsCount = async () => {
        try {
            const adminsQuery = query(
                collection(db, 'users'),
                where('role', 'in', ['super_admin', 'admin'])
            );
            const snapshot = await getDocs(adminsQuery);
            await trackFirestoreOperation('read', 1);
            return snapshot.size;
        } catch (error) {
            console.error('Error getting admins count:', error);
            return 0;
        }
    };

    const setupRealtimeListeners = () => {
        const schoolsQuery = query(
            collection(db, 'schools'),
            orderBy('createdAt', 'desc')
        );
        const unsubscribe = onSnapshot(schoolsQuery, (snapshot) => {
            const schoolsData = [];
            snapshot.forEach(doc => {
                schoolsData.push({ id: doc.id, ...doc.data() });
            });
            setSchools(schoolsData);
            const total = schoolsData.length;
            const active = schoolsData.filter(s => s.subscriptionStatus === 'active' || s.subscriptionStatus === 'trial').length;
            const pending = schoolsData.filter(s => s.subscriptionStatus === 'pending' || s.subscriptionStatus === 'inactive').length;
            setStats(prev => ({
                ...prev,
                totalSchools: total,
                activeSchools: active,
                pendingSchools: pending
            }));
            setRecentSchools(schoolsData.slice(0, 5));
            
            // Track realtime reads
            trackFirestoreOperation('read', 1);
        }, (error) => {
            console.error('Schools listener error:', error);
        });

        return () => unsubscribe();
    };

    const loadRecentActivities = async () => {
        try {
            const activitiesQuery = query(
                collection(db, 'activities'),
                orderBy('timestamp', 'desc'),
                limit(10)
            );
            const snapshot = await getDocs(activitiesQuery);
            const activities = [];
            snapshot.forEach(doc => {
                activities.push({ 
                    id: doc.id, 
                    ...doc.data(), 
                    timestamp: doc.data().timestamp?.toDate?.() || new Date() 
                });
            });
            setRecentActivities(activities);
            await trackFirestoreOperation('read', 1);
        } catch (error) {
            console.error('Error loading activities:', error);
        }
    };

    const handleSchoolClick = (schoolId) => {
        navigate(`/platform-admin/schools/${schoolId}`);
    };

    const handleDeleteSchool = async (schoolId) => {
        if (!window.confirm('Are you sure you want to delete this school? This action cannot be undone!')) return;

        try {
            await deleteDoc(doc(db, 'schools', schoolId));
            await trackFirestoreOperation('delete', 1);
            showNotification('School deleted successfully', 'success');
            setShowDeleteModal(false);
        } catch (error) {
            console.error('Error deleting school:', error);
            showNotification('Failed to delete school', 'error');
        }
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

    const getStatusColor = (status) => {
        switch (status) {
            case 'active': return '#27ae60';
            case 'trial': return '#3498db';
            case 'pending': return '#f39c12';
            case 'inactive': return '#e74c3c';
            default: return '#95a5a6';
        }
    };

    const getStatusLabel = (status) => {
        switch (status) {
            case 'active': return 'Active';
            case 'trial': return 'Trial';
            case 'pending': return 'Pending';
            case 'inactive': return 'Inactive';
            default: return 'Unknown';
        }
    };

    const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading dashboard..." />;
    }

    return (
        <Layout title="Platform Admin Dashboard">
            <style>{`
                .pa-dashboard {
                    padding: 0;
                }

                .pa-header {
                    background: #1a237e;
                    border-radius: 16px;
                    padding: 30px;
                    color: white;
                    margin-bottom: 30px;
                }

                .pa-header h1 {
                    font-size: 24px;
                    margin-bottom: 5px;
                }

                .pa-header p {
                    opacity: 0.9;
                    font-size: 14px;
                }

                .pa-stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }

                .pa-stat-card {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                    transition: all 0.3s;
                    cursor: pointer;
                }

                .pa-stat-card:hover {
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-lg);
                }

                .pa-stat-card .stat-label {
                    font-size: 13px;
                    color: var(--gray);
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .pa-stat-card .stat-value {
                    font-size: 28px;
                    font-weight: 700;
                    color: var(--secondary);
                    margin-top: 5px;
                }

                .pa-stat-card .stat-icon {
                    float: right;
                    font-size: 28px;
                    opacity: 0.2;
                    color: var(--primary);
                }

                .pa-stat-card .stat-change {
                    font-size: 12px;
                    margin-top: 5px;
                }

                .pa-stat-card .stat-change.positive {
                    color: var(--success);
                }

                .pa-stat-card .stat-change.negative {
                    color: var(--danger);
                }

                /* Firestore Stats */
                .firestore-stats {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                    margin-bottom: 30px;
                    border-top: 4px solid #4285f4;
                }

                .firestore-stats .section-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 15px;
                    flex-wrap: wrap;
                    gap: 10px;
                }

                .firestore-stats .section-header .title {
                    font-size: 16px;
                    font-weight: 700;
                    color: var(--secondary);
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .firestore-stats .section-header .title i {
                    color: #4285f4;
                }

                .firestore-stats .section-header .badge {
                    font-size: 11px;
                    padding: 4px 12px;
                    border-radius: 12px;
                    background: var(--light);
                    color: var(--gray);
                }

                .firestore-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: 15px;
                }

                .firestore-item {
                    padding: 12px;
                    background: var(--light);
                    border-radius: 8px;
                }

                .firestore-item .label {
                    font-size: 11px;
                    color: var(--gray);
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .firestore-item .value {
                    font-size: 20px;
                    font-weight: 700;
                    color: var(--secondary);
                    margin-top: 2px;
                }

                .firestore-item .value.danger {
                    color: #e74c3c;
                }

                .firestore-item .value.warning {
                    color: #f39c12;
                }

                .firestore-item .value.success {
                    color: #27ae60;
                }

                .firestore-item .sub {
                    font-size: 11px;
                    color: var(--gray);
                    margin-top: 2px;
                }

                .progress-bar-container {
                    margin-top: 5px;
                    background: #e9ecef;
                    border-radius: 4px;
                    height: 6px;
                    overflow: hidden;
                }

                .progress-bar-container .progress-fill {
                    height: 100%;
                    border-radius: 4px;
                    transition: width 0.5s ease;
                }

                .quota-warning {
                    margin-top: 10px;
                    padding: 10px 15px;
                    border-radius: 8px;
                    font-size: 13px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .quota-warning.info {
                    background: #d1ecf1;
                    border: 1px solid #bee5eb;
                    color: #0c5460;
                }

                .quota-warning.warning {
                    background: #fff3cd;
                    border: 1px solid #ffc107;
                    color: #856404;
                }

                .quota-warning.danger {
                    background: #f8d7da;
                    border: 1px solid #f5c6cb;
                    color: #721c24;
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

                .schools-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }

                .school-card {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                    transition: all 0.3s;
                    cursor: pointer;
                    border-left: 4px solid var(--primary);
                }

                .school-card:hover {
                    transform: translateY(-3px);
                    box-shadow: var(--shadow-lg);
                }

                .school-card .school-name {
                    font-size: 16px;
                    font-weight: 600;
                    color: var(--secondary);
                    margin-bottom: 5px;
                }

                .school-card .school-details {
                    font-size: 13px;
                    color: var(--gray);
                }

                .school-card .school-status {
                    display: inline-block;
                    padding: 2px 12px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: 600;
                    margin-top: 8px;
                }

                .school-card .school-actions {
                    margin-top: 12px;
                    display: flex;
                    gap: 8px;
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
                    font-size: 13px;
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

                .btn-danger {
                    background: var(--danger);
                    color: white;
                }

                .btn-danger:hover {
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
                    padding: 4px 12px;
                    font-size: 12px;
                }

                .activity-list {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
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

                .modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.5);
                    z-index: 1000;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }

                .modal-overlay.active {
                    display: flex;
                }

                .modal {
                    background: white;
                    border-radius: 16px;
                    max-width: 700px;
                    width: 100%;
                    max-height: 90vh;
                    overflow-y: auto;
                    padding: 30px;
                }

                .modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 25px;
                }

                .modal-header h2 {
                    font-size: 22px;
                    color: var(--secondary);
                }

                .modal-close {
                    width: 40px;
                    height: 40px;
                    border: none;
                    border-radius: 50%;
                    background: var(--light);
                    cursor: pointer;
                    font-size: 18px;
                    transition: all 0.3s;
                }

                .modal-close:hover {
                    background: var(--border);
                }

                .modal-footer {
                    display: flex;
                    gap: 10px;
                    justify-content: flex-end;
                    margin-top: 25px;
                    padding-top: 20px;
                    border-top: 1px solid var(--border);
                }

                @media (max-width: 768px) {
                    .pa-stats-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }

                    .firestore-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }

                    .schools-grid {
                        grid-template-columns: 1fr;
                    }
                }

                @media (max-width: 480px) {
                    .pa-stats-grid {
                        grid-template-columns: 1fr;
                    }

                    .firestore-grid {
                        grid-template-columns: 1fr;
                    }

                    .firestore-stats .section-header {
                        flex-direction: column;
                        align-items: flex-start;
                    }
                }

                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }

                .custom-notification {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    padding: 15px 20px;
                    border-radius: 8px;
                    box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    animation: slideIn 0.3s ease;
                    max-width: 400px;
                    word-wrap: break-word;
                    color: white;
                    font-family: 'Poppins', sans-serif;
                }
            `}</style>

            <div className="pa-dashboard">
                {/* Header */}
                <div className="pa-header">
                    <h1><i className="fas fa-crown"></i> Platform Admin Dashboard</h1>
                    <p>Manage all schools, admins, and platform activities</p>
                </div>

                {/* Stats */}
                <div className="pa-stats-grid">
                    <div className="pa-stat-card" onClick={() => navigate('/platform-admin/schools')}>
                        <div className="stat-label">Total Schools</div>
                        <div className="stat-value">{stats.totalSchools}</div>
                        <div className="stat-icon"><i className="fas fa-school"></i></div>
                        <div className="stat-change positive">
                            <i className="fas fa-arrow-up"></i> {stats.newSchoolsThisMonth} new this month
                        </div>
                    </div>
                    <div className="pa-stat-card">
                        <div className="stat-label">Active Schools</div>
                        <div className="stat-value">{stats.activeSchools}</div>
                        <div className="stat-icon"><i className="fas fa-check-circle" style={{ color: '#27ae60' }}></i></div>
                    </div>
                    <div className="pa-stat-card">
                        <div className="stat-label">Pending Schools</div>
                        <div className="stat-value">{stats.pendingSchools}</div>
                        <div className="stat-icon"><i className="fas fa-clock" style={{ color: '#f39c12' }}></i></div>
                    </div>
                    <div className="pa-stat-card">
                        <div className="stat-label">Total Admins</div>
                        <div className="stat-value">{stats.totalAdmins}</div>
                        <div className="stat-icon"><i className="fas fa-users-cog"></i></div>
                    </div>
                </div>

                {/* Firestore Usage Stats */}
                <div className="firestore-stats">
                    <div className="section-header">
                        <div className="title">
                            <i className="fas fa-database"></i>
                            Firestore Usage
                            <span className="badge">
                                <i className="fas fa-sync-alt"></i> Auto-refreshes
                            </span>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                            <i className="far fa-calendar-alt"></i> {getTodayString()}
                            {firestoreStats.lastUpdated && (
                                <span style={{ marginLeft: '10px' }}>
                                    <i className="far fa-clock"></i> Updated: {new Date(firestoreStats.lastUpdated).toLocaleTimeString()}
                                </span>
                            )}
                        </div>
                    </div>

                    {firestoreStats.isLoading ? (
                        <div style={{ textAlign: 'center', padding: '20px' }}>
                            <div className="spinner" style={{ width: '30px', height: '30px', border: '3px solid var(--border)', borderTopColor: '#4285f4', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto' }}></div>
                            <p style={{ marginTop: '10px', color: 'var(--gray)' }}>Loading usage stats...</p>
                        </div>
                    ) : (
                        <>
                            <div className="firestore-grid">
                                <div className="firestore-item">
                                    <div className="label"><i className="fas fa-eye"></i> Reads Today</div>
                                    <div className={`value ${firestoreStats.readPercentage > 80 ? 'danger' : firestoreStats.readPercentage > 60 ? 'warning' : ''}`}>
                                        {firestoreStats.readsToday.toLocaleString()}
                                    </div>
                                    <div className="sub">Quota: {firestoreStats.dailyReadQuota.toLocaleString()}</div>
                                    <div className="progress-bar-container">
                                        <div 
                                            className="progress-fill" 
                                            style={{ 
                                                width: `${Math.min(firestoreStats.readPercentage, 100)}%`,
                                                background: getQuotaColor(firestoreStats.readPercentage)
                                            }}
                                        ></div>
                                    </div>
                                    <div className="sub" style={{ marginTop: '2px' }}>
                                        {firestoreStats.readPercentage.toFixed(1)}% of daily quota
                                    </div>
                                </div>
                                <div className="firestore-item">
                                    <div className="label"><i className="fas fa-pen"></i> Writes Today</div>
                                    <div className={`value ${firestoreStats.writePercentage > 80 ? 'danger' : firestoreStats.writePercentage > 60 ? 'warning' : ''}`}>
                                        {firestoreStats.writesToday.toLocaleString()}
                                    </div>
                                    <div className="sub">Quota: {firestoreStats.dailyWriteQuota.toLocaleString()}</div>
                                    <div className="progress-bar-container">
                                        <div 
                                            className="progress-fill" 
                                            style={{ 
                                                width: `${Math.min(firestoreStats.writePercentage, 100)}%`,
                                                background: getQuotaColor(firestoreStats.writePercentage)
                                            }}
                                        ></div>
                                    </div>
                                    <div className="sub" style={{ marginTop: '2px' }}>
                                        {firestoreStats.writePercentage.toFixed(1)}% of daily quota
                                    </div>
                                </div>
                                <div className="firestore-item">
                                    <div className="label"><i className="fas fa-trash"></i> Deletes Today</div>
                                    <div className="value">{firestoreStats.deletesToday.toLocaleString()}</div>
                                </div>
                                <div className="firestore-item">
                                    <div className="label"><i className="fas fa-hdd"></i> Storage Used</div>
                                    <div className="value">
                                        {firestoreStats.storageGB > 1 
                                            ? firestoreStats.storageGB.toFixed(2) + ' GB' 
                                            : firestoreStats.storageMB.toFixed(2) + ' MB'}
                                    </div>
                                    <div className="sub">{formatBytes(firestoreStats.storageBytes)}</div>
                                </div>
                                <div className="firestore-item">
                                    <div className="label"><i className="fas fa-chart-line"></i> Total Reads (Lifetime)</div>
                                    <div className="value">{firestoreStats.totalReads.toLocaleString()}</div>
                                </div>
                                <div className="firestore-item">
                                    <div className="label"><i className="fas fa-chart-line"></i> Total Writes (Lifetime)</div>
                                    <div className="value">{firestoreStats.totalWrites.toLocaleString()}</div>
                                </div>
                            </div>

                            {/* Quota Warning */}
                            {firestoreStats.readPercentage > 80 && (
                                <div className="quota-warning danger">
                                    <i className="fas fa-exclamation-triangle"></i>
                                    <span>
                                        <strong>High Read Usage!</strong> You've used {firestoreStats.readPercentage.toFixed(1)}% of your daily read quota. 
                                        Consider optimizing your queries or upgrading your plan.
                                    </span>
                                </div>
                            )}
                            {firestoreStats.writePercentage > 80 && (
                                <div className="quota-warning warning">
                                    <i className="fas fa-exclamation-triangle"></i>
                                    <span>
                                        <strong>High Write Usage!</strong> You've used {firestoreStats.writePercentage.toFixed(1)}% of your daily write quota. 
                                        Consider batching operations or upgrading your plan.
                                    </span>
                                </div>
                            )}
                            {firestoreStats.readPercentage < 50 && firestoreStats.writePercentage < 50 && (
                                <div className="quota-warning info">
                                    <i className="fas fa-info-circle"></i>
                                    <span>
                                        Your Firestore usage is well within the free tier limits. 
                                        {firestoreStats.readsToday === 0 && firestoreStats.writesToday === 0 && ' No usage recorded today yet.'}
                                    </span>
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Schools Section */}
                <div className="section-header">
                    <h2 className="section-title">Recent Schools</h2>
                    <button className="btn btn-primary" onClick={() => navigate('/platform-admin/schools')}>
                        <i className="fas fa-arrow-right"></i> View All Schools
                    </button>
                </div>

                <div className="schools-grid">
                    {recentSchools.length === 0 ? (
                        <div className="empty-state" style={{ gridColumn: '1 / -1', background: 'white', borderRadius: '12px', padding: '40px', boxShadow: 'var(--shadow)' }}>
                            <i className="fas fa-school"></i>
                            <p>No schools registered yet</p>
                        </div>
                    ) : (
                        recentSchools.map(school => (
                            <div key={school.id} className="school-card" onClick={() => handleSchoolClick(school.id)}>
                                <div className="school-name">{school.name || school.schoolName || 'Unnamed School'}</div>
                                <div className="school-details">
                                    <div>Admin: {school.adminName || 'N/A'}</div>
                                    <div>Registered: {formatDate(school.createdAt)}</div>
                                </div>
                                <span className="school-status" style={{
                                    background: getStatusColor(school.subscriptionStatus) + '20',
                                    color: getStatusColor(school.subscriptionStatus)
                                }}>
                                    {getStatusLabel(school.subscriptionStatus)}
                                </span>
                                <div className="school-actions" onClick={(e) => e.stopPropagation()}>
                                    <button className="btn btn-primary btn-sm" onClick={() => handleSchoolClick(school.id)}>
                                        <i className="fas fa-eye"></i> View
                                    </button>
                                    <button className="btn btn-danger btn-sm" onClick={() => {
                                        setSelectedSchool(school);
                                        setShowDeleteModal(true);
                                    }}>
                                        <i className="fas fa-trash"></i>
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Recent Activities */}
                <div className="section-header">
                    <h2 className="section-title">Recent Activities</h2>
                </div>

                <div className="activity-list">
                    {recentActivities.length === 0 ? (
                        <div className="empty-state">
                            <i className="fas fa-clock"></i>
                            <p>No recent activities</p>
                        </div>
                    ) : (
                        recentActivities.map(activity => (
                            <div key={activity.id} className="activity-item">
                                <div className="activity-icon">
                                    <i className={`fas fa-${activity.icon || 'info-circle'}`}></i>
                                </div>
                                <div className="activity-content">
                                    <div className="text">{activity.description || 'Activity'}</div>
                                    <div className="time">{formatDate(activity.timestamp)}</div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Delete Modal */}
                {showDeleteModal && selectedSchool && (
                    <div className="modal-overlay active" onClick={(e) => {
                        if (e.target === e.currentTarget) setShowDeleteModal(false);
                    }}>
                        <div className="modal" style={{ maxWidth: '500px' }}>
                            <div className="modal-header">
                                <h2>Delete School</h2>
                                <button className="modal-close" onClick={() => setShowDeleteModal(false)}>
                                    <i className="fas fa-times"></i>
                                </button>
                            </div>
                            <div style={{ padding: '20px 0' }}>
                                <p style={{ color: 'var(--secondary)', marginBottom: '20px' }}>
                                    Are you sure you want to delete <strong>{selectedSchool.name || selectedSchool.schoolName || 'this school'}</strong>?
                                    This action cannot be undone and will delete all associated data.
                                </p>
                                <div style={{
                                    padding: '15px',
                                    background: '#fff3cd',
                                    borderRadius: '8px',
                                    border: '1px solid #ffc107',
                                    marginBottom: '20px'
                                }}>
                                    <i className="fas fa-exclamation-triangle" style={{ color: '#856404', marginRight: '10px' }}></i>
                                    <span style={{ color: '#856404', fontSize: '13px' }}>
                                        This will permanently delete all school data including students, teachers, and fee records.
                                    </span>
                                </div>
                                <div className="modal-footer">
                                    <button className="btn btn-outline" onClick={() => setShowDeleteModal(false)}>
                                        Cancel
                                    </button>
                                    <button className="btn btn-danger" onClick={() => handleDeleteSchool(selectedSchool.id)}>
                                        <i className="fas fa-trash"></i> Delete School
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </Layout>
    );
}
