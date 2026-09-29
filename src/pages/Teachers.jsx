// src/pages/Teachers.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { useSync } from '../context/SyncContext';
import { db, auth } from '../firebase';
import { 
  collection, query, where, getDocs, onSnapshot, doc, getDoc, 
  updateDoc, deleteDoc, addDoc, setDoc, orderBy 
} from 'firebase/firestore';
import { 
  sendPasswordResetEmail,
  deleteUser 
} from 'firebase/auth';
import { AuditLogService } from '../services/auditService';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { LEVEL_SUBJECTS, LEVEL_CLASSES, LEVEL_DISPLAY_NAMES } from '../utils/constants';

export default function Teachers() {
  const navigate = useNavigate();
  const { currentUser, userData, userRole } = useAuth();
  const { getLevelClasses } = useSchool();
  const { 
    isOnline, 
    isSyncing, 
    saveToIndexedDB,
    getFromIndexedDB,
    addToSyncQueue,
    processSyncQueue
  } = useSync();
  
  // State
  const [teachers, setTeachers] = useState([]);
  const [filteredTeachers, setFilteredTeachers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(10);
  const [schoolId, setSchoolId] = useState(null);
  const [usingCachedData, setUsingCachedData] = useState(false);
  
  // Filter state
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  
  // Modal states
  const [showTeacherModal, setShowTeacherModal] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState(null);
  
  // Form state
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    level: '',
    subjects: [],
    classes: [],
    status: 'active',
    phone: '',
    qualification: '',
    address: ''
  });
  
  // Stats
  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    invited: 0,
    subjects: 0
  });
  
  // Spinner state
  const [spinnerVisible, setSpinnerVisible] = useState(false);
  const [spinnerText, setSpinnerText] = useState('Processing...');
  
  // Refs
  const unsubscribeRef = useRef(null);
  
  // Load school data on mount
  useEffect(() => {
    if (currentUser && userData) {
      loadSchoolId();
    }
    
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, [currentUser, userData, isOnline]);
  
  const loadSchoolId = async () => {
    try {
      const sid = userData?.schoolId || 'default_school';
      setSchoolId(sid);
      loadTeachersOffline(sid);
    } catch (error) {
      console.error('Error loading school ID:', error);
      setSchoolId('default_school');
    }
  };
  
  // Load teachers with offline support
  const loadTeachersOffline = async (sid) => {
    setLoading(true);
    try {
      // Try to load from cache first
      const cachedTeachers = await getFromIndexedDB('teachers');
      if (cachedTeachers && cachedTeachers.length > 0) {
        const filtered = cachedTeachers.filter(t => t.schoolId === sid);
        if (filtered.length > 0) {
          setTeachers(filtered);
          setUsingCachedData(true);
          updateStats(filtered);
          applyFilters(filtered);
          setLoading(false);
        }
      }

      // If online, set up realtime listener
      if (isOnline) {
        const q = query(
          collection(db, 'teachers'),
          where('schoolId', '==', sid),
          orderBy('createdAt', 'desc')
        );
        
        unsubscribeRef.current = onSnapshot(q, async (snapshot) => {
          const teacherList = [];
          snapshot.forEach(doc => {
            teacherList.push({ id: doc.id, ...doc.data() });
          });
          setTeachers(teacherList);
          setUsingCachedData(false);
          updateStats(teacherList);
          applyFilters(teacherList);
          setLoading(false);
          // Cache the data
          await saveToIndexedDB('teachers', teacherList);
        }, (error) => {
          console.error('Realtime listener error:', error);
          setLoading(false);
        });
      } else {
        setLoading(false);
      }
      
    } catch (error) {
      console.error('Error loading teachers:', error);
      showNotification('Failed to load teachers', 'error');
      setLoading(false);
    }
  };
  
  // Update stats
  const updateStats = (teacherList = teachers) => {
    const total = teacherList.length;
    const active = teacherList.filter(t => t.status === 'active').length;
    const invited = teacherList.filter(t => t.status === 'invited').length;
    
    // Count unique subjects
    const subjects = new Set();
    teacherList.forEach(t => {
      if (t.subjects && Array.isArray(t.subjects)) {
        t.subjects.forEach(s => subjects.add(s));
      } else if (t.subjects && typeof t.subjects === 'string') {
        t.subjects.split(',').forEach(s => subjects.add(s.trim()));
      }
    });
    
    setStats({ total, active, invited, subjects: subjects.size });
  };
  
  // Apply filters
  const applyFilters = (teacherList = teachers) => {
    const term = searchTerm.toLowerCase();
    const status = statusFilter;
    const subject = subjectFilter;
    
    const filtered = teacherList.filter(t => {
      const matchSearch = (t.firstName || '').toLowerCase().includes(term) ||
                         (t.lastName || '').toLowerCase().includes(term) ||
                         (t.email || '').toLowerCase().includes(term) ||
                         (t.subjects || '').toString().toLowerCase().includes(term);
      const matchStatus = !status || t.status === status;
      const matchSubject = !subject || (t.subjects || []).includes(subject) || 
                          (t.subjects || '').toString().toLowerCase().includes(subject.toLowerCase());
      return matchSearch && matchStatus && matchSubject;
    });
    
    setFilteredTeachers(filtered);
    setCurrentPage(1);
  };
  
  // Get unique subjects for filter
  const getUniqueSubjects = () => {
    const subjects = new Set();
    teachers.forEach(t => {
      if (t.subjects) {
        if (Array.isArray(t.subjects)) {
          t.subjects.forEach(s => subjects.add(s));
        } else if (typeof t.subjects === 'string') {
          t.subjects.split(',').forEach(s => subjects.add(s.trim()));
        }
      }
    });
    return [...subjects].sort();
  };
  
  // Get available classes for a level
  const getAvailableClasses = (level) => {
    return getLevelClasses ? getLevelClasses(level) : (LEVEL_CLASSES[level] || []);
  };
  
  // Get available subjects for a level
  const getAvailableSubjects = (level) => {
    return LEVEL_SUBJECTS[level] || [];
  };
  
  // Generate temporary password
  const generateTempPassword = () => {
    const length = 12;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
    let password = '';
    for (let i = 0; i < length; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  };

  // Create teacher account using Firebase Auth REST API
  const createTeacherAccountViaAPI = async (email, fullName, schoolId) => {
    try {
      const API_KEY = process.env.REACT_APP_FIREBASE_API_KEY;
      const tempPassword = generateTempPassword();
      
      // Create user via REST API - this doesn't affect the current session
      const createResponse = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email,
            password: tempPassword,
            displayName: fullName,
            returnSecureToken: false
          })
        }
      );
      
      const createData = await createResponse.json();
      
      if (!createResponse.ok) {
        // Check if user already exists
        if (createData.error?.message === 'EMAIL_EXISTS') {
          // Try to get existing user info
          const existingTeacher = await getDocs(
            query(collection(db, 'teachers'), where('email', '==', email), where('schoolId', '==', schoolId))
          );
          
          if (!existingTeacher.empty) {
            // Send password reset for existing user
            await sendPasswordResetEmail(auth, email, {
              url: window.location.origin + '/login',
              handleCodeInApp: true
            });
            
            return {
              success: true,
              uid: existingTeacher.docs[0].data().uid || null,
              email: email,
              existing: true
            };
          }
          
          // If teacher doesn't exist in Firestore but exists in Auth, we need to handle it
          // Send password reset anyway
          await sendPasswordResetEmail(auth, email, {
            url: window.location.origin + '/login',
            handleCodeInApp: true
          });
          
          return {
            success: true,
            email: email,
            existing: true,
            uid: null
          };
        }
        
        throw new Error(createData.error?.message || 'Failed to create account');
      }
      
      const uid = createData.localId;
      
      // Store user role in Firestore
      await setDoc(doc(db, 'user_roles', uid), {
        uid: uid,
        email: email,
        role: 'teacher',
        schoolId: schoolId,
        createdAt: new Date().toISOString()
      });
      
      // Send password reset email to set password
      await sendPasswordResetEmail(auth, email, {
        url: window.location.origin + '/login',
        handleCodeInApp: true
      });
      
      return {
        success: true,
        uid: uid,
        email: email
      };
      
    } catch (error) {
      console.error('Error creating teacher account via API:', error);
      
      // If it's an email exists error from our handling
      if (error.message?.includes('EMAIL_EXISTS')) {
        return {
          success: true,
          email: email,
          existing: true
        };
      }
      
      return {
        success: false,
        error: error.message || 'Unknown error occurred',
        code: error.code || 'unknown'
      };
    }
  };
  
  // Create teacher account (legacy - kept for compatibility but now uses API)
  const createTeacherAccount = async (email, fullName) => {
    return createTeacherAccountViaAPI(email, fullName, schoolId);
  };
  
  // Resend invitation
  const handleResendInvitation = async (teacher) => {
    if (!teacher.uid) {
      // Try to find the user in Firestore first
      try {
        const userQuery = await getDocs(
          query(collection(db, 'user_roles'), where('email', '==', teacher.email))
        );
        
        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          await sendPasswordResetEmail(auth, teacher.email, {
            url: window.location.origin + '/login',
            handleCodeInApp: true
          });
          
          await updateDoc(doc(db, 'teachers', teacher.id), {
            invitedAt: new Date().toISOString(),
            status: 'invited',
            uid: userDoc.id
          });
          
          showNotification(`Invitation resent to ${teacher.email}`, 'success');
          return;
        }
      } catch (err) {
        console.error('Error finding user:', err);
      }
      
      showNotification('No account found for this teacher. Please recreate the account.', 'error');
      return;
    }
    
    try {
      await sendPasswordResetEmail(auth, teacher.email, {
        url: window.location.origin + '/login',
        handleCodeInApp: true
      });
      
      await updateDoc(doc(db, 'teachers', teacher.id), {
        invitedAt: new Date().toISOString(),
        status: 'invited'
      });
      
      showNotification(`Invitation resent to ${teacher.email}`, 'success');
      
    } catch (error) {
      console.error('Error resending invitation:', error);
      
      if (error.code === 'auth/user-not-found') {
        if (window.confirm('The teacher account no longer exists. Would you like to recreate it and send a new invitation?')) {
          await handleRecreateTeacher(teacher);
        }
      } else {
        showNotification('Failed to resend invitation: ' + error.message, 'error');
      }
    }
  };
  
  // Recreate teacher account
  const handleRecreateTeacher = async (teacher) => {
    setSpinnerVisible(true);
    setSpinnerText('Recreating teacher account...');
    
    try {
      const fullName = `${teacher.firstName || ''} ${teacher.lastName || ''}`.trim();
      const result = await createTeacherAccountViaAPI(teacher.email, fullName, schoolId);
      
      if (result.success) {
        await updateDoc(doc(db, 'teachers', teacher.id), {
          uid: result.uid,
          invitedAt: new Date().toISOString(),
          status: 'invited'
        });
        
        showNotification(`Invitation sent to ${teacher.email}`, 'success');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Error recreating teacher account:', error);
      showNotification('Failed to recreate teacher account: ' + error.message, 'error');
    } finally {
      setSpinnerVisible(false);
    }
  };
  
  // Render table
  const renderTable = () => {
    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    const pageItems = filteredTeachers.slice(start, end);
    
    if (pageItems.length === 0) {
      return (
        <tr>
          <td colSpan="6">
            <div className="empty-state">
              <i className="fas fa-chalkboard-teacher"></i>
              <h3>No Teachers Found</h3>
              <p>Add your first teacher to get started.</p>
              <button className="btn btn-primary" onClick={handleAddTeacher}>
                <i className="fas fa-plus"></i> Add Teacher
              </button>
            </div>
          </td>
        </tr>
      );
    }
    
    return pageItems.map(teacher => {
      // Handle subjects display (array or string)
      let subjectsList = [];
      if (Array.isArray(teacher.subjects)) {
        subjectsList = teacher.subjects;
      } else if (typeof teacher.subjects === 'string') {
        subjectsList = teacher.subjects.split(',').map(s => s.trim());
      }
      
      // Handle classes display (array or string)
      let classesList = [];
      if (Array.isArray(teacher.classes)) {
        classesList = teacher.classes;
      } else if (typeof teacher.classes === 'string') {
        classesList = teacher.classes.split(',').map(c => c.trim());
      }
      
      return (
        <tr key={teacher.id}>
          <td>
            <div className="teacher-info">
              <div className="teacher-avatar">
                {(teacher.firstName || 'T')[0]}
              </div>
              <div>
                <div className="name">{teacher.firstName || ''} {teacher.lastName || ''}</div>
                <div className="email">{teacher.email || ''}</div>
              </div>
            </div>
          </td>
          <td>{teacher.teacherId || 'N/A'}</td>
          <td>
            <div className="subjects-list">
              {subjectsList.length > 0 ? subjectsList.map((s, i) => (
                <span key={i} className="subject-tag">{s}</span>
              )) : 'N/A'}
            </div>
          </td>
          <td>
            <div className="classes-list">
              {classesList.length > 0 ? classesList.map((c, i) => (
                <span key={i} className="class-tag">{c}</span>
              )) : 'N/A'}
            </div>
          </td>
          <td>
            <span className={`status-badge ${teacher.status || 'pending'}`}>
              {teacher.status ? teacher.status.charAt(0).toUpperCase() + teacher.status.slice(1) : 'Pending'}
            </span>
            {teacher.invitedAt && (
              <div style={{ fontSize: '10px', color: 'var(--gray)', marginTop: '2px' }}>
                Invited: {new Date(teacher.invitedAt).toLocaleDateString()}
              </div>
            )}
            {teacher.claimedAt && (
              <div style={{ fontSize: '10px', color: 'var(--success)', marginTop: '2px' }}>
                Account claimed
              </div>
            )}
          </td>
          <td>
            <div className="action-btns">
              <button className="action-btn edit" onClick={() => handleEditTeacher(teacher)}>
                <i className="fas fa-edit"></i>
              </button>
              {teacher.status === 'invited' && !teacher.claimedAt && (
                <button className="action-btn resend" onClick={() => handleResendInvitation(teacher)} title="Resend Invitation">
                  <i className="fas fa-envelope"></i>
                </button>
              )}
              <button className="action-btn delete" onClick={() => handleDeleteTeacher(teacher)}>
                <i className="fas fa-trash"></i>
              </button>
            </div>
          </td>
        </tr>
      );
    });
  };
  
  // Pagination
  const renderPagination = () => {
    const total = filteredTeachers.length;
    const totalPages = Math.ceil(total / pageSize);
    
    if (totalPages <= 1) {
      return (
        <span style={{ color: 'var(--gray)', fontSize: '14px' }}>Page 1 of 1</span>
      );
    }
    
    const buttons = [];
    
    buttons.push(
      <button key="prev" onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1}>
        <i className="fas fa-chevron-left"></i>
      </button>
    );
    
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || Math.abs(i - currentPage) <= 2) {
        buttons.push(
          <button key={i} className={i === currentPage ? 'active' : ''} onClick={() => setCurrentPage(i)}>
            {i}
          </button>
        );
      } else if (i === currentPage - 3 || i === currentPage + 3) {
        buttons.push(
          <span key={`dots-${i}`} style={{ padding: '0 10px', color: 'var(--gray)' }}>...</span>
        );
      }
    }
    
    buttons.push(
      <button key="next" onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages}>
        <i className="fas fa-chevron-right"></i>
      </button>
    );
    
    return buttons;
  };
  
  // Handlers
  const handleAddTeacher = () => {
    setEditingTeacher(null);
    setFormData({
      firstName: '',
      lastName: '',
      email: '',
      level: '',
      subjects: [],
      classes: [],
      status: 'active',
      phone: '',
      qualification: '',
      address: ''
    });
    setShowTeacherModal(true);
  };
  
  const handleEditTeacher = (teacher) => {
    // Handle subjects - convert string to array if needed
    let subjects = teacher.subjects || [];
    if (typeof subjects === 'string') {
      subjects = subjects.split(',').map(s => s.trim()).filter(s => s);
    }
    
    // Handle classes - convert string to array if needed
    let classes = teacher.classes || [];
    if (typeof classes === 'string') {
      classes = classes.split(',').map(c => c.trim()).filter(c => c);
    }
    
    setEditingTeacher(teacher);
    setFormData({
      firstName: teacher.firstName || '',
      lastName: teacher.lastName || '',
      email: teacher.email || '',
      level: teacher.level || '',
      subjects: subjects,
      classes: classes,
      status: teacher.status || 'active',
      phone: teacher.phone || '',
      qualification: teacher.qualification || '',
      address: teacher.address || ''
    });
    setShowTeacherModal(true);
  };
  
  const handleDeleteTeacher = async (teacher) => {
    if (!window.confirm(`Delete ${teacher.firstName || 'this'} teacher?`)) return;
    
    setSpinnerVisible(true);
    setSpinnerText('Deleting teacher account...');
    
    try {
      if (isOnline) {
        await deleteDoc(doc(db, 'teachers', teacher.id));
        
        if (teacher.uid) {
          try {
            await deleteDoc(doc(db, 'user_roles', teacher.uid));
          } catch (roleError) {
            console.warn('Could not delete user_roles:', roleError);
          }
        }
        showNotification('Teacher deleted successfully', 'success');
      } else {
        // Offline - add to sync queue
        await addToSyncQueue('teachers', 'delete', { id: teacher.id });
        // Remove from local state
        const updatedTeachers = teachers.filter(t => t.id !== teacher.id);
        setTeachers(updatedTeachers);
        updateStats(updatedTeachers);
        applyFilters(updatedTeachers);
        await saveToIndexedDB('teachers', updatedTeachers);
        showNotification('Teacher deleted offline - will sync when online', 'info');
      }
    } catch (error) {
      console.error('Delete error:', error);
      showNotification('Failed to delete teacher: ' + error.message, 'error');
    } finally {
      setSpinnerVisible(false);
    }
  };
  
  const handleFormSubmit = async (e) => {
    e.preventDefault();
    
    const email = formData.email.trim();
    const fullName = `${formData.firstName.trim()} ${formData.lastName.trim()}`;
    
    const data = {
      firstName: formData.firstName.trim(),
      lastName: formData.lastName.trim(),
      email: email,
      level: formData.level,
      subjects: formData.subjects,
      classes: formData.classes,
      status: formData.status,
      phone: formData.phone.trim(),
      qualification: formData.qualification.trim(),
      address: formData.address.trim(),
      schoolId: schoolId,
      updatedAt: new Date().toISOString()
    };
    
    try {
      if (editingTeacher) {
        // Update existing teacher
        const teacher = teachers.find(t => t.id === editingTeacher.id);
        
        if (isOnline) {
          if (teacher && teacher.email !== email && teacher.uid) {
            await sendPasswordResetEmail(auth, email, {
              url: window.location.origin + '/login',
              handleCodeInApp: true
            });
            showNotification(`Invitation sent to new email: ${email}`, 'success');
          }
          
          await updateDoc(doc(db, 'teachers', editingTeacher.id), data);
          if (editingTeacher.uid) {
            await updateDoc(doc(db, 'user_roles', editingTeacher.uid), { assignedClasses: data.classes });
          }
          await AuditLogService.logAction(
            schoolId,
            { uid: currentUser?.uid, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
            'TEACHER_UPDATED',
            { entityId: editingTeacher.id, email: data.email }
          );
          showNotification('Teacher updated successfully', 'success');
        } else {
          // Offline - add to sync queue
          await addToSyncQueue('teachers', 'update', { id: editingTeacher.id, ...data });
          // Update local state
          const updatedTeachers = teachers.map(t => 
            t.id === editingTeacher.id ? { ...t, ...data } : t
          );
          setTeachers(updatedTeachers);
          updateStats(updatedTeachers);
          applyFilters(updatedTeachers);
          await saveToIndexedDB('teachers', updatedTeachers);
          showNotification('Teacher updated offline - will sync when online', 'info');
        }
      } else {
        // Create new teacher with account
        setSpinnerVisible(true);
        setSpinnerText('Creating teacher account and sending invitation...');
        
        if (isOnline) {
          // Use the REST API to create teacher account (doesn't affect admin session)
          const result = await createTeacherAccountViaAPI(email, fullName, schoolId);
          
          if (!result.success) {
            throw new Error(result.error);
          }
          
          data.uid = result.uid;
          data.teacherId = `TCH${Date.now().toString().slice(-6)}`;
          data.invitedAt = new Date().toISOString();
          data.status = formData.status || 'invited';
          data.createdAt = new Date().toISOString();
          
          const docRef = await addDoc(collection(db, 'teachers'), data);
          await AuditLogService.logAction(
            schoolId,
            { uid: currentUser?.uid, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
            'TEACHER_CREATED',
            { entityId: docRef.id, email: data.email }
          );
          
          if (result.existing) {
            showNotification(`Invitation resent to ${email}`, 'success');
          } else {
            showNotification(`Teacher invited! An email has been sent to ${email} to set their password.`, 'success');
          }
        } else {
          // Offline - add to sync queue
          const tempId = `temp_${Date.now()}`;
          data.id = tempId;
          data.teacherId = `TCH${Date.now().toString().slice(-6)}`;
          data.invitedAt = new Date().toISOString();
          data.status = formData.status || 'invited';
          data.createdAt = new Date().toISOString();
          
          await addToSyncQueue('teachers', 'add', data);
          // Add to local state
          const updatedTeachers = [data, ...teachers];
          setTeachers(updatedTeachers);
          updateStats(updatedTeachers);
          applyFilters(updatedTeachers);
          await saveToIndexedDB('teachers', updatedTeachers);
          showNotification('Teacher added offline - will sync when online', 'info');
        }
      }
      
      setShowTeacherModal(false);
      setFormData({
        firstName: '',
        lastName: '',
        email: '',
        level: '',
        subjects: [],
        classes: [],
        status: 'active',
        phone: '',
        qualification: '',
        address: ''
      });
      
    } catch (error) {
      console.error('Save error:', error);
      showNotification('Failed to save teacher: ' + error.message, 'error');
    } finally {
      setSpinnerVisible(false);
    }
  };
  
  const handleExportCSV = () => {
    const data = filteredTeachers.length ? filteredTeachers : teachers;
    const headers = ['ID', 'First Name', 'Last Name', 'Email', 'Level', 'Subjects', 'Classes', 'Status', 'Phone', 'Qualification', 'UID'];
    const rows = data.map(t => [
      t.teacherId || '',
      t.firstName || '',
      t.lastName || '',
      t.email || '',
      t.level || '',
      Array.isArray(t.subjects) ? t.subjects.join(', ') : t.subjects || '',
      Array.isArray(t.classes) ? t.classes.join(', ') : t.classes || '',
      t.status || '',
      t.phone || '',
      t.qualification || '',
      t.uid || ''
    ]);
    
    const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `teachers_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    showNotification('Teachers exported successfully', 'success');
  };
  
  const handleClearFilters = () => {
    setSearchTerm('');
    setStatusFilter('');
    setSubjectFilter('');
    applyFilters(teachers);
  };
  
  // Show notification
  const showNotification = (message, type = 'info') => {
    const colors = {
      success: '#27ae60',
      error: '#e74c3c',
      warning: '#f39c12',
      info: '#3498db'
    };
    const iconMap = {
      success: 'check-circle',
      error: 'exclamation-circle',
      warning: 'exclamation-triangle',
      info: 'info-circle'
    };
    
    const notificationEl = document.createElement('div');
    notificationEl.className = 'custom-notification';
    notificationEl.style.backgroundColor = colors[type] || colors.info;
    notificationEl.innerHTML = `
      <i class="fas fa-${iconMap[type] || 'info-circle'}"></i>
      <span>${message}</span>
    `;
    document.body.appendChild(notificationEl);
    
    setTimeout(() => {
      notificationEl.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => {
        if (notificationEl.parentNode) {
          notificationEl.parentNode.removeChild(notificationEl);
        }
      }, 300);
    }, 5000);
  };
  
  if (loading) {
    return <LoadingSpinner fullScreen text="Loading teachers..." />;
  }
  
  return (
    <Layout title="Teachers Management">
      <style>{`
        /* Stats Grid */
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
        
        /* Filters Section */
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
          box-shadow: 0 0 0 3px rgba(26, 35, 126, 0.1);
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
        
        /* Table */
        .table-container {
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
          padding: 15px 20px;
          text-align: left;
          font-size: 13px;
          font-weight: 600;
          color: var(--gray);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        td {
          padding: 15px 20px;
          border-bottom: 1px solid var(--border);
          font-size: 14px;
        }
        
        tr:hover {
          background: var(--light);
        }
        
        .teacher-avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: #0284c7;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 16px;
          flex-shrink: 0;
        }
        
        .teacher-info {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        
        .teacher-info .name {
          font-weight: 600;
          color: var(--secondary);
        }
        
        .teacher-info .email {
          font-size: 12px;
          color: var(--gray);
        }
        
        .subjects-list, .classes-list {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
        }
        
        .subject-tag {
          padding: 2px 10px;
          background: var(--light);
          border-radius: 12px;
          font-size: 12px;
          color: var(--secondary);
          border: 1px solid var(--border);
        }
        
        .class-tag {
          padding: 2px 10px;
          background: #d1ecf1;
          border-radius: 12px;
          font-size: 12px;
          color: #0c5460;
          border: 1px solid #bee5eb;
        }
        
        .status-badge {
          padding: 4px 12px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
        }
        
        .status-badge.active {
          background: #d4edda;
          color: #155724;
        }
        
        .status-badge.inactive {
          background: #f8d7da;
          color: #721c24;
        }
        
        .status-badge.pending {
          background: #fff3cd;
          color: #856404;
        }
        
        .status-badge.invited {
          background: #d1ecf1;
          color: #0c5460;
        }
        
        .action-btns {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        
        .action-btn {
          padding: 6px 12px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          transition: all 0.3s;
        }
        
        .action-btn.edit {
          background: var(--primary);
          color: white;
        }
        
        .action-btn.edit:hover {
          background: var(--primary-dark);
        }
        
        .action-btn.delete {
          background: var(--danger);
          color: white;
        }
        
        .action-btn.delete:hover {
          opacity: 0.9;
        }
        
        .action-btn.resend {
          background: var(--warning);
          color: white;
        }
        
        .action-btn.resend:hover {
          opacity: 0.9;
        }
        
        /* Pagination */
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
        
        .pagination-btns button:disabled:hover {
          border-color: var(--border);
          color: var(--secondary);
        }
        
        /* Empty State */
        .empty-state {
          text-align: center;
          padding: 60px 20px;
        }
        
        .empty-state i {
          font-size: 64px;
          color: var(--border);
          margin-bottom: 20px;
        }
        
        .empty-state h3 {
          font-size: 20px;
          color: var(--secondary);
          margin-bottom: 10px;
        }
        
        .empty-state p {
          color: var(--gray);
          max-width: 400px;
          margin: 0 auto 20px;
        }
        
        /* Modals */
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
          max-width: 650px;
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
        
        .form-group select[multiple] {
          height: 120px;
        }
        
        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 15px;
        }
        
        .modal-footer {
          display: flex;
          gap: 10px;
          justify-content: flex-end;
          margin-top: 25px;
          padding-top: 20px;
          border-top: 1px solid var(--border);
        }
        
        .help-text {
          font-size: 12px;
          color: var(--gray);
          margin-top: 5px;
        }
        
        /* Spinner Overlay */
        .spinner-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(255, 255, 255, 0.8);
          z-index: 9999;
          display: none;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          gap: 20px;
        }
        
        .spinner-overlay.active {
          display: flex;
        }
        
        .spinner {
          width: 50px;
          height: 50px;
          border: 3px solid var(--border);
          border-top-color: var(--primary);
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        
        .spinner-text {
          color: var(--secondary);
          font-weight: 500;
          font-size: 16px;
        }
        
        /* Responsive */
        @media (max-width: 768px) {
          .stats-grid {
            grid-template-columns: repeat(2, 1fr);
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
        }
        
        @media (max-width: 480px) {
          .stats-grid {
            grid-template-columns: 1fr;
          }
          
          td, th {
            padding: 10px 12px;
            font-size: 12px;
          }
        }
        
        /* Animations */
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
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
        
        @keyframes spin {
          to { transform: rotate(360deg); }
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
        
        /* Selected items in multi-select */
        .selected-items {
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          margin-top: 5px;
        }
        
        .selected-item {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 2px 10px;
          background: var(--primary);
          color: white;
          border-radius: 12px;
          font-size: 12px;
        }
        
        .selected-item .remove-btn {
          background: none;
          border: none;
          color: white;
          cursor: pointer;
          font-size: 10px;
          padding: 0 2px;
        }
        
        .selected-item .remove-btn:hover {
          opacity: 0.7;
        }
      `}</style>
      
      {/* Spinner Overlay */}
      {spinnerVisible && (
        <div className="spinner-overlay active">
          <div className="spinner"></div>
          <div className="spinner-text">{spinnerText}</div>
        </div>
      )}
      
      {/* Using cached data indicator */}
      {usingCachedData && isOnline && (
        <div style={{
          background: '#d1ecf1',
          color: '#0c5460',
          padding: '8px 16px',
          borderRadius: '8px',
          marginBottom: '20px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontSize: '13px',
          border: '1px solid #bee5eb'
        }}>
          <i className="fas fa-database"></i>
          <span>Showing cached data. Syncing in background...</span>
        </div>
      )}
      
      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Teachers</div>
          <div className="stat-value">{stats.total}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active</div>
          <div className="stat-value">{stats.active}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Invited</div>
          <div className="stat-value">{stats.invited}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Subjects</div>
          <div className="stat-value">{stats.subjects}</div>
        </div>
      </div>
      
      {/* Filters */}
      <div className="filters-section">
        <input
          type="text"
          className="search-input"
          placeholder="Search by name, email, or subject..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && applyFilters()}
        />
        
        <select
          className="filter-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="pending">Pending</option>
          <option value="invited">Invited</option>
        </select>
        
        <select
          className="filter-select"
          value={subjectFilter}
          onChange={(e) => setSubjectFilter(e.target.value)}
        >
          <option value="">All Subjects</option>
          {getUniqueSubjects().map(subject => (
            <option key={subject} value={subject}>{subject}</option>
          ))}
        </select>
        
        <button className="btn btn-primary" onClick={() => applyFilters()}>
          <i className="fas fa-filter"></i> Apply Filters
        </button>
        <button className="btn btn-outline" onClick={handleClearFilters}>
          <i className="fas fa-times"></i> Clear
        </button>
        <button className="btn btn-primary" onClick={handleAddTeacher}>
          <i className="fas fa-plus"></i> Add Teacher
        </button>
        <button className="btn btn-success" onClick={handleExportCSV}>
          <i className="fas fa-download"></i> Export
        </button>
      </div>
      
      {/* Table */}
      <div className="table-container">
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Teacher</th>
                <th>ID</th>
                <th>Subjects</th>
                <th>Classes</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {renderTable()}
            </tbody>
          </table>
        </div>
        
        <div className="pagination">
          <div className="info">
            Showing {Math.min(filteredTeachers.length, (currentPage - 1) * pageSize + 1)}-
            {Math.min(filteredTeachers.length, currentPage * pageSize)} of {filteredTeachers.length} teachers
          </div>
          <div className="pagination-btns">
            {renderPagination()}
          </div>
        </div>
      </div>
      
      {/* Add/Edit Teacher Modal */}
      {showTeacherModal && (
        <div className="modal-overlay active" id="teacherModal">
          <div className="modal">
            <div className="modal-header">
              <h2>{editingTeacher ? 'Edit Teacher' : 'Add Teacher'}</h2>
              <button className="modal-close" onClick={() => setShowTeacherModal(false)}>
                <i className="fas fa-times"></i>
              </button>
            </div>
            <form onSubmit={handleFormSubmit}>
              <input type="hidden" id="teacherId" value={editingTeacher?.id || ''} />
              <input type="hidden" id="teacherUid" value={editingTeacher?.uid || ''} />
              
              <div className="form-row">
                <div className="form-group">
                  <label>First Name <span className="required">*</span></label>
                  <input
                    type="text"
                    value={formData.firstName}
                    onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Last Name <span className="required">*</span></label>
                  <input
                    type="text"
                    value={formData.lastName}
                    onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                    required
                  />
                </div>
              </div>
              
              <div className="form-group">
                <label>Email <span className="required">*</span></label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  required
                />
                <div className="help-text">An account will be created and an invitation email will be sent.</div>
              </div>
              
              <div className="form-group">
                <label>Assigned Level</label>
                <select
                  value={formData.level}
                  onChange={(e) => setFormData({ 
                    ...formData, 
                    level: e.target.value,
                    subjects: [],
                    classes: []
                  })}
                >
                  <option value="">Select Level</option>
                  <option value="pre-primary">Pre-Primary</option>
                  <option value="lower-primary">Lower Primary</option>
                  <option value="upper-primary">Upper Primary</option>
                  <option value="junior-school">Junior School</option>
                  <option value="senior-school">Senior School</option>
                </select>
                <div className="help-text">Select the level this teacher is assigned to.</div>
              </div>
              
              <div className="form-row">
                <div className="form-group">
                  <label>Assigned Subjects</label>
                  <select
                    multiple
                    value={formData.subjects}
                    onChange={(e) => {
                      const options = e.target.options;
                      const selected = [];
                      for (let i = 0; i < options.length; i++) {
                        if (options[i].selected) {
                          selected.push(options[i].value);
                        }
                      }
                      setFormData({ ...formData, subjects: selected });
                    }}
                  >
                    {getAvailableSubjects(formData.level).map(subject => (
                      <option key={subject} value={subject}>{subject}</option>
                    ))}
                  </select>
                  <div className="help-text">Hold Ctrl/Cmd to select multiple subjects.</div>
                </div>
                <div className="form-group">
                  <label>Assigned Classes</label>
                  <select
                    multiple
                    value={formData.classes}
                    onChange={(e) => {
                      const options = e.target.options;
                      const selected = [];
                      for (let i = 0; i < options.length; i++) {
                        if (options[i].selected) {
                          selected.push(options[i].value);
                        }
                      }
                      setFormData({ ...formData, classes: selected });
                    }}
                  >
                    {getAvailableClasses(formData.level).map(cls => (
                      <option key={cls} value={cls}>{cls}</option>
                    ))}
                  </select>
                  <div className="help-text">Hold Ctrl/Cmd to select multiple classes.</div>
                </div>
              </div>
              
              <div className="form-row">
                <div className="form-group">
                  <label>Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                    required
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="pending">Pending</option>
                    <option value="invited">Invited</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Phone Number</label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  />
                </div>
              </div>
              
              <div className="form-group">
                <label>Qualification</label>
                <input
                  type="text"
                  value={formData.qualification}
                  onChange={(e) => setFormData({ ...formData, qualification: e.target.value })}
                  placeholder="e.g. B.Ed, M.Sc"
                />
              </div>
              
              <div className="form-group">
                <label>Address</label>
                <textarea
                  rows="2"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                ></textarea>
              </div>
              
              {/* Selected Subjects Display */}
              {formData.subjects.length > 0 && (
                <div className="form-group">
                  <label>Selected Subjects:</label>
                  <div className="selected-items">
                    {formData.subjects.map(subject => (
                      <span key={subject} className="selected-item">
                        {subject}
                        <button
                          type="button"
                          className="remove-btn"
                          onClick={() => {
                            setFormData({
                              ...formData,
                              subjects: formData.subjects.filter(s => s !== subject)
                            });
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              
              {/* Selected Classes Display */}
              {formData.classes.length > 0 && (
                <div className="form-group">
                  <label>Selected Classes:</label>
                  <div className="selected-items">
                    {formData.classes.map(cls => (
                      <span key={cls} className="selected-item">
                        {cls}
                        <button
                          type="button"
                          className="remove-btn"
                          onClick={() => {
                            setFormData({
                              ...formData,
                              classes: formData.classes.filter(c => c !== cls)
                            });
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="modal-footer">
                <button type="button" className="btn btn-outline" onClick={() => setShowTeacherModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingTeacher ? 'Update Teacher' : 'Save Teacher'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Layout>
  );
}
