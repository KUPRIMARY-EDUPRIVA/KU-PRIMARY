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
    const [schoolLogo, setSchoolLogo] = useState('/Logo.png');
    const [logoLoaded, setLogoLoaded] = useState(true);

    // Cache the resolved avatar URL so a broken Cloudinary URL doesn't
    // cause the <img> to re-render on every keystroke.
    const [avatarUrl, setAvatarUrl] = useState('');
    const [avatarBroken, setAvatarBroken] = useState(false);

    // Load school data
    useEffect(() => {
        if (userData?.schoolId) {
            loadSchoolData();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userData]);

    // Resolve the user's avatar URL.
    // Priority:
    //   1. profileImageUrl  (Cloudinary URL written by Settings.jsx)
    //   2. photoURL         (Firebase Auth photoURL — legacy)
    //   3. photoURL on Firebase Auth currentUser (in case userData lags)
    useEffect(() => {
        const fromProfile = userData?.profileImageUrl || userData?.photoURL || '';
        const fromAuth = currentUser?.photoURL || '';
        const next = (fromProfile || fromAuth || '').trim();

        setAvatarUrl(next);
        setAvatarBroken(false);   // reset on any change of source
    }, [
        userData?.profileImageUrl,
        userData?.photoURL,
        currentUser?.photoURL,
    ]);

    const loadSchoolData = async () => {
        try {
            const schoolDoc = await getDoc(doc(db, 'schools', userData.schoolId));
            if (schoolDoc.exists()) {
                const data = schoolDoc.data();
                setSchoolName(data.schoolName || data.name || 'EduPriva');
                if (data.logoUrl && data.logoUrl.trim() !== '') {
                    setSchoolLogo(data.logoUrl);
                    setLogoLoaded(true);
                } else {
                    setSchoolLogo('/Logo.png');
                    setLogoLoaded(true);
                }
            }
        } catch (error) {
            console.error('Error loading school data:', error);
            setSchoolLogo('/Logo.png');
            setLogoLoaded(true);
        }
    };

    const getInitials = () => {
        if (userData?.firstName) return userData.firstName.charAt(0).toUpperCase();
        if (userData?.fullName) return userData.fullName.charAt(0).toUpperCase();
        if (userData?.email) return userData.email.charAt(0).toUpperCase();
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
            '#fd7e14', '#e83e8c',
        ];
        const index = (initials || 'U').charCodeAt(0) % colors.length;
        return colors[index];
    };

    /**
     * Compact display name for mobile / narrow viewports.
     *
     * Rule: take the FIRST word of the school name and append " SCHOOL".
     *   "KENYATTA PREPARATORY ACADEMY" -> "KENYATTA SCHOOL"
     *   "St. Mary's Boys High School"  -> "St. Mary's SCHOOL"
     *   "Nairobi Primary"              -> "Nairobi SCHOOL"
     *   "EduPriva"                     -> "EduPriva"  (single word)
     */
    const getShortSchoolName = (name) => {
        if (!name) return 'EduPriva';
        const trimmed = String(name).trim();
        if (!trimmed) return 'EduPriva';

        const parts = trimmed.split(/\s+/);
        if (parts.length <= 1) return trimmed;

        return `${parts[0]} SCHOOL`;
    };

    const isSuperAdmin = userRole === 'super-admin';

    const handleProfileClick = () => navigate('/settings');

    const handleLogoError = (e) => {
        e.target.style.display = 'none';
        setLogoLoaded(false);
    };

    const handleAvatarError = () => {
        // If the Cloudinary URL fails (deleted asset, expired account,
        // etc.), fall back to initials.
        setAvatarBroken(true);
    };

    const showPhoto = !!avatarUrl && !avatarBroken;
    const initials = getInitials();
    const avatarBg = getAvatarColor(initials);

    return (
        <header className="header">
            {/* Left — Menu Button */}
            <button className="menu-btn" onClick={toggleSideNav} aria-label="Toggle menu">
                <i className="fas fa-bars" aria-hidden="true"></i>
            </button>

            {/* Center — School Logo & Name */}
            <div
                className="logo-container"
                onClick={() => navigate('/dashboard')}
                role="link"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate('/dashboard'); }}
            >
                {logoLoaded && schoolLogo && (
                    <img
                        src={schoolLogo}
                        alt={`${schoolName} Logo`}
                        className="logo-img"
                        onError={handleLogoError}
                    />
                )}
                <div className="school-name-header" title={schoolName}>{schoolName}</div>
                <div className="school-name-short" title={schoolName}>
                    {getShortSchoolName(schoolName)}
                </div>
            </div>

            {/* Right — User Profile & Role */}
            <div className="user-menu">
                {isSuperAdmin && <span className="admin-badge platform">PLATFORM</span>}
                {userRole === 'admin' && <span className="admin-badge admin">ADMIN</span>}
                {userRole === 'teacher' && <span className="admin-badge teacher">TEACHER</span>}
                {userRole === 'student' && <span className="admin-badge student">STUDENT</span>}

                <div
                    className="user-avatar"
                    title={getFullName()}
                    onClick={handleProfileClick}
                    style={{
                        cursor: 'pointer',
                        backgroundColor: showPhoto ? undefined : avatarBg,
                    }}
                >
                    {showPhoto ? (
                        <img
                            src={avatarUrl}
                            alt="Profile"
                            className="user-avatar-img"
                            onError={handleAvatarError}
                        />
                    ) : (
                        <span
                            style={{
                                backgroundColor: avatarBg,
                                width: '100%',
                                height: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'white',
                                fontWeight: '600',
                                fontSize: '18px',
                            }}
                        >
                            {initials}
                        </span>
                    )}
                </div>
            </div>
        </header>
    );
};

export default Header;
