// src/pages/PlatformAdmin/Schools.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSync } from '../../context/SyncContext';
import { db, auth } from '../../firebase';
import { 
    collection, query, getDocs, onSnapshot, 
    doc, getDoc, updateDoc, deleteDoc, 
    orderBy, where, serverTimestamp,
    writeBatch, addDoc, setDoc
} from 'firebase/firestore';
import { createUserWithEmailAndPassword, updateProfile, sendPasswordResetEmail } from 'firebase/auth';
import Layout from '../../components/Layout/Layout';
import LoadingSpinner from '../../components/Common/LoadingSpinner';

import { showAppNotice } from '../../utils/appNotice';
export default function SchoolsManagement() {
    const navigate = useNavigate();
    const { currentUser, userData } = useAuth();
    const { isOnline, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();

    // State
    const [loading, setLoading] = useState(true);
    const [schools, setSchools] = useState([]);
    const [filteredSchools, setFilteredSchools] = useState([]);
    const [showAddModal, setShowAddModal] = useState(false);
    const [showEditModal, setShowEditModal] = useState(false);
    const [selectedSchool, setSelectedSchool] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize] = useState(10);
    const [saving, setSaving] = useState(false);

    // Registration form state (same as Login.jsx)
    const [signupSchoolName, setSignupSchoolName] = useState('');
    const [signupAdminFullName, setSignupAdminFullName] = useState('');
    const [signupEmail, setSignupEmail] = useState('');
    const [signupPassword, setSignupPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [termsAgreement, setTermsAgreement] = useState(false);
    const [logoUrl, setLogoUrl] = useState('');
    const [profileUrl, setProfileUrl] = useState('');
    const [logoPreview, setLogoPreview] = useState(null);
    const [profilePreview, setProfilePreview] = useState(null);
    const [signupEmailValid, setSignupEmailValid] = useState(null);
    const [passwordsMatch, setPasswordsMatch] = useState(null);
    const [cachedUsers, setCachedUsers] = useState([]);

    // Edit form state
    const [editFormData, setEditFormData] = useState({
        schoolName: '',
        schoolEmail: '',
        schoolPhone: '',
        adminName: '',
        adminEmail: '',
        subscriptionStatus: 'trial',
        trialEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        address: '',
        city: '',
        country: 'Kenya'
    });

    // Generate school ID
    const generateSchoolId = (schoolName) => {
        const timestamp = Date.now().toString(36);
        const randomStr = Math.random().toString(36).substring(2, 6);
        const nameCode = schoolName.substring(0, 3).toUpperCase();
        return `${nameCode}-${timestamp}-${randomStr}`;
    };

    // Validate email
    const validateEmail = (email) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    };

    // Handle email validation for signup
    const handleSignupEmailChange = (e) => {
        const email = e.target.value;
        setSignupEmail(email);
        if (email === '') {
            setSignupEmailValid(null);
        } else {
            setSignupEmailValid(validateEmail(email));
        }
    };

    // Handle password confirmation
    const handleConfirmPasswordChange = (e) => {
        const confirm = e.target.value;
        setConfirmPassword(confirm);
        if (confirm === '') {
            setPasswordsMatch(null);
        } else {
            setPasswordsMatch(signupPassword === confirm);
        }
    };

    // Handle image upload
    const handleImageUpload = (type) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/gif,image/webp';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64String = reader.result;
                    if (type === 'logo') {
                        setLogoUrl(base64String);
                        setLogoPreview(base64String);
                    } else {
                        setProfileUrl(base64String);
                        setProfilePreview(base64String);
                    }
                    showNotification('✅ Image uploaded successfully!', 'success');
                };
                reader.readAsDataURL(file);
            }
        };
        input.click();
    };

    // Show notification
    const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

    // Load schools
    useEffect(() => {
        loadSchools();
    }, []);

    const loadSchools = () => {
        setLoading(true);
        const q = query(
            collection(db, 'schools'),
            orderBy('createdAt', 'desc')
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const schoolsData = [];
            snapshot.forEach(doc => {
                schoolsData.push({ id: doc.id, ...doc.data() });
            });
            setSchools(schoolsData);
            applyFilters(schoolsData);
            setLoading(false);
        }, (error) => {
            console.error('Error loading schools:', error);
            setLoading(false);
        });

        return () => unsubscribe();
    };

    const applyFilters = (schoolsData = schools) => {
        const term = searchTerm.toLowerCase();
        const status = statusFilter;

        const filtered = schoolsData.filter(school => {
            const matchSearch = (school.name || school.schoolName || '').toLowerCase().includes(term) ||
                               (school.adminName || '').toLowerCase().includes(term) ||
                               (school.email || school.schoolEmail || '').toLowerCase().includes(term);
            const matchStatus = status === 'all' || school.subscriptionStatus === status;
            return matchSearch && matchStatus;
        });

        setFilteredSchools(filtered);
        setCurrentPage(1);
    };

    const handleSearch = (e) => {
        setSearchTerm(e.target.value);
        applyFilters();
    };

    const handleStatusFilter = (e) => {
        setStatusFilter(e.target.value);
        applyFilters();
    };

    // Reset registration form
    const resetForm = () => {
        setSignupSchoolName('');
        setSignupAdminFullName('');
        setSignupEmail('');
        setSignupPassword('');
        setConfirmPassword('');
        setTermsAgreement(false);
        setLogoUrl('');
        setProfileUrl('');
        setLogoPreview(null);
        setProfilePreview(null);
        setSignupEmailValid(null);
        setPasswordsMatch(null);
    };

    // Handle school registration (same as Login.jsx)
    const handleRegisterSchool = async (e) => {
        e.preventDefault();
        setSaving(true);

        // Validation
        if (!signupSchoolName) {
            showNotification('Please enter school name', 'error');
            setSaving(false);
            return;
        }
        
        if (!signupAdminFullName) {
            showNotification('Please enter admin full name', 'error');
            setSaving(false);
            return;
        }
        
        if (!logoUrl) {
            showNotification('Please upload school logo', 'error');
            setSaving(false);
            return;
        }
        
        if (!profileUrl) {
            showNotification('Please upload admin profile picture', 'error');
            setSaving(false);
            return;
        }
        
        if (!validateEmail(signupEmail)) {
            showNotification('Please enter a valid email address', 'error');
            setSaving(false);
            return;
        }
        
        if (signupPassword.length < 6) {
            showNotification('Password must be at least 6 characters', 'error');
            setSaving(false);
            return;
        }
        
        if (signupPassword !== confirmPassword) {
            showNotification('Passwords do not match', 'error');
            setSaving(false);
            return;
        }
        
        if (!termsAgreement) {
            showNotification('Please agree to the terms and conditions', 'error');
            setSaving(false);
            return;
        }

        try {
            // Create auth user
            const userCredential = await createUserWithEmailAndPassword(auth, signupEmail, signupPassword);
            const user = userCredential.user;
            
            // Generate school ID
            const schoolId = generateSchoolId(signupSchoolName);
            
            // Create school document
            const schoolData = {
                schoolId: schoolId,
                schoolName: signupSchoolName,
                logoUrl: logoUrl,
                adminName: signupAdminFullName,
                adminImageUrl: profileUrl,
                adminEmail: signupEmail,
                subscriptionStatus: 'inactive',
                trialStartDate: serverTimestamp(),
                trialEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                emailVerified: false,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                settings: {
                    theme: 'default',
                    language: 'en',
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
                }
            };
            
            await setDoc(doc(db, 'schools', schoolId), schoolData);
            
            // Create user document
            const userData = {
                uid: user.uid,
                schoolId: schoolId,
                fullName: signupAdminFullName,
                email: signupEmail,
                role: 'admin',
                profileImageUrl: profileUrl,
                emailVerified: false,
                lastLogin: serverTimestamp(),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                permissions: {
                    canManageUsers: true,
                    canManageStudents: true,
                    canManageTeachers: true,
                    canManageClasses: true,
                    canManageFinance: true,
                    canManageSettings: true
                }
            };
            
            await setDoc(doc(db, 'users', user.uid), userData);
            
            // Send verification email
            try {
                await user.sendEmailVerification();
            } catch (emailError) {
                console.error('Error sending verification email:', emailError);
            }

            showNotification(`✅ School account created! Verification email sent to ${signupEmail}`, 'success');
            
            // Reset form
            resetForm();
            setShowAddModal(false);

        } catch (error) {
            let errorMessage = 'Registration failed. ';
            
            switch (error.code) {
                case 'auth/email-already-in-use':
                    errorMessage = 'Email already registered. Please use a different email';
                    break;
                case 'auth/invalid-email':
                    errorMessage = 'Invalid email address';
                    break;
                case 'auth/weak-password':
                    errorMessage = 'Password is too weak. Use at least 6 characters';
                    break;
                case 'auth/network-request-failed':
                    errorMessage = 'Network error. Check your connection';
                    break;
                default:
                    errorMessage += error.message;
            }
            
            showNotification(errorMessage, 'error');
        } finally {
            setSaving(false);
        }
    };

    // Edit school
    const handleEditSchool = async (e) => {
        e.preventDefault();
        setSaving(true);

        try {
            const schoolData = {
                name: editFormData.schoolName.trim(),
                schoolName: editFormData.schoolName.trim(),
                email: editFormData.schoolEmail.trim(),
                phone: editFormData.schoolPhone.trim(),
                adminName: editFormData.adminName.trim(),
                adminEmail: editFormData.adminEmail.trim(),
                subscriptionStatus: editFormData.subscriptionStatus,
                trialEndDate: new Date(editFormData.trialEndDate),
                address: editFormData.address.trim(),
                city: editFormData.city.trim(),
                country: editFormData.country.trim(),
                updatedAt: serverTimestamp()
            };

            await updateDoc(doc(db, 'schools', selectedSchool.id), schoolData);
            showNotification('School updated successfully!', 'success');
            setShowEditModal(false);
            setSelectedSchool(null);
        } catch (error) {
            console.error('Error updating school:', error);
            showNotification('Failed to update school', 'error');
        } finally {
            setSaving(false);
        }
    };

    const openEditModal = (school) => {
        setSelectedSchool(school);
        setEditFormData({
            schoolName: school.name || school.schoolName || '',
            schoolEmail: school.email || school.schoolEmail || '',
            schoolPhone: school.phone || '',
            adminName: school.adminName || '',
            adminEmail: school.adminEmail || '',
            subscriptionStatus: school.subscriptionStatus || 'trial',
            trialEndDate: school.trialEndDate?.toDate?.()?.toISOString().split('T')[0] || 
                          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            address: school.address || '',
            city: school.city || '',
            country: school.country || 'Kenya'
        });
        setShowEditModal(true);
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

    // Pagination
    const totalPages = Math.ceil(filteredSchools.length / pageSize);
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const currentSchools = filteredSchools.slice(startIndex, endIndex);

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading schools..." />;
    }

    return (
        <Layout title="Schools Management">
            <style>{`
                .schools-management {
                    padding: 0;
                }

                .header-actions {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 25px;
                    flex-wrap: wrap;
                    gap: 15px;
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

                .search-input {
                    flex: 1;
                    min-width: 200px;
                    padding: 10px 15px;
                    border: 2px solid var(--border);
                    border-radius: 8px;
                    font-size: 14px;
                    transition: all 0.3s;
                    background: white;
                    color: var(--secondary);
                }

                .search-input:focus {
                    outline: none;
                    border-color: var(--primary);
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

                .btn-danger {
                    background: var(--danger);
                    color: white;
                }

                .btn-danger:hover {
                    opacity: 0.9;
                    transform: translateY(-2px);
                }

                .btn-sm {
                    padding: 4px 12px;
                    font-size: 12px;
                }

                .schools-table-container {
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
                    font-size: 13px;
                }

                tr:hover {
                    background: var(--light);
                }

                .status-badge {
                    display: inline-block;
                    padding: 2px 12px;
                    border-radius: 12px;
                    font-size: 12px;
                    font-weight: 600;
                }

                .pagination {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 15px 20px;
                    background: white;
                    border-top: 1px solid var(--border);
                    flex-wrap: wrap;
                    gap: 10px;
                }

                .pagination .info {
                    font-size: 14px;
                    color: var(--gray);
                }

                .pagination-btns {
                    display: flex;
                    gap: 5px;
                    flex-wrap: wrap;
                }

                .pagination-btns button {
                    padding: 8px 14px;
                    border: 1px solid var(--border);
                    border-radius: 6px;
                    background: white;
                    cursor: pointer;
                    transition: all 0.3s;
                    font-weight: 500;
                    color: var(--secondary);
                }

                .pagination-btns button:hover:not(:disabled) {
                    border-color: var(--primary);
                    color: var(--primary);
                }

                .pagination-btns button.active {
                    background: var(--primary);
                    color: white;
                    border-color: var(--primary);
                }

                .pagination-btns button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
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
                    max-width: 700px;
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

                .modal-footer {
                    display: flex;
                    gap: 10px;
                    justify-content: flex-end;
                    margin-top: 25px;
                    padding-top: 20px;
                    border-top: 1px solid var(--border);
                }

                .empty-state {
                    text-align: center;
                    padding: 60px 20px;
                    color: var(--gray);
                }

                .empty-state i {
                    font-size: 64px;
                    color: var(--border);
                    margin-bottom: 20px;
                }

                /* File Upload Styles */
                .file-upload-container {
                    margin-bottom: 20px;
                }

                .upload-preview {
                    display: flex;
                    align-items: center;
                    margin-bottom: 10px;
                    gap: 15px;
                }

                .logo-preview,
                .profile-preview {
                    width: 80px;
                    height: 80px;
                    border-radius: 10px;
                    overflow: hidden;
                    border: 2px dashed #ddd;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background-color: #f8f9fa;
                    flex-shrink: 0;
                }

                .logo-preview img,
                .profile-preview img {
                    max-width: 100%;
                    max-height: 100%;
                    object-fit: cover;
                }

                .upload-info {
                    flex: 1;
                }

                .upload-info p {
                    font-size: 13px;
                    color: #666;
                    margin-bottom: 5px;
                }

                .upload-btn {
                    padding: 8px 16px;
                    background: var(--primary);
                    color: white;
                    border: none;
                    border-radius: 6px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                }

                .upload-btn:hover {
                    background: #1e3a8a;
                    transform: translateY(-2px);
                    box-shadow: 0 4px 12px rgba(155, 89, 182, 0.3);
                }

                .validation-icon {
                    position: absolute;
                    right: 14px;
                    top: 37px;
                    font-size: 16px;
                    display: none;
                }

                .validation-icon.valid {
                    color: var(--success);
                    display: block;
                }

                .validation-icon.invalid {
                    color: var(--danger);
                    display: block;
                }

                .input-group {
                    position: relative;
                }

                .divider {
                    display: flex;
                    align-items: center;
                    margin: 20px 0 15px;
                    color: #777;
                    font-size: 13px;
                }

                .divider:before,
                .divider:after {
                    content: '';
                    flex: 1;
                    height: 1px;
                    background: #ddd;
                }

                .divider span {
                    padding: 0 12px;
                }

                @media (max-width: 768px) {
                    .header-actions {
                        flex-direction: column;
                        align-items: stretch;
                    }

                    .filters-section {
                        flex-direction: column;
                        align-items: stretch;
                    }

                    .search-input,
                    .filter-select {
                        width: 100%;
                    }

                    .form-row {
                        grid-template-columns: 1fr;
                    }

                    .modal {
                        padding: 20px;
                    }

                    .pagination {
                        flex-direction: column;
                    }

                    .upload-preview {
                        flex-direction: column;
                        text-align: center;
                    }
                }
            `}</style>

            <div className="schools-management">
                {/* Header */}
                <div className="header-actions">
                    <h1 className="section-title">Schools Management</h1>
                    <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
                        <i className="fas fa-plus"></i> Register New School
                    </button>
                </div>

                {/* Filters */}
                <div className="filters-section">
                    <input
                        type="text"
                        className="search-input"
                        placeholder="Search by school name, admin name, or email..."
                        value={searchTerm}
                        onChange={handleSearch}
                    />
                    <select
                        className="filter-select"
                        value={statusFilter}
                        onChange={handleStatusFilter}
                    >
                        <option value="all">All Status</option>
                        <option value="active">Active</option>
                        <option value="trial">Trial</option>
                        <option value="pending">Pending</option>
                        <option value="inactive">Inactive</option>
                    </select>
                    <button className="btn btn-primary" onClick={() => applyFilters()}>
                        <i className="fas fa-filter"></i> Apply
                    </button>
                    <button className="btn btn-outline" onClick={() => {
                        setSearchTerm('');
                        setStatusFilter('all');
                        applyFilters();
                    }}>
                        <i className="fas fa-times"></i> Clear
                    </button>
                </div>

                {/* Schools Table */}
                <div className="schools-table-container">
                    <div className="table-wrapper">
                        <table>
                            <thead>
                                <tr>
                                    <th>School</th>
                                    <th>Admin</th>
                                    <th>Status</th>
                                    <th>Registered</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {currentSchools.length === 0 ? (
                                    <tr>
                                        <td colSpan="5">
                                            <div className="empty-state">
                                                <i className="fas fa-school"></i>
                                                <p>No schools found</p>
                                            </div>
                                        </td>
                                    </tr>
                                ) : (
                                    currentSchools.map(school => (
                                        <tr key={school.id}>
                                            <td>
                                                <div>
                                                    <div style={{ fontWeight: '600', color: 'var(--secondary)' }}>
                                                        {school.name || school.schoolName || 'Unnamed School'}
                                                    </div>
                                                    <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                                                        {school.email || school.schoolEmail || 'No email'}
                                                    </div>
                                                </div>
                                            </td>
                                            <td>
                                                <div>
                                                    <div style={{ fontWeight: '500', color: 'var(--secondary)' }}>
                                                        {school.adminName || 'N/A'}
                                                    </div>
                                                    <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                                                        {school.adminEmail || 'No email'}
                                                    </div>
                                                </div>
                                            </td>
                                            <td>
                                                <span className="status-badge" style={{
                                                    background: getStatusColor(school.subscriptionStatus) + '20',
                                                    color: getStatusColor(school.subscriptionStatus)
                                                }}>
                                                    {getStatusLabel(school.subscriptionStatus)}
                                                </span>
                                            </td>
                                            <td>{formatDate(school.createdAt)}</td>
                                            <td>
                                                <div style={{ display: 'flex', gap: '5px' }}>
                                                    <button 
                                                        className="btn btn-primary btn-sm" 
                                                        onClick={() => navigate(`/platform-admin/schools/${school.id}`)}
                                                    >
                                                        <i className="fas fa-eye"></i>
                                                    </button>
                                                    <button 
                                                        className="btn btn-success btn-sm" 
                                                        onClick={() => openEditModal(school)}
                                                    >
                                                        <i className="fas fa-edit"></i>
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                    {filteredSchools.length > 0 && (
                        <div className="pagination">
                            <div className="info">
                                Showing {startIndex + 1}-{Math.min(endIndex, filteredSchools.length)} of {filteredSchools.length} schools
                            </div>
                            <div className="pagination-btns">
                                <button 
                                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                                    disabled={currentPage === 1}
                                >
                                    <i className="fas fa-chevron-left"></i>
                                </button>
                                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                                    let pageNum;
                                    if (totalPages <= 5) {
                                        pageNum = i + 1;
                                    } else if (currentPage <= 3) {
                                        pageNum = i + 1;
                                    } else if (currentPage >= totalPages - 2) {
                                        pageNum = totalPages - 4 + i;
                                    } else {
                                        pageNum = currentPage - 2 + i;
                                    }
                                    if (pageNum <= 0 || pageNum > totalPages) return null;
                                    return (
                                        <button 
                                            key={pageNum}
                                            className={pageNum === currentPage ? 'active' : ''}
                                            onClick={() => setCurrentPage(pageNum)}
                                        >
                                            {pageNum}
                                        </button>
                                    );
                                })}
                                <button 
                                    onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                                    disabled={currentPage === totalPages}
                                >
                                    <i className="fas fa-chevron-right"></i>
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Register New School Modal - Same as Login.jsx */}
                {showAddModal && (
                    <div className="modal-overlay active" onClick={(e) => {
                        if (e.target === e.currentTarget) setShowAddModal(false);
                    }}>
                        <div className="modal" style={{ maxWidth: '700px' }}>
                            <div className="modal-header">
                                <h2>Register New School</h2>
                                <button className="modal-close" onClick={() => {
                                    setShowAddModal(false);
                                    resetForm();
                                }}>
                                    <i className="fas fa-times"></i>
                                </button>
                            </div>
                            <form onSubmit={handleRegisterSchool}>
                                <div className="form-group">
                                    <label>School Name <span className="required">*</span></label>
                                    <input 
                                        type="text" 
                                        value={signupSchoolName}
                                        onChange={(e) => setSignupSchoolName(e.target.value)}
                                        placeholder="Enter school name" 
                                        required 
                                    />
                                </div>
                                
                                <div className="form-group">
                                    <label>Admin Full Name <span className="required">*</span></label>
                                    <input 
                                        type="text" 
                                        value={signupAdminFullName}
                                        onChange={(e) => setSignupAdminFullName(e.target.value)}
                                        placeholder="Enter admin full name" 
                                        required 
                                    />
                                </div>
                                
                                {/* School Logo Upload */}
                                <div className="file-upload-container">
                                    <label>School Logo <span className="required">*</span></label>
                                    <div className="upload-preview">
                                        <div className="logo-preview">
                                            {logoPreview ? (
                                                <img src={logoPreview} alt="School Logo" />
                                            ) : (
                                                <i className="fas fa-school fa-2x" style={{ color: '#ccc' }}></i>
                                            )}
                                        </div>
                                        <div className="upload-info">
                                            <p>Upload your school logo (Max 2MB)</p>
                                            <button type="button" className="upload-btn" onClick={() => handleImageUpload('logo')}>
                                                <i className="fas fa-upload"></i>
                                                <span>Upload Logo</span>
                                            </button>
                                        </div>
                                    </div>
                                    <input type="hidden" value={logoUrl} />
                                </div>
                                
                                {/* Admin Profile Picture Upload */}
                                <div className="file-upload-container">
                                    <label>Admin Profile Picture <span className="required">*</span></label>
                                    <div className="upload-preview">
                                        <div className="profile-preview">
                                            {profilePreview ? (
                                                <img src={profilePreview} alt="Admin Profile" />
                                            ) : (
                                                <i className="fas fa-user fa-2x" style={{ color: '#ccc' }}></i>
                                            )}
                                        </div>
                                        <div className="upload-info">
                                            <p>Upload admin profile picture (Max 2MB)</p>
                                            <button type="button" className="upload-btn" onClick={() => handleImageUpload('profile')}>
                                                <i className="fas fa-upload"></i>
                                                <span>Upload Profile</span>
                                            </button>
                                        </div>
                                    </div>
                                    <input type="hidden" value={profileUrl} />
                                </div>
                                
                                <div className="form-group input-group">
                                    <label>Admin Email Address <span className="required">*</span></label>
                                    <input 
                                        type="email" 
                                        value={signupEmail}
                                        onChange={handleSignupEmailChange}
                                        placeholder="Enter admin email" 
                                        required 
                                    />
                                    <div className={`validation-icon ${signupEmailValid === true ? 'valid' : signupEmailValid === false ? 'invalid' : ''}`}>
                                        {signupEmailValid === true && <i className="fas fa-check-circle"></i>}
                                        {signupEmailValid === false && <i className="fas fa-exclamation-circle"></i>}
                                    </div>
                                </div>
                                
                                <div className="form-group input-group">
                                    <label>Password <span className="required">*</span></label>
                                    <input 
                                        type="password" 
                                        value={signupPassword}
                                        onChange={(e) => setSignupPassword(e.target.value)}
                                        placeholder="Create a strong password" 
                                        required 
                                    />
                                </div>
                                
                                <div className="form-group input-group">
                                    <label>Confirm Password <span className="required">*</span></label>
                                    <input 
                                        type="password" 
                                        value={confirmPassword}
                                        onChange={handleConfirmPasswordChange}
                                        placeholder="Confirm your password" 
                                        required 
                                    />
                                    <div className={`validation-icon ${passwordsMatch === true ? 'valid' : passwordsMatch === false ? 'invalid' : ''}`}>
                                        {passwordsMatch === true && <i className="fas fa-check-circle"></i>}
                                        {passwordsMatch === false && <i className="fas fa-exclamation-circle"></i>}
                                    </div>
                                </div>
                                
                                <div className="divider">
                                    <span>Terms & Conditions</span>
                                </div>
                                
                                <div className="form-group" style={{ marginBottom: '15px' }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                                        <input 
                                            type="checkbox" 
                                            id="termsAgreement" 
                                            checked={termsAgreement}
                                            onChange={(e) => setTermsAgreement(e.target.checked)}
                                            style={{ width: 'auto', marginTop: '3px' }} 
                                        />
                                        <label htmlFor="termsAgreement" style={{ fontSize: '13px', color: '#666', cursor: 'pointer' }}>
                                            I agree to the <a href="#" style={{ color: 'var(--primary)' }}>Terms of Service</a> and <a href="#" style={{ color: 'var(--primary)' }}>Privacy Policy</a>. I understand that my school account will be in trial mode until subscription is activated.
                                        </label>
                                    </div>
                                </div>
                                
                                <div className="modal-footer">
                                    <button type="button" className="btn btn-outline" onClick={() => {
                                        setShowAddModal(false);
                                        resetForm();
                                    }}>
                                        Cancel
                                    </button>
                                    <button type="submit" className="btn btn-primary" disabled={saving}>
                                        {saving ? 'Registering...' : 'Register School'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}

                {/* Edit School Modal */}
                {showEditModal && selectedSchool && (
                    <div className="modal-overlay active" onClick={(e) => {
                        if (e.target === e.currentTarget) setShowEditModal(false);
                    }}>
                        <div className="modal">
                            <div className="modal-header">
                                <h2>Edit School</h2>
                                <button className="modal-close" onClick={() => setShowEditModal(false)}>
                                    <i className="fas fa-times"></i>
                                </button>
                            </div>
                            <form onSubmit={handleEditSchool}>
                                <div className="form-row">
                                    <div className="form-group">
                                        <label>School Name <span className="required">*</span></label>
                                        <input
                                            type="text"
                                            value={editFormData.schoolName}
                                            onChange={(e) => setEditFormData({ ...editFormData, schoolName: e.target.value })}
                                            required
                                        />
                                    </div>
                                    <div className="form-group">
                                        <label>School Email</label>
                                        <input
                                            type="email"
                                            value={editFormData.schoolEmail}
                                            onChange={(e) => setEditFormData({ ...editFormData, schoolEmail: e.target.value })}
                                        />
                                    </div>
                                </div>
                                <div className="form-row">
                                    <div className="form-group">
                                        <label>School Phone</label>
                                        <input
                                            type="tel"
                                            value={editFormData.schoolPhone}
                                            onChange={(e) => setEditFormData({ ...editFormData, schoolPhone: e.target.value })}
                                        />
                                    </div>
                                    <div className="form-group">
                                        <label>Admin Name <span className="required">*</span></label>
                                        <input
                                            type="text"
                                            value={editFormData.adminName}
                                            onChange={(e) => setEditFormData({ ...editFormData, adminName: e.target.value })}
                                            required
                                        />
                                    </div>
                                </div>
                                <div className="form-row">
                                    <div className="form-group">
                                        <label>Admin Email <span className="required">*</span></label>
                                        <input
                                            type="email"
                                            value={editFormData.adminEmail}
                                            onChange={(e) => setEditFormData({ ...editFormData, adminEmail: e.target.value })}
                                            required
                                        />
                                    </div>
                                    <div className="form-group">
                                        <label>Subscription Status</label>
                                        <select
                                            value={editFormData.subscriptionStatus}
                                            onChange={(e) => setEditFormData({ ...editFormData, subscriptionStatus: e.target.value })}
                                        >
                                            <option value="trial">Trial</option>
                                            <option value="active">Active</option>
                                            <option value="pending">Pending</option>
                                            <option value="inactive">Inactive</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="form-group">
                                    <label>Trial End Date</label>
                                    <input
                                        type="date"
                                        value={editFormData.trialEndDate}
                                        onChange={(e) => setEditFormData({ ...editFormData, trialEndDate: e.target.value })}
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Address</label>
                                    <textarea
                                        rows="2"
                                        value={editFormData.address}
                                        onChange={(e) => setEditFormData({ ...editFormData, address: e.target.value })}
                                    ></textarea>
                                </div>
                                <div className="form-row">
                                    <div className="form-group">
                                        <label>City</label>
                                        <input
                                            type="text"
                                            value={editFormData.city}
                                            onChange={(e) => setEditFormData({ ...editFormData, city: e.target.value })}
                                        />
                                    </div>
                                    <div className="form-group">
                                        <label>Country</label>
                                        <input
                                            type="text"
                                            value={editFormData.country}
                                            onChange={(e) => setEditFormData({ ...editFormData, country: e.target.value })}
                                        />
                                    </div>
                                </div>
                                <div className="modal-footer">
                                    <button type="button" className="btn btn-outline" onClick={() => setShowEditModal(false)}>
                                        Cancel
                                    </button>
                                    <button type="submit" className="btn btn-primary" disabled={saving}>
                                        {saving ? 'Updating...' : 'Update School'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}
            </div>
        </Layout>
    );
}
