// src/pages/PlatformAdmin/SchoolDetails.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSync } from '../../context/SyncContext';
import { db } from '../../firebase';
import { 
    doc, getDoc, updateDoc, deleteDoc,
    collection, query, where, getDocs,
    orderBy, limit, serverTimestamp
} from 'firebase/firestore';
import Layout from '../../components/Layout/Layout';
import LoadingSpinner from '../../components/Common/LoadingSpinner';

import { showAppNotice } from '../../utils/appNotice';
export default function SchoolDetails() {
    const navigate = useNavigate();
    const { schoolId } = useParams();
    const { currentUser, userData } = useAuth();
    const { isOnline } = useSync();

    // State
    const [loading, setLoading] = useState(true);
    const [school, setSchool] = useState(null);
    const [admins, setAdmins] = useState([]);
    const [stats, setStats] = useState({
        totalStudents: 0,
        totalTeachers: 0,
        totalExams: 0,
        totalRevenue: 0,
        pendingInvoices: 0
    });
    const [activeTab, setActiveTab] = useState('overview');
    const [showEditModal, setShowEditModal] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [saving, setSaving] = useState(false);

    // Feature flags - these are the current state of features
    const [features, setFeatures] = useState({
        transport: false,
        accommodation: false,
        health: false,
        inventory: false,
        fees: true,
        exams: true,
        results: true,
        reports: true,
        subscription: true
    });

    // Form state
    const [formData, setFormData] = useState({
        name: '',
        schoolName: '',
        email: '',
        phone: '',
        adminName: '',
        adminEmail: '',
        subscriptionStatus: 'trial',
        trialEndDate: '',
        address: '',
        city: '',
        country: 'Kenya',
        schoolType: 'secondary',
        curriculum: 'cbc'
    });

    useEffect(() => {
        if (schoolId) {
            loadSchoolData();
        }
    }, [schoolId]);

    const loadSchoolData = async () => {
        setLoading(true);
        try {
            // Load school
            const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
            if (!schoolDoc.exists()) {
                showNotification('School not found', 'error');
                navigate('/platform-admin/schools');
                return;
            }
            const schoolData = { id: schoolDoc.id, ...schoolDoc.data() };
            setSchool(schoolData);
            populateForm(schoolData);

            // Load features from school data
            if (schoolData.features) {
                setFeatures({
                    transport: schoolData.features.transport || false,
                    accommodation: schoolData.features.accommodation || false,
                    health: schoolData.features.health || false,
                    inventory: schoolData.features.inventory || false,
                    fees: schoolData.features.fees !== undefined ? schoolData.features.fees : true,
                    exams: schoolData.features.exams !== undefined ? schoolData.features.exams : true,
                    results: schoolData.features.results !== undefined ? schoolData.features.results : true,
                    reports: schoolData.features.reports !== undefined ? schoolData.features.reports : true,
                    subscription: schoolData.features.subscription !== undefined ? schoolData.features.subscription : true
                });
            }

            // Load admins
            await loadAdmins(schoolId);

            // Load stats
            await loadStats(schoolId);

        } catch (error) {
            console.error('Error loading school data:', error);
            showNotification('Failed to load school data', 'error');
        } finally {
            setLoading(false);
        }
    };

    const loadAdmins = async (schoolId) => {
        try {
            const q = query(
                collection(db, 'users'),
                where('schoolId', '==', schoolId),
                where('role', 'in', ['admin', 'super-admin'])
            );
            const snapshot = await getDocs(q);
            const adminList = [];
            snapshot.forEach(doc => {
                adminList.push({ id: doc.id, ...doc.data() });
            });
            setAdmins(adminList);
        } catch (error) {
            console.error('Error loading admins:', error);
        }
    };

    const loadStats = async (schoolId) => {
        try {
            // Get students count
            const studentsQuery = query(
                collection(db, 'students'),
                where('schoolId', '==', schoolId)
            );
            const studentsSnapshot = await getDocs(studentsQuery);

            // Get teachers count
            const teachersQuery = query(
                collection(db, 'teachers'),
                where('schoolId', '==', schoolId)
            );
            const teachersSnapshot = await getDocs(teachersQuery);

            // Get exams count
            const examsQuery = query(
                collection(db, 'exams'),
                where('schoolId', '==', schoolId)
            );
            const examsSnapshot = await getDocs(examsQuery);

            // Get fee transactions
            const feeQuery = query(
                collection(db, 'fee_transactions'),
                where('schoolId', '==', schoolId),
                where('type', '==', 'payment'),
                where('status', '==', 'completed')
            );
            const feeSnapshot = await getDocs(feeQuery);
            let totalRevenue = 0;
            feeSnapshot.forEach(doc => {
                totalRevenue += doc.data().amount || 0;
            });

            // Get pending invoices
            const invoicesQuery = query(
                collection(db, 'fee_invoices'),
                where('schoolId', '==', schoolId),
                where('status', '==', 'pending')
            );
            const invoicesSnapshot = await getDocs(invoicesQuery);

            setStats({
                totalStudents: studentsSnapshot.size,
                totalTeachers: teachersSnapshot.size,
                totalExams: examsSnapshot.size,
                totalRevenue: totalRevenue,
                pendingInvoices: invoicesSnapshot.size
            });

        } catch (error) {
            console.error('Error loading stats:', error);
        }
    };

    const populateForm = (data) => {
        setFormData({
            name: data.name || data.schoolName || '',
            schoolName: data.name || data.schoolName || '',
            email: data.email || data.schoolEmail || '',
            phone: data.phone || '',
            adminName: data.adminName || '',
            adminEmail: data.adminEmail || '',
            subscriptionStatus: data.subscriptionStatus || 'trial',
            trialEndDate: data.trialEndDate?.toDate?.()?.toISOString().split('T')[0] || '',
            address: data.address || '',
            city: data.city || '',
            country: data.country || 'Kenya',
            schoolType: data.schoolType || 'secondary',
            curriculum: data.curriculum || 'cbc'
        });
    };

    const handleUpdateSchool = async (e) => {
        e.preventDefault();
        setSaving(true);

        try {
            // IMPORTANT: Include features in the update data
            const updateData = {
                name: formData.schoolName.trim(),
                schoolName: formData.schoolName.trim(),
                email: formData.email.trim(),
                phone: formData.phone.trim(),
                adminName: formData.adminName.trim(),
                adminEmail: formData.adminEmail.trim(),
                subscriptionStatus: formData.subscriptionStatus,
                trialEndDate: formData.trialEndDate ? new Date(formData.trialEndDate) : null,
                address: formData.address.trim(),
                city: formData.city.trim(),
                country: formData.country.trim(),
                schoolType: formData.schoolType,
                curriculum: formData.curriculum,
                features: features, // ✅ This saves the features to Firestore
                updatedAt: serverTimestamp()
            };

            console.log('Saving features:', features); // Debug log
            console.log('Update data:', updateData); // Debug log

            await updateDoc(doc(db, 'schools', schoolId), updateData);
            
            showNotification('School updated successfully! Features saved.', 'success');
            setShowEditModal(false);
            
            // Reload data to reflect changes
            await loadSchoolData();
            
        } catch (error) {
            console.error('Error updating school:', error);
            showNotification('Failed to update school: ' + error.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    // Handle feature toggle - updates local state immediately
    const handleFeatureToggle = (featureName) => {
        setFeatures(prev => {
            const newFeatures = {
                ...prev,
                [featureName]: !prev[featureName]
            };
            console.log('Feature toggled:', featureName, newFeatures[featureName]); // Debug log
            return newFeatures;
        });
    };

    // Save features directly without opening the edit modal
    const saveFeaturesDirectly = async () => {
        setSaving(true);
        try {
            await updateDoc(doc(db, 'schools', schoolId), {
                features: features,
                updatedAt: serverTimestamp()
            });
            showNotification('Features saved successfully!', 'success');
            await loadSchoolData(); // Reload to confirm changes
        } catch (error) {
            console.error('Error saving features:', error);
            showNotification('Failed to save features: ' + error.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteSchool = async () => {
        setSaving(true);
        try {
            await deleteDoc(doc(db, 'schools', schoolId));
            showNotification('School deleted successfully!', 'success');
            navigate('/platform-admin/schools');
        } catch (error) {
            console.error('Error deleting school:', error);
            showNotification('Failed to delete school', 'error');
            setShowDeleteModal(false);
        } finally {
            setSaving(false);
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

    const formatCurrency = (amount) => {
        return `KES ${(amount || 0).toLocaleString()}`;
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
        return <LoadingSpinner fullScreen text="Loading school details..." />;
    }

    if (!school) {
        return (
            <Layout title="School Not Found">
                <div style={{ textAlign: 'center', padding: '60px 20px' }}>
                    <i className="fas fa-school" style={{ fontSize: '64px', color: '#e0e6ed', marginBottom: '20px' }}></i>
                    <h3 style={{ fontSize: '20px', color: '#2c3e50', marginBottom: '10px' }}>School Not Found</h3>
                    <p style={{ color: '#95a5a6' }}>The school you're looking for could not be found.</p>
                    <button className="btn btn-primary" onClick={() => navigate('/platform-admin/schools')} style={{ marginTop: '20px' }}>
                        <i className="fas fa-arrow-left"></i> Back to Schools
                    </button>
                </div>
            </Layout>
        );
    }

    return (
        <Layout title={`School: ${school.name || school.schoolName || 'N/A'}`}>
            <style>{`
                .school-details {
                    padding: 0;
                }

                .school-header {
                    background: white;
                    border-radius: 16px;
                    padding: 30px;
                    box-shadow: var(--shadow);
                    margin-bottom: 30px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 20px;
                }

                .school-header .school-info h1 {
                    font-size: 24px;
                    color: var(--secondary);
                    margin-bottom: 5px;
                }

                .school-header .school-info .details {
                    color: var(--gray);
                    font-size: 14px;
                }

                .school-header .school-status {
                    display: inline-block;
                    padding: 4px 16px;
                    border-radius: 20px;
                    font-size: 13px;
                    font-weight: 600;
                }

                .school-header .actions {
                    display: flex;
                    gap: 10px;
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
                    font-size: 28px;
                    opacity: 0.2;
                    color: var(--primary);
                }

                .tabs {
                    display: flex;
                    gap: 5px;
                    background: var(--light);
                    padding: 5px;
                    border-radius: 12px;
                    margin-bottom: 25px;
                    flex-wrap: wrap;
                }

                .tabs .tab {
                    padding: 10px 20px;
                    border: none;
                    border-radius: 8px;
                    background: transparent;
                    cursor: pointer;
                    font-weight: 600;
                    color: var(--gray);
                    transition: all 0.3s;
                    font-size: 14px;
                }

                .tabs .tab:hover {
                    color: var(--secondary);
                }

                .tabs .tab.active {
                    background: white;
                    color: var(--primary);
                    box-shadow: var(--shadow);
                }

                .details-section {
                    background: white;
                    border-radius: 12px;
                    padding: 25px;
                    box-shadow: var(--shadow);
                    margin-bottom: 30px;
                }

                .details-section .section-title {
                    font-size: 18px;
                    font-weight: 700;
                    color: var(--secondary);
                    margin-bottom: 20px;
                }

                .details-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 20px;
                }

                .feature-toggle {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 12px 16px;
                    background: var(--light);
                    border-radius: 8px;
                    margin-bottom: 10px;
                    transition: all 0.3s;
                }

                .feature-toggle:hover {
                    background: #e8ecf1;
                }

                .feature-toggle .feature-info {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .feature-toggle .feature-info i {
                    font-size: 18px;
                    color: var(--primary);
                    width: 24px;
                }

                .feature-toggle .feature-info .feature-name {
                    font-weight: 500;
                    color: var(--secondary);
                }

                .feature-toggle .feature-info .feature-desc {
                    font-size: 12px;
                    color: var(--gray);
                }

                .toggle-switch {
                    position: relative;
                    width: 48px;
                    height: 26px;
                    flex-shrink: 0;
                }

                .toggle-switch input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }

                .toggle-slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: #ccc;
                    transition: 0.4s;
                    border-radius: 34px;
                }

                .toggle-slider:before {
                    position: absolute;
                    content: "";
                    height: 18px;
                    width: 18px;
                    left: 4px;
                    bottom: 4px;
                    background-color: white;
                    transition: 0.4s;
                    border-radius: 50%;
                }

                .toggle-switch input:checked + .toggle-slider {
                    background-color: var(--primary);
                }

                .toggle-switch input:checked + .toggle-slider:before {
                    transform: translateX(22px);
                }

                .features-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 10px;
                }

                .save-features-btn {
                    margin-top: 20px;
                    padding: 10px 24px;
                    background: var(--success);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                    font-size: 14px;
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                }

                .save-features-btn:hover {
                    opacity: 0.9;
                    transform: translateY(-2px);
                }

                .save-features-btn:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                    transform: none;
                }

                @media (max-width: 768px) {
                    .details-grid {
                        grid-template-columns: 1fr;
                    }
                    .features-grid {
                        grid-template-columns: 1fr;
                    }
                }

                .details-grid .detail-item {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }

                .details-grid .detail-item .label {
                    font-size: 12px;
                    color: var(--gray);
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .details-grid .detail-item .value {
                    font-size: 14px;
                    color: var(--secondary);
                    font-weight: 500;
                }

                .admins-list {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                    gap: 15px;
                }

                .admin-card {
                    background: var(--light);
                    border-radius: 12px;
                    padding: 15px;
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    transition: all 0.3s;
                }

                .admin-card:hover {
                    box-shadow: var(--shadow);
                }

                .admin-card .admin-avatar {
                    width: 50px;
                    height: 50px;
                    border-radius: 50%;
                    background: var(--primary);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 20px;
                    flex-shrink: 0;
                }

                .admin-card .admin-info .name {
                    font-weight: 600;
                    color: var(--secondary);
                }

                .admin-card .admin-info .email {
                    font-size: 12px;
                    color: var(--gray);
                }

                .admin-card .admin-info .role {
                    font-size: 11px;
                    padding: 2px 10px;
                    border-radius: 10px;
                    background: var(--primary);
                    color: white;
                    display: inline-block;
                    margin-top: 4px;
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
                    backdrop-filter: blur(4px);
                }

                .modal-overlay.active {
                    display: flex;
                }

                .modal {
                    background: white;
                    border-radius: 16px;
                    max-width: 800px;
                    width: 100%;
                    max-height: 90vh;
                    overflow-y: auto;
                    padding: 30px;
                    animation: slideUp 0.3s ease;
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

                .form-group {
                    margin-bottom: 20px;
                }

                .form-group label {
                    display: block;
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--secondary);
                    margin-bottom: 5px;
                }

                .form-group label .required {
                    color: var(--danger);
                }

                .form-group input,
                .form-group select,
                .form-group textarea {
                    width: 100%;
                    padding: 10px 15px;
                    border: 2px solid var(--border);
                    border-radius: 8px;
                    font-size: 14px;
                    transition: all 0.3s;
                    background: white;
                    color: var(--secondary);
                }

                .form-group input:focus,
                .form-group select:focus,
                .form-group textarea:focus {
                    outline: none;
                    border-color: var(--primary);
                }

                .form-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 20px;
                }

                @media (max-width: 768px) {
                    .form-row {
                        grid-template-columns: 1fr;
                    }
                }

                .form-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 10px;
                    margin-top: 25px;
                    padding-top: 20px;
                    border-top: 1px solid var(--border);
                }

                .btn:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                    transform: none !important;
                }

                @keyframes slideUp {
                    from {
                        transform: translateY(30px);
                        opacity: 0;
                    }
                    to {
                        transform: translateY(0);
                        opacity: 1;
                    }
                }

                @keyframes slideOut {
                    from {
                        transform: translateX(0);
                        opacity: 1;
                    }
                    to {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                }

                .custom-notification {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    padding: 15px 25px;
                    border-radius: 12px;
                    color: white;
                    font-weight: 500;
                    z-index: 9999;
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    box-shadow: var(--shadow-lg);
                    animation: slideUp 0.3s ease;
                    font-size: 14px;
                }

                .custom-notification i {
                    font-size: 20px;
                }

                .empty-state {
                    text-align: center;
                    padding: 40px 20px;
                    color: var(--gray);
                }

                .empty-state i {
                    font-size: 48px;
                    opacity: 0.3;
                    margin-bottom: 15px;
                }

                .empty-state h4 {
                    color: var(--secondary);
                    margin-bottom: 5px;
                }

                .delete-modal-content {
                    text-align: center;
                    padding: 20px 0;
                }

                .delete-modal-content .warning-icon {
                    font-size: 56px;
                    color: var(--danger);
                    margin-bottom: 15px;
                }

                .delete-modal-content p {
                    color: var(--gray);
                    margin-bottom: 5px;
                }

                .delete-modal-content .school-name {
                    font-weight: 700;
                    color: var(--secondary);
                }

                .features-section-title {
                    font-size: 16px;
                    font-weight: 600;
                    color: var(--secondary);
                    margin: 20px 0 15px;
                    padding-bottom: 10px;
                    border-bottom: 2px solid var(--border);
                }

                .feature-enabled-badge {
                    display: inline-block;
                    padding: 2px 10px;
                    border-radius: 12px;
                    font-size: 10px;
                    font-weight: 600;
                }

                .feature-enabled-badge.active {
                    background: #d4edda;
                    color: #155724;
                }

                .feature-enabled-badge.inactive {
                    background: #f8d7da;
                    color: #721c24;
                }
            `}</style>

            <div className="school-details">
                {/* School Header */}
                <div className="school-header">
                    <div className="school-info">
                        <h1>{school.name || school.schoolName || 'N/A'}</h1>
                        <div className="details">
                            {school.email || school.schoolEmail} • {school.phone || 'No phone'} • 
                            {school.city || 'No city'}, {school.country || 'Kenya'}
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
                        <span 
                            className="school-status" 
                            style={{ 
                                backgroundColor: getStatusColor(school.subscriptionStatus) + '20',
                                color: getStatusColor(school.subscriptionStatus),
                                border: `2px solid ${getStatusColor(school.subscriptionStatus)}`
                            }}
                        >
                            {getStatusLabel(school.subscriptionStatus)}
                        </span>
                        <div className="actions">
                            <button className="btn btn-primary" onClick={() => setShowEditModal(true)}>
                                <i className="fas fa-edit"></i> Edit
                            </button>
                            <button className="btn btn-danger" onClick={() => setShowDeleteModal(true)}>
                                <i className="fas fa-trash"></i> Delete
                            </button>
                            <button className="btn btn-outline" onClick={() => navigate('/platform-admin/schools')}>
                                <i className="fas fa-arrow-left"></i> Back
                            </button>
                        </div>
                    </div>
                </div>

                {/* Stats Grid */}
                <div className="stats-grid">
                    <div className="stat-card">
                        <i className="fas fa-users stat-icon"></i>
                        <div className="stat-label">Students</div>
                        <div className="stat-value">{stats.totalStudents}</div>
                    </div>
                    <div className="stat-card">
                        <i className="fas fa-chalkboard-teacher stat-icon"></i>
                        <div className="stat-label">Teachers</div>
                        <div className="stat-value">{stats.totalTeachers}</div>
                    </div>
                    <div className="stat-card">
                        <i className="fas fa-file-alt stat-icon"></i>
                        <div className="stat-label">Exams</div>
                        <div className="stat-value">{stats.totalExams}</div>
                    </div>
                    <div className="stat-card">
                        <i className="fas fa-money-bill-wave stat-icon"></i>
                        <div className="stat-label">Revenue</div>
                        <div className="stat-value">{formatCurrency(stats.totalRevenue)}</div>
                    </div>
                    <div className="stat-card">
                        <i className="fas fa-clock stat-icon"></i>
                        <div className="stat-label">Pending Invoices</div>
                        <div className="stat-value">{stats.pendingInvoices}</div>
                    </div>
                </div>

                {/* Tabs */}
                <div className="tabs">
                    <button 
                        className={`tab ${activeTab === 'overview' ? 'active' : ''}`}
                        onClick={() => setActiveTab('overview')}
                    >
                        <i className="fas fa-info-circle"></i> Overview
                    </button>
                    <button 
                        className={`tab ${activeTab === 'features' ? 'active' : ''}`}
                        onClick={() => setActiveTab('features')}
                    >
                        <i className="fas fa-cogs"></i> Features
                    </button>
                    <button 
                        className={`tab ${activeTab === 'admins' ? 'active' : ''}`}
                        onClick={() => setActiveTab('admins')}
                    >
                        <i className="fas fa-user-shield"></i> Admins ({admins.length})
                    </button>
                </div>

                {activeTab === 'overview' && (
                    <div className="details-section">
                        <div className="section-title">School Information</div>
                        <div className="details-grid">
                            <div className="detail-item">
                                <span className="label">School Name</span>
                                <span className="value">{school.name || school.schoolName || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">Email</span>
                                <span className="value">{school.email || school.schoolEmail || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">Phone</span>
                                <span className="value">{school.phone || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">School Type</span>
                                <span className="value">{school.schoolType || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">Curriculum</span>
                                <span className="value">{school.curriculum || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">Subscription Status</span>
                                <span className="value" style={{ color: getStatusColor(school.subscriptionStatus) }}>
                                    {getStatusLabel(school.subscriptionStatus)}
                                </span>
                            </div>
                            <div className="detail-item">
                                <span className="label">Trial End Date</span>
                                <span className="value">{formatDate(school.trialEndDate)}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">Address</span>
                                <span className="value">{school.address || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">City</span>
                                <span className="value">{school.city || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">Country</span>
                                <span className="value">{school.country || 'Kenya'}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">Admin Name</span>
                                <span className="value">{school.adminName || 'N/A'}</span>
                            </div>
                            <div className="detail-item">
                                <span className="label">Admin Email</span>
                                <span className="value">{school.adminEmail || 'N/A'}</span>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'features' && (
                    <div className="details-section">
                        <div className="section-title">
                            <i className="fas fa-cogs"></i> Feature Management
                        </div>
                        <p style={{ color: 'var(--gray)', marginBottom: '20px', fontSize: '14px' }}>
                            Enable or disable features for this school. Disabled features will be hidden from the school's sidebar.
                            <strong> Click "Save Features" to apply changes.</strong>
                        </p>
                        
                        <div className="features-section-title">Core Features</div>
                        <div className="features-grid">
                            <div className="feature-toggle">
                                <div className="feature-info">
                                    <i className="fas fa-coins"></i>
                                    <div>
                                        <div className="feature-name">Fee Management</div>
                                        <div className="feature-desc">Manage fees, invoices, and payments</div>
                                    </div>
                                </div>
                                <label className="toggle-switch">
                                    <input 
                                        type="checkbox" 
                                        checked={features.fees} 
                                        onChange={() => handleFeatureToggle('fees')}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>

                            <div className="feature-toggle">
                                <div className="feature-info">
                                    <i className="fas fa-file-alt"></i>
                                    <div>
                                        <div className="feature-name">Exams</div>
                                        <div className="feature-desc">Create and manage exams</div>
                                    </div>
                                </div>
                                <label className="toggle-switch">
                                    <input 
                                        type="checkbox" 
                                        checked={features.exams} 
                                        onChange={() => handleFeatureToggle('exams')}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>

                            <div className="feature-toggle">
                                <div className="feature-info">
                                    <i className="fas fa-chart-line"></i>
                                    <div>
                                        <div className="feature-name">Results</div>
                                        <div className="feature-desc">Manage exam results and transcripts</div>
                                    </div>
                                </div>
                                <label className="toggle-switch">
                                    <input 
                                        type="checkbox" 
                                        checked={features.results} 
                                        onChange={() => handleFeatureToggle('results')}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>

                            <div className="feature-toggle">
                                <div className="feature-info">
                                    <i className="fas fa-chart-pie"></i>
                                    <div>
                                        <div className="feature-name">Reports</div>
                                        <div className="feature-desc">Generate reports and analytics</div>
                                    </div>
                                </div>
                                <label className="toggle-switch">
                                    <input 
                                        type="checkbox" 
                                        checked={features.reports} 
                                        onChange={() => handleFeatureToggle('reports')}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>

                            <div className="feature-toggle">
                                <div className="feature-info">
                                    <i className="fas fa-credit-card"></i>
                                    <div>
                                        <div className="feature-name">Subscription</div>
                                        <div className="feature-desc">Manage school subscription</div>
                                    </div>
                                </div>
                                <label className="toggle-switch">
                                    <input 
                                        type="checkbox" 
                                        checked={features.subscription} 
                                        onChange={() => handleFeatureToggle('subscription')}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>
                        </div>

                        <div className="features-section-title">Optional Modules</div>
                        <div className="features-grid">
                            <div className="feature-toggle">
                                <div className="feature-info">
                                    <i className="fas fa-bus"></i>
                                    <div>
                                        <div className="feature-name">Transport</div>
                                        <div className="feature-desc">Bus management, routes, and tracking</div>
                                    </div>
                                </div>
                                <label className="toggle-switch">
                                    <input 
                                        type="checkbox" 
                                        checked={features.transport} 
                                        onChange={() => handleFeatureToggle('transport')}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>

                            <div className="feature-toggle">
                                <div className="feature-info">
                                    <i className="fas fa-house"></i>
                                    <div>
                                        <div className="feature-name">Accommodation</div>
                                        <div className="feature-desc">Dormitory management and boarding</div>
                                    </div>
                                </div>
                                <label className="toggle-switch">
                                    <input 
                                        type="checkbox" 
                                        checked={features.accommodation} 
                                        onChange={() => handleFeatureToggle('accommodation')}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>

                            <div className="feature-toggle">
                                <div className="feature-info">
                                    <i className="fas fa-cross"></i>
                                    <div>
                                        <div className="feature-name">Health Unit</div>
                                        <div className="feature-desc">Medical records and health management</div>
                                    </div>
                                </div>
                                <label className="toggle-switch">
                                    <input 
                                        type="checkbox" 
                                        checked={features.health} 
                                        onChange={() => handleFeatureToggle('health')}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>

                            <div className="feature-toggle">
                                <div className="feature-info">
                                    <i className="fas fa-boxes"></i>
                                    <div>
                                        <div className="feature-name">Inventory</div>
                                        <div className="feature-desc">School assets, textbooks, and stock tracking</div>
                                    </div>
                                </div>
                                <label className="toggle-switch">
                                    <input 
                                        type="checkbox" 
                                        checked={features.inventory} 
                                        onChange={() => handleFeatureToggle('inventory')}
                                    />
                                    <span className="toggle-slider"></span>
                                </label>
                            </div>
                        </div>

                        {/* Save Features Button */}
                        <div style={{ marginTop: '20px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                            <button 
                                className="save-features-btn" 
                                onClick={saveFeaturesDirectly}
                                disabled={saving}
                            >
                                {saving ? (
                                    <><i className="fas fa-spinner fa-spin"></i> Saving...</>
                                ) : (
                                    <><i className="fas fa-save"></i> Save Features</>
                                )}
                            </button>
                            <button 
                                className="btn btn-outline" 
                                onClick={() => loadSchoolData()}
                                disabled={saving}
                            >
                                <i className="fas fa-undo"></i> Reset
                            </button>
                        </div>

                        <div style={{ marginTop: '15px', padding: '15px', background: '#e8f4fd', borderRadius: '8px', border: '1px solid #bee5eb' }}>
                            <i className="fas fa-info-circle" style={{ color: '#0c5460', marginRight: '10px' }}></i>
                            <span style={{ color: '#0c5460', fontSize: '13px' }}>
                                <strong>Note:</strong> Click "Save Features" to apply changes. Features will be hidden from the school's sidebar navigation.
                            </span>
                        </div>
                    </div>
                )}

                {activeTab === 'admins' && (
                    <div className="details-section">
                        <div className="section-title">School Administrators</div>
                        {admins.length > 0 ? (
                            <div className="admins-list">
                                {admins.map(admin => (
                                    <div key={admin.id} className="admin-card">
                                        <div className="admin-avatar">
                                            {admin.displayName?.charAt(0) || admin.email?.charAt(0) || 'A'}
                                        </div>
                                        <div className="admin-info">
                                            <div className="name">{admin.displayName || admin.name || 'N/A'}</div>
                                            <div className="email">{admin.email}</div>
                                            <span className="role">{admin.role}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="empty-state">
                                <i className="fas fa-user-shield"></i>
                                <h4>No Administrators Found</h4>
                                <p>This school doesn't have any administrators assigned yet.</p>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Edit Modal */}
            <div className={`modal-overlay ${showEditModal ? 'active' : ''}`} onClick={() => setShowEditModal(false)}>
                <div className="modal" onClick={e => e.stopPropagation()}>
                    <div className="modal-header">
                        <h2><i className="fas fa-edit"></i> Edit School</h2>
                        <button className="modal-close" onClick={() => setShowEditModal(false)}>
                            <i className="fas fa-times"></i>
                        </button>
                    </div>
                    <form onSubmit={handleUpdateSchool}>
                        <div className="form-row">
                            <div className="form-group">
                                <label>School Name <span className="required">*</span></label>
                                <input
                                    type="text"
                                    value={formData.schoolName}
                                    onChange={(e) => setFormData({...formData, schoolName: e.target.value})}
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>Email <span className="required">*</span></label>
                                <input
                                    type="email"
                                    value={formData.email}
                                    onChange={(e) => setFormData({...formData, email: e.target.value})}
                                    required
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Phone</label>
                                <input
                                    type="tel"
                                    value={formData.phone}
                                    onChange={(e) => setFormData({...formData, phone: e.target.value})}
                                />
                            </div>
                            <div className="form-group">
                                <label>School Type</label>
                                <select
                                    value={formData.schoolType}
                                    onChange={(e) => setFormData({...formData, schoolType: e.target.value})}
                                >
                                    <option value="primary">Primary</option>
                                    <option value="secondary">Secondary</option>
                                    <option value="college">College</option>
                                    <option value="university">University</option>
                                </select>
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Curriculum</label>
                                <select
                                    value={formData.curriculum}
                                    onChange={(e) => setFormData({...formData, curriculum: e.target.value})}
                                >
                                    <option value="cbc">CBC</option>
                                    <option value="8-4-4">8-4-4</option>
                                    <option value="igcse">IGCSE</option>
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Subscription Status</label>
                                <select
                                    value={formData.subscriptionStatus}
                                    onChange={(e) => setFormData({...formData, subscriptionStatus: e.target.value})}
                                >
                                    <option value="trial">Trial</option>
                                    <option value="active">Active</option>
                                    <option value="pending">Pending</option>
                                    <option value="inactive">Inactive</option>
                                </select>
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Admin Name</label>
                                <input
                                    type="text"
                                    value={formData.adminName}
                                    onChange={(e) => setFormData({...formData, adminName: e.target.value})}
                                />
                            </div>
                            <div className="form-group">
                                <label>Admin Email</label>
                                <input
                                    type="email"
                                    value={formData.adminEmail}
                                    onChange={(e) => setFormData({...formData, adminEmail: e.target.value})}
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Trial End Date</label>
                                <input
                                    type="date"
                                    value={formData.trialEndDate}
                                    onChange={(e) => setFormData({...formData, trialEndDate: e.target.value})}
                                />
                            </div>
                            <div className="form-group">
                                <label>City</label>
                                <input
                                    type="text"
                                    value={formData.city}
                                    onChange={(e) => setFormData({...formData, city: e.target.value})}
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Country</label>
                                <input
                                    type="text"
                                    value={formData.country}
                                    onChange={(e) => setFormData({...formData, country: e.target.value})}
                                />
                            </div>
                            <div className="form-group">
                                <label>Address</label>
                                <input
                                    type="text"
                                    value={formData.address}
                                    onChange={(e) => setFormData({...formData, address: e.target.value})}
                                />
                            </div>
                        </div>

                        <div className="form-actions">
                            <button type="button" className="btn btn-outline" onClick={() => setShowEditModal(false)}>
                                Cancel
                            </button>
                            <button type="submit" className="btn btn-primary" disabled={saving}>
                                {saving ? <><i className="fas fa-spinner fa-spin"></i> Saving...</> : <><i className="fas fa-save"></i> Save Changes</>}
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            {/* Delete Modal */}
            <div className={`modal-overlay ${showDeleteModal ? 'active' : ''}`} onClick={() => setShowDeleteModal(false)}>
                <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
                    <div className="modal-header">
                        <h2><i className="fas fa-trash" style={{ color: 'var(--danger)' }}></i> Delete School</h2>
                        <button className="modal-close" onClick={() => setShowDeleteModal(false)}>
                            <i className="fas fa-times"></i>
                        </button>
                    </div>
                    <div className="delete-modal-content">
                        <div className="warning-icon">
                            <i className="fas fa-exclamation-triangle"></i>
                        </div>
                        <h3>Are you sure you want to delete this school?</h3>
                        <p>
                            You are about to delete <span className="school-name">"{school.name || school.schoolName}"</span>.
                            This action <strong>cannot be undone</strong> and will permanently remove:
                        </p>
                        <ul style={{ textAlign: 'left', marginTop: '15px', color: 'var(--gray)', listStyle: 'disc', paddingLeft: '20px' }}>
                            <li>All student data and records</li>
                            <li>All teacher information</li>
                            <li>All exam records and results</li>
                            <li>All fee transactions and invoices</li>
                            <li>All school settings and configurations</li>
                        </ul>
                        <div className="form-actions" style={{ justifyContent: 'center' }}>
                            <button className="btn btn-outline" onClick={() => setShowDeleteModal(false)}>
                                Cancel
                            </button>
                            <button className="btn btn-danger" onClick={handleDeleteSchool} disabled={saving}>
                                {saving ? <><i className="fas fa-spinner fa-spin"></i> Deleting...</> : <><i className="fas fa-trash"></i> Delete Permanently</>}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </Layout>
    );
}
