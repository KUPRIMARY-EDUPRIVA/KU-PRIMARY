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
import { sendPasswordResetEmail } from 'firebase/auth';
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

  // Form state — `assignments` is the authoritative pairing; subjects/classes
  // are kept in sync for backward compatibility with older pages.
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    level: '',
    subjects: [],
    classes: [],
    assignments: [],
    status: 'active',
    phone: '',
    qualification: '',
    address: ''
  });

  // Add-assignment sub-form state
  const [newAssignmentSubject, setNewAssignmentSubject] = useState('');
  const [newAssignmentClasses, setNewAssignmentClasses] = useState([]);

  // Stats
  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    invited: 0,
    subjects: 0
  });

  // Spinner
  const [spinnerVisible, setSpinnerVisible] = useState(false);
  const [spinnerText, setSpinnerText] = useState('Processing...');

  const unsubscribeRef = useRef(null);

  // ---------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------
  useEffect(() => {
    if (currentUser && userData) {
      loadSchoolId();
    }
    return () => {
      if (unsubscribeRef.current) unsubscribeRef.current();
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

  const loadTeachersOffline = async (sid) => {
    setLoading(true);
    try {
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

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  // Pull a normalized list of subjects out of a teacher record.
  const teacherSubjects = (t) => {
    if (Array.isArray(t.subjects)) return t.subjects;
    if (typeof t.subjects === 'string') {
      return t.subjects.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
  };

  // Pull a normalized list of classes out of a teacher record.
  const teacherClasses = (t) => {
    if (Array.isArray(t.classes)) return t.classes;
    if (typeof t.classes === 'string') {
      return t.classes.split(',').map(c => c.trim()).filter(Boolean);
    }
    return [];
  };

  // Derive `subjects` and `classes` from the `assignments` array.
  const deriveLegacyFields = (assignments) => {
    const subjectSet = new Set();
    const classSet = new Set();
    assignments.forEach(a => {
      if (a.subject) subjectSet.add(a.subject);
      (a.classes || []).forEach(c => classSet.add(c));
    });
    return {
      subjects: [...subjectSet],
      classes: [...classSet]
    };
  };

  // Reconstruct `assignments` from a legacy teacher doc.
  const reconstructAssignments = (teacher) => {
    if (Array.isArray(teacher.assignments) && teacher.assignments.length > 0) {
      return teacher.assignments.map(a => ({
        subject: a.subject,
        classes: Array.isArray(a.classes) ? [...a.classes] : []
      }));
    }
    // Legacy: no pairings saved. Duplicate every class across every subject
    // so the admin can then trim from the UI.
    const subs = teacherSubjects(teacher);
    const clss = teacherClasses(teacher);
    if (subs.length && clss.length) {
      return subs.map(s => ({ subject: s, classes: [...clss] }));
    }
    return [];
  };

  // ---------------------------------------------------------------
  // Stats + filters
  // ---------------------------------------------------------------
  const updateStats = (teacherList = teachers) => {
    const total = teacherList.length;
    const active = teacherList.filter(t => t.status === 'active').length;
    const invited = teacherList.filter(t => t.status === 'invited').length;

    const subjects = new Set();
    teacherList.forEach(t => {
      teacherSubjects(t).forEach(s => subjects.add(s));
    });

    setStats({ total, active, invited, subjects: subjects.size });
  };

  const applyFilters = (teacherList = teachers) => {
    const term = searchTerm.toLowerCase();
    const status = statusFilter;
    const subject = subjectFilter;

    const filtered = teacherList.filter(t => {
      const subs = teacherSubjects(t);
      const matchSearch =
        (t.firstName || '').toLowerCase().includes(term) ||
        (t.lastName || '').toLowerCase().includes(term) ||
        (t.email || '').toLowerCase().includes(term) ||
        subs.join(' ').toLowerCase().includes(term);
      const matchStatus = !status || t.status === status;
      const matchSubject = !subject || subs.includes(subject);
      return matchSearch && matchStatus && matchSubject;
    });

    setFilteredTeachers(filtered);
    setCurrentPage(1);
  };

  const getUniqueSubjects = () => {
    const subjects = new Set();
    teachers.forEach(t => {
      teacherSubjects(t).forEach(s => subjects.add(s));
    });
    return [...subjects].sort();
  };

  const getAvailableClasses = (level) => {
    return getLevelClasses ? getLevelClasses(level) : (LEVEL_CLASSES[level] || []);
  };

  const getAvailableSubjects = (level) => {
    return LEVEL_SUBJECTS[level] || [];
  };

  // ---------------------------------------------------------------
  // Password — fixed default that admins share with teachers.
  // Firebase's own verification email handles onboarding; we do NOT
  // send a separate welcome email.
  // ---------------------------------------------------------------
  const DEFAULT_TEACHER_PASSWORD = '12345678';

  // ---------------------------------------------------------------
  // Account creation via Firebase Auth REST API
  //
  // Writes the teacher profile to BOTH:
  //   - user_roles/{uid}  → role-based access
  //   - users/{uid}       → AuthContext source of truth
  //
  // This is what makes Results.jsx and Students.jsx see the
  // teacher's assignments, classes, subjects and level.
  // ---------------------------------------------------------------
  const createTeacherAccountViaAPI = async (
    email,
    fullName,
    sid,
    assignments = [],
    classes = [],
    subjects = [],
    level = ''
  ) => {
    try {
      const API_KEY = process.env.REACT_APP_FIREBASE_API_KEY;
      const tempPassword = DEFAULT_TEACHER_PASSWORD;
      const nameParts = String(fullName || '').trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      const createResponse = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            password: tempPassword,
            displayName: fullName,
            returnSecureToken: false
          })
        }
      );

      const createData = await createResponse.json();

      if (!createResponse.ok) {
        if (createData.error?.message === 'EMAIL_EXISTS') {
          const existingTeacher = await getDocs(
            query(collection(db, 'teachers'), where('email', '==', email), where('schoolId', '==', sid))
          );

          if (!existingTeacher.empty) {
            return {
              success: true,
              uid: existingTeacher.docs[0].data().uid || null,
              email,
              existing: true
            };
          }

          return { success: true, email, existing: true, uid: null };
        }

        throw new Error(createData.error?.message || 'Failed to create account');
      }

      const uid = createData.localId;
      const nowIso = new Date().toISOString();

      // ---- user_roles/{uid} (role-based access) ----
      await setDoc(doc(db, 'user_roles', uid), {
        uid,
        email,
        role: 'teacher',
        schoolId: sid,
        level,
        assignments,
        assignedClasses: classes,
        assignedSubjects: subjects,
        createdAt: nowIso
      }, { merge: true });

      // ---- users/{uid} (AuthContext source of truth) ----
      // Written here so Results.jsx / Students.jsx can read
      // `userData.assignments`, `userData.classes`, etc.
      await setDoc(doc(db, 'users', uid), {
        uid,
        email,
        firstName,
        lastName,
        fullName: fullName || `${firstName} ${lastName}`.trim(),
        role: 'teacher',
        schoolId: sid,
        // Authoritative shape other pages read:
        assignments,
        // Legacy fields other pages still fall back to:
        classes,
        subjects,
        levels: level ? [level] : [],
        level,
        status: 'invited',
        createdAt: nowIso
      }, { merge: true });

      return { success: true, uid, email, tempPassword };
    } catch (error) {
      console.error('Error creating teacher account via API:', error);
      if (error.message?.includes('EMAIL_EXISTS')) {
        return { success: true, email, existing: true };
      }
      return {
        success: false,
        error: error.message || 'Unknown error occurred',
        code: error.code || 'unknown'
      };
    }
  };

  // ---------------------------------------------------------------
  // Resend invitation (uses password reset — kept for existing users)
  // ---------------------------------------------------------------
  const handleResendInvitation = async (teacher) => {
    if (!teacher.uid) {
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
        if (window.confirm('The teacher account no longer exists. Would you like to recreate it?')) {
          await handleRecreateTeacher(teacher);
        }
      } else {
        showNotification('Failed to resend invitation: ' + error.message, 'error');
      }
    }
  };

  const handleRecreateTeacher = async (teacher) => {
    setSpinnerVisible(true);
    setSpinnerText('Recreating teacher account...');

    try {
      const fullName = `${teacher.firstName || ''} ${teacher.lastName || ''}`.trim();
      const assignments = reconstructAssignments(teacher);
      const derived = deriveLegacyFields(assignments);

      const result = await createTeacherAccountViaAPI(
        teacher.email,
        fullName,
        schoolId,
        assignments,
        derived.classes,
        derived.subjects,
        teacher.level || ''
      );

      if (!result.success) throw new Error(result.error);

      await updateDoc(doc(db, 'teachers', teacher.id), {
        uid: result.uid,
        invitedAt: new Date().toISOString(),
        status: 'invited'
      });

      showNotification(`Account recreated for ${teacher.email}`, 'success');
    } catch (error) {
      console.error('Error recreating teacher account:', error);
      showNotification('Failed to recreate teacher account: ' + error.message, 'error');
    } finally {
      setSpinnerVisible(false);
    }
  };

  // ---------------------------------------------------------------
  // Assignment sub-form handlers
  // ---------------------------------------------------------------
  const handleAddAssignment = () => {
    const subject = newAssignmentSubject.trim();
    const classes = [...newAssignmentClasses].filter(Boolean);

    if (!subject) {
      showNotification('Please select a subject.', 'warning');
      return;
    }
    if (classes.length === 0) {
      showNotification('Please select at least one class.', 'warning');
      return;
    }

    setFormData(prev => {
      const existingIdx = prev.assignments.findIndex(a => a.subject === subject);
      let next;
      if (existingIdx >= 0) {
        const merged = new Set([
          ...(prev.assignments[existingIdx].classes || []),
          ...classes
        ]);
        next = prev.assignments.slice();
        next[existingIdx] = { subject, classes: [...merged] };
      } else {
        next = [...prev.assignments, { subject, classes }];
      }
      const derived = deriveLegacyFields(next);
      return { ...prev, assignments: next, ...derived };
    });

    setNewAssignmentSubject('');
    setNewAssignmentClasses([]);
  };

  const handleRemoveClassFromAssignment = (subject, cls) => {
    setFormData(prev => {
      const next = prev.assignments
        .map(a => a.subject === subject
          ? { ...a, classes: a.classes.filter(c => c !== cls) }
          : a)
        .filter(a => a.classes.length > 0);
      const derived = deriveLegacyFields(next);
      return { ...prev, assignments: next, ...derived };
    });
  };

  const handleRemoveAssignment = (subject) => {
    setFormData(prev => {
      const next = prev.assignments.filter(a => a.subject !== subject);
      const derived = deriveLegacyFields(next);
      return { ...prev, assignments: next, ...derived };
    });
  };

  // ---------------------------------------------------------------
  // Table
  // ---------------------------------------------------------------
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
      const subs = teacherSubjects(teacher);
      const clss = teacherClasses(teacher);
      const assignments = Array.isArray(teacher.assignments) ? teacher.assignments : [];

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
            {assignments.length > 0 ? (
              <div className="assignments-list">
                {assignments.map(a => (
                  <div key={a.subject} className="assignment-line">
                    <span className="subject-tag">{a.subject}</span>
                    <span className="assign-arrow">→</span>
                    <span className="classes-inline">
                      {a.classes.map(c => (
                        <span key={c} className="class-tag">{c}</span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="subjects-list">
                {subs.length > 0
                  ? subs.map((s, i) => <span key={i} className="subject-tag">{s}</span>)
                  : 'N/A'}
                <div className="classes-list" style={{ marginTop: 4 }}>
                  {clss.length > 0
                    ? clss.map((c, i) => <span key={i} className="class-tag">{c}</span>)
                    : null}
                </div>
              </div>
            )}
          </td>
          <td>
            {assignments.length > 0 ? (
              <span style={{ fontSize: 12, color: 'var(--gray)' }}>
                {assignments.length} pairing{assignments.length === 1 ? '' : 's'}
              </span>
            ) : (
              <div className="classes-list">
                {clss.length > 0
                  ? clss.map((c, i) => <span key={i} className="class-tag">{c}</span>)
                  : 'N/A'}
              </div>
            )}
          </td>
          <td>
            <span className={`status-badge ${teacher.status || 'pending'}`}>
              {teacher.status
                ? teacher.status.charAt(0).toUpperCase() + teacher.status.slice(1)
                : 'Pending'}
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

  const renderPagination = () => {
    const total = filteredTeachers.length;
    const totalPages = Math.ceil(total / pageSize);

    if (totalPages <= 1) {
      return <span style={{ color: 'var(--gray)', fontSize: '14px' }}>Page 1 of 1</span>;
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

  // ---------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------
  const handleAddTeacher = () => {
    setEditingTeacher(null);
    setFormData({
      firstName: '', lastName: '', email: '', level: '',
      subjects: [], classes: [], assignments: [],
      status: 'active', phone: '', qualification: '', address: ''
    });
    setNewAssignmentSubject('');
    setNewAssignmentClasses([]);
    setShowTeacherModal(true);
  };

  const handleEditTeacher = (teacher) => {
    const assignments = reconstructAssignments(teacher);
    const legacy = deriveLegacyFields(assignments);

    setEditingTeacher(teacher);
    setFormData({
      firstName: teacher.firstName || '',
      lastName: teacher.lastName || '',
      email: teacher.email || '',
      level: teacher.level || '',
      subjects: legacy.subjects,
      classes: legacy.classes,
      assignments,
      status: teacher.status || 'active',
      phone: teacher.phone || '',
      qualification: teacher.qualification || '',
      address: teacher.address || ''
    });
    setNewAssignmentSubject('');
    setNewAssignmentClasses([]);
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
          // Clean up the mirrored records so AuthContext / other pages
          // don't keep reading a ghost teacher.
          try {
            await deleteDoc(doc(db, 'user_roles', teacher.uid));
          } catch (roleError) {
            console.warn('Could not delete user_roles:', roleError);
          }
          try {
            await deleteDoc(doc(db, 'users', teacher.uid));
          } catch (userError) {
            console.warn('Could not delete users doc:', userError);
          }
        }
        showNotification('Teacher deleted successfully', 'success');
      } else {
        await addToSyncQueue('teachers', 'delete', { id: teacher.id });
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

    if (formData.assignments.length === 0) {
      showNotification('Please add at least one subject-class assignment.', 'warning');
      return;
    }

    const derived = deriveLegacyFields(formData.assignments);

    const data = {
      firstName: formData.firstName.trim(),
      lastName: formData.lastName.trim(),
      email,
      level: formData.level,
      assignments: formData.assignments,
      subjects: derived.subjects,
      classes: derived.classes,
      status: formData.status,
      phone: formData.phone.trim(),
      qualification: formData.qualification.trim(),
      address: formData.address.trim(),
      schoolId,
      updatedAt: new Date().toISOString()
    };

    try {
      if (editingTeacher) {
        if (isOnline) {
          const existing = teachers.find(t => t.id === editingTeacher.id);
          if (existing && existing.email !== email && existing.uid) {
            await sendPasswordResetEmail(auth, email, {
              url: window.location.origin + '/login',
              handleCodeInApp: true
            });
            showNotification(`Email-change notice sent to ${email}`, 'info');
          }

          await updateDoc(doc(db, 'teachers', editingTeacher.id), data);

          if (editingTeacher.uid) {
            // Sync to user_roles (role-based access)
            await updateDoc(doc(db, 'user_roles', editingTeacher.uid), {
              assignments: data.assignments,
              assignedClasses: data.classes,
              assignedSubjects: data.subjects,
              level: data.level
            });

            // Sync to users (AuthContext source of truth) so
            // Results.jsx / Students.jsx pick up changes immediately.
            await setDoc(doc(db, 'users', editingTeacher.uid), {
              assignments: data.assignments,
              classes: data.classes,
              subjects: data.subjects,
              levels: data.level ? [data.level] : [],
              level: data.level,
              updatedAt: new Date().toISOString()
            }, { merge: true });
          }

          await AuditLogService.logAction(
            schoolId,
            { uid: currentUser?.uid, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
            'TEACHER_UPDATED',
            { entityId: editingTeacher.id, email: data.email }
          );
          showNotification('Teacher updated successfully', 'success');
        } else {
          await addToSyncQueue('teachers', 'update', { id: editingTeacher.id, ...data });
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
        setSpinnerVisible(true);
        setSpinnerText('Creating teacher account...');

        if (isOnline) {
          // Pass assignments/classes/subjects/level into the account
          // creation so all three collections are populated at once.
          const result = await createTeacherAccountViaAPI(
            email,
            fullName,
            schoolId,
            data.assignments,
            data.classes,
            data.subjects,
            data.level
          );
          if (!result.success) throw new Error(result.error);

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
            showNotification(`Existing account found for ${email}. Profile linked.`, 'info');
          } else {
            showNotification(`Teacher added. Default password: 12345678`, 'success');
          }
        } else {
          // Offline: no account creation possible
          showNotification('Adding teachers requires an internet connection.', 'warning');
          return;
        }
      }

      setShowTeacherModal(false);
      setFormData({
        firstName: '', lastName: '', email: '', level: '',
        subjects: [], classes: [], assignments: [],
        status: 'active', phone: '', qualification: '', address: ''
      });
      setNewAssignmentSubject('');
      setNewAssignmentClasses([]);
    } catch (error) {
      console.error('Save error:', error);
      showNotification('Failed to save teacher: ' + error.message, 'error');
    } finally {
      setSpinnerVisible(false);
    }
  };

  const handleExportCSV = () => {
    const data = filteredTeachers.length ? filteredTeachers : teachers;
    const headers = ['ID', 'First Name', 'Last Name', 'Email', 'Level', 'Assignments', 'Status', 'Phone', 'Qualification', 'UID'];
    const rows = data.map(t => {
      const assignmentsStr = (t.assignments || [])
        .map(a => `${a.subject}: ${(a.classes || []).join('|')}`)
        .join('; ');
      return [
        t.teacherId || '',
        t.firstName || '',
        t.lastName || '',
        t.email || '',
        t.level || '',
        assignmentsStr,
        t.status || '',
        t.phone || '',
        t.qualification || '',
        t.uid || ''
      ];
    });

    const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `teachers_${new Date().toISOString().slice(0, 10)}.csv`;
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
    }, 5000);
  };

  if (loading) {
    return <LoadingSpinner fullScreen text="Loading teachers..." />;
  }

  return (
    <Layout title="Teachers Management">
      <style>{`
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; border-radius: 12px; padding: 20px; box-shadow: var(--shadow); }
        .stat-card .stat-label { font-size: 13px; color: var(--gray); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
        .stat-card .stat-value { font-size: 28px; font-weight: 700; color: var(--secondary); margin-top: 5px; }
        .filters-section { background: white; border-radius: 12px; padding: 20px; box-shadow: var(--shadow); margin-bottom: 25px; display: flex; flex-wrap: wrap; gap: 15px; align-items: center; }
        .search-input { flex: 1; min-width: 200px; padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; transition: all 0.3s; background: white; color: var(--secondary); }
        .search-input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(26, 35, 126, 0.1); }
        .filter-select { padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; background: white; cursor: pointer; min-width: 150px; color: var(--secondary); }
        .filter-select:focus { outline: none; border-color: var(--primary); }
        .btn { padding: 10px 20px; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.3s; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
        .btn-primary { background: var(--primary); color: white; }
        .btn-primary:hover { background: var(--primary-dark); transform: translateY(-2px); box-shadow: var(--shadow-lg); }
        .btn-outline { background: transparent; border: 2px solid var(--border); color: var(--secondary); }
        .btn-outline:hover { border-color: var(--primary); color: var(--primary); }
        .btn-success { background: var(--success); color: white; }
        .btn-success:hover { opacity: 0.9; transform: translateY(-2px); }
        .table-container { background: white; border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
        .table-wrapper { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        thead { background: var(--light); }
        th { padding: 15px 20px; text-align: left; font-size: 13px; font-weight: 600; color: var(--gray); text-transform: uppercase; letter-spacing: 0.5px; }
        td { padding: 15px 20px; border-bottom: 1px solid var(--border); font-size: 14px; vertical-align: top; }
        tr:hover { background: var(--light); }
        .teacher-avatar { width: 40px; height: 40px; border-radius: 50%; background: #0284c7; color: white; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 16px; flex-shrink: 0; }
        .teacher-info { display: flex; align-items: center; gap: 12px; }
        .teacher-info .name { font-weight: 600; color: var(--secondary); }
        .teacher-info .email { font-size: 12px; color: var(--gray); }
        .subjects-list, .classes-list { display: flex; flex-wrap: wrap; gap: 5px; }
        .assignments-list { display: flex; flex-direction: column; gap: 6px; }
        .assignment-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
        .assign-arrow { color: var(--gray); font-weight: 700; }
        .classes-inline { display: inline-flex; gap: 4px; flex-wrap: wrap; }
        .subject-tag { padding: 2px 10px; background: var(--light); border-radius: 12px; font-size: 12px; color: var(--secondary); border: 1px solid var(--border); white-space: nowrap; }
        .class-tag { padding: 2px 10px; background: #d1ecf1; border-radius: 12px; font-size: 12px; color: #0c5460; border: 1px solid #bee5eb; white-space: nowrap; }
        .status-badge { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
        .status-badge.active { background: #d4edda; color: #155724; }
        .status-badge.inactive { background: #f8d7da; color: #721c24; }
        .status-badge.pending { background: #fff3cd; color: #856404; }
        .status-badge.invited { background: #d1ecf1; color: #0c5460; }
        .action-btns { display: flex; gap: 8px; flex-wrap: wrap; }
        .action-btn { padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.3s; }
        .action-btn.edit { background: var(--primary); color: white; }
        .action-btn.edit:hover { background: var(--primary-dark); }
        .action-btn.delete { background: var(--danger); color: white; }
        .action-btn.delete:hover { opacity: 0.9; }
        .action-btn.resend { background: var(--warning); color: white; }
        .action-btn.resend:hover { opacity: 0.9; }
        .pagination { display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; background: white; border-top: 1px solid var(--border); flex-wrap: wrap; gap: 10px; }
        .pagination .info { font-size: 14px; color: var(--gray); }
        .pagination-btns { display: flex; gap: 5px; flex-wrap: wrap; }
        .pagination-btns button { padding: 8px 14px; border: 1px solid var(--border); border-radius: 6px; background: white; cursor: pointer; transition: all 0.3s; font-weight: 500; color: var(--secondary); }
        .pagination-btns button:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
        .pagination-btns button.active { background: var(--primary); color: white; border-color: var(--primary); }
        .pagination-btns button:disabled { opacity: 0.5; cursor: not-allowed; }
        .empty-state { text-align: center; padding: 60px 20px; }
        .empty-state i { font-size: 64px; color: var(--border); margin-bottom: 20px; }
        .empty-state h3 { font-size: 20px; color: var(--secondary); margin-bottom: 10px; }
        .empty-state p { color: var(--gray); max-width: 400px; margin: 0 auto 20px; }
        .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); z-index: 1000; display: none; align-items: center; justify-content: center; padding: 20px; }
        .modal-overlay.active { display: flex; }
        .modal { background: white; border-radius: 16px; max-width: 700px; width: 100%; max-height: 90vh; overflow-y: auto; padding: 30px; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
        .modal-header h2 { font-size: 22px; color: var(--secondary); }
        .modal-close { width: 40px; height: 40px; border: none; border-radius: 50%; background: var(--light); cursor: pointer; font-size: 18px; transition: all 0.3s; }
        .modal-close:hover { background: var(--border); }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; font-size: 14px; font-weight: 600; color: var(--secondary); margin-bottom: 5px; }
        .form-group label .required { color: var(--danger); }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; transition: all 0.3s; background: white; color: var(--secondary); }
        .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: var(--primary); }
        .form-group select[multiple] { height: 120px; }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        .modal-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; padding-top: 20px; border-top: 1px solid var(--border); }
        .help-text { font-size: 12px; color: var(--gray); margin-top: 5px; }
        .spinner-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(255, 255, 255, 0.8); z-index: 9999; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 20px; }
        .spinner-overlay.active { display: flex; }
        .spinner { width: 50px; height: 50px; border: 3px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; }
        .spinner-text { color: var(--secondary); font-weight: 500; font-size: 16px; }
        @media (max-width: 768px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr); }
          .filters-section { flex-direction: column; align-items: stretch; }
          .search-input, .filter-select { width: 100%; }
          .form-row { grid-template-columns: 1fr; }
          .modal { padding: 20px; }
          .pagination { flex-direction: column; }
        }
        @media (max-width: 480px) {
          .stats-grid { grid-template-columns: 1fr; }
          td, th { padding: 10px 12px; font-size: 12px; }
        }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .custom-notification { position: fixed; top: 20px; right: 20px; padding: 15px 20px; border-radius: 8px; box-shadow: 0 5px 15px rgba(0,0,0,0.2); z-index: 10000; display: flex; align-items: center; gap: 10px; animation: slideIn 0.3s ease; max-width: 400px; word-wrap: break-word; color: white; font-family: 'Poppins', sans-serif; }
        .selected-items { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
        .selected-item { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; background: var(--primary); color: white; border-radius: 12px; font-size: 12px; }
        .selected-item .remove-btn { background: none; border: none; color: white; cursor: pointer; font-size: 12px; padding: 0 4px; }
        .selected-item .remove-btn:hover { opacity: 0.7; }
      `}</style>

      {spinnerVisible && (
        <div className="spinner-overlay active">
          <div className="spinner"></div>
          <div className="spinner-text">{spinnerText}</div>
        </div>
      )}

      {usingCachedData && isOnline && (
        <div style={{ background: '#d1ecf1', color: '#0c5460', padding: '8px 16px', borderRadius: '8px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', border: '1px solid #bee5eb' }}>
          <i className="fas fa-database"></i>
          <span>Showing cached data. Syncing in background...</span>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card"><div className="stat-label">Total Teachers</div><div className="stat-value">{stats.total}</div></div>
        <div className="stat-card"><div className="stat-label">Active</div><div className="stat-value">{stats.active}</div></div>
        <div className="stat-card"><div className="stat-label">Invited</div><div className="stat-value">{stats.invited}</div></div>
        <div className="stat-card"><div className="stat-label">Subjects</div><div className="stat-value">{stats.subjects}</div></div>
      </div>

      <div className="filters-section">
        <input
          type="text"
          className="search-input"
          placeholder="Search by name, email, or subject..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && applyFilters()}
        />
        <select className="filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="pending">Pending</option>
          <option value="invited">Invited</option>
        </select>
        <select className="filter-select" value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)}>
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

      <div className="table-container">
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Teacher</th>
                <th>ID</th>
                <th>Teaching Assignments</th>
                <th>Pairings</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>{renderTable()}</tbody>
          </table>
        </div>
        <div className="pagination">
          <div className="info">
            Showing {Math.min(filteredTeachers.length, (currentPage - 1) * pageSize + 1)}-
            {Math.min(filteredTeachers.length, currentPage * pageSize)} of {filteredTeachers.length} teachers
          </div>
          <div className="pagination-btns">{renderPagination()}</div>
        </div>
      </div>

      {/* ---------- Add/Edit Modal ---------- */}
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
              <div className="form-row">
                <div className="form-group">
                  <label>First Name <span className="required">*</span></label>
                  <input type="text" value={formData.firstName}
                    onChange={(e) => setFormData({ ...formData, firstName: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Last Name <span className="required">*</span></label>
                  <input type="text" value={formData.lastName}
                    onChange={(e) => setFormData({ ...formData, lastName: e.target.value })} required />
                </div>
              </div>

              <div className="form-group">
                <label>Email <span className="required">*</span></label>
                <input type="email" value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })} required />
                <div className="help-text">
                  {editingTeacher
                    ? 'Change the email only if necessary. The account email is not changed automatically.'
                    : 'A Firebase verification email will be sent to this address. Initial password: 12345678'}
                </div>
              </div>

              <div className="form-group">
                <label>Level</label>
                <select value={formData.level}
                  onChange={(e) => setFormData({
                    ...formData,
                    level: e.target.value,
                    subjects: [],
                    classes: [],
                    assignments: []
                  })}>
                  <option value="">Select Level</option>
                  {Object.entries(LEVEL_DISPLAY_NAMES).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <div className="help-text">Changing level clears subject/class assignments below.</div>
              </div>

              {/* Assignments builder */}
              <div className="form-group">
                <label>Teaching Assignments <span className="required">*</span></label>
                <div className="help-text" style={{ marginBottom: 12 }}>
                  Pair each subject with the specific classes the teacher handles it in.
                  Example: Mathematics → Grade 8P, Grade 8Q. Kiswahili → Grade 9S.
                </div>

                {formData.assignments.length > 0 && (
                  <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    {formData.assignments.map(a => (
                      <div key={a.subject} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'white' }}>
                        <div style={{ fontWeight: 600, minWidth: 130, color: 'var(--secondary)' }}>{a.subject}</div>
                        <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {a.classes.map(c => (
                            <span key={c} className="selected-item" style={{ background: '#d1ecf1', color: '#0c5460' }}>
                              {c}
                              <button type="button" className="remove-btn" style={{ color: '#0c5460' }}
                                onClick={() => handleRemoveClassFromAssignment(a.subject, c)}
                                title={`Remove ${c}`}>×</button>
                            </span>
                          ))}
                        </div>
                        <button type="button" onClick={() => handleRemoveAssignment(a.subject)}
                          style={{ background: 'transparent', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 14, padding: '4px 8px' }}
                          title={`Remove all ${a.subject} assignments`}>
                          <i className="fas fa-trash"></i>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ padding: 14, background: 'var(--light)', borderRadius: 8, border: '1px dashed var(--border)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    Add Assignment
                  </div>
                  <div className="form-row" style={{ marginBottom: 12 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 13 }}>Subject</label>
                      <select value={newAssignmentSubject}
                        onChange={(e) => setNewAssignmentSubject(e.target.value)}>
                        <option value="">Select subject…</option>
                        {getAvailableSubjects(formData.level).map(s => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ fontSize: 13 }}>Classes</label>
                      <select multiple value={newAssignmentClasses}
                        onChange={(e) => {
                          const opts = e.target.options;
                          const selected = [];
                          for (let i = 0; i < opts.length; i++) {
                            if (opts[i].selected) selected.push(opts[i].value);
                          }
                          setNewAssignmentClasses(selected);
                        }}
                        style={{ height: 120 }}>
                        {getAvailableClasses(formData.level).map(c => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      <div className="help-text">Hold Ctrl/Cmd to select multiple classes.</div>
                    </div>
                  </div>
                  <button type="button" className="btn btn-primary" onClick={handleAddAssignment}
                    disabled={!newAssignmentSubject || newAssignmentClasses.length === 0}
                    style={{ width: '100%', justifyContent: 'center' }}>
                    <i className="fas fa-plus"></i> Add Assignment
                  </button>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Status</label>
                  <select value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })} required>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="pending">Pending</option>
                    <option value="invited">Invited</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Phone Number</label>
                  <input type="tel" value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })} />
                </div>
              </div>

              <div className="form-group">
                <label>Qualification</label>
                <input type="text" value={formData.qualification}
                  onChange={(e) => setFormData({ ...formData, qualification: e.target.value })}
                  placeholder="e.g. B.Ed, M.Sc" />
              </div>

              <div className="form-group">
                <label>Address</label>
                <textarea rows="2" value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}></textarea>
              </div>

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
