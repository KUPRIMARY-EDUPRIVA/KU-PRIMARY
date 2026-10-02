// src/components/Layout/Header.jsx
import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { db } from '../../firebase';
import { doc, getDoc } from 'firebase/firestore';
import './Layout.css';

const Header = ({ toggleSideNav }) => {
    const { currentUser, userData, userRole } = useAuth();
    const navigate = useNavigate();
    
    const [schoolName, setSchoolName] = useState('EduPriva');
    const [schoolLogo, setSchoolLogo] = useState('/Logo.png'); // Changed to Logo.png
    const [logoLoaded, setLogoLoaded] = useState(true);

    // Load school data
    useEffect(() => {
        if (userData?.schoolId) {
            loadSchoolData();
        }
    }, [userData]);

    const loadSchoolData = async () => {
        try {
            const schoolDoc = await getDoc(doc(db, 'schools', userData.schoolId));
            if (schoolDoc.exists()) {
                const data = schoolDoc.data();
                setSchoolName(data.schoolName || data.name || 'EduPriva');
                // Check if logoUrl exists and is not empty
                if (data.logoUrl && data.logoUrl.trim() !== '') {
                    setSchoolLogo(data.logoUrl);
                    setLogoLoaded(true);
                } else {
                    // Use default platform logo
                    setSchoolLogo('/Logo.png');
                    setLogoLoaded(true);
                }
            }
        } catch (error) {
            console.error('Error loading school data:', error);
            // Fallback to default logo
            setSchoolLogo('/Logo.png');
            setLogoLoaded(true);
        }
    };

    const getInitials = () => {
        if (userData?.firstName) {
            return userData.firstName.charAt(0).toUpperCase();
        }
        if (userData?.fullName) {
            return userData.fullName.charAt(0).toUpperCase();
        }
        if (userData?.email) {
            return userData.email.charAt(0).toUpperCase();
        }
        return 'U';
    };

    const getFullName = () => {
        if (userData?.fullName) return userData.fullName;
        if (userData?.firstName && userData?.lastName) {
            return `${userData.firstName} ${userData.lastName}`;
        }
        if (userData?.firstName) return userData.firstName;
        return 'User';
    };

    const getAvatarColor = (initials) => {
        const colors = [
            '#1034A6', '#0c2a7a', '#28a745', '#dc3545', 
            '#ffc107', '#6f42c1', '#17a2b8', '#20c997',
            '#fd7e14', '#e83e8c'
        ];
        const index = initials.charCodeAt(0) % colors.length;
        return colors[index];
    };

    // Return a compact name for mobile display.
    // Examples:
    //   "KENYATTA PREPARATORY ACADEMY" -> "KENYATTA SCHOOL"
    //   "St. Mary's Boys High School"  -> "St. Mary's SCHOOL"
    //   "EduPriva"                      -> "EduPriva"
    //   "Nairobi Primary"               -> "Nairobi SCHOOL"
    const getShortSchoolName = (name) => {
        if (!name) return 'EduPriva';
        const trimmed = String(name).trim();
        const parts = trimmed.split(/\s+/);
        if (parts.length <= 1) return trimmed;

        // Common suffix words we don't want to include in the short form
        const skipWords = new Set([
            'primary', 'secondary', 'preparatory', 'prep', 'academy',
            'school', 'high', 'junior', 'senior', 'mixed', 'girls', 'boys',
            'integrated', 'day', 'boarding',
        ]);

        // Walk back from the start to find the first meaningful word —
        // this preserves multi-word proper names like "St. Mary's".
        let startIdx = 0;
        while (
            startIdx < parts.length - 1 &&
            skipWords.has(parts[startIdx].toLowerCase())
        ) {
            startIdx++;
        }

        // Grab from startIdx up to (but excluding) the first suffix word
        const taken = [];
        for (let i = startIdx; i < parts.length; i++) {
            if (skipWords.has(parts[i].toLowerCase())) break;
            taken.push(parts[i]);
        }

        // If we took nothing (e.g. name was all suffix words), fall back to the first word
        const base = taken.length > 0 ? taken.join(' ') : parts[0];
        return `${base} SCHOOL`;
    };

    // Check if user is super admin
    const isSuperAdmin = userRole === 'super-admin';

    // Handle profile click - navigate to settings
    const handleProfileClick = () => {
        navigate('/settings');
    };

    // Handle logo error - fallback to platform logo
    const handleLogoError = (e) => {
        e.target.style.display = 'none';
        setLogoLoaded(false);
    };

    return (
        <header className="header">
            {/* Left - Menu Button */}
            <button className="menu-btn" onClick={toggleSideNav} aria-label="Toggle menu">
                <i className="fas fa-bars"></i>
            </button>
            
            {/* Center - School Logo & Name */}
            <div className="logo-container" onClick={() => navigate('/dashboard')}>
                {logoLoaded && schoolLogo && (
                    <img 
                        src={schoolLogo} 
                        alt={`${schoolName} Logo`} 
                        className="logo-img" 
                        onError={handleLogoError}
                    />
                )}
                <div className="school-name-header">{schoolName}</div>
                <div className="school-name-short">{getShortSchoolName(schoolName)}</div>
            </div>
            
            {/* Right - User Profile & Role */}
            <div className="user-menu">
                {/* Role Badge */}
                {isSuperAdmin && <span className="admin-badge platform">PLATFORM</span>}
                {userRole === 'admin' && <span className="admin-badge admin">ADMIN</span>}
                {userRole === 'teacher' && <span className="admin-badge teacher">TEACHER</span>}
                {userRole === 'student' && <span className="admin-badge student">STUDENT</span>}
                
                {/* User Avatar - Click to go to Settings */}
                <div 
                    className="user-avatar" 
                    title={getFullName()}
                    onClick={handleProfileClick}
                    style={{ cursor: 'pointer' }}
                >
                    {userData?.photoURL ? (
                        <img 
                            src={userData.photoURL} 
                            alt="Profile" 
                            className="user-avatar-img"
                            onError={(e) => {
                                e.target.style.display = 'none';
                                e.target.parentElement.style.backgroundColor = getAvatarColor(getInitials());
                                e.target.parentElement.textContent = getInitials();
                            }}
                        />
                    ) : (
                        <span style={{ 
                            backgroundColor: getAvatarColor(getInitials()),
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'white',
                            fontWeight: '600',
                            fontSize: '18px'
                        }}>
                            {getInitials()}
                        </span>
                    )}
                </div>
            </div>
        </header>
    );
};

export default Header;
