```jsx
// src/components/Layout/Sidebar.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useBadges } from '../../context/BadgeContext';
import { db } from '../../firebase';
import {
    doc,
    getDoc,
    collection,
    query,
    where,
    getDocs
} from 'firebase/firestore';
import './Layout.css';

export default function Sidebar({ isOpen, onClose }) {
    const navigate = useNavigate();
    const location = useLocation();
    const { currentUser, userData, userRole, logout } = useAuth();
    const { badges } = useBadges();

    const [userName, setUserName] = useState('User');
    const [userEmail, setUserEmail] = useState('');
    const [userAvatar, setUserAvatar] = useState('');
    const [feeBadge, setFeeBadge] = useState(0);

    // ---- Load user profile + fee badge ----
    useEffect(() => {
        if (userData?.schoolId) {
            loadFeeBadge();
        }

        if (currentUser) {
            loadUserProfile();
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userData, currentUser]);

    const loadUserProfile = async () => {
        try {
            // 1. Users collection
            const userDoc = await getDoc(doc(db, 'users', currentUser.uid));

            if (userDoc.exists()) {
                const data = userDoc.data();

                setUserName(
                    data.fullName ||
                    data.firstName ||
                    'User'
                );

                setUserEmail(
                    data.email ||
                    currentUser.email ||
                    ''
                );

                if (data.profileImageUrl) {
                    setUserAvatar(data.profileImageUrl);
                }

                return;
            }

            // 2. Teachers collection
            const teacherDoc = await getDoc(
                doc(db, 'teachers', currentUser.uid)
            );

            if (teacherDoc.exists()) {
                const data = teacherDoc.data();

                setUserName(
                    `${data.firstName || ''} ${data.lastName || ''}`.trim() ||
                    'Teacher'
                );

                setUserEmail(
                    data.email ||
                    currentUser.email ||
                    ''
                );

                if (data.profileImageUrl) {
                    setUserAvatar(data.profileImageUrl);
                }

                return;
            }

            // 3. Students collection
            const studentDoc = await getDoc(
                doc(db, 'students', currentUser.uid)
            );

            if (studentDoc.exists()) {
                const data = studentDoc.data();

                setUserName(
                    `${data.firstName || ''} ${data.lastName || ''}`.trim() ||
                    'Student'
                );

                setUserEmail(
                    data.email ||
                    currentUser.email ||
                    ''
                );

                if (data.profileImageUrl) {
                    setUserAvatar(data.profileImageUrl);
                }
            }
        } catch (error) {
            console.error('Error loading user profile:', error);
        }
    };

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

            const studentsQuery = query(
                collection(db, 'students'),
                where('schoolId', '==', userData.schoolId)
            );

            const studentsSnapshot = await getDocs(studentsQuery);

            let overdueCount = 0;

            studentsSnapshot.forEach((d) => {
                const student = d.data();

                if (
                    student.feeBalance &&
                    student.feeBalance > 0
                ) {
                    overdueCount++;
                }
            });

            setFeeBadge(
                invoicesSnapshot.size + overdueCount
            );
        } catch (error) {
            console.error('Error loading fee badge:', error);
            setFeeBadge(0);
        }
    };

    // ---- Navigation ----
    const handleNavigation = (path) => {
        navigate(path);
        onClose();
    };

    const handleLogout = async () => {
        try {
            await logout();
            navigate('/login');
            onClose();
        } catch (error) {
            console.error('Logout error:', error);
        }
    };

    const getResultsBadgeClass = () => {
        const resultsNum = parseInt(badges.results, 10);

        if (isNaN(resultsNum)) return '';
        if (resultsNum >= 70) return 'success';
        if (resultsNum < 40) return 'danger';

        return '';
    };

    // ---- Build navigation groups ----
    const getNavGroups = () => {
        const role = userRole || userData?.role || 'user';

        const isAdmin =
            role === 'admin' ||
            role === 'user' ||
            role === 'school_admin';

        const isTeacher = role === 'teacher';
        const isStudent = role === 'student';

        // ---- Admin items ----
        const adminItems = [
            {
                path: '/dashboard',
                icon: 'fa-tachometer-alt',
                label: 'Dashboard',
                show: isAdmin
            },
            {
                path: '/students',
                icon: 'fa-user-graduate',
                label: 'Students',
                badge: badges.students,
                show: isAdmin
            },
            {
                path: '/teachers',
                icon: 'fa-chalkboard-teacher',
                label: 'Teachers',
                badge: badges.teachers,
                show: isAdmin
            },
            {
                path: '/exams',
                icon: 'fa-file-alt',
                label: 'Exams',
                badge: badges.exams,
                show: isAdmin
            },
            {
                path: '/results',
                icon: 'fa-chart-line',
                label: 'Results',
                badge: badges.results,
                badgeClass: getResultsBadgeClass(),
                show: isAdmin
            },
            {
                path: '/fees',
                icon: 'fa-coins',
                label: 'Fee Management',
                badge: feeBadge,
                badgeClass: 'danger',
                show: isAdmin
            },
            {
                path: '/reports',
                icon: 'fa-chart-pie',
                label: 'Reports',
                show: isAdmin
            },
            {
                path: '/studentreports',
                icon: 'fa-file-alt',
                label: 'Student Reports',
                show: isAdmin
            },
            {
                path: '/school-profile',
                icon: 'fa-school',
                label: 'School Profile',
                show: isAdmin
            },
            {
                path: '/audit-logs',
                icon: 'fa-shield-alt',
                label: 'Audit Logs',
                show: isAdmin
            },
            {
                path: '/transcripts',
                icon: 'fa-graduation-cap',
                label: 'Transcripts',
                show: isAdmin
            }
        ];

        // ---- Teacher items ----
        const teacherItems = [
            {
                path: '/mydashboard',
                icon: 'fa-chalkboard-teacher',
                label: 'Dashboard',
                show: isTeacher
            },
            {
                path: '/my-students',
                icon: 'fa-user-graduate',
                label: 'My Students',
                show: isTeacher
            },
            {
                path: '/results',
                icon: 'fa-chart-line',
                label: 'Results',
                show: isTeacher
            },
            {
                path: '/myreports',
                icon: 'fa-file-alt',
                label: 'My Reports',
                show: isTeacher
            }
        ];

        // ---- Student items ----
        const studentItems = [
            {
                path: '/student-dashboard',
                icon: 'fa-user-graduate',
                label: 'My Dashboard',
                show: isStudent
            },
            {
                path: '/student-results',
                icon: 'fa-chart-line',
                label: 'My Results',
                show: isStudent
            },
            {
                path: '/student-fees',
                icon: 'fa-coins',
                label: 'My Fees',
                show: isStudent
            }
        ];

        // ---- Common items ----
        const commonItems = [
            {
                path: '/timetable',
                icon: 'fa-calendar-alt',
                label: 'Timetable',
                show: true
            },
            {
                path: '/settings',
                icon: 'fa-user-cog',
                label: 'My Profile',
                show: true
            }
        ];

        const visible = (arr) =>
            arr.filter((item) => item.show);

        return {
            main: [
                ...visible(adminItems),
                ...visible(teacherItems),
                ...visible(studentItems)
            ],
            common: visible(commonItems)
        };
    };

    const groups = getNavGroups();

    // ---- Auto-active logic ----
    const firstAvailablePath = useMemo(() => {
        if (groups.main.length > 0) {
            return groups.main[0].path;
        }

        if (groups.common.length > 0) {
            return groups.common[0].path;
        }

        return null;
    }, [groups]);

    const effectiveActivePath = useMemo(() => {
        const allPaths = [
            ...groups.main.map((item) => item.path),
            ...groups.common.map((item) => item.path)
        ];

        if (allPaths.includes(location.pathname)) {
            return location.pathname;
        }

        return firstAvailablePath;
    }, [
        location.pathname,
        groups,
        firstAvailablePath
    ]);

    // ---- Render navigation item ----
    const renderNavItem = (item, index) => {
        const active =
            effectiveActivePath === item.path;

        return (
            <div
                key={`${item.path}_${index}`}
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() =>
                    handleNavigation(item.path)
                }
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (
                        e.key === 'Enter' ||
                        e.key === ' '
                    ) {
                        handleNavigation(item.path);
                    }
                }}
                aria-current={
                    active ? 'page' : undefined
                }
            >
                <i
                    className={`fas ${item.icon}`}
                ></i>

                <span>{item.label}</span>

                {item.badge !== undefined &&
                    item.badge > 0 && (
                        <span
                            className={`nav-badge ${
                                item.badgeClass || ''
                            }`}
                        >
                            {item.badge}
                        </span>
                    )}
            </div>
        );
    };

    return (
        <>
            <div
                className={`side-nav ${
                    isOpen ? 'open' : ''
                }`}
            >
                {/* Brand */}
                <div className="side-nav-brand">
                    <div className="brand-logo">
                        <img
                            src="/Logo.png"
                            alt="EduPriva"
                            onError={(e) => {
                                e.target.style.display =
                                    'none';

                                e.target.parentElement.innerHTML =
                                    '<span style="font-size:24px;font-weight:700;color:#1a237e;">EP</span>';
                            }}
                        />
                    </div>

                    <div className="brand-name">
                        EDUPRIVA
                    </div>
                </div>

                <nav className="side-nav-menu">
                    {/* Main items */}
                    {groups.main.map(renderNavItem)}

                    {/* Common items */}
                    {groups.common.map(renderNavItem)}
                </nav>

                {/* User profile + logout */}
                <div className="side-nav-footer">
                    <div className="user-profile-mini">
                        <div className="user-avatar-mini">
                            {userAvatar ? (
                                <img
                                    src={userAvatar}
                                    alt="Profile"
                                    onError={(e) => {
                                        e.target.style.display =
                                            'none';

                                        e.target.parentElement.textContent =
                                            userName
                                                .charAt(0)
                                                .toUpperCase();
                                    }}
                                />
                            ) : (
                                <span>
                                    {userName
                                        .charAt(0)
                                        .toUpperCase()}
                                </span>
                            )}
                        </div>

                        <div className="user-info-mini">
                            <div className="user-name">
                                {userName}
                            </div>

                            <div className="user-email">
                                {userEmail}
                            </div>
                        </div>
                    </div>

                    <div
                        className="logout-btn"
                        onClick={handleLogout}
                    >
                        <i className="fas fa-sign-out-alt"></i>
                        <span>Logout</span>
                    </div>
                </div>
            </div>

            <div
                className={`overlay ${
                    isOpen ? 'show' : ''
                }`}
                onClick={onClose}
            ></div>
        </>
    );
}
```
