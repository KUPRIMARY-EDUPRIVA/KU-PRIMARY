// src/components/Layout/Sidebar.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useBadges } from '../../context/BadgeContext';
import { db } from '../../firebase';
import { doc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
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
    const [schoolFeatures, setSchoolFeatures] = useState(null);
    const [premiumOpen, setPremiumOpen] = useState(false);

    const isSuperAdmin = userRole === 'super-admin';

    // ---- Load school features + user profile + fee badge ----
    useEffect(() => {
        if (!isSuperAdmin && userData?.schoolId) {
            loadSchoolFeatures();
            loadFeeBadge();
        }
        if (currentUser) {
            loadUserProfile();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userData, currentUser, isSuperAdmin]);

    const loadSchoolFeatures = async () => {
        try {
            const schoolDoc = await getDoc(doc(db, 'schools', userData.schoolId));
            if (schoolDoc.exists()) {
                const data = schoolDoc.data();
                if (data.features) {
                    setSchoolFeatures(data.features);
                } else {
                    setSchoolFeatures({
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
                }
            }
        } catch (error) {
            console.error('Error loading school features:', error);
            setSchoolFeatures({
                transport: true,
                accommodation: true,
                health: true,
                inventory: true,
                fees: true,
                exams: true,
                results: true,
                reports: true,
                subscription: true
            });
        }
    };

    const loadUserProfile = async () => {
        try {
            // 1. Users collection
            const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
            if (userDoc.exists()) {
                const data = userDoc.data();
                setUserName(data.fullName || data.firstName || 'User');
                setUserEmail(data.email || currentUser.email || '');
                if (data.profileImageUrl) setUserAvatar(data.profileImageUrl);
                return;
            }

            // 2. Teachers collection
            const teacherDoc = await getDoc(doc(db, 'teachers', currentUser.uid));
            if (teacherDoc.exists()) {
                const data = teacherDoc.data();
                setUserName(
                    `${data.firstName || ''} ${data.lastName || ''}`.trim() || 'Teacher'
                );
                setUserEmail(data.email || currentUser.email || '');
                if (data.profileImageUrl) setUserAvatar(data.profileImageUrl);
                return;
            }

            // 3. Students collection
            const studentDoc = await getDoc(doc(db, 'students', currentUser.uid));
            if (studentDoc.exists()) {
                const data = studentDoc.data();
                setUserName(
                    `${data.firstName || ''} ${data.lastName || ''}`.trim() || 'Student'
                );
                setUserEmail(data.email || currentUser.email || '');
                if (data.profileImageUrl) setUserAvatar(data.profileImageUrl);
            }
        } catch (error) {
            console.error('Error loading user profile:', error);
        }
    };

    const loadFeeBadge = async () => {
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
                if (student.feeBalance && student.feeBalance > 0) overdueCount++;
            });

            setFeeBadge(invoicesSnapshot.size + overdueCount);
        } catch (error) {
            console.error('Error loading fee badge:', error);
            setFeeBadge(0);
        }
    };

    // ---- Feature gating ----
    const isFeatureEnabled = (featureName) => {
        if (isSuperAdmin) return true;
        if (!schoolFeatures) return true;
        return schoolFeatures[featureName] !== false;
    };

  

    const enabledOptionalItems = useMemo(() => {
        if (isSuperAdmin) return [];
        return optionalFeatures
            .filter((item) => isFeatureEnabled(item.key))
            .map((item) => ({ ...item, show: true }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [optionalFeatures, schoolFeatures, isSuperAdmin]);

    // Whether the Premium accordion should be rendered at all
    const hasPremium = enabledOptionalItems.length > 0;

    // ---- Active tab logic ----
    // If we're not on any known nav path, default the "active" highlight to the
    // first tab the user has access to. This gives a stable landing indicator
    // even before the user navigates.
    const isActive = (path) => location.pathname === path;

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

    // ---- Build nav item groups ----
    const getNavGroups = () => {
        const role = userRole || userData?.role || 'user';
        const isAdmin = role === 'admin' || role === 'user' || role === 'school_admin';
        const isTeacher = role === 'teacher';
        const isStudent = role === 'student';
        const isSuper = role === 'super-admin';

        // ---- Admin items ----
        const adminItems = [
            {
                path: '/dashboard',
                icon: 'fa-tachometer-alt',
                label: 'Dashboard',
                show: isAdmin && !isSuper
            },
            {
                path: '/students',
                icon: 'fa-user-graduate',
                label: 'Students',
                badge: badges.students,
                show: isAdmin && !isSuper
            },
            {
                path: '/teachers',
                icon: 'fa-chalkboard-teacher',
                label: 'Teachers',
                badge: badges.teachers,
                show: isAdmin && !isSuper
            },
            {
                path: '/exams',
                icon: 'fa-file-alt',
                label: 'Exams',
                badge: badges.exams,
                show: isAdmin && !isSuper && isFeatureEnabled('exams')
            },
            {
                path: '/results',
                icon: 'fa-chart-line',
                label: 'Results',
                badge: badges.results,
                badgeClass: getResultsBadgeClass(),
                show: isAdmin && !isSuper && isFeatureEnabled('results')
            },
            {
                path: '/fees',
                icon: 'fa-coins',
                label: 'Fee Management',
                badge: feeBadge,
                badgeClass: 'danger',
                show: isAdmin && !isSuper && isFeatureEnabled('fees')
            },
            {
                path: '/reports',
                icon: 'fa-chart-pie',
                label: 'Reports',
                show: isAdmin && !isSuper && isFeatureEnabled('reports')
            },
            {
                path: '/studentreports',
                icon: 'fa-file-alt',
                label: 'Student Reports',
                show: isAdmin && !isSuper && isFeatureEnabled('reports')
            },
           
            {
                path: '/school-profile',
                icon: 'fa-school',
                label: 'School Profile',
                show: isAdmin && !isSuper
            },
            {
                path: '/audit-logs',
                icon: 'fa-shield-alt',
                label: 'Audit Logs',
                show: isAdmin && !isSuper
            },
            {
                path: '/transcripts',
                icon: 'fa-graduation-cap',
                label: 'Transcripts',
                show: isAdmin && !isSuper
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
                show: isTeacher && isFeatureEnabled('results')
            },
            {
                path: '/myreports',
                icon: 'fa-file-alt',
                label: 'My Reports',
                show: isTeacher && isFeatureEnabled('reports')
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
                show: isStudent && isFeatureEnabled('results')
            },
            {
                path: '/student-fees',
                icon: 'fa-coins',
                label: 'My Fees',
                show: isStudent && isFeatureEnabled('fees')
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

        const visible = (arr) => arr.filter((i) => i.show);

        return {
            main: [
                ...visible(adminItems),
                ...visible(teacherItems),
                ...visible(studentItems),
                ...visible(superadminItems)
            ],
            premium: enabledOptionalItems,
            common: visible(commonItems)
        };
    };

    const groups = getNavGroups();

    // ---- Auto-active logic ----
    // Compute the "effective" first tab. When the URL is a fallback (e.g. "/"),
    // the sidebar highlights the first tab the user has access to so the
    // sidebar always shows a clear landing state.
    const firstAvailablePath = useMemo(() => {
        if (groups.main.length > 0) return groups.main[0].path;
        if (groups.premium.length > 0) return groups.premium[0].path;
        if (groups.common.length > 0) return groups.common[0].path;
        return null;
    }, [groups]);

    const effectiveActivePath = useMemo(() => {
        const allPaths = [
            ...groups.main.map((i) => i.path),
            ...groups.premium.map((i) => i.path),
            ...groups.common.map((i) => i.path)
        ];
        // If we're on a path we know about, use it. Otherwise fall back to first tab.
        if (allPaths.includes(location.pathname)) return location.pathname;
        return firstAvailablePath;
    }, [location.pathname, groups, firstAvailablePath]);

    // ---- Premium accordion ----
    // Auto-open the accordion if the user is currently on one of its pages.
    useEffect(() => {
        if (!hasPremium) {
            setPremiumOpen(false);
            return;
        }
        const isInsidePremium = groups.premium.some(
            (item) => item.path === location.pathname
        );
        if (isInsidePremium) setPremiumOpen(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.pathname, hasPremium]);

    // ---- Render one nav item ----
    const renderNavItem = (item, index) => {
        const active = effectiveActivePath === item.path;
        return (
            <div
                key={`${item.path}_${index}`}
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() => handleNavigation(item.path)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleNavigation(item.path);
                }}
                aria-current={active ? 'page' : undefined}
            >
                <i className={`fas ${item.icon}`}></i>
                <span>{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                    <span className={`nav-badge ${item.badgeClass || ''}`}>
                        {item.badge}
                    </span>
                )}
            </div>
        );
    };

    return (
        <>
            <div className={`side-nav ${isOpen ? 'open' : ''}`}>
                {/* Brand */}
                <div className="side-nav-brand">
                    <div className="brand-logo">
                        <img
                            src="/Logo.png"
                            alt="EduPriva"
                            onError={(e) => {
                                e.target.style.display = 'none';
                                e.target.parentElement.innerHTML =
                                    '<span style="font-size:24px;font-weight:700;color:#1a237e;">EP</span>';
                            }}
                        />
                    </div>
                    <div className="brand-name">EDUPRIVA</div>
                </div>

                {/* Super-admin badge */}
                {isSuperAdmin && (
                    <div className="side-nav-super-admin">
                        <div className="super-admin-text">
                            <i className="fas fa-crown"></i> Platform Admin
                        </div>
                    </div>
                )}

                <nav className="side-nav-menu">
                    {/* Main items */}
                    {groups.main.map(renderNavItem)}

                    {/* Premium accordion — only if the school has ≥1 optional feature */}
                    {hasPremium && (
                        <div className="nav-group">
                            <div
                                className={`nav-item nav-group-header ${
                                    premiumOpen ? 'open' : ''
                                }`}
                                onClick={() => setPremiumOpen((v) => !v)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        setPremiumOpen((v) => !v);
                                    }
                                }}
                                aria-expanded={premiumOpen}
                            >
                                <i className="fas fa-star"></i>
                                <span>Premium</span>
                                <i
                                    className={`fas fa-chevron-${
                                        premiumOpen ? 'down' : 'right'
                                    } nav-group-caret`}
                                ></i>
                            </div>

                            {premiumOpen && (
                                <div className="nav-group-children">
                                    {groups.premium.map(renderNavItem)}
                                </div>
                            )}
                        </div>
                    )}

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
                                        e.target.style.display = 'none';
                                        e.target.parentElement.textContent = userName
                                            .charAt(0)
                                            .toUpperCase();
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
                    <div className="logout-btn" onClick={handleLogout}>
                        <i className="fas fa-sign-out-alt"></i>
                        <span>Logout</span>
                    </div>
                </div>
            </div>
            <div
                className={`overlay ${isOpen ? 'show' : ''}`}
                onClick={onClose}
            ></div>
        </>
    );
}
