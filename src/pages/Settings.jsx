// src/pages/Settings.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { db, auth } from '../firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { updatePassword, updateEmail, updateProfile, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';

// Roles that can be assigned through the Settings page.
const ASSIGNABLE_ROLES = [
    { value: 'user',         label: 'User' },
    { value: 'staff',        label: 'Staff' },
    { value: 'teacher',      label: 'Teacher' },
    { value: 'admin',        label: 'Administrator' },
    { value: 'school_admin', label: 'School Administrator' },
    { value: 'super-admin',  label: 'Super Administrator' },
];

const ADMIN_ROLES = new Set(['admin', 'school_admin', 'super-admin']);

export default function Settings() {
    const navigate = useNavigate();
    const { currentUser, userData, userRole, updateUserData } = useAuth();
    const { isOnline, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();

    // State
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [activeTab, setActiveTab] = useState('profile');
    const [userProfile, setUserProfile] = useState(null);
    const [profileImage, setProfileImage] = useState(null);
    const [imagePreview, setImagePreview] = useState(null);
    const [showPasswordModal, setShowPasswordModal] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [usingCachedData, setUsingCachedData] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const fileInputRef = useRef(null);

    // Cloudinary config
    const CLOUDINARY_CLOUD_NAME = process.env.REACT_APP_CLOUDINARY_CLOUD_NAME || 'your-cloud-name';
    const CLOUDINARY_UPLOAD_PRESET = process.env.REACT_APP_CLOUDINARY_UPLOAD_PRESET || 'school_profile';

    // ------------------------------------------------------------------
    // ROLE EDITING
    // ------------------------------------------------------------------
    // 🔓 TEST MODE — REMOVE THE NEXT TWO LINES BEFORE PRODUCTION LAUNCH.
    // Currently allows any signed-in user to change their own role so the
    // team can walk through every role's experience (admin / teacher / user)
    // without needing a Firestore console.
    const TEST_MODE_ALLOW_ROLE_EDIT = true;
    const canEditRole = TEST_MODE_ALLOW_ROLE_EDIT || ADMIN_ROLES.has(userRole || userData?.role || userProfile?.role || 'user');
    // 🔓 END TEST MODE
    //
    // Production version — delete the line above and use this instead:
    // const currentRole = userRole || userData?.role || userProfile?.role || 'user';
    // const canEditRole = ADMIN_ROLES.has(currentRole);
    // ------------------------------------------------------------------

    // Form states
    const [profileForm, setProfileForm] = useState({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        role: '',
        schoolId: ''
    });

    const [passwordForm, setPasswordForm] = useState({
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
    });

    const [deleteConfirm, setDeleteConfirm] = useState('');

    // Load user profile
    useEffect(() => {
        if (currentUser && userData) {
            loadUserProfile();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser, userData, isOnline]);

    const loadUserProfile = async () => {
        setLoading(true);
        try {
            const cachedProfile = await getFromIndexedDB('user_profile', currentUser.uid);
            if (cachedProfile) {
                setUserProfile(cachedProfile);
                populateFormData(cachedProfile);
                setUsingCachedData(true);
                setLoading(false);
            }

            if (isOnline) {
                const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
                if (userDoc.exists()) {
                    const data = userDoc.data();
                    setUserProfile(data);
                    populateFormData(data);
                    setUsingCachedData(false);
                    await saveToIndexedDB('user_profile', { ...data, uid: currentUser.uid });
                } else {
                    const teacherDoc = await getDoc(doc(db, 'teachers', currentUser.uid));
                    if (teacherDoc.exists()) {
                        const data = teacherDoc.data();
                        setUserProfile(data);
                        populateFormData(data);
                        setUsingCachedData(false);
                        await saveToIndexedDB('user_profile', { ...data, uid: currentUser.uid });
                    }
                }
            }
        } catch (error) {
            console.error('Error loading user profile:', error);
            showNotification('Failed to load profile', 'error');
        } finally {
            setLoading(false);
        }
    };

    const populateFormData = (data) => {
        setProfileForm({
            firstName: data.firstName || data.fullName?.split(' ')[0] || '',
            lastName: data.lastName || data.fullName?.split(' ').slice(1).join(' ') || '',
            email: data.email || currentUser?.email || '',
            phone: data.phone || '',
            role: data.role || 'user',
            schoolId: data.schoolId || ''
        });
        setImagePreview(data.profileImageUrl || data.photoURL || null);
    };

    const handleProfileChange = (e) => {
        const { id, value } = e.target;
        setProfileForm(prev => ({ ...prev, [id]: value }));
    };

    const handlePasswordChange = (e) => {
        const { id, value } = e.target;
        setPasswordForm(prev => ({ ...prev, [id]: value }));
    };

    const handleImageUpload = () => {
        if (!isOnline) {
            showNotification('You are offline. Please connect to the internet to upload a photo.', 'warning');
            return;
        }
        fileInputRef.current.click();
    };

    const uploadToCloudinary = async (file) => {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
            formData.append('folder', `profiles/${currentUser.uid}`);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, true);

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    const progress = Math.round((event.loaded / event.total) * 100);
                    setUploadProgress(progress);
                }
            };

            xhr.onload = () => {
                if (xhr.status === 200) {
                    const response = JSON.parse(xhr.responseText);
                    resolve(response.secure_url);
                } else {
                    reject(new Error('Upload failed'));
                }
            };

            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(formData);
        });
    };

    const handleFileChange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 2 * 1024 * 1024) {
            showNotification('Image must be less than 2MB', 'error');
            return;
        }

        const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!validTypes.includes(file.type)) {
            showNotification('Please upload a valid image (JPEG, PNG, GIF, WEBP)', 'error');
            return;
        }

        setSaving(true);
        setUploadProgress(0);

        try {
            const downloadUrl = await uploadToCloudinary(file);

            await updateDoc(doc(db, 'users', currentUser.uid), {
                profileImageUrl: downloadUrl,
                updatedAt: new Date().toISOString()
            });

            setImagePreview(downloadUrl);
            setUserProfile(prev => ({ ...prev, profileImageUrl: downloadUrl }));
            await saveToIndexedDB('user_profile', { ...userProfile, profileImageUrl: downloadUrl, uid: currentUser.uid });

            showNotification('Profile photo uploaded successfully!', 'success');
        } catch (error) {
            console.error('Error uploading image:', error);
            showNotification('Failed to upload image: ' + error.message, 'error');
        } finally {
            setSaving(false);
            setUploadProgress(0);
            e.target.value = '';
        }
    };

    const handleSaveProfile = async () => {
        if (saving) return;

        const originalRole = userProfile?.role || 'user';
        const roleChanged = canEditRole && profileForm.role && profileForm.role !== originalRole;

        setSaving(true);
        try {
            const updates = {
                firstName: profileForm.firstName.trim(),
                lastName: profileForm.lastName.trim(),
                phone: profileForm.phone.trim(),
                fullName: `${profileForm.firstName.trim()} ${profileForm.lastName.trim()}`,
                updatedAt: new Date().toISOString()
            };

            if (roleChanged) {
                updates.role = profileForm.role;
                updates.roleUpdatedAt = new Date().toISOString();
                updates.roleUpdatedBy = currentUser.uid;
            }

            if (isOnline) {
                await updateDoc(doc(db, 'users', currentUser.uid), updates);

                if (roleChanged) {
                    try {
                        const roleRef = doc(db, 'user_roles', currentUser.uid);
                        const roleSnap = await getDoc(roleRef);
                        if (roleSnap.exists()) {
                            await updateDoc(roleRef, {
                                role: updates.role,
                                updatedAt: new Date().toISOString()
                            });
                        } else {
                            // Create the doc if it doesn't exist yet (useful in test mode
                            // so a role change on a brand-new account persists).
                            const { setDoc } = await import('firebase/firestore');
                            await setDoc(roleRef, {
                                uid: currentUser.uid,
                                email: currentUser.email,
                                role: updates.role,
                                schoolId: userData?.schoolId || '',
                                createdAt: new Date().toISOString(),
                                updatedAt: new Date().toISOString()
                            }, { merge: true });
                        }
                    } catch (roleErr) {
                        console.warn('Could not mirror role to user_roles:', roleErr.message);
                    }

                    // Force a token refresh so the new role takes effect.
                    try {
                        await currentUser.getIdToken(true);
                    } catch (refreshErr) {
                        console.warn('Could not refresh token after role change:', refreshErr.message);
                    }
                }

                await updateProfile(currentUser, { displayName: updates.fullName });

                showNotification(
                    roleChanged
                        ? `Profile and role updated to "${updates.role}".`
                        : 'Profile updated successfully!',
                    'success'
                );
            } else {
                await addToSyncQueue('users', 'update', { id: currentUser.uid, ...updates });
                showNotification('Profile saved offline - will sync when online', 'info');
            }

            setUserProfile(prev => ({ ...prev, ...updates }));
            await saveToIndexedDB('user_profile', { ...userProfile, ...updates, uid: currentUser.uid });
            await updateUserData(updates);

        } catch (error) {
            console.error('Error saving profile:', error);
            showNotification('Failed to save profile: ' + error.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleChangePassword = async (e) => {
        e.preventDefault();
        if (saving) return;

        const { currentPassword, newPassword, confirmPassword } = passwordForm;

        if (newPassword.length < 6) {
            showNotification('Password must be at least 6 characters', 'error');
            return;
        }

        if (newPassword !== confirmPassword) {
            showNotification('Passwords do not match', 'error');
            return;
        }

        if (!isOnline) {
            showNotification('You are offline. Please connect to the internet to change password.', 'warning');
            return;
        }

        setSaving(true);
        try {
            const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
            await reauthenticateWithCredential(currentUser, credential);
            await updatePassword(currentUser, newPassword);

            setShowPasswordModal(false);
            setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
            showNotification('Password changed successfully!', 'success');
        } catch (error) {
            console.error('Error changing password:', error);
            let errorMessage = 'Failed to change password. ';
            if (error.code === 'auth/wrong-password') errorMessage = 'Current password is incorrect';
            else if (error.code === 'auth/weak-password') errorMessage = 'New password is too weak';
            else errorMessage += error.message;
            showNotification(errorMessage, 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteAccount = async () => {
        if (deleteConfirm !== 'DELETE') {
            showNotification('Please type DELETE to confirm', 'warning');
            return;
        }

        if (!isOnline) {
            showNotification('You are offline. Please connect to the internet to delete account.', 'warning');
            return;
        }

        if (!window.confirm('Are you sure you want to delete your account? This action cannot be undone!')) return;

        setSaving(true);
        try {
            await updateDoc(doc(db, 'users', currentUser.uid), {
                status: 'deleted',
                deletedAt: new Date().toISOString()
            });
            await currentUser.delete();
            showNotification('Account deleted successfully', 'success');
            setTimeout(() => navigate('/login'), 2000);
        } catch (error) {
            console.error('Error deleting account:', error);
            showNotification('Failed to delete account: ' + error.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    const showNotification = (message, type = 'info') => {
        const colors = { success: '#27ae60', error: '#e74c3c', warning: '#f39c12', info: '#3498db' };
        const iconMap = { success: 'check-circle', error: 'exclamation-circle', warning: 'exclamation-triangle', info: 'info-circle' };

        const el = document.createElement('div');
        el.className = 'custom-notification';
        el.style.backgroundColor = colors[type] || colors.info;
        el.innerHTML = `<i class="fas fa-${iconMap[type] || 'info-circle'}"></i><span>${message}</span>`;
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => el.parentNode && el.parentNode.removeChild(el), 300);
        }, 4000);
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading settings..." />;
    }

    return (
        <Layout title="Settings">
            <style>{`
                .settings-container { max-width: 900px; margin: 0 auto; padding: 20px 0; }
                .settings-card { background: white; border-radius: 16px; box-shadow: var(--shadow); overflow: hidden; }
                .settings-header { padding: 25px 30px; border-bottom: 2px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; }
                .settings-header h2 { font-size: 22px; color: var(--secondary); font-weight: 700; }
                .settings-header .user-email { font-size: 14px; color: var(--gray); }
                .settings-tabs { display: flex; gap: 5px; border-bottom: 2px solid var(--border); padding: 0 30px; flex-wrap: wrap; }
                .settings-tab { padding: 12px 24px; border: none; background: transparent; color: var(--gray); font-weight: 600; cursor: pointer; transition: all 0.3s; font-size: 14px; border-bottom: 3px solid transparent; margin-bottom: -2px; display: flex; align-items: center; gap: 8px; }
                .settings-tab:hover { color: var(--secondary); }
                .settings-tab.active { color: var(--primary); border-bottom-color: var(--primary); }
                .settings-body { padding: 30px; }
                .settings-section { display: none; animation: fadeIn 0.3s ease; }
                .settings-section.active { display: block; }
                .profile-avatar-section { display: flex; align-items: center; gap: 25px; margin-bottom: 30px; padding: 20px; background: var(--light); border-radius: 12px; flex-wrap: wrap; }
                .profile-avatar { width: 100px; height: 100px; border-radius: 50%; overflow: hidden; background: var(--primary); display: flex; align-items: center; justify-content: center; font-size: 48px; color: white; flex-shrink: 0; border: 3px solid var(--primary); position: relative; }
                .profile-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .profile-avatar .avatar-placeholder { font-weight: 700; text-transform: uppercase; }
                .profile-avatar .upload-overlay { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.6); padding: 8px; text-align: center; color: white; font-size: 11px; cursor: pointer; transition: all 0.3s; opacity: 0; }
                .profile-avatar:hover .upload-overlay { opacity: 1; }
                .profile-avatar .upload-overlay i { display: block; font-size: 14px; margin-bottom: 2px; }
                .avatar-info h4 { font-size: 18px; color: var(--secondary); margin-bottom: 5px; }
                .avatar-info p { color: var(--gray); font-size: 14px; }
                .upload-progress { width: 100%; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; margin-top: 8px; }
                .upload-progress .progress-bar { height: 100%; background: var(--primary); transition: width 0.3s ease; border-radius: 2px; }
                .form-group { margin-bottom: 20px; }
                .form-group label { display: block; font-size: 14px; font-weight: 600; color: var(--secondary); margin-bottom: 5px; }
                .form-group label .required { color: var(--danger); }
                .form-group input, .form-group select { width: 100%; padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; transition: all 0.3s; background: white; color: var(--secondary); }
                .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--primary); }
                .form-group input:disabled, .form-group select:disabled { background: var(--light); cursor: not-allowed; opacity: 0.7; }
                .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                .form-actions { display: flex; gap: 10px; margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border); flex-wrap: wrap; }
                .btn { padding: 10px 24px; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.3s; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
                .btn-primary { background: var(--primary); color: white; }
                .btn-primary:hover { background: var(--primary-dark); transform: translateY(-2px); box-shadow: var(--shadow-lg); }
                .btn-danger { background: var(--danger); color: white; }
                .btn-danger:hover { opacity: 0.9; transform: translateY(-2px); }
                .btn-outline { background: transparent; border: 2px solid var(--border); color: var(--secondary); }
                .btn-outline:hover { border-color: var(--primary); color: var(--primary); }
                .btn-success { background: var(--success); color: white; }
                .btn-success:hover { opacity: 0.9; transform: translateY(-2px); }
                .btn-warning { background: var(--warning); color: white; }
                .btn-warning:hover { opacity: 0.9; transform: translateY(-2px); }
                .btn-sm { padding: 6px 14px; font-size: 12px; }
                .password-section { background: var(--light); border-radius: 12px; padding: 20px; margin-top: 20px; }
                .danger-zone { border: 2px solid var(--danger); border-radius: 12px; padding: 25px; margin-top: 30px; background: #fff5f5; }
                .danger-zone h4 { color: var(--danger); font-size: 18px; margin-bottom: 10px; display: flex; align-items: center; gap: 10px; }
                .danger-zone p { color: var(--gray); font-size: 14px; margin-bottom: 20px; }
                .danger-zone .delete-input { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
                .danger-zone .delete-input input { flex: 1; min-width: 200px; padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; }
                .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); z-index: 1000; display: none; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px); }
                .modal-overlay.active { display: flex; }
                .modal { background: white; border-radius: 16px; max-width: 500px; width: 100%; max-height: 90vh; overflow-y: auto; padding: 30px; animation: slideUp 0.3s ease; }
                .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
                .modal-header h2 { font-size: 22px; color: var(--secondary); }
                .modal-close { width: 40px; height: 40px; border: none; border-radius: 50%; background: var(--light); cursor: pointer; font-size: 18px; transition: all 0.3s; }
                .modal-close:hover { background: var(--border); }
                .modal-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; padding-top: 20px; border-top: 1px solid var(--border); }
                .cached-indicator { background: #d1ecf1; color: #0c5460; padding: 8px 16px; border-radius: 8px; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; font-size: 13px; border: 1px solid #bee5eb; }
                .role-locked-hint { font-size: 12px; color: var(--gray); margin-top: 4px; display: flex; align-items: center; gap: 5px; }
                .test-mode-banner { background: #fff3cd; color: #856404; padding: 10px 14px; border-radius: 8px; font-size: 12px; margin-bottom: 10px; display: flex; align-items: flex-start; gap: 8px; border: 1px solid #ffeeba; line-height: 1.5; }
                .test-mode-banner i { color: #d39e00; font-size: 14px; margin-top: 1px; flex-shrink: 0; }
                @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes spin { to { transform: rotate(360deg); } }
                @media (max-width: 768px) {
                    .settings-header { padding: 20px; }
                    .settings-tabs { padding: 0 15px; }
                    .settings-tab { padding: 10px 16px; font-size: 13px; }
                    .settings-body { padding: 20px; }
                    .form-row { grid-template-columns: 1fr; }
                    .profile-avatar-section { flex-direction: column; text-align: center; }
                    .danger-zone .delete-input { flex-direction: column; }
                    .danger-zone .delete-input input { width: 100%; }
                }
                @media (max-width: 480px) {
                    .profile-avatar { width: 80px; height: 80px; font-size: 36px; }
                    .settings-tab { padding: 8px 12px; font-size: 12px; }
                    .settings-tab i { font-size: 12px; }
                }
            `}</style>

            <div className="settings-container">
                {usingCachedData && isOnline && (
                    <div className="cached-indicator">
                        <i className="fas fa-database"></i>
                        <span>Showing cached data. Syncing in background...</span>
                    </div>
                )}

                <div className="settings-card">
                    <div className="settings-header">
                        <div>
                            <h2><i className="fas fa-cog"></i> Settings</h2>
                            <div className="user-email">{currentUser?.email}</div>
                        </div>
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                            <span style={{
                                padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: '600',
                                background: ADMIN_ROLES.has(profileForm.role) ? '#d4edda' : '#d1ecf1',
                                color: ADMIN_ROLES.has(profileForm.role) ? '#155724' : '#0c5460'
                            }}>
                                {profileForm.role || 'user'}
                            </span>
                            <span style={{
                                padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: '600',
                                background: isOnline ? '#d4edda' : '#fff3cd',
                                color: isOnline ? '#155724' : '#856404'
                            }}>
                                <i className={`fas ${isOnline ? 'fa-wifi' : 'fa-wifi-slash'}`}></i>
                                {isOnline ? 'Online' : 'Offline'}
                            </span>
                        </div>
                    </div>

                    <div className="settings-tabs">
                        <button className={`settings-tab ${activeTab === 'profile' ? 'active' : ''}`} onClick={() => setActiveTab('profile')}>
                            <i className="fas fa-user"></i> Profile
                        </button>
                        <button className={`settings-tab ${activeTab === 'security' ? 'active' : ''}`} onClick={() => setActiveTab('security')}>
                            <i className="fas fa-lock"></i> Security
                        </button>
                        <button className={`settings-tab ${activeTab === 'danger' ? 'active' : ''}`} onClick={() => setActiveTab('danger')}>
                            <i className="fas fa-exclamation-triangle"></i> Danger Zone
                        </button>
                    </div>

                    <div className="settings-body">
                        {/* Profile Section */}
                        <div className={`settings-section ${activeTab === 'profile' ? 'active' : ''}`}>
                            <div className="profile-avatar-section">
                                <div className="profile-avatar">
                                    {imagePreview ? (
                                        <img src={imagePreview} alt="Profile" />
                                    ) : (
                                        <div className="avatar-placeholder">
                                            {profileForm.firstName?.[0] || profileForm.lastName?.[0] || 'U'}
                                        </div>
                                    )}
                                    <div className="upload-overlay" onClick={handleImageUpload}>
                                        <i className="fas fa-camera"></i>
                                        Upload
                                    </div>
                                </div>
                                <div className="avatar-info">
                                    <h4>{profileForm.firstName} {profileForm.lastName}</h4>
                                    <p>{currentUser?.email}</p>
                                    <button className="btn btn-primary btn-sm" onClick={handleImageUpload} style={{ marginTop: '8px' }}>
                                        <i className="fas fa-upload"></i> Change Photo
                                    </button>
                                    {uploadProgress > 0 && uploadProgress < 100 && (
                                        <div className="upload-progress">
                                            <div className="progress-bar" style={{ width: `${uploadProgress}%` }}></div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <input
                                type="file"
                                ref={fileInputRef}
                                accept="image/*"
                                style={{ display: 'none' }}
                                onChange={handleFileChange}
                            />

                            <form onSubmit={(e) => { e.preventDefault(); handleSaveProfile(); }}>
                                <div className="form-row">
                                    <div className="form-group">
                                        <label>First Name <span className="required">*</span></label>
                                        <input type="text" id="firstName" value={profileForm.firstName} onChange={handleProfileChange} required />
                                    </div>
                                    <div className="form-group">
                                        <label>Last Name <span className="required">*</span></label>
                                        <input type="text" id="lastName" value={profileForm.lastName} onChange={handleProfileChange} required />
                                    </div>
                                </div>

                                <div className="form-row">
                                    <div className="form-group">
                                        <label>Email Address</label>
                                        <input type="email" id="email" value={profileForm.email} disabled />
                                        <div style={{ fontSize: '12px', color: 'var(--gray)', marginTop: '4px' }}>
                                            Email cannot be changed here. Contact administrator.
                                        </div>
                                    </div>
                                    <div className="form-group">
                                        <label>Phone Number</label>
                                        <input type="tel" id="phone" value={profileForm.phone} onChange={handleProfileChange} placeholder="Enter phone number" />
                                    </div>
                                </div>

                                <div className="form-row">
                                    <div className="form-group">
                                        <label>Role {canEditRole && <span className="required">*</span>}</label>

                                        {TEST_MODE_ALLOW_ROLE_EDIT && (
                                            <div className="test-mode-banner">
                                                <i className="fas fa-flask"></i>
                                                <span>
                                                    <strong>Test mode active.</strong> Role editing is unlocked
                                                    for all signed-in users so the team can preview each role&rsquo;s
                                                    experience. Remove the <code>TEST_MODE_ALLOW_ROLE_EDIT</code>
                                                    flag in <code>Settings.jsx</code> before going live.
                                                </span>
                                            </div>
                                        )}

                                        <select
                                            id="role"
                                            value={profileForm.role}
                                            onChange={handleProfileChange}
                                            disabled={!canEditRole}
                                        >
                                            {ASSIGNABLE_ROLES.map((r) => (
                                                <option key={r.value} value={r.value}>{r.label}</option>
                                            ))}
                                        </select>

                                        {canEditRole ? (
                                            <div className="role-locked-hint">
                                                <i className="fas fa-shield-alt" style={{ color: 'var(--success)' }}></i>
                                                Changes take effect on the next request (token refresh runs automatically).
                                            </div>
                                        ) : (
                                            <div className="role-locked-hint">
                                                <i className="fas fa-lock" style={{ color: 'var(--warning)' }}></i>
                                                Role changes require administrator privileges.
                                            </div>
                                        )}
                                    </div>
                                    <div className="form-group">
                                        <label>School ID</label>
                                        <input type="text" id="schoolId" value={profileForm.schoolId} disabled />
                                    </div>
                                </div>

                                <div className="form-actions">
                                    <button type="submit" className="btn btn-primary" disabled={saving}>
                                        {saving ? (
                                            <>
                                                <span
                                                    className="loading-spinner"
                                                    style={{
                                                        width: '18px',
                                                        height: '18px',
                                                        border: '2px solid rgba(255,255,255,0.3)',
                                                        borderTopColor: 'white',
                                                        borderRadius: '50%',
                                                        animation: 'spin 1s linear infinite'
                                                    }}
                                                />
                                                Saving...
                                            </>
                                        ) : (
                                            <>
                                                <i className="fas fa-save"></i> Save Changes
                                            </>
                                        )}
                                    </button>
                                </div>
                            </form>
                        </div>

                        {/* Security Section */}
                        <div className={`settings-section ${activeTab === 'security' ? 'active' : ''}`}>
                            <div className="password-section">
                                <h3 style={{ marginBottom: '15px', color: 'var(--secondary)' }}>
                                    <i className="fas fa-key"></i> Change Password
                                </h3>
                                <p style={{ color: 'var(--gray)', fontSize: '14px', marginBottom: '20px' }}>
                                    Change your password regularly to keep your account secure.
                                </p>
                                <button className="btn btn-warning" onClick={() => setShowPasswordModal(true)} disabled={!isOnline}>
                                    <i className="fas fa-lock"></i> Change Password
                                </button>
                                {!isOnline && (
                                    <div style={{ fontSize: '12px', color: 'var(--warning)', marginTop: '8px' }}>
                                        <i className="fas fa-info-circle"></i> You need to be online to change password.
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Danger Zone */}
                        <div className={`settings-section ${activeTab === 'danger' ? 'active' : ''}`}>
                            <div className="danger-zone">
                                <h4><i className="fas fa-exclamation-triangle"></i> Delete Account</h4>
                                <p>
                                    Once you delete your account, there is no going back. Please be certain.
                                    This action will permanently delete all your data.
                                </p>
                                <div className="delete-input">
                                    <input
                                        type="text"
                                        placeholder='Type "DELETE" to confirm'
                                        value={deleteConfirm}
                                        onChange={(e) => setDeleteConfirm(e.target.value)}
                                    />
                                    <button className="btn btn-danger" onClick={handleDeleteAccount} disabled={!isOnline || saving}>
                                        <i className="fas fa-trash"></i> Delete Account
                                    </button>
                                </div>
                                {!isOnline && (
                                    <div style={{ fontSize: '12px', color: 'var(--warning)', marginTop: '10px' }}>
                                        <i className="fas fa-info-circle"></i> You need to be online to delete your account.
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Change Password Modal */}
            <div className={`modal-overlay ${showPasswordModal ? 'active' : ''}`}>
                <div className="modal">
                    <div className="modal-header">
                        <h2>Change Password</h2>
                        <button className="modal-close" onClick={() => setShowPasswordModal(false)}>
                            <i className="fas fa-times"></i>
                        </button>
                    </div>
                    <form onSubmit={handleChangePassword}>
                        <div className="form-group">
                            <label>Current Password <span className="required">*</span></label>
                            <input type="password" id="currentPassword" value={passwordForm.currentPassword} onChange={handlePasswordChange} required />
                        </div>
                        <div className="form-group">
                            <label>New Password <span className="required">*</span></label>
                            <input type="password" id="newPassword" value={passwordForm.newPassword} onChange={handlePasswordChange} required placeholder="Minimum 6 characters" />
                        </div>
                        <div className="form-group">
                            <label>Confirm New Password <span className="required">*</span></label>
                            <input type="password" id="confirmPassword" value={passwordForm.confirmPassword} onChange={handlePasswordChange} required />
                        </div>
                        <div className="modal-footer">
                            <button type="button" className="btn btn-outline" onClick={() => setShowPasswordModal(false)}>Cancel</button>
                            <button type="submit" className="btn btn-primary" disabled={saving}>
                                {saving ? 'Updating...' : 'Update Password'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </Layout>
    );
}
