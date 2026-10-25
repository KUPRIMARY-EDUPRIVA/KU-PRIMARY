// src/components/Layout/Sidebar.jsx

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useBadges } from '../../context/BadgeContext';
import { normalizeRole, isSchoolAdminRole } from '../../utils/roles';
import { getCachedStudentRoster } from '../../services/studentRosterService';
import { db } from '../../firebase';
import {
    doc,
    getDoc,
    collection,
    query,
    where,
    getDocs,
    limit,
} from 'firebase/firestore';
import './Layout.css';

export default function Sidebar({ isOpen, onClose }) {
    const navigate = useNavigate();
    const location = useLocation();

    const {
        currentUser,
        userData,
        userRole,
        logout,
    } = useAuth();

    const { badges } = useBadges();

    const [userName, setUserName] = useState('User');
    const [userEmail, setUserEmail] = useState('');
    const [userAvatar, setUserAvatar] = useState('');
    const [feeBadge, setFeeBadge] = useState(0);

    // Resolve the role early — used by several effects and render helpers.
    const role = useMemo(
        () => normalizeRole(userRole || userData?.role || 'user'),
        [userRole, userData?.role]
    );
    const isStudent = role === 'student';

    // --------------------------------------------------
    // LOAD USER DATA
    // --------------------------------------------------
    useEffect(() => {
        if (currentUser) {
            loadUserProfile();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser]);

    // Fee badge is admin/headteacher/accountant only — never for students.
    useEffect(() => {
        if (!userData?.schoolId) {
            setFeeBadge(0);
            return;
        }
        if (isStudent) {
            setFeeBadge(0);
            return;
        }
        loadFeeBadge();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userData?.schoolId, isStudent]);

    // --------------------------------------------------
    // LOAD USER PROFILE
    // --------------------------------------------------
    const loadUserProfile = async () => {
        if (!currentUser?.uid) return;

        try {
            // ------------------------------------------
            // 1. USERS COLLECTION (admins, headteacher, accountant, etc.)
            // ------------------------------------------
            const userSnapshot = await getDoc(doc(db, 'users', currentUser.uid));
            if (userSnapshot.exists()) {
                const data = userSnapshot.data();
                setUserName(data.fullName || data.firstName || 'User');
                setUserEmail(data.email || currentUser.email || '');
                if (data.profileImageUrl) setUserAvatar(data.profileImageUrl);
                return;
            }

            // ------------------------------------------
            // 2. TEACHERS COLLECTION
            // ------------------------------------------
            const teacherSnapshot = await getDoc(doc(db, 'teachers', currentUser.uid));
            if (teacherSnapshot.exists()) {
                const data = teacherSnapshot.data();
                const fullName = `${data.firstName || ''} ${data.lastName || ''}`.trim();
                setUserName(fullName || 'Teacher');
                setUserEmail(data.email || currentUser.email || '');
                if (data.profileImageUrl) setUserAvatar(data.profileImageUrl);
                return;
            }

            // ------------------------------------------
            // 3. STUDENTS COLLECTION
            //    First try by UID (if the school provisioned the doc
            //    that way); then fall back to email + schoolId, since
            //    our login flow creates student auth users via email
            //    and keeps the student doc keyed by its own ID.
            // ------------------------------------------
            const studentByUid = await getDoc(doc(db, 'students', currentUser.uid));
            if (studentByUid.exists()) {
                const data = studentByUid.data();
                applyStudentProfile(data);
                return;
            }

            if (currentUser.email && userData?.schoolId) {
                const snap = await getDocs(query(
                    collection(db, 'students'),
                    where('schoolId', '==', userData.schoolId),
                    where('email', '==', currentUser.email),
                    limit(1)
                ));
                if (!snap.empty) {
                    applyStudentProfile(snap.docs[0].data());
                    return;
                }
            }
        } catch (error) {
            console.error('Error loading user profile:', error);
        }
    };

    const applyStudentProfile = (data) => {
        const fullName = `${data.firstName || ''} ${data.lastName || ''}`.trim();
        setUserName(fullName || 'Student');
        setUserEmail(data.email || currentUser?.email || '');
        if (data.profileImageUrl) setUserAvatar(data.profileImageUrl);
    };

    // --------------------------------------------------
    // LOAD FEE BADGE (admin/headteacher/accountant only)
    // --------------------------------------------------
    const loadFeeBadge = async () => {
        if (!userData?.schoolId) {
            setFeeBadge(0);
            return;
        }

        try {
            const invoicesQuery = query(
                collection(db, 'fee_invoices'),
                where('schoolId', '==', userData.schoolId),
                where('status', '==', 'pending')
            );
            const invoicesSnapshot = await getDocs(invoicesQuery);

            // Use the cached roster when available; otherwise load once.
            const cachedStudents = await getCachedStudentRoster(userData.schoolId);
            let students = cachedStudents;

            if (!students) {
                const snap = await getDocs(query(
                    collection(db, 'students'),
                    where('schoolId', '==', userData.schoolId)
                ));
                students = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            }

            let overdueCount = 0;
            students.forEach((student) => {
                if (student.isDeleted) return;
                if (student.feeBalance && student.feeBalance > 0) overdueCount++;
            });

            setFeeBadge(invoicesSnapshot.size + overdueCount);
        } catch (error) {
            console.error('Error loading fee badge:', error);
            setFeeBadge(0);
        }
    };

    // --------------------------------------------------
    // NAVIGATION
    // --------------------------------------------------
    const handleNavigation = useCallback((path) => {
        navigate(path);
        if (onClose) onClose();
    }, [navigate, onClose]);

    // --------------------------------------------------
    // LOGOUT
    // --------------------------------------------------
    const handleLogout = async () => {
        try {
            await logout();
            navigate('/login');
            if (onClose) onClose();
        } catch (error) {
            console.error('Logout error:', error);
        }
    };

    // --------------------------------------------------
    // RESULTS BADGE
    // --------------------------------------------------
    const getResultsBadgeClass = () => {
        const resultsNum = parseInt(badges.results, 10);
        if (isNaN(resultsNum)) return '';
        if (resultsNum >= 70) return 'success';
        if (resultsNum < 40) return 'danger';
        return '';
    };

    // --------------------------------------------------
    // NAVIGATION GROUPS
    // --------------------------------------------------
    const groups = useMemo(() => {
        const isAdmin = isSchoolAdminRole(role) && role !== 'super-admin';
        const isHeadteacher = role === 'headteacher';
        const isDeputyHeadteacher = role === 'deputy-headteacher';
        const isAccountant = role === 'accountant';
        const isTeacher = role === 'teacher';
        const isTeacherOrDeputy = isTeacher || isDeputyHeadteacher;
        const studentRole = role === 'student';

        // ----------------------------------------------
        // ADMIN / HEADTEACHER
        // ----------------------------------------------
        const adminItems = [
            { path: '/dashboard', icon: 'fa-tachometer-alt', label: 'Dashboard', show: isAdmin || isHeadteacher },
            { path: '/students', icon: 'fa-user-graduate', label: 'Students', badge: badges.students, show: isAdmin || isHeadteacher },
            { path: '/teachers', icon: 'fa-chalkboard-teacher', label: 'Teachers', badge: badges.teachers, show: isAdmin || isHeadteacher },
            { path: '/exams', icon: 'fa-file-alt', label: 'Exams', badge: badges.exams, show: isAdmin || isHeadteacher },
            { path: '/results', icon: 'fa-chart-line', label: 'Results', badge: badges.results, badgeClass: getResultsBadgeClass(), show: isAdmin || isHeadteacher },
            { path: '/attendance', icon: 'fa-clipboard-check', label: 'Attendance', show: isAdmin || isHeadteacher },
            { path: '/discipline', icon: 'fa-scale-balanced', label: 'Discipline', show: isHeadteacher },
            { path: '/fees', icon: 'fa-coins', label: 'Fee Management', badge: feeBadge, badgeClass: 'danger', show: isAdmin || isAccountant || isHeadteacher },
            { path: '/communications', icon: 'fa-comment-sms', label: 'Communications', show: isHeadteacher },
            { path: '/reports', icon: 'fa-chart-pie', label: 'Reports', show: isAdmin || isHeadteacher },
            { path: '/studentreports', icon: 'fa-file-alt', label: 'Student Reports', show: isAdmin || isHeadteacher },
            { path: '/school-profile', icon: 'fa-school', label: 'School Profile', show: isAdmin || isHeadteacher },
            { path: '/audit-logs', icon: 'fa-shield-alt', label: 'Audit Logs', show: isAdmin || isHeadteacher },
            { path: '/transcripts', icon: 'fa-graduation-cap', label: 'Transcripts', show: isAdmin || isHeadteacher },
        ];

        // ----------------------------------------------
        // TEACHER / DEPUTY
        // ----------------------------------------------
        const teacherItems = [
            { path: '/dashboard', icon: 'fa-chalkboard-teacher', label: 'Dashboard', show: isTeacherOrDeputy },
            { path: '/students', icon: 'fa-user-graduate', label: 'My Students', show: isTeacherOrDeputy },
            { path: '/results', icon: 'fa-chart-line', label: 'Results', show: isTeacherOrDeputy },
            { path: '/attendance', icon: 'fa-clipboard-check', label: 'Attendance', show: isTeacherOrDeputy },
            { path: '/myreports', icon: 'fa-file-alt', label: 'My Reports', show: isTeacherOrDeputy },
            { path: '/studentreports', icon: 'fa-file-alt', label: 'Student Reports', show: isDeputyHeadteacher },
            { path: '/discipline', icon: 'fa-scale-balanced', label: 'Discipline', show: isDeputyHeadteacher },
        ];

        // ----------------------------------------------
        // STUDENT — the five student pages we've built
        // ----------------------------------------------
        const studentItems = [
            {
                path: '/dashboard',
                icon: 'fa-home',
                label: 'Dashboard',
                show: studentRole,
            },
            {
                path: '/student-results',
                icon: 'fa-chart-line',
                label: 'My Results',
                show: studentRole,
            },
            {
                path: '/studentreports',
                icon: 'fa-file-alt',
                label: 'Report Form',
                show: studentRole,
            },
            {
                path: '/attendance',
                icon: 'fa-clipboard-check',
                label: 'My Attendance',
                show: studentRole,
            },
            {
                path: '/fees',
                icon: 'fa-coins',
                label: 'My Fees',
                show: studentRole,
            },
        ];

        // ----------------------------------------------
        // COMMON
        // ----------------------------------------------
        const commonItems = [
            { path: '/timetable', icon: 'fa-calendar-alt', label: 'Timetable', show: !isAccountant },
            { path: '/settings', icon: 'fa-user-cog', label: 'My Profile', show: !isAccountant },
        ];

        const visible = (items) => items.filter((i) => i.show);

        return {
            main: [
                ...visible(adminItems),
                ...visible(teacherItems),
                ...visible(studentItems),
            ],
            common: visible(commonItems),
        };
    }, [role, badges, feeBadge]);

    // --------------------------------------------------
    // ACTIVE PATH
    // --------------------------------------------------
    const firstAvailablePath = useMemo(() => {
        if (groups.main.length > 0) return groups.main[0].path;
        if (groups.common.length > 0) return groups.common[0].path;
        return null;
    }, [groups]);

    const effectiveActivePath = useMemo(() => {
        const allPaths = [
            ...groups.main.map((item) => item.path),
            ...groups.common.map((item) => item.path),
        ];
        if (allPaths.includes(location.pathname)) return location.pathname;
        return firstAvailablePath;
    }, [location.pathname, groups, firstAvailablePath]);

    // --------------------------------------------------
    // RENDER NAV ITEM
    // --------------------------------------------------
    const renderNavItem = (item, index) => {
        const active = effectiveActivePath === item.path;
        return (
            <div
                key={item.path + '_' + index}
                className={'nav-item ' + (active ? 'active' : '')}
                onClick={() => handleNavigation(item.path)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        handleNavigation(item.path);
                    }
                }}
                aria-current={active ? 'page' : undefined}
            >
                <i className={'fas ' + item.icon}></i>
                <span>{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                    <span className={'nav-badge ' + (item.badgeClass || '')}>
                        {item.badge}
                    </span>
                )}
            </div>
        );
    };

    // --------------------------------------------------
    // RENDER
    // --------------------------------------------------
    return (
        <>
            <div className={'side-nav ' + (isOpen ? 'open' : '')}>
                {/* BRAND */}
                <div className="side-nav-brand">
                    <div className="brand-logo">
                        <img
                            src="/Logo.png"
                            alt="EduPriva"
                            onError={(event) => {
                                event.currentTarget.style.display = 'none';
                                event.currentTarget.parentElement.innerHTML =
                                    '<span style="font-size:24px;font-weight:700;color:#1a237e;">EP</span>';
                            }}
                        />
                    </div>
                    <div className="brand-name">EDUPRIVA</div>
                </div>

                {/* NAVIGATION */}
                <nav className="side-nav-menu">
                    {groups.main.map(renderNavItem)}
                    {groups.common.map(renderNavItem)}
                </nav>

                {/* USER FOOTER */}
                <div className="side-nav-footer">
                    <div className="user-profile-mini">
                        <div className="user-avatar-mini">
                            {userAvatar ? (
                                <img
                                    src={userAvatar}
                                    alt="Profile"
                                    onError={(event) => {
                                        event.currentTarget.style.display = 'none';
                                        event.currentTarget.parentElement.textContent =
                                            userName.charAt(0).toUpperCase();
                                    }}
                                />
                            ) : (
                                <span>{userName.charAt(0).toUpperCase()}</span>
                            )}
                        </div>
                        <div className="user-info-mini">
                            <div className="user-name">{userName}</div>
                            <div className="user-email">{userEmail}</div>
                        </div>
                    </div>
                    <div
                        className="logout-btn"
                        onClick={handleLogout}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                handleLogout();
                            }
                        }}
                    >
                        <i className="fas fa-sign-out-alt"></i>
                        <span>Logout</span>
                    </div>
                </div>
            </div>

            {/* MOBILE OVERLAY */}
            <div className={'overlay ' + (isOpen ? 'show' : '')} onClick={onClose}></div>
        </>
    );
}
