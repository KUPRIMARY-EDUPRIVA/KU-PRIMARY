// src/pages/TeacherProfile.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../firebase';
import { 
    collection, query, where, getDocs, doc, getDoc, 
    updateDoc, serverTimestamp, setDoc 
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';

import { showAppNotice } from '../utils/appNotice';
export default function TeacherProfile() {
    const navigate = useNavigate();
    const { currentUser, userData, userRole } = useAuth();
    
    // State for teacher data
    const [teacherData, setTeacherData] = useState({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        qualification: '',
        subjects: '',
        experience: '',
        bio: '',
        status: 'active',
        teacherId: '',
        profileImageUrl: ''
    });
    const [teacherDocId, setTeacherDocId] = useState(null);
    const [schoolData, setSchoolData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    
    // State for form
    const [formData, setFormData] = useState({
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        qualification: '',
        subjects: '',
        experience: '',
        bio: '',
        status: 'active',
        role: 'teacher'
    });
    
    // State for profile image
    const [profileImage, setProfileImage] = useState('');
    const [uploadingImage, setUploadingImage] = useState(false);
    
    // Refs
    const fileInputRef = useRef(null);
    
    // Load teacher data on mount
    useEffect(() => {
        if (currentUser && userData) {
            loadTeacherData();
        }
    }, [currentUser, userData]);

    // Load teacher data
    const loadTeacherData = async () => {
        setLoading(true);
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) {
                showNotification('School ID not found', 'error');
                setLoading(false);
                return;
            }

            // Try to find teacher by email in teachers collection
            const teacherQuery = query(
                collection(db, 'teachers'),
                where('email', '==', currentUser.email),
                limit(1)
            );
            const teacherSnapshot = await getDocs(teacherQuery);
            
            let teacher = null;
            let docId = null;
            
            if (!teacherSnapshot.empty) {
                const doc = teacherSnapshot.docs[0];
                docId = doc.id;
                teacher = {
                    id: doc.id,
                    ...doc.data()
                };
            } else {
                // If not found, check users collection
                const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
                if (userDoc.exists()) {
                    const userData = userDoc.data();
                    docId = currentUser.uid;
                    teacher = {
                        id: currentUser.uid,
                        firstName: userData.fullName || userData.firstName || 'Teacher',
                        lastName: userData.lastName || '',
                        email: currentUser.email,
                        schoolId: userData.schoolId || schoolId,
                        phone: userData.phone || '',
                        profileImageUrl: userData.profileImageUrl || '',
                        qualification: userData.qualification || '',
                        subjects: userData.subjects || '',
                        experience: userData.experience || '',
                        bio: userData.bio || '',
                        status: userData.status || 'active',
                        teacherId: userData.teacherId || userData.uid?.slice(0, 8) || 'N/A'
                    };
                } else {
                    // Create a basic teacher record
                    docId = currentUser.uid;
                    teacher = {
                        id: currentUser.uid,
                        firstName: currentUser.displayName?.split(' ')[0] || 'Teacher',
                        lastName: currentUser.displayName?.split(' ').slice(1).join(' ') || '',
                        email: currentUser.email,
                        schoolId: schoolId,
                        phone: '',
                        profileImageUrl: '',
                        qualification: '',
                        subjects: '',
                        experience: '',
                        bio: '',
                        status: 'active',
                        teacherId: currentUser.uid?.slice(0, 8) || 'N/A'
                    };
                }
            }

            if (teacher) {
                setTeacherData(teacher);
                setTeacherDocId(docId);
                
                // Populate form data
                setFormData({
                    firstName: teacher.firstName || '',
                    lastName: teacher.lastName || '',
                    email: teacher.email || '',
                    phone: teacher.phone || '',
                    qualification: teacher.qualification || '',
                    subjects: teacher.subjects || '',
                    experience: teacher.experience || '',
                    bio: teacher.bio || '',
                    status: teacher.status || 'active',
                    role: 'teacher'
                });
                
                setProfileImage(teacher.profileImageUrl || '');
                
                // Load school data
                const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
                if (schoolDoc.exists()) {
                    setSchoolData({
                        id: schoolDoc.id,
                        ...schoolDoc.data()
                    });
                }
            } else {
                showNotification('Teacher profile not found', 'error');
            }
        } catch (error) {
            console.error('Error loading teacher data:', error);
            showNotification('Failed to load profile data', 'error');
        } finally {
            setLoading(false);
        }
    };

    // Handle form input changes
    const handleFormChange = (e) => {
        const { id, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [id]: value
        }));
    };

    // Handle profile image upload
    const handleImageUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // Validate file type and size
        const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!validTypes.includes(file.type)) {
            showNotification('Please upload a valid image (JPEG, PNG, GIF, WEBP)', 'warning');
            return;
        }
        
        if (file.size > 2 * 1024 * 1024) {
            showNotification('Image size must be less than 2MB', 'warning');
            return;
        }
        
        setUploadingImage(true);
        
        try {
            // Convert image to base64
            const reader = new FileReader();
            reader.onloadend = async () => {
                const base64Image = reader.result;
                
                // Update profile image in Firestore
                await updateProfileImage(base64Image);
                setUploadingImage(false);
            };
            reader.readAsDataURL(file);
        } catch (error) {
            console.error('Error uploading image:', error);
            showNotification('Failed to upload image', 'error');
            setUploadingImage(false);
        }
    };

    // Update profile image
    const updateProfileImage = async (imageUrl) => {
        try {
            const updateData = {
                profileImageUrl: imageUrl,
                updatedAt: serverTimestamp()
            };

            // Update in the appropriate collection
            if (teacherDocId) {
                // Check if teacher exists in teachers collection
                const teacherDoc = await getDoc(doc(db, 'teachers', teacherDocId));
                if (teacherDoc.exists()) {
                    await updateDoc(doc(db, 'teachers', teacherDocId), updateData);
                } else {
                    // Update in users collection
                    await updateDoc(doc(db, 'users', teacherDocId), updateData);
                }
            }

            // Update local state
            setProfileImage(imageUrl);
            setTeacherData(prev => ({ ...prev, profileImageUrl: imageUrl }));
            
            showNotification('Profile image updated successfully!', 'success');

        } catch (error) {
            console.error('Error updating profile image:', error);
            throw error;
        }
    };

    // Save profile
    const saveProfile = async (e) => {
        e.preventDefault();
        
        // Validate required fields
        if (!formData.firstName || !formData.lastName) {
            showNotification('Please fill in all required fields', 'warning');
            return;
        }
        
        setSaving(true);
        
        try {
            const data = {
                firstName: formData.firstName,
                lastName: formData.lastName,
                email: formData.email,
                phone: formData.phone || '',
                qualification: formData.qualification || '',
                subjects: formData.subjects || '',
                experience: parseInt(formData.experience) || 0,
                bio: formData.bio || '',
                status: formData.status || 'active',
                updatedAt: serverTimestamp()
            };

            // Save to Firestore
            let collectionName = 'teachers';
            let docId = teacherDocId;

            // Check if document exists
            const docCheck = await getDoc(doc(db, 'teachers', docId));
            if (!docCheck.exists()) {
                collectionName = 'users';
            }

            await updateDoc(doc(db, collectionName, docId), data);

            // Also update users collection if it exists
            await updateDoc(doc(db, 'users', currentUser.uid), {
                fullName: `${data.firstName} ${data.lastName}`,
                firstName: data.firstName,
                lastName: data.lastName,
                email: data.email,
                phone: data.phone,
                updatedAt: serverTimestamp()
            });

            // Update local state
            setTeacherData(prev => ({ 
                ...prev, 
                ...data,
                teacherId: prev.teacherId || prev.id?.slice(0, 8) || 'N/A'
            }));
            
            showNotification('Profile saved successfully!', 'success');

        } catch (error) {
            console.error('Error saving profile:', error);
            showNotification('Failed to save profile: ' + error.message, 'error');
        } finally {
            setSaving(false);
        }
    };

    // Cancel changes
    const handleCancel = () => {
        // Reset form to current teacher data
        setFormData({
            firstName: teacherData.firstName || '',
            lastName: teacherData.lastName || '',
            email: teacherData.email || '',
            phone: teacherData.phone || '',
            qualification: teacherData.qualification || '',
            subjects: teacherData.subjects || '',
            experience: teacherData.experience || '',
            bio: teacherData.bio || '',
            status: teacherData.status || 'active',
            role: 'teacher'
        });
        setProfileImage(teacherData.profileImageUrl || '');
        showNotification('Changes discarded', 'info');
    };

    // Show notification
    const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading profile data..." />;
    }

    return (
        <Layout title="My Profile">
            {/* Profile Card */}
            <div className="profile-card" style={{
                background: 'white',
                borderRadius: '16px',
                padding: '30px',
                boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                marginBottom: '30px',
                maxWidth: '900px',
                margin: '0 auto'
            }}>
                {/* Profile Header */}
                <div className="profile-header" style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '30px',
                    marginBottom: '30px',
                    paddingBottom: '20px',
                    borderBottom: '1px solid #e0e6ed'
                }}>
                    <div className="profile-avatar" style={{
                        width: '120px',
                        height: '120px',
                        borderRadius: '50%',
                        overflow: 'hidden',
                        background: '#f8f9fa',
                        position: 'relative',
                        flexShrink: '0',
                        border: '3px solid #1a237e'
                    }}>
                        <img 
                            src={profileImage || `https://ui-avatars.com/api/?name=${encodeURIComponent(formData.firstName || 'Teacher')}&background=1a237e&color=fff&size=120`} 
                            alt="Profile" 
                            style={{
                                width: '100%',
                                height: '100%',
                                objectFit: 'cover'
                            }}
                        />
                        <input 
                            type="file"
                            ref={fileInputRef}
                            onChange={handleImageUpload}
                            accept="image/jpeg,image/png,image/gif,image/webp"
                            style={{ display: 'none' }}
                        />
                        <div 
                            className="upload-overlay"
                            style={{
                                position: 'absolute',
                                bottom: 0,
                                left: 0,
                                right: 0,
                                background: 'rgba(0,0,0,0.6)',
                                padding: '8px',
                                textAlign: 'center',
                                color: 'white',
                                fontSize: '12px',
                                cursor: 'pointer',
                                transition: 'all 0.3s',
                                opacity: 0
                            }}
                            onClick={() => fileInputRef.current?.click()}
                            onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                            onMouseLeave={(e) => e.currentTarget.style.opacity = '0'}
                        >
                            <i className="fas fa-camera" style={{
                                fontSize: '16px',
                                display: 'block',
                                marginBottom: '2px'
                            }}></i>
                            <span>Change Photo</span>
                        </div>
                        {uploadingImage && (
                            <div style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                right: 0,
                                bottom: 0,
                                background: 'rgba(0,0,0,0.5)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'white',
                                fontSize: '14px'
                            }}>
                                <i className="fas fa-spinner fa-spin" style={{marginRight: '8px'}}></i>
                                Uploading...
                            </div>
                        )}
                    </div>
                    <div className="profile-info">
                        <h2 style={{
                            fontSize: '24px',
                            color: '#2c3e50',
                            marginBottom: '5px'
                        }}>
                            {formData.firstName} {formData.lastName}
                        </h2>
                        <div className="teacher-id" style={{
                            fontSize: '14px',
                            color: '#95a5a6'
                        }}>
                            Teacher ID: {teacherData.teacherId || 'N/A'}
                        </div>
                        <div className="teacher-email" style={{
                            fontSize: '14px',
                            color: '#95a5a6'
                        }}>
                            {formData.email}
                        </div>
                        <span className={`status-badge ${formData.status}`} style={{
                            display: 'inline-block',
                            padding: '4px 16px',
                            borderRadius: '20px',
                            fontSize: '13px',
                            fontWeight: '600',
                            marginTop: '8px',
                            background: formData.status === 'active' ? '#d4edda' : 
                                      formData.status === 'inactive' ? '#f8d7da' : '#fff3cd',
                            color: formData.status === 'active' ? '#155724' : 
                                   formData.status === 'inactive' ? '#721c24' : '#856404'
                        }}>
                            {formData.status.charAt(0).toUpperCase() + formData.status.slice(1)}
                        </span>
                    </div>
                </div>

                {/* Profile Form */}
                <form onSubmit={saveProfile}>
                    <div className="form-section" style={{marginTop: '20px'}}>
                        <h3 style={{
                            fontSize: '18px',
                            color: '#2c3e50',
                            marginBottom: '20px',
                            paddingBottom: '10px',
                            borderBottom: '2px solid #e0e6ed'
                        }}>Personal Information</h3>
                        <div className="form-row" style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: '20px'
                        }}>
                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label htmlFor="firstName" style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>
                                    First Name <span style={{color: '#e74c3c'}}>*</span>
                                </label>
                                <input 
                                    type="text" 
                                    id="firstName" 
                                    value={formData.firstName}
                                    onChange={handleFormChange}
                                    required
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s',
                                        background: 'white'
                                    }}
                                />
                            </div>
                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label htmlFor="lastName" style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>
                                    Last Name <span style={{color: '#e74c3c'}}>*</span>
                                </label>
                                <input 
                                    type="text" 
                                    id="lastName" 
                                    value={formData.lastName}
                                    onChange={handleFormChange}
                                    required
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s',
                                        background: 'white'
                                    }}
                                />
                            </div>
                        </div>
                        <div className="form-group" style={{marginBottom: '20px'}}>
                            <label htmlFor="email" style={{
                                display: 'block',
                                fontSize: '14px',
                                fontWeight: '600',
                                color: '#2c3e50',
                                marginBottom: '5px'
                            }}>
                                Email Address <span style={{color: '#e74c3c'}}>*</span>
                            </label>
                            <input 
                                type="email" 
                                id="email" 
                                value={formData.email}
                                onChange={handleFormChange}
                                required
                                style={{
                                    width: '100%',
                                    padding: '10px 15px',
                                    border: '2px solid #e0e6ed',
                                    borderRadius: '8px',
                                    fontSize: '14px',
                                    transition: 'all 0.3s',
                                    background: 'white'
                                }}
                            />
                            <div className="help-text" style={{
                                fontSize: '12px',
                                color: '#95a5a6',
                                marginTop: '5px'
                            }}>This email is used for login and notifications</div>
                        </div>
                        <div className="form-group" style={{marginBottom: '20px'}}>
                            <label htmlFor="phone" style={{
                                display: 'block',
                                fontSize: '14px',
                                fontWeight: '600',
                                color: '#2c3e50',
                                marginBottom: '5px'
                            }}>Phone Number</label>
                            <input 
                                type="tel" 
                                id="phone" 
                                value={formData.phone}
                                onChange={handleFormChange}
                                placeholder="Enter phone number"
                                style={{
                                    width: '100%',
                                    padding: '10px 15px',
                                    border: '2px solid #e0e6ed',
                                    borderRadius: '8px',
                                    fontSize: '14px',
                                    transition: 'all 0.3s',
                                    background: 'white'
                                }}
                            />
                        </div>
                    </div>

                    <div className="form-section" style={{marginTop: '20px'}}>
                        <h3 style={{
                            fontSize: '18px',
                            color: '#2c3e50',
                            marginBottom: '20px',
                            paddingBottom: '10px',
                            borderBottom: '2px solid #e0e6ed'
                        }}>Professional Information</h3>
                        <div className="form-group" style={{marginBottom: '20px'}}>
                            <label htmlFor="qualification" style={{
                                display: 'block',
                                fontSize: '14px',
                                fontWeight: '600',
                                color: '#2c3e50',
                                marginBottom: '5px'
                            }}>Qualifications</label>
                            <textarea 
                                id="qualification" 
                                rows="3" 
                                value={formData.qualification}
                                onChange={handleFormChange}
                                placeholder="List your qualifications (e.g., B.Ed, M.Sc, Teaching Certificate)"
                                style={{
                                    width: '100%',
                                    padding: '10px 15px',
                                    border: '2px solid #e0e6ed',
                                    borderRadius: '8px',
                                    fontSize: '14px',
                                    transition: 'all 0.3s',
                                    background: 'white',
                                    resize: 'vertical'
                                }}
                            />
                        </div>
                        <div className="form-row" style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: '20px'
                        }}>
                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label htmlFor="subjects" style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>Subjects Taught</label>
                                <input 
                                    type="text" 
                                    id="subjects" 
                                    value={formData.subjects}
                                    onChange={handleFormChange}
                                    placeholder="e.g., Mathematics, English, Science"
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s',
                                        background: 'white'
                                    }}
                                />
                                <div className="help-text" style={{
                                    fontSize: '12px',
                                    color: '#95a5a6',
                                    marginTop: '5px'
                                }}>Separate multiple subjects with commas</div>
                            </div>
                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label htmlFor="experience" style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>Years of Experience</label>
                                <input 
                                    type="number" 
                                    id="experience" 
                                    value={formData.experience}
                                    onChange={handleFormChange}
                                    placeholder="Years"
                                    min="0"
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s',
                                        background: 'white'
                                    }}
                                />
                            </div>
                        </div>
                        <div className="form-group" style={{marginBottom: '20px'}}>
                            <label htmlFor="bio" style={{
                                display: 'block',
                                fontSize: '14px',
                                fontWeight: '600',
                                color: '#2c3e50',
                                marginBottom: '5px'
                            }}>Short Bio</label>
                            <textarea 
                                id="bio" 
                                rows="3" 
                                value={formData.bio}
                                onChange={handleFormChange}
                                placeholder="Write a short biography about yourself..."
                                style={{
                                    width: '100%',
                                    padding: '10px 15px',
                                    border: '2px solid #e0e6ed',
                                    borderRadius: '8px',
                                    fontSize: '14px',
                                    transition: 'all 0.3s',
                                    background: 'white',
                                    resize: 'vertical'
                                }}
                            />
                        </div>
                    </div>

                    <div className="form-section" style={{marginTop: '20px'}}>
                        <h3 style={{
                            fontSize: '18px',
                            color: '#2c3e50',
                            marginBottom: '20px',
                            paddingBottom: '10px',
                            borderBottom: '2px solid #e0e6ed'
                        }}>Account Settings</h3>
                        <div className="form-row" style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: '20px'
                        }}>
                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label htmlFor="status" style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>Account Status</label>
                                <select 
                                    id="status" 
                                    value={formData.status}
                                    onChange={handleFormChange}
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s',
                                        background: 'white'
                                    }}
                                >
                                    <option value="active">Active</option>
                                    <option value="inactive">Inactive</option>
                                    <option value="pending">Pending</option>
                                </select>
                            </div>
                            <div className="form-group" style={{marginBottom: '20px'}}>
                                <label htmlFor="role" style={{
                                    display: 'block',
                                    fontSize: '14px',
                                    fontWeight: '600',
                                    color: '#2c3e50',
                                    marginBottom: '5px'
                                }}>Role</label>
                                <select 
                                    id="role" 
                                    value={formData.role}
                                    disabled
                                    style={{
                                        width: '100%',
                                        padding: '10px 15px',
                                        border: '2px solid #e0e6ed',
                                        borderRadius: '8px',
                                        fontSize: '14px',
                                        transition: 'all 0.3s',
                                        background: '#f8f9fa',
                                        cursor: 'not-allowed'
                                    }}
                                >
                                    <option value="teacher">Teacher</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <div className="form-actions" style={{
                        display: 'flex',
                        gap: '10px',
                        marginTop: '25px',
                        paddingTop: '20px',
                        borderTop: '1px solid #e0e6ed'
                    }}>
                        <button 
                            type="submit" 
                            className="btn btn-primary"
                            style={{
                                padding: '10px 20px',
                                border: 'none',
                                borderRadius: '8px',
                                fontWeight: '600',
                                cursor: 'pointer',
                                transition: 'all 0.3s',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '8px',
                                fontSize: '14px',
                                background: '#1a237e',
                                color: 'white'
                            }}
                            disabled={saving}
                        >
                            <i className="fas fa-save"></i> {saving ? 'Saving...' : 'Save Changes'}
                        </button>
                        <button 
                            type="button" 
                            className="btn btn-outline"
                            style={{
                                padding: '10px 20px',
                                border: '2px solid #e0e6ed',
                                borderRadius: '8px',
                                fontWeight: '600',
                                cursor: 'pointer',
                                transition: 'all 0.3s',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '8px',
                                fontSize: '14px',
                                background: 'transparent',
                                color: '#2c3e50'
                            }}
                            onClick={handleCancel}
                        >
                            <i className="fas fa-times"></i> Cancel
                        </button>
                    </div>
                </form>
            </div>

            {/* Add animation styles */}
            <style>{`
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
                .profile-card {
                    transition: all 0.3s;
                }
                .profile-card:hover {
                    box-shadow: 0 15px 35px rgba(0,0,0,0.12);
                }
                .profile-avatar .upload-overlay {
                    opacity: 0;
                    transition: opacity 0.3s;
                }
                .profile-avatar:hover .upload-overlay {
                    opacity: 1;
                }
                .btn-primary:hover {
                    background: #0d1445 !important;
                    transform: translateY(-2px);
                    box-shadow: 0 10px 25px rgba(0,0,0,0.1);
                }
                .btn-outline:hover {
                    border-color: #1a237e;
                    color: #1a237e;
                }
                input:focus, select:focus, textarea:focus {
                    outline: none;
                    border-color: #1a237e !important;
                }
                @media (max-width: 768px) {
                    .profile-header {
                        flex-direction: column;
                        text-align: center;
                        gap: 15px;
                    }
                    .form-row {
                        grid-template-columns: 1fr !important;
                    }
                    .form-actions {
                        flex-direction: column;
                    }
                    .form-actions .btn {
                        width: 100%;
                        justify-content: center;
                    }
                }
                @media (max-width: 480px) {
                    .profile-avatar {
                        width: 100px !important;
                        height: 100px !important;
                    }
                }
            `}</style>
        </Layout>
    );
}
