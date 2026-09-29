// src/components/Layout/Layout.jsx
import React, { useState, useRef, useEffect } from 'react';
import Header from './Header';
import Sidebar from './Sidebar';
import SyncStatus from '../Common/SyncStatus';
import EduprivaChatbot from '../Common/EduprivaChatbot';
import { useAuth } from '../../context/AuthContext';
import { useLocation } from 'react-router-dom';
import { useNotifications } from '../../context/NotificationContext';
import './Layout.css';

export default function Layout({ children, title = 'Dashboard Overview' }) {
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [showNotifications, setShowNotifications] = useState(false);
    const [chatbotVisible, setChatbotVisible] = useState(true);
    const { currentUser, userData } = useAuth();
    const location = useLocation();
    const { notifications, unreadCount, markAsRead, markAllAsRead, formatTimeAgo } = useNotifications();
    const notificationRef = useRef(null);

    // Close notification dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (notificationRef.current && !notificationRef.current.contains(event.target)) {
                setShowNotifications(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Get icon based on route (kept for the subheader)
    const getPageIcon = () => {
        const path = location.pathname;
        const iconMap = {
            '/dashboard': 'fa-tachometer-alt',
            '/students': 'fa-user-graduate',
            '/teachers': 'fa-chalkboard-teacher',
            '/exams': 'fa-file-alt',
            '/results': 'fa-chart-line',
            '/reports': 'fa-chart-pie',
            '/studentreports': 'fa-file-pdf',
            '/subscription': 'fa-credit-card',
            '/school-profile': 'fa-school',
            '/teacher-dashboard': 'fa-chalkboard-teacher',
            '/teacher-profile': 'fa-user',
            '/teacher-reports': 'fa-file-alt',
            '/transport': 'fa-bus',
            '/accomodation': 'fa-house',
            '/health': 'fa-heart-pulse',
            '/inventory': 'fa-boxes',
            '/fees': 'fa-coins',
            '/settings': 'fa-user-cog',
            '/platformtower': 'fa-crown',
            '/platform-admin/schools': 'fa-school',
            '/platform-admin/users': 'fa-users-cog',
            '/platform-admin/settings': 'fa-cog',
            '/sms': 'fa-sms',
            '/mydashboard': 'fa-chalkboard-teacher',
            '/my-students': 'fa-user-graduate',
            '/my-results': 'fa-chart-line',
            '/myreports': 'fa-file-alt',
            '/student-dashboard': 'fa-user-graduate',
            '/student-results': 'fa-chart-line',
            '/student-fees': 'fa-coins',
        };
        return iconMap[path] || 'fa-tachometer-alt';
    };

    // Get user display name
    const getUserName = () => {
        if (userData?.fullName) return userData.fullName;
        if (userData?.firstName) return userData.firstName;
        if (currentUser?.displayName) return currentUser.displayName;
        if (userData?.email) return userData.email.split('@')[0];
        return 'User';
    };

    const getInitials = () => {
        const name = getUserName();
        if (name === 'User') return 'U';
        return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    };

    const toggleSidebar = () => {
        setSidebarOpen(!sidebarOpen);
    };

    const closeSidebar = () => {
        setSidebarOpen(false);
    };

    const toggleNotifications = () => {
        setShowNotifications(!showNotifications);
    };

    const handleNotificationClick = (notification) => {
        markAsRead(notification.id);
        if (notification.link) {
            // Use navigate if available, or window.location
            window.location.href = notification.link;
            setShowNotifications(false);
        }
    };

    const getNotificationIcon = (type) => {
        const iconMap = {
            'student_added': 'fa-user-graduate',
            'student_updated': 'fa-user-edit',
            'student_promoted': 'fa-arrow-up',
            'teacher_added': 'fa-chalkboard-teacher',
            'teacher_invited': 'fa-envelope',
            'exam_created': 'fa-file-alt',
            'exam_published': 'fa-upload',
            'results_entry': 'fa-chart-line',
            'results_published': 'fa-chart-bar',
            'subscription_updated': 'fa-credit-card'
        };
        return iconMap[type] || 'fa-bell';
    };

    const getNotificationColor = (type) => {
        const colorMap = {
            'student_added': '#4a5fc1',
            'student_updated': '#3498db',
            'student_promoted': '#27ae60',
            'teacher_added': '#f5576c',
            'teacher_invited': '#f39c12',
            'exam_created': '#4facfe',
            'exam_published': '#27ae60',
            'results_entry': '#8e44ad',
            'results_published': '#2ecc71',
            'subscription_updated': '#9b59b6'
        };
        return colorMap[type] || '#1a237e';
    };

    return (
        <div className="app-container">
            {/* Header with menu toggle */}
            <Header toggleSideNav={toggleSidebar} />
            
            {/* Sidebar with overlay */}
            <Sidebar isOpen={sidebarOpen} onClose={closeSidebar} />

            {/* Edupriva AI Chatbot Widget */}
            {chatbotVisible && <EduprivaChatbot onClose={() => setChatbotVisible(false)} />}
            
            {/* Main Content */}
            <div className="layout-main">
                {/* PAGE SUBHEADER */}
                <div className="page-subheader-wrapper">
                    <div className="page-subheader">
                        <div className="subheader-left">
                            <i className={`fas ${getPageIcon()} subheader-icon`}></i>
                            <h1 className="subheader-title">{title}</h1>
                        </div>
                        <div className="subheader-right">
                            {/* Sync Status */}
                            <SyncStatus />

                            {!chatbotVisible && (
                                <button
                                    className="subheader-notification-btn"
                                    onClick={() => setChatbotVisible(true)}
                                    aria-label="Show LABAN assistant"
                                    title="Show LABAN assistant"
                                >
                                    <i className="fas fa-comment-dots"></i>
                                </button>
                            )}
                            
                            {/* Notifications */}
                            <div className="subheader-notification-wrapper" ref={notificationRef}>
                                <button 
                                    className="subheader-notification-btn"
                                    onClick={toggleNotifications}
                                    aria-label="Notifications"
                                >
                                    <i className="fas fa-bell"></i>
                                    {unreadCount > 0 && (
                                        <span className="subheader-notification-badge">
                                            {unreadCount > 99 ? '99+' : unreadCount}
                                        </span>
                                    )}
                                </button>

                                {/* Notification Dropdown */}
                                {showNotifications && (
                                    <div className="subheader-notification-dropdown">
                                        <div className="subheader-notification-header">
                                            <h3>Notifications</h3>
                                            {unreadCount > 0 && (
                                                <button 
                                                    className="subheader-mark-all-read"
                                                    onClick={markAllAsRead}
                                                >
                                                    Mark all as read
                                                </button>
                                            )}
                                        </div>
                                        <div className="subheader-notification-list">
                                            {notifications.length === 0 ? (
                                                <div className="subheader-notification-empty">
                                                    <i className="fas fa-bell-slash"></i>
                                                    <p>No notifications yet</p>
                                                </div>
                                            ) : (
                                                notifications.slice(0, 10).map((notification) => (
                                                    <div 
                                                        key={notification.id}
                                                        className={`subheader-notification-item ${!notification.read ? 'unread' : ''}`}
                                                        onClick={() => handleNotificationClick(notification)}
                                                    >
                                                        <div 
                                                            className="subheader-notification-icon"
                                                            style={{ backgroundColor: getNotificationColor(notification.type) }}
                                                        >
                                                            <i className={`fas ${getNotificationIcon(notification.type)}`}></i>
                                                        </div>
                                                        <div className="subheader-notification-content">
                                                            <div className="subheader-notification-title">{notification.title}</div>
                                                            <div className="subheader-notification-message">{notification.message}</div>
                                                            <div className="subheader-notification-time">
                                                                {formatTimeAgo(notification.timestamp)}
                                                            </div>
                                                        </div>
                                                        {!notification.read && (
                                                            <div className="subheader-notification-unread-dot"></div>
                                                        )}
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                        {notifications.length > 10 && (
                                            <div className="subheader-notification-footer">
                                                <button 
                                                    className="subheader-view-all-btn"
                                                    onClick={() => {
                                                        setShowNotifications(false);
                                                        window.location.href = '/notifications';
                                                    }}
                                                >
                                                    View all notifications
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* CONTENT AREA */}
                <main className="content-area">
                    {children}
                </main>
            </div>

            {/* Notification Dropdown CSS */}
            <style>{`
                .subheader-notification-wrapper {
                    position: relative;
                }

                .subheader-notification-dropdown {
                    position: absolute;
                    top: 42px;
                    right: 0;
                    width: 380px;
                    max-height: 460px;
                    background: white;
                    border-radius: 12px;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
                    z-index: 1000;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    animation: slideDown 0.25s ease;
                }

                @keyframes slideDown {
                    from {
                        opacity: 0;
                        transform: translateY(-10px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .subheader-notification-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 14px 18px;
                    border-bottom: 1px solid #e0e0e0;
                }

                .subheader-notification-header h3 {
                    font-size: 15px;
                    font-weight: 600;
                    color: #333;
                    margin: 0;
                }

                .subheader-mark-all-read {
                    border: none;
                    background: transparent;
                    color: #1a237e;
                    font-size: 12px;
                    font-weight: 500;
                    cursor: pointer;
                    padding: 4px 8px;
                    border-radius: 4px;
                    transition: all 0.2s;
                }

                .subheader-mark-all-read:hover {
                    background: #e8eaf6;
                }

                .subheader-notification-list {
                    flex: 1;
                    overflow-y: auto;
                    max-height: 360px;
                }

                .subheader-notification-list::-webkit-scrollbar {
                    width: 4px;
                }

                .subheader-notification-list::-webkit-scrollbar-thumb {
                    background: #d0d0d0;
                    border-radius: 4px;
                }

                .subheader-notification-empty {
                    text-align: center;
                    padding: 35px 20px;
                    color: #999;
                }

                .subheader-notification-empty i {
                    font-size: 32px;
                    display: block;
                    margin-bottom: 10px;
                    color: #ddd;
                }

                .subheader-notification-empty p {
                    margin: 0;
                    font-size: 13px;
                }

                .subheader-notification-item {
                    display: flex;
                    align-items: flex-start;
                    gap: 12px;
                    padding: 12px 18px;
                    cursor: pointer;
                    transition: all 0.2s;
                    border-bottom: 1px solid #f0f0f0;
                    position: relative;
                }

                .subheader-notification-item:hover {
                    background: #f8f9fa;
                }

                .subheader-notification-item.unread {
                    background: #f0f4ff;
                }

                .subheader-notification-item.unread:hover {
                    background: #e8edf5;
                }

                .subheader-notification-icon {
                    width: 34px;
                    height: 34px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    font-size: 13px;
                    flex-shrink: 0;
                    margin-top: 2px;
                }

                .subheader-notification-content {
                    flex: 1;
                    min-width: 0;
                }

                .subheader-notification-title {
                    font-size: 13px;
                    font-weight: 600;
                    color: #333;
                    margin-bottom: 2px;
                }

                .subheader-notification-message {
                    font-size: 12px;
                    color: #666;
                    line-height: 1.4;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }

                .subheader-notification-time {
                    font-size: 10px;
                    color: #999;
                    margin-top: 4px;
                }

                .subheader-notification-unread-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #1a237e;
                    flex-shrink: 0;
                    margin-top: 14px;
                }

                .subheader-notification-footer {
                    padding: 10px 18px;
                    border-top: 1px solid #e0e0e0;
                    text-align: center;
                }

                .subheader-view-all-btn {
                    border: none;
                    background: transparent;
                    color: #1a237e;
                    font-size: 13px;
                    font-weight: 500;
                    cursor: pointer;
                    padding: 6px 12px;
                    border-radius: 4px;
                    transition: all 0.2s;
                }

                .subheader-view-all-btn:hover {
                    background: #e8eaf6;
                }

                @media (max-width: 480px) {
                    .subheader-notification-dropdown {
                        width: 310px;
                        right: -60px;
                    }
                }

                @media (max-width: 360px) {
                    .subheader-notification-dropdown {
                        width: 270px;
                        right: -70px;
                    }
                }

                /* Dark mode support */
                @media (prefers-color-scheme: dark) {
                    .subheader-notification-dropdown {
                        background: #1a1a2e;
                    }

                    .subheader-notification-header {
                        border-bottom-color: #2d2d44;
                    }

                    .subheader-notification-header h3 {
                        color: #e0e0e0;
                    }

                    .subheader-mark-all-read {
                        color: #5c6bc0;
                    }

                    .subheader-mark-all-read:hover {
                        background: #2d2d44;
                    }

                    .subheader-notification-item {
                        border-bottom-color: #2d2d44;
                    }

                    .subheader-notification-item:hover {
                        background: #2d2d44;
                    }

                    .subheader-notification-item.unread {
                        background: #1a1a3e;
                    }

                    .subheader-notification-item.unread:hover {
                        background: #252545;
                    }

                    .subheader-notification-title {
                        color: #e0e0e0;
                    }

                    .subheader-notification-message {
                        color: #aaa;
                    }

                    .subheader-notification-time {
                        color: #666;
                    }

                    .subheader-notification-empty {
                        color: #666;
                    }

                    .subheader-notification-empty i {
                        color: #444;
                    }

                    .subheader-notification-footer {
                        border-top-color: #2d2d44;
                    }

                    .subheader-view-all-btn {
                        color: #5c6bc0;
                    }

                    .subheader-view-all-btn:hover {
                        background: #2d2d44;
                    }
                }
            `}</style>
        </div>
    );
}
