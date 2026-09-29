// src/components/Layout/MobileNav.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useBadges } from '../../context/BadgeContext';
import { db } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';

export default function MobileNav() {
    const navigate = useNavigate();
    const location = useLocation();
    const { userRole, userData, currentUser } = useAuth();
    const { badges } = useBadges();
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [schoolFeatures, setSchoolFeatures] = useState(null);
    const [feeBadge, setFeeBadge] = useState(0);
    const [isSuperAdmin, setIsSuperAdmin] = useState(false);

    // Load school features and check if super-admin
    useEffect(() => {
        const checkRoleAndLoadFeatures = async () => {
            const role = userRole || userData?.role || 'user';
            const superAdmin = role === 'super-admin';
            setIsSuperAdmin(superAdmin);

            // Only load features for non-super-admin users with schoolId
            if (!superAdmin && userData?.schoolId) {
                await loadSchoolFeatures();
                await loadFeeBadge();
            }
        };

        checkRoleAndLoadFeatures();
    }, [userRole, userData, currentUser]);

    const loadSchoolFeatures = async () => {
        try {
            const schoolDoc = await getDoc(doc(db, 'schools', userData.schoolId));
            if (schoolDoc.exists()) {
                const data = schoolDoc.data();
                if (data.features) {
                    setSchoolFeatures(data.features);
                } else {
                    // Default features (all enabled)
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
            // Default to all features enabled
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

    // Load fee badge (pending invoices or overdue payments)
    const loadFeeBadge = async () => {
        try {
            // Get pending invoices count
            const { collection, query, where, getDocs } = await import('firebase/firestore');
            const invoicesQuery = query(
                collection(db, 'fee_invoices'),
                where('schoolId', '==', userData.schoolId),
                where('status', '==', 'pending')
            );
            const invoicesSnapshot = await getDocs(invoicesQuery);
            
            // Get students with outstanding balance
            const studentsQuery = query(
                collection(db, 'students'),
                where('schoolId', '==', userData.schoolId)
            );
            const studentsSnapshot = await getDocs(studentsQuery);
            
            // Count students with outstanding balance
            let overdueCount = 0;
            studentsSnapshot.forEach(doc => {
                const student = doc.data();
                if (student.feeBalance && student.feeBalance > 0) {
                    overdueCount++;
                }
            });

            // Set badge count (pending invoices + overdue payments)
            setFeeBadge(invoicesSnapshot.size + overdueCount);
        } catch (error) {
            console.error('Error loading fee badge:', error);
            setFeeBadge(0);
        }
    };

    // Check if a feature is enabled for the school
    const isFeatureEnabled = (featureName) => {
        // For super-admin, all features are always available
        if (isSuperAdmin) return true;
        if (!schoolFeatures) return true; // Default to enabled if not loaded
        return schoolFeatures[featureName] !== false;
    };

    // Determine results badge class
    const getResultsBadgeClass = () => {
        const resultsNum = parseInt(badges.results);
        if (isNaN(resultsNum)) return '';
        if (resultsNum >= 70) return 'success';
        if (resultsNum < 40) return 'danger';
        return '';
    };

    const isActive = (path) => {
        return location.pathname === path;
    };

    const handleNavigation = (path) => {
        navigate(path);
        if (showMoreMenu) {
            setShowMoreMenu(false);
        }
    };

    const handleMoreMenuToggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setShowMoreMenu(!showMoreMenu);
    };

    // Close more menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (e) => {
            if (showMoreMenu) {
                const menu = document.querySelector('.mobile-more-menu');
                if (menu && !menu.contains(e.target) && e.target.id !== 'mobileMoreBtn') {
                    setShowMoreMenu(false);
                }
            }
        };

        document.addEventListener('click', handleClickOutside);
        return () => {
            document.removeEventListener('click', handleClickOutside);
        };
    }, [showMoreMenu]);

    // Get role-based navigation items (same as Sidebar with feature checks)
    const getNavItems = () => {
        const role = userRole || userData?.role || 'user';
        const isAdmin = role === 'admin' || role === 'user' || role === 'school_admin';
        const isTeacher = role === 'teacher';
        const isStudent = role === 'student';
        const isSuperAdmin = role === 'super-admin';

        // Admin / School Admin Items
        const adminItems = [
            {
                path: '/dashboard',
                icon: 'fa-tachometer-alt',
                label: 'Dashboard',
                show: isAdmin && !isSuperAdmin
            },
            {
                path: '/students',
                icon: 'fa-user-graduate',
                label: 'Students',
                badge: badges.students,
                show: isAdmin && !isSuperAdmin
            },
            {
                path: '/teachers',
                icon: 'fa-chalkboard-teacher',
                label: 'Teachers',
                badge: badges.teachers,
                show: isAdmin && !isSuperAdmin
            },
            {
                path: '/exams',
                icon: 'fa-file-alt',
                label: 'Exams',
                badge: badges.exams,
                show: isAdmin && !isSuperAdmin && isFeatureEnabled('exams')
            },
            {
                path: '/results',
                icon: 'fa-chart-line',
                label: 'Results',
                badge: badges.results,
                badgeClass: getResultsBadgeClass(),
                show: isAdmin && !isSuperAdmin && isFeatureEnabled('results')
            },
            {
                path: '/fees',
                icon: 'fa-coins',
                label: 'Fee Management',
                badge: feeBadge,
                badgeClass: 'danger',
                show: isAdmin && !isSuperAdmin && isFeatureEnabled('fees')
            },
            {
                path: '/communications',
                icon: 'fa-comment-sms',
                label: 'Communications',
                show: isAdmin && !isSuperAdmin
            },
            {
                path: '/reports',
                icon: 'fa-chart-pie',
                label: 'Reports',
                show: isAdmin && !isSuperAdmin && isFeatureEnabled('reports')
            },
            {
                path: '/studentreports',
                icon: 'fa-file-alt',
                label: 'Student Reports',
                show: isAdmin && !isSuperAdmin && isFeatureEnabled('reports')
            },
            {
                path: '/subscription',
                icon: 'fa-credit-card',
                label: 'Subscription',
                show: isAdmin && !isSuperAdmin && isFeatureEnabled('subscription')
            },
            {
                path: '/school-profile',
                icon: 'fa-school',
                label: 'School Profile',
                show: isAdmin && !isSuperAdmin
            },
            {
                path: '/audit-logs',
                icon: 'fa-shield-alt',
                label: 'Audit Logs',
                show: isAdmin && !isSuperAdmin
            }
        ];

        // Teacher Items
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

        // Student Items
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

        // Super Admin / Platform Admin Items
        const superadminItems = [
            {
                path: '/platformtower',
                icon: 'fa-tachometer-alt',
                label: 'Platform Dashboard',
                show: isSuperAdmin
            },
            {
                path: '/platform-admin/schools',
                icon: 'fa-school',
                label: 'Schools',
                show: isSuperAdmin
            },
            {
                path: '/platform-admin/users',
                icon: 'fa-users-cog',
                label: 'Platform Users',
                show: isSuperAdmin
            },
            {
                path: '/platform-admin/settings',
                icon: 'fa-cog',
                label: 'Platform Settings',
                show: isSuperAdmin
            }
        ];

        // Optional Modules (Common Items) - only for non super-admin
        const optionalItems = [
            {
                path: '/transport',
                icon: 'fa-bus',
                label: 'Transport',
                show: !isSuperAdmin && isFeatureEnabled('transport')
            },
            {
                path: '/accomodation',
                icon: 'fa-house',
                label: 'Accommodation',
                show: !isSuperAdmin && isFeatureEnabled('accommodation')
            },
            {
                path: '/health',
                icon: 'fa-cross',
                label: 'Health Unit',
                show: !isSuperAdmin && isFeatureEnabled('health')
            },
            {
                path: '/inventory',
                icon: 'fa-boxes',
                label: 'Inventory',
                show: !isSuperAdmin && isFeatureEnabled('inventory')
            }
        ];

        // Common Items (visible to all roles)
        const commonItems = [
            {
                path: '/settings',
                icon: 'fa-user-cog',
                label: 'My Profile',
                show: true
            }
        ];

        // Combine all items
        const allItems = [...adminItems, ...teacherItems, ...studentItems, ...superadminItems, ...optionalItems, ...commonItems]
            .filter(item => item.show);

        // Separate into main items (first 4) and more items
        const maxMainItems = 4;
        const mainItems = allItems.slice(0, maxMainItems);
        const moreItems = allItems.slice(maxMainItems);

        return { mainItems, moreItems };
    };

    const { mainItems, moreItems } = getNavItems();

    return (
        <>
            <nav className="mobile-nav" id="mobileNav">
                {mainItems.map((item, index) => (
                    <button 
                        key={index}
                        className={`mobile-nav-item ${isActive(item.path) ? 'active' : ''}`}
                        onClick={() => handleNavigation(item.path)}
                    >
                        <i className={`fas ${item.icon} mobile-nav-icon`}></i>
                        <span className="mobile-nav-label">{item.label}</span>
                        {item.badge !== undefined && item.badge > 0 && (
                            <span className="mobile-nav-badge" style={{
                                position: 'absolute',
                                top: '4px',
                                right: '50%',
                                transform: 'translateX(50%)',
                                background: item.badgeClass === 'success' ? 'var(--success)' : 'var(--danger)',
                                color: 'white',
                                fontSize: '9px',
                                fontWeight: '700',
                                padding: '1px 6px',
                                borderRadius: '50%',
                                minWidth: '18px',
                                textAlign: 'center'
                            }}>
                                {item.badge}
                            </span>
                        )}
                    </button>
                ))}
                
                {/* More button - only show if there are more items */}
                {moreItems.length > 0 && (
                    <button 
                        className="mobile-nav-item" 
                        id="mobileMoreBtn"
                        onClick={handleMoreMenuToggle}
                    >
                        <i className="fas fa-ellipsis-h mobile-nav-icon"></i>
                        <span className="mobile-nav-label">More</span>
                        {showMoreMenu && (
                            <i className="fas fa-times" style={{
                                position: 'absolute',
                                top: '8px',
                                right: '8px',
                                fontSize: '12px',
                                color: 'var(--gray)'
                            }}></i>
                        )}
                    </button>
                )}
            </nav>

            {/* More Menu */}
            {showMoreMenu && moreItems.length > 0 && (
                <div className="mobile-more-menu" style={{
                    position: 'fixed',
                    bottom: '70px',
                    right: '20px',
                    background: 'white',
                    borderRadius: '12px',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
                    zIndex: 1001,
                    minWidth: '220px',
                    overflow: 'hidden',
                    maxHeight: '400px',
                    overflowY: 'auto',
                    animation: 'slideUp 0.3s ease'
                }}>
                    {moreItems.map((item, index) => (
                        <button 
                            key={index}
                            className="mobile-menu-item" 
                            onClick={() => handleNavigation(item.path)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '12px 18px',
                                color: 'var(--secondary)',
                                borderBottom: index < moreItems.length - 1 ? '1px solid var(--border)' : 'none',
                                transition: 'background 0.2s',
                                width: '100%',
                                border: 'none',
                                background: 'none',
                                textAlign: 'left',
                                cursor: 'pointer',
                                fontSize: '14px',
                                fontFamily: 'inherit'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = 'var(--light)'}
                            onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                            <div style={{ display: 'flex', alignItems: 'center' }}>
                                <i className={`fas ${item.icon}`} style={{ marginRight: '12px', width: '20px', color: 'var(--primary)' }}></i>
                                <span>{item.label}</span>
                            </div>
                            {item.badge !== undefined && item.badge > 0 && (
                                <span style={{
                                    background: item.badgeClass === 'success' ? 'var(--success)' : 'var(--danger)',
                                    color: 'white',
                                    fontSize: '10px',
                                    fontWeight: '700',
                                    padding: '1px 8px',
                                    borderRadius: '12px',
                                    minWidth: '20px',
                                    textAlign: 'center'
                                }}>
                                    {item.badge}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
            )}

            <style>{`
                @keyframes slideUp {
                    from {
                        transform: translateY(20px);
                        opacity: 0;
                    }
                    to {
                        transform: translateY(0);
                        opacity: 1;
                    }
                }

                .mobile-nav {
                    position: fixed;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    background: white;
                    display: flex;
                    justify-content: space-around;
                    align-items: center;
                    padding: 8px 0 env(safe-area-inset-bottom);
                    box-shadow: 0 -2px 10px rgba(0,0,0,0.08);
                    z-index: 1000;
                    border-top: 1px solid var(--border);
                    height: 60px;
                }

                .mobile-nav-item {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    flex: 1;
                    padding: 4px 0;
                    background: none;
                    border: none;
                    cursor: pointer;
                    color: var(--gray);
                    transition: all 0.3s;
                    position: relative;
                    font-family: inherit;
                }

                .mobile-nav-item .mobile-nav-icon {
                    font-size: 20px;
                    transition: all 0.3s;
                }

                .mobile-nav-item .mobile-nav-label {
                    font-size: 10px;
                    margin-top: 2px;
                    font-weight: 500;
                }

                .mobile-nav-item.active {
                    color: var(--primary);
                }

                .mobile-nav-item.active .mobile-nav-icon {
                    transform: scale(1.1);
                }

                .mobile-nav-item:hover {
                    color: var(--primary);
                }

                .mobile-nav-badge {
                    position: absolute;
                    top: 2px;
                    right: 50%;
                    transform: translateX(50%);
                    background: var(--danger);
                    color: white;
                    font-size: 9px;
                    font-weight: 700;
                    padding: 1px 6px;
                    border-radius: 50%;
                    min-width: 18px;
                    text-align: center;
                    line-height: 1.4;
                }

                /* Mobile More Menu Scrollbar */
                .mobile-more-menu::-webkit-scrollbar {
                    width: 4px;
                }

                .mobile-more-menu::-webkit-scrollbar-track {
                    background: transparent;
                }

                .mobile-more-menu::-webkit-scrollbar-thumb {
                    background: var(--border);
                    border-radius: 2px;
                }

                .mobile-more-menu::-webkit-scrollbar-thumb:hover {
                    background: var(--gray);
                }

                @media (min-width: 769px) {
                    .mobile-nav {
                        display: none !important;
                    }
                    .mobile-more-menu {
                        display: none !important;
                    }
                }
            `}</style>
        </>
    );
}
