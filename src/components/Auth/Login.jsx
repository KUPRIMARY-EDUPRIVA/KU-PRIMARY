// src/components/Auth/Login.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import {
    getAuth, signInWithEmailAndPassword, sendPasswordResetEmail,
    createUserWithEmailAndPassword, updateProfile, sendEmailVerification,
} from 'firebase/auth';
import { db } from '../../firebase';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { useSync } from '../../context/SyncContext';

// ---- Cloudinary config (from env) ----
const CLOUDINARY_CLOUD_NAME = process.env.REACT_APP_CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_UPLOAD_PRESET = process.env.REACT_APP_CLOUDINARY_UPLOAD_PRESET;

// ---- Unsigned upload to Cloudinary ----
async function uploadToCloudinary(file) {
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
        throw new Error(
            'Cloudinary is not configured. Set REACT_APP_CLOUDINARY_CLOUD_NAME and REACT_APP_CLOUDINARY_UPLOAD_PRESET.'
        );
    }
    const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
    const form = new FormData();
    form.append('file', file);
    form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    // Optional: put uploads in a folder
    form.append('folder', 'edupriva/schools');

    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.json())?.error?.message || ''; } catch {}
        throw new Error(`Cloudinary upload failed (${res.status}) ${detail}`.trim());
    }
    const data = await res.json();
    // secure_url is the https URL; url is http
    return data.secure_url || data.url;
}

export default function Login() {
    const navigate = useNavigate();
    const { login } = useAuth();
    const { isOnline, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();

    const auth = getAuth();

    // ---- Login / signup form state ----
    const [loginEmail, setLoginEmail] = useState('');
    const [loginPassword, setLoginPassword] = useState('');
    const [signupSchoolName, setSignupSchoolName] = useState('');
    const [signupAdminFullName, setSignupAdminFullName] = useState('');
    const [signupEmail, setSignupEmail] = useState('');
    const [signupPassword, setSignupPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [termsAgreement, setTermsAgreement] = useState(false);

    // ---- UI state ----
    const [activeTab, setActiveTab] = useState('login');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState({ text: '', type: '' });
    const [emailValid, setEmailValid] = useState(null);
    const [signupEmailValid, setSignupEmailValid] = useState(null);
    const [passwordsMatch, setPasswordsMatch] = useState(null);
    const [showVerification, setShowVerification] = useState(false);
    const [verificationEmail, setVerificationEmail] = useState('');
    const [verificationTimer, setVerificationTimer] = useState(30);
    const [showRegister, setShowRegister] = useState(false);

    // ---- Upload state (File objects + previews) ----
    const [logoFile, setLogoFile] = useState(null);
    const [profileFile, setProfileFile] = useState(null);
    const [logoPreview, setLogoPreview] = useState(null);
    const [profilePreview, setProfilePreview] = useState(null);
    const [offlineMode, setOfflineMode] = useState(false);
    const [cachedUsers, setCachedUsers] = useState([]);

    const verificationIntervalRef = useRef(null);
    const timerIntervalRef = useRef(null);
    const fileInputRef = useRef(null);

    // ---- Lifecycle / network ----
    useEffect(() => {
        if (!isOnline) {
            setOfflineMode(true);
            loadCachedUsers();
            showMessage('You are offline. Login may be limited.', 'warning');
        }
    }, [isOnline]);

    useEffect(() => {
        const handleOnline = () => {
            setOfflineMode(false);
            showMessage('Back online! You can now login normally.', 'success');
        };
        const handleOffline = () => {
            setOfflineMode(true);
            showMessage('You are offline. Some features may be limited.', 'warning');
        };
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    useEffect(() => {
        return () => {
            if (verificationIntervalRef.current) clearInterval(verificationIntervalRef.current);
            if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
        };
    }, []);

    // ---- Cache helpers ----
    const loadCachedUsers = async () => {
        try {
            const cached = await getFromIndexedDB('cached_users');
            if (cached) setCachedUsers(cached);
        } catch (error) {
            console.error('Error loading cached users:', error);
        }
    };

    const cacheUserData = async (userData) => {
        try {
            const cached = (await getFromIndexedDB('cached_users')) || [];
            const existing = cached.findIndex((u) => u.uid === userData.uid);
            if (existing >= 0) {
                cached[existing] = { ...cached[existing], ...userData, cachedAt: new Date().toISOString() };
            } else {
                cached.push({ ...userData, cachedAt: new Date().toISOString() });
            }
            await saveToIndexedDB('cached_users', cached);
            setCachedUsers(cached);
        } catch (error) {
            console.error('Error caching user data:', error);
        }
    };

    // ---- Validation ----
    const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    const handleLoginEmailChange = (e) => {
        const email = e.target.value;
        setLoginEmail(email);
        setEmailValid(email === '' ? null : validateEmail(email));
    };

    const handleSignupEmailChange = (e) => {
        const email = e.target.value;
        setSignupEmail(email);
        setSignupEmailValid(email === '' ? null : validateEmail(email));
    };

    const handleConfirmPasswordChange = (e) => {
        const confirm = e.target.value;
        setConfirmPassword(confirm);
        setPasswordsMatch(confirm === '' ? null : signupPassword === confirm);
    };

    // ---- Image picker (stores File + preview, no base64 in Firestore) ----
    const handleImageUpload = (type) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/gif,image/webp';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (file.size > 2 * 1024 * 1024) {
                showMessage('Image must be under 2MB', 'error');
                return;
            }

            if (type === 'logo') setLogoFile(file);
            else setProfileFile(file);

            const reader = new FileReader();
            reader.onloadend = () => {
                if (type === 'logo') setLogoPreview(reader.result);
                else setProfilePreview(reader.result);
                showMessage('✅ Image selected', 'success');
            };
            reader.readAsDataURL(file);
        };
        input.click();
    };

    // ---- Message helpers ----
    const showMessage = (text, type = 'info') => {
        setMessage({ text, type });
        if (type === 'success' && !text.includes('Redirecting')) {
            setTimeout(() => setMessage({ text: '', type: '' }), 5000);
        }
    };
    const clearMessages = () => setMessage({ text: '', type: '' });

    // ---- Misc ----
    const generateSchoolId = (schoolName) => {
        const timestamp = Date.now().toString(36);
        const randomStr = Math.random().toString(36).substring(2, 6);
        const nameCode = schoolName.substring(0, 3).toUpperCase();
        return `${nameCode}-${timestamp}-${randomStr}`;
    };

    const findUserDocument = async (uid, email) => {
        if (isOnline) {
            try {
                const userDoc = await getDoc(doc(db, 'users', uid));
                if (userDoc.exists()) {
                    const data = userDoc.data();
                    await cacheUserData({ uid, ...data, collection: 'users' });
                    return { collection: 'users', docId: uid, data };
                }
                const teacherDoc = await getDoc(doc(db, 'teachers', uid));
                if (teacherDoc.exists()) {
                    const data = teacherDoc.data();
                    await cacheUserData({ uid, ...data, collection: 'teachers' });
                    return { collection: 'teachers', docId: uid, data };
                }
                const studentDoc = await getDoc(doc(db, 'students', uid));
                if (studentDoc.exists()) {
                    const data = studentDoc.data();
                    await cacheUserData({ uid, ...data, collection: 'students' });
                    return { collection: 'students', docId: uid, data };
                }
            } catch (error) {
                console.error('Error checking collections:', error);
            }
        }
        const cachedUser = cachedUsers.find((u) => u.uid === uid || u.email === email);
        if (cachedUser) {
            return { collection: cachedUser.collection || 'users', docId: cachedUser.uid, data: cachedUser };
        }
        return null;
    };

    const sendVerificationEmail = async (user) => {
        try { await sendEmailVerification(user); return true; }
        catch (error) { console.error('Error sending verification email:', error); return false; }
    };

    const checkEmailVerification = async () => {
        const user = auth.currentUser;
        if (!user) {
            showMessage('Session expired. Please login again.', 'error');
            setShowVerification(false);
            return;
        }
        try {
            await user.reload();
            if (user.emailVerified) {
                if (verificationIntervalRef.current) clearInterval(verificationIntervalRef.current);
                if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);

                const userData = await findUserDocument(user.uid, user.email);
                if (userData) {
                    const { collection, docId, data } = userData;
                    if (isOnline) {
                        await updateDoc(doc(db, collection, docId), {
                            emailVerified: true,
                            verifiedAt: serverTimestamp(),
                            updatedAt: serverTimestamp(),
                        });
                    }
                    await cacheUserData({
                        ...data, uid: user.uid, email: user.email,
                        emailVerified: true, collection,
                    });
                    showMessage('✅ Email verified successfully! Redirecting to dashboard...', 'success');
                    sessionStorage.setItem('userRole', collection);
                    sessionStorage.setItem('userId', docId);
                    setTimeout(() => navigateToDashboard(collection), 2000);
                } else {
                    if (isOnline) {
                        await setDoc(doc(db, 'users', user.uid), {
                            uid: user.uid, email: user.email, role: 'user',
                            emailVerified: true,
                            verifiedAt: serverTimestamp(),
                            createdAt: serverTimestamp(),
                            updatedAt: serverTimestamp(),
                        });
                    }
                    await cacheUserData({
                        uid: user.uid, email: user.email, role: 'user',
                        emailVerified: true, collection: 'users',
                    });
                    showMessage('✅ Email verified successfully! Redirecting to dashboard...', 'success');
                    setTimeout(() => navigateToDashboard('users'), 2000);
                }
            }
        } catch (error) {
            console.error('Error checking email verification:', error);
            showMessage('Error checking verification status. Please try again.', 'error');
        }
    };

    const navigateToDashboard = (collection) => {
        switch (collection) {
            case 'teachers': navigate('/teacher-dashboard'); break;
            case 'students': navigate('/student-dashboard'); break;
            case 'users':
            default: navigate('/dashboard'); break;
        }
    };

    const startVerificationCheck = (email) => {
        setVerificationEmail(email);
        setShowVerification(true);
        setVerificationTimer(30);

        timerIntervalRef.current = setInterval(() => {
            setVerificationTimer((prev) => {
                if (prev <= 1) {
                    clearInterval(timerIntervalRef.current);
                    checkEmailVerification();
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);

        verificationIntervalRef.current = setInterval(checkEmailVerification, 30000);
    };

    const handleResendVerification = async () => {
        const user = auth.currentUser;
        if (!user) {
            showMessage('Session expired. Please login again.', 'error');
            setShowVerification(false);
            return;
        }
        try {
            await sendEmailVerification(user);
            showMessage('✅ Verification email resent! Check your inbox.', 'success');
            setVerificationTimer(30);
        } catch {
            showMessage('Failed to resend verification email', 'error');
        }
    };

    const toggleRegister = () => {
        setShowRegister(!showRegister);
        clearMessages();
        if (!showRegister) {
            setSignupSchoolName('');
            setSignupAdminFullName('');
            setSignupEmail('');
            setSignupPassword('');
            setConfirmPassword('');
            setTermsAgreement(false);
            setLogoFile(null);
            setProfileFile(null);
            setLogoPreview(null);
            setProfilePreview(null);
            setSignupEmailValid(null);
            setPasswordsMatch(null);
        }
    };

    // ---- Login ----
    const handleLogin = async (e) => {
        e.preventDefault();
        clearMessages();

        if (!validateEmail(loginEmail)) {
            showMessage('Please enter a valid email address', 'error');
            return;
        }
        if (loginPassword.length < 6) {
            showMessage('Password must be at least 6 characters', 'error');
            return;
        }
        setLoading(true);
        try {
            if (!isOnline) {
                const cachedUser = cachedUsers.find((u) => u.email === loginEmail);
                if (cachedUser) {
                    showMessage('✅ Offline login successful! Limited functionality available.', 'success');
                    sessionStorage.setItem('userRole', cachedUser.collection || 'users');
                    sessionStorage.setItem('userId', cachedUser.uid);
                    sessionStorage.setItem('offlineMode', 'true');
                    setTimeout(() => navigateToDashboard(cachedUser.collection || 'users'), 2000);
                    setLoading(false);
                    return;
                } else {
                    showMessage('Offline: No cached credentials found. Please connect to the internet.', 'error');
                    setLoading(false);
                    return;
                }
            }

            const userCredential = await signInWithEmailAndPassword(auth, loginEmail, loginPassword);
            const user = userCredential.user;

            if (!user.emailVerified) {
                showMessage('⚠️ Please verify your email address to access the dashboard.', 'warning');
                startVerificationCheck(user.email);
                await sendVerificationEmail(user);
                setLoading(false);
                return;
            }

            const userData = await findUserDocument(user.uid, loginEmail);
            if (userData) {
                const { collection, docId } = userData;
                if (isOnline) {
                    await updateDoc(doc(db, collection, docId), { lastLogin: serverTimestamp() });
                }
                await cacheUserData({
                    uid: user.uid, email: loginEmail, collection,
                    ...userData.data,
                });
                sessionStorage.setItem('userRole', collection);
                sessionStorage.setItem('userId', docId);
                const roleDisplay =
                    collection === 'users' ? 'Admin' :
                    collection === 'teachers' ? 'Teacher' : 'Student';
                showMessage(`Welcome ${roleDisplay}! Redirecting to dashboard...`, 'success');
                setTimeout(() => navigateToDashboard(collection), 2000);
            } else {
                if (isOnline) {
                    await setDoc(doc(db, 'users', user.uid), {
                        uid: user.uid, email: loginEmail, role: 'user',
                        fullName: user.displayName || 'User',
                        emailVerified: true,
                        lastLogin: serverTimestamp(),
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    });
                }
                await cacheUserData({
                    uid: user.uid, email: loginEmail, role: 'user',
                    fullName: user.displayName || 'User', collection: 'users',
                });
                sessionStorage.setItem('userRole', 'users');
                sessionStorage.setItem('userId', user.uid);
                showMessage('Welcome! Redirecting to dashboard...', 'success');
                setTimeout(() => navigateToDashboard('users'), 2000);
            }
        } catch (error) {
            let errorMessage = 'Login failed. ';
            switch (error.code) {
                case 'auth/invalid-credential':
                case 'auth/wrong-password': errorMessage = 'Invalid email or password'; break;
                case 'auth/user-not-found': errorMessage = 'No account found with this email'; break;
                case 'auth/user-disabled': errorMessage = 'Account disabled. Contact support'; break;
                case 'auth/too-many-requests': errorMessage = 'Too many attempts. Try again later'; break;
                case 'auth/network-request-failed': errorMessage = 'Network error. Check connection'; break;
                default: errorMessage = 'An unexpected error occurred';
            }
            showMessage(errorMessage, 'error');
        } finally {
            setLoading(false);
        }
    };

    // ---- Signup — now uploads to Cloudinary ----
    const handleSignup = async (e) => {
        e.preventDefault();
        clearMessages();

        if (!isOnline) {
            showMessage('You are offline. Please connect to the internet to register.', 'error');
            return;
        }
        if (!signupSchoolName) { showMessage('Please enter school name', 'error'); return; }
        if (!signupAdminFullName) { showMessage('Please enter admin full name', 'error'); return; }
        if (!logoFile) { showMessage('Please upload school logo', 'error'); return; }
        if (!profileFile) { showMessage('Please upload admin profile picture', 'error'); return; }
        if (!validateEmail(signupEmail)) { showMessage('Please enter a valid email address', 'error'); return; }
        if (signupPassword.length < 6) { showMessage('Password must be at least 6 characters', 'error'); return; }
        if (signupPassword !== confirmPassword) { showMessage('Passwords do not match', 'error'); return; }
        if (!termsAgreement) { showMessage('Please agree to the terms and conditions', 'error'); return; }

        setLoading(true);
        try {
            // 1) Upload images to Cloudinary FIRST (before creating Auth user),
            //    so a failure here doesn't leave an orphaned auth account.
            let logoUrl = '';
            let profileUrl = '';
            try {
                logoUrl = await uploadToCloudinary(logoFile);
                profileUrl = await uploadToCloudinary(profileFile);
            } catch (uploadErr) {
                console.error('Cloudinary upload failed:', uploadErr);
                showMessage(`Image upload failed: ${uploadErr.message}`, 'error');
                setLoading(false);
                return;
            }

            // 2) Create auth user
            const userCredential = await createUserWithEmailAndPassword(auth, signupEmail, signupPassword);
            const user = userCredential.user;

            await updateProfile(user, { displayName: signupAdminFullName });

            const schoolId = generateSchoolId(signupSchoolName);

            // 3) School doc — now only small HTTPS URLs live here
            const schoolData = {
                schoolId,
                schoolName: signupSchoolName,
                logoUrl,              // canonical field used by AuthContext
                schoolLogo: logoUrl,  // alias so StudentReports picks it up directly
                adminName: signupAdminFullName,
                adminImageUrl: profileUrl,
                adminEmail: signupEmail,
                subscriptionStatus: 'inactive',
                trialStartDate: serverTimestamp(),
                trialEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                emailVerified: false,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                settings: {
                    theme: 'default',
                    language: 'en',
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
            };
            await setDoc(doc(db, 'schools', schoolId), schoolData);

            // 4) User doc — same treatment for profile image
            const userData = {
                uid: user.uid,
                schoolId,
                fullName: signupAdminFullName,
                email: signupEmail,
                role: 'admin',
                profileImageUrl: profileUrl,
                emailVerified: false,
                lastLogin: serverTimestamp(),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                permissions: {
                    canManageUsers: true,
                    canManageStudents: true,
                    canManageTeachers: true,
                    canManageClasses: true,
                    canManageFinance: true,
                    canManageSettings: true,
                },
            };
            await setDoc(doc(db, 'users', user.uid), userData);
            await cacheUserData({ ...userData, collection: 'users' });

            const emailSent = await sendVerificationEmail(user);

            // 5) Clear form
            setSignupSchoolName('');
            setSignupAdminFullName('');
            setSignupEmail('');
            setSignupPassword('');
            setConfirmPassword('');
            setLogoFile(null);
            setProfileFile(null);
            setLogoPreview(null);
            setProfilePreview(null);
            setTermsAgreement(false);

            if (emailSent) {
                showMessage(`✅ School account created! Verification email sent to ${signupEmail}`, 'success');
            } else {
                showMessage('Account created but verification email failed. Please try resending.', 'warning');
            }
            startVerificationCheck(signupEmail);
        } catch (error) {
            let errorMessage = 'Registration failed. ';
            switch (error.code) {
                case 'auth/email-already-in-use':
                    errorMessage = 'Email already registered. Please login instead'; break;
                case 'auth/invalid-email':
                    errorMessage = 'Invalid email address'; break;
                case 'auth/weak-password':
                    errorMessage = 'Password is too weak. Use at least 6 characters'; break;
                case 'auth/network-request-failed':
                    errorMessage = 'Network error. Check your connection'; break;
                default:
                    errorMessage += error.message;
            }
            showMessage(errorMessage, 'error');
        } finally {
            setLoading(false);
        }
    };

    // ---- Password reset ----
    const handleForgotPassword = async () => {
        if (!isOnline) {
            alert('You are offline. Please connect to the internet to reset your password.');
            return;
        }
        const email = prompt('Enter your email address to reset password:');
        if (email && validateEmail(email)) {
            try {
                await sendPasswordResetEmail(auth, email);
                alert('✅ Password reset email sent! Check your inbox and spam folder.');
            } catch (error) {
                let errorMessage = 'Error sending reset email. ';
                switch (error.code) {
                    case 'auth/user-not-found': errorMessage = 'No account found with this email'; break;
                    case 'auth/invalid-email': errorMessage = 'Invalid email address'; break;
                    default: errorMessage += error.message;
                }
                alert(errorMessage);
            }
        } else if (email) {
            alert('Please enter a valid email address');
        }
    };

    const handleLogout = async () => {
        try {
            await auth.signOut();
            setShowVerification(false);
            clearMessages();
            showMessage('Logged out successfully', 'info');
        } catch (error) {
            console.error('Error logging out:', error);
        }
    };

    // ---- Render ----
    return (
        <div className="login-container">
            {!isOnline && (
                <div className="offline-indicator">
                    <i className="fas fa-wifi-slash"></i> Offline Mode
                </div>
            )}

            <div className="split-container">
                <div className="left-panel">
                    <div className="image-overlay">
                        <div className="overlay-content">
                            <h1>Welcome Back!</h1>
                            <p>Manage your school efficiently with EduPriva</p>
                            <div className="features-list">
                                <div className="feature-item"><i className="fas fa-users"></i><span>Student Management</span></div>
                                <div className="feature-item"><i className="fas fa-chalkboard-teacher"></i><span>Teacher Management</span></div>
                                <div className="feature-item"><i className="fas fa-file-invoice-dollar"></i><span>Fee & Invoice Tracking</span></div>
                                <div className="feature-item"><i className="fas fa-chart-line"></i><span>Real-time Analytics</span></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="right-panel">
                    <div className="form-wrapper">
                        <div className="header">
                            <div className="logo-container"><div className="logo"></div></div>
                            <h1 className="system-title">EDUPRIVA</h1>
                            <div className="system-subtitle">School Management System</div>
                        </div>

                        <div className="form-container">
                            {showVerification ? (
                                <div className="verification-section">
                                    <div className="verification-icon"><i className="fas fa-envelope-circle-check"></i></div>
                                    <div className="verification-content">
                                        <h3>Verify Your Email Address</h3>
                                        <p>We've sent a verification email to:</p>
                                        <div className="email-display">{verificationEmail}</div>
                                        <p>Please check your inbox and click the verification link to activate your account.</p>
                                        <p><strong>Important:</strong> You must verify your email before accessing the system.</p>
                                        <div className="verification-timer">
                                            <p>Checking verification status automatically in <span className="timer">{verificationTimer}</span> seconds...</p>
                                        </div>
                                        <div className="resend-link">
                                            Didn't receive the email? <span onClick={handleResendVerification}>Resend Verification Email</span>
                                        </div>
                                        <button type="button" className="btn warning" onClick={checkEmailVerification}>
                                            <i className="fas fa-sync-alt"></i><span>Check Verification Status</span>
                                        </button>
                                        <button type="button" className="btn danger" onClick={handleLogout} style={{ marginTop: '10px' }}>
                                            <i className="fas fa-sign-out-alt"></i><span>Logout</span>
                                        </button>
                                        <div className="verification-note">
                                            <p><i className="fas fa-info-circle"></i> Check your spam folder if you don't see the email.</p>
                                            <p>After verification, you'll be automatically redirected to your dashboard.</p>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <h2 className="form-title">{showRegister ? 'Register School' : 'School Portal'}</h2>

                                    {message.text && (
                                        <div className={`message ${message.type}`}>{message.text}</div>
                                    )}

                                    {!showRegister && (
                                        <form className="form active" onSubmit={handleLogin}>
                                            <div className="input-group">
                                                <label htmlFor="loginEmail">Email Address</label>
                                                <i className="fas fa-envelope"></i>
                                                <input
                                                    type="email" id="loginEmail" value={loginEmail}
                                                    onChange={handleLoginEmailChange}
                                                    placeholder="Enter your email" required
                                                />
                                                <div className={`validation-icon ${emailValid === true ? 'valid' : emailValid === false ? 'invalid' : ''}`}>
                                                    {emailValid === true && <i className="fas fa-check-circle"></i>}
                                                    {emailValid === false && <i className="fas fa-exclamation-circle"></i>}
                                                </div>
                                            </div>

                                            <div className="input-group">
                                                <label htmlFor="loginPassword">Password</label>
                                                <i className="fas fa-lock"></i>
                                                <input
                                                    type="password" id="loginPassword" value={loginPassword}
                                                    onChange={(e) => setLoginPassword(e.target.value)}
                                                    placeholder="Enter your password" required
                                                />
                                            </div>

                                            {!isOnline && (
                                                <div style={{ padding: '10px', marginBottom: '15px', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '8px', fontSize: '13px', color: '#856404' }}>
                                                    <i className="fas fa-info-circle"></i> Offline mode: Login with cached credentials
                                                </div>
                                            )}

                                            <button type="submit" className="btn" disabled={loading}>
                                                {loading ? (<><div className="loading"></div><span>Logging in...</span></>) : (<><i className="fas fa-sign-in-alt"></i><span>Login to Dashboard</span></>)}
                                            </button>

                                            <div className="forgot-password" onClick={handleForgotPassword}>Forgot Password?</div>

                                            <div className="toggle-link" onClick={toggleRegister}>
                                                Don't have an account? <span>Register School</span>
                                            </div>
                                        </form>
                                    )}

                                    {showRegister && (
                                        <form className="form active" onSubmit={handleSignup}>
                                            <div className="input-group">
                                                <label htmlFor="schoolName">School Name</label>
                                                <i className="fas fa-school"></i>
                                                <input
                                                    type="text" id="schoolName" value={signupSchoolName}
                                                    onChange={(e) => setSignupSchoolName(e.target.value)}
                                                    placeholder="Enter school name" required
                                                />
                                            </div>

                                            <div className="input-group">
                                                <label htmlFor="adminFullName">Admin Full Name</label>
                                                <i className="fas fa-user-tie"></i>
                                                <input
                                                    type="text" id="adminFullName" value={signupAdminFullName}
                                                    onChange={(e) => setSignupAdminFullName(e.target.value)}
                                                    placeholder="Enter admin full name" required
                                                />
                                            </div>

                                            <div className="file-upload-container">
                                                <label>School Logo</label>
                                                <div className="upload-preview">
                                                    <div className="logo-preview">
                                                        {logoPreview ? (<img src={logoPreview} alt="School Logo" />) : (<i className="fas fa-school fa-2x" style={{ color: '#ccc' }}></i>)}
                                                    </div>
                                                    <div className="upload-info">
                                                        <p>Upload your school logo (Max 2MB)</p>
                                                        <button type="button" className="upload-btn" onClick={() => handleImageUpload('logo')}>
                                                            <i className="fas fa-upload"></i><span>Upload Logo</span>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="file-upload-container">
                                                <label>Admin Profile Picture</label>
                                                <div className="upload-preview">
                                                    <div className="profile-preview">
                                                        {profilePreview ? (<img src={profilePreview} alt="Admin Profile" />) : (<i className="fas fa-user fa-2x" style={{ color: '#ccc' }}></i>)}
                                                    </div>
                                                    <div className="upload-info">
                                                        <p>Upload admin profile picture (Max 2MB)</p>
                                                        <button type="button" className="upload-btn" onClick={() => handleImageUpload('profile')}>
                                                            <i className="fas fa-upload"></i><span>Upload Profile</span>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="input-group">
                                                <label htmlFor="signupEmail">Admin Email Address</label>
                                                <i className="fas fa-envelope"></i>
                                                <input
                                                    type="email" id="signupEmail" value={signupEmail}
                                                    onChange={handleSignupEmailChange}
                                                    placeholder="Enter admin email" required
                                                />
                                                <div className={`validation-icon ${signupEmailValid === true ? 'valid' : signupEmailValid === false ? 'invalid' : ''}`}>
                                                    {signupEmailValid === true && <i className="fas fa-check-circle"></i>}
                                                    {signupEmailValid === false && <i className="fas fa-exclamation-circle"></i>}
                                                </div>
                                            </div>

                                            <div className="input-group">
                                                <label htmlFor="signupPassword">Password</label>
                                                <i className="fas fa-lock"></i>
                                                <input
                                                    type="password" id="signupPassword" value={signupPassword}
                                                    onChange={(e) => setSignupPassword(e.target.value)}
                                                    placeholder="Create a strong password" required
                                                />
                                            </div>

                                            <div className="input-group">
                                                <label htmlFor="confirmPassword">Confirm Password</label>
                                                <i className="fas fa-lock"></i>
                                                <input
                                                    type="password" id="confirmPassword" value={confirmPassword}
                                                    onChange={handleConfirmPasswordChange}
                                                    placeholder="Confirm your password" required
                                                />
                                                <div className={`validation-icon ${passwordsMatch === true ? 'valid' : passwordsMatch === false ? 'invalid' : ''}`}>
                                                    {passwordsMatch === true && <i className="fas fa-check-circle"></i>}
                                                    {passwordsMatch === false && <i className="fas fa-exclamation-circle"></i>}
                                                </div>
                                            </div>

                                            <div className="divider"><span>Terms & Conditions</span></div>

                                            <div className="input-group" style={{ marginBottom: '10px' }}>
                                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                                                    <input
                                                        type="checkbox" id="termsAgreement" checked={termsAgreement}
                                                        onChange={(e) => setTermsAgreement(e.target.checked)}
                                                        style={{ width: 'auto', marginTop: '3px' }}
                                                    />
                                                    <label htmlFor="termsAgreement" style={{ fontSize: '13px', color: '#666', cursor: 'pointer' }}>
                                                        I agree to the <a href="#" style={{ color: 'var(--primary)' }}>Terms of Service</a> and <a href="#" style={{ color: 'var(--primary)' }}>Privacy Policy</a>. I understand that my school account will be in trial mode until subscription is activated.
                                                    </label>
                                                </div>
                                            </div>

                                            {!isOnline && (
                                                <div style={{ padding: '10px', marginBottom: '15px', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '8px', fontSize: '13px', color: '#856404' }}>
                                                    <i className="fas fa-info-circle"></i> You are offline. Registration requires an internet connection.
                                                </div>
                                            )}

                                            <button type="submit" className="btn warning" disabled={loading || !isOnline}>
                                                {loading ? (<><div className="loading"></div><span>Creating account...</span></>) : (<><i className="fas fa-school"></i><span>Register School</span></>)}
                                            </button>

                                            <div className="toggle-link" onClick={toggleRegister}>
                                                Already have an account? <span>Login</span>
                                            </div>
                                        </form>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

{/* Styles */}
            <style>{`
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                }

                :root {
                    --primary: #3498db;
                    --secondary: #2c3e50;
                    --accent: #9b59b6;
                    --success: #27ae60;
                    --warning: #f39c12;
                    --danger: #e74c3c;
                    --light: #f5f7fa;
                    --dark: #2c3e50;
                    --white: #ffffff;
                }

                .login-container {
                    min-height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    background: #f0f2f5;
                    padding: 20px;
                }

                .split-container {
                    display: flex;
                    width: 100%;
                    max-width: 1200px;
                    min-height: 90vh;
                    max-height: 750px;
                    background: var(--white);
                    border-radius: 24px;
                    overflow: hidden;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
                    animation: gentleAppear 1s ease-out;
                }

                @keyframes gentleAppear {
                    from { 
                        opacity: 0; 
                        transform: translateY(30px) scale(0.96); 
                    }
                    to { 
                        opacity: 1; 
                        transform: translateY(0) scale(1); 
                    }
                }

                /* ===== LEFT PANEL ===== */
                .left-panel {
                    flex: 1;
                    background: url('/modern.png') center/cover no-repeat;
                    position: relative;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 400px;
                }

                .image-overlay {
                    position: absolute;
                    inset: 0;
                    background: rgba(26, 35, 126, 0.85);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 40px;
                }

                .overlay-content {
                    text-align: center;
                    color: var(--white);
                    max-width: 400px;
                }

                .overlay-content h1 {
                    font-size: 36px;
                    font-weight: 700;
                    margin-bottom: 12px;
                    text-shadow: 0 2px 20px rgba(0, 0, 0, 0.2);
                }

                .overlay-content p {
                    font-size: 16px;
                    opacity: 0.9;
                    margin-bottom: 30px;
                    line-height: 1.6;
                }

                .features-list {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 12px;
                    text-align: left;
                }

                .feature-item {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    background: rgba(255, 255, 255, 0.15);
                    backdrop-filter: blur(4px);
                    padding: 10px 14px;
                    border-radius: 10px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    transition: all 0.3s;
                }

                .feature-item:hover {
                    background: rgba(255, 255, 255, 0.25);
                    transform: translateY(-2px);
                }

                .feature-item i {
                    font-size: 18px;
                    width: 28px;
                    color: #f1c40f;
                }

                .feature-item span {
                    font-size: 13px;
                    font-weight: 500;
                }

                /* ===== RIGHT PANEL ===== */
                .right-panel {
                    flex: 1.2;
                    display: flex;
                    flex-direction: column;
                    background: var(--white);
                    overflow-y: auto;
                    padding: 0;
                }

                .form-wrapper {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    padding: 20px 30px 30px;
                }

                /* Header */
                .header {
                    text-align: center;
                    padding: 10px 0 5px;
                    background: transparent;
                    border-bottom: none;
                }

                .logo-container {
                    width: 70px;
                    height: 70px;
                    margin: 0 auto 10px;
                    background-color: var(--white);
                    border-radius: 50%;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
                    border: 3px solid var(--warning);
                    overflow: hidden;
                }

                .logo {
                    width: 55px;
                    height: 55px;
                    background-image: url('/logo.png');
                    background-size: contain;
                    background-repeat: no-repeat;
                    background-position: center;
                }

                .system-title {
                    color: var(--secondary);
                    font-size: 24px;
                    font-weight: 700;
                    letter-spacing: 1px;
                    margin-bottom: 2px;
                }

                .system-subtitle {
                    color: var(--gray);
                    font-size: 13px;
                    font-weight: 500;
                    letter-spacing: 0.5px;
                }

                /* Form Container */
                .form-container {
                    flex: 1;
                    padding: 10px 0 0;
                    overflow-y: auto;
                }

                .form-title {
                    color: var(--secondary);
                    text-align: center;
                    margin-bottom: 18px;
                    font-size: 20px;
                    font-weight: 600;
                    position: relative;
                    padding-bottom: 10px;
                }

                .form-title:after {
                    content: '';
                    position: absolute;
                    bottom: 0;
                    left: 50%;
                    transform: translateX(-50%);
                    width: 60px;
                    height: 3px;
                    background: var(--primary);
                    border-radius: 2px;
                }

                /* Messages */
                .message {
                    padding: 12px 16px;
                    border-radius: 10px;
                    margin: 10px 0 15px;
                    text-align: center;
                    font-weight: 500;
                    font-size: 14px;
                    animation: messageSlide 0.4s;
                    border: 1px solid transparent;
                }

                @keyframes messageSlide {
                    from { opacity: 0; transform: translateY(-8px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .message.success {
                    background-color: #d4edda;
                    color: #155724;
                    border-color: #c3e6cb;
                }

                .message.error {
                    background-color: #f8d7da;
                    color: #721c24;
                    border-color: #f5c6cb;
                }

                .message.info {
                    background-color: #d1ecf1;
                    color: #0c5460;
                    border-color: #bee5eb;
                }

                .message.warning {
                    background-color: #fff3cd;
                    color: #856404;
                    border-color: #ffeaa7;
                }

                /* Input Groups */
                .input-group {
                    margin-bottom: 14px;
                    position: relative;
                }

                .input-group label {
                    display: block;
                    margin-bottom: 5px;
                    color: var(--secondary);
                    font-weight: 500;
                    font-size: 13px;
                    padding-left: 3px;
                }

                .input-group i {
                    position: absolute;
                    left: 14px;
                    top: 37px;
                    color: #aaa;
                    font-size: 16px;
                    transition: color 0.3s;
                }

                .input-group input {
                    width: 100%;
                    padding: 12px 12px 12px 44px;
                    border: 2px solid #e0e0e0;
                    border-radius: 10px;
                    font-size: 14px;
                    transition: all 0.3s;
                    background-color: var(--white);
                    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
                }

                .input-group input:focus {
                    border-color: var(--primary);
                    box-shadow: 0 0 0 3px rgba(52, 152, 219, 0.15);
                    outline: none;
                }

                .input-group .validation-icon {
                    position: absolute;
                    right: 14px;
                    top: 37px;
                    font-size: 16px;
                    display: none;
                }

                .input-group .validation-icon.valid {
                    color: var(--success);
                    display: block;
                }

                .input-group .validation-icon.invalid {
                    color: var(--danger);
                    display: block;
                }

                /* File Upload */
                .file-upload-container {
                    margin-bottom: 14px;
                }

                .upload-preview {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .logo-preview,
                .profile-preview {
                    width: 60px;
                    height: 60px;
                    border-radius: 10px;
                    overflow: hidden;
                    border: 2px dashed #ddd;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background-color: #f8f9fa;
                    flex-shrink: 0;
                }

                .logo-preview img,
                .profile-preview img {
                    max-width: 100%;
                    max-height: 100%;
                    object-fit: cover;
                }

                .upload-info {
                    flex: 1;
                }

                .upload-info p {
                    font-size: 12px;
                    color: #666;
                    margin-bottom: 4px;
                }

                .upload-btn {
                    padding: 8px 16px;
                    background: var(--primary);
                    color: white;
                    border: none;
                    border-radius: 6px;
                    font-size: 12px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                }

                .upload-btn:hover {
                    background: #1e3a8a;
                    transform: translateY(-1px);
                    box-shadow: 0 4px 12px rgba(155, 89, 182, 0.3);
                }

                /* Buttons */
                .btn {
                    width: 100%;
                    padding: 14px;
                    background: var(--primary);
                    color: white;
                    border: none;
                    border-radius: 10px;
                    font-size: 15px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 10px;
                    margin-top: 6px;
                    box-shadow: 0 4px 16px rgba(52, 152, 219, 0.25);
                }

                .btn:hover {
                    background: #1e3a8a;
                    transform: translateY(-2px);
                    box-shadow: 0 8px 24px rgba(155, 89, 182, 0.35);
                }

                .btn:active {
                    transform: translateY(1px);
                }

                .btn:disabled {
                    background: #cccccc;
                    cursor: not-allowed;
                    transform: none;
                    box-shadow: none;
                }

                .btn.warning {
                    background: var(--warning);
                    box-shadow: 0 4px 16px rgba(243, 156, 18, 0.25);
                }

                .btn.warning:hover {
                    background: #d97706;
                    box-shadow: 0 8px 24px rgba(243, 156, 18, 0.35);
                }

                .btn.danger {
                    background: var(--danger);
                    box-shadow: 0 4px 16px rgba(231, 76, 60, 0.25);
                }

                .btn.danger:hover {
                    background: #dc2626;
                    box-shadow: 0 8px 24px rgba(231, 76, 60, 0.35);
                }

                .btn .loading {
                    display: inline-block;
                    width: 20px;
                    height: 20px;
                    border: 3px solid rgba(255, 255, 255, 0.3);
                    border-radius: 50%;
                    border-top-color: white;
                    animation: spin 1s ease-in-out infinite;
                }

                @keyframes spin {
                    to { transform: rotate(360deg); }
                }

                .forgot-password {
                    text-align: center;
                    margin-top: 14px;
                    color: var(--primary);
                    font-size: 13px;
                    cursor: pointer;
                    transition: all 0.3s;
                    font-weight: 500;
                }

                .forgot-password:hover {
                    color: var(--accent);
                    text-decoration: underline;
                }

                .toggle-link {
                    text-align: center;
                    margin-top: 14px;
                    font-size: 13px;
                    color: #666;
                    cursor: pointer;
                    transition: all 0.3s;
                }

                .toggle-link span {
                    color: var(--primary);
                    font-weight: 600;
                    transition: color 0.3s;
                }

                .toggle-link span:hover {
                    color: var(--accent);
                    text-decoration: underline;
                }

                .divider {
                    display: flex;
                    align-items: center;
                    margin: 16px 0;
                    color: #777;
                    font-size: 13px;
                }

                .divider:before,
                .divider:after {
                    content: '';
                    flex: 1;
                    height: 1px;
                    background: #ddd;
                }

                .divider span {
                    padding: 0 12px;
                }

                /* Verification */
                .verification-section {
                    background: #f8fafc;
                    padding: 20px;
                    border-radius: 12px;
                    margin-top: 10px;
                    border-left: 4px solid var(--primary);
                    text-align: center;
                    animation: verificationSlide 0.5s ease-out;
                }

                @keyframes verificationSlide {
                    from { opacity: 0; transform: translateY(15px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .verification-icon {
                    font-size: 48px;
                    color: var(--primary);
                    margin-bottom: 15px;
                    animation: gentlePulse 2s infinite ease-in-out;
                }

                @keyframes gentlePulse {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.05); }
                }

                .verification-content h3 {
                    color: var(--secondary);
                    margin-bottom: 10px;
                    font-size: 20px;
                }

                .verification-content p {
                    color: #666;
                    margin-bottom: 10px;
                    line-height: 1.5;
                    font-size: 14px;
                }

                .email-display {
                    font-weight: bold;
                    color: var(--primary);
                    background-color: rgba(52, 152, 219, 0.08);
                    padding: 8px 18px;
                    border-radius: 6px;
                    display: inline-block;
                    margin: 10px 0;
                    font-size: 15px;
                    border: 2px dashed var(--primary);
                }

                .verification-timer {
                    margin-top: 14px;
                    padding: 8px;
                    background-color: rgba(243, 156, 18, 0.08);
                    border-radius: 6px;
                    color: var(--secondary);
                    font-size: 13px;
                }

                .timer {
                    font-weight: bold;
                    color: var(--warning);
                    font-size: 16px;
                }

                .resend-link {
                    text-align: center;
                    margin-top: 14px;
                    font-size: 13px;
                    color: #666;
                }

                .resend-link span {
                    color: var(--primary);
                    cursor: pointer;
                    font-weight: 600;
                    transition: color 0.3s;
                }

                .resend-link span:hover {
                    color: var(--accent);
                    text-decoration: underline;
                }

                .verification-note {
                    margin-top: 12px;
                    font-size: 12px;
                    color: #666;
                }

                .verification-note i {
                    margin-right: 4px;
                }

                .offline-indicator {
                    position: fixed;
                    top: 12px;
                    right: 12px;
                    background: var(--danger);
                    color: white;
                    padding: 6px 14px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: 600;
                    z-index: 1000;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
                    animation: pulse 2s infinite;
                }

                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.7; }
                }

                /* ===== RESPONSIVE ===== */
                @media (max-width: 1024px) {
                    .split-container {
                        max-height: none;
                        height: auto;
                        min-height: 90vh;
                    }

                    .left-panel {
                        min-height: 300px;
                    }

                    .features-list {
                        grid-template-columns: 1fr 1fr;
                    }
                }

                @media (max-width: 820px) {
                    .split-container {
                        flex-direction: column;
                        border-radius: 20px;
                        max-height: none;
                    }

                    .left-panel {
                        min-height: 200px;
                        max-height: 250px;
                    }

                    .overlay-content h1 {
                        font-size: 28px;
                    }

                    .overlay-content p {
                        font-size: 14px;
                        margin-bottom: 16px;
                    }

                    .features-list {
                        grid-template-columns: 1fr 1fr;
                        gap: 8px;
                    }

                    .feature-item {
                        padding: 6px 10px;
                        font-size: 12px;
                    }

                    .feature-item i {
                        font-size: 14px;
                        width: 22px;
                    }

                    .right-panel {
                        flex: 1;
                        padding: 0;
                    }

                    .form-wrapper {
                        padding: 16px 20px 20px;
                    }

                    .logo-container {
                        width: 56px;
                        height: 56px;
                    }

                    .logo {
                        width: 42px;
                        height: 42px;
                    }

                    .system-title {
                        font-size: 20px;
                    }

                    .system-subtitle {
                        font-size: 12px;
                    }

                    .form-title {
                        font-size: 18px;
                        margin-bottom: 14px;
                    }

                    .input-group input {
                        padding: 10px 10px 10px 38px;
                        font-size: 13px;
                    }

                    .input-group i {
                        left: 12px;
                        top: 34px;
                        font-size: 14px;
                    }

                    .btn {
                        padding: 12px;
                        font-size: 14px;
                    }
                }

                @media (max-width: 768px) {
                    .left-panel {
                        display: none !important;
                    }
                    
                    .right-panel {
                        flex: 1;
                        min-height: 100vh;
                    }
                    
                    .split-container {
                        border-radius: 16px;
                        min-height: 100vh;
                    }
                }

                @media (max-width: 480px) {
                    .login-container {
                        padding: 10px;
                    }

                    .split-container {
                        border-radius: 16px;
                        min-height: 100vh;
                    }

                    .form-wrapper {
                        padding: 12px 14px 16px;
                    }

                    .logo-container {
                        width: 48px;
                        height: 48px;
                    }

                    .logo {
                        width: 36px;
                        height: 36px;
                    }

                    .system-title {
                        font-size: 18px;
                    }

                    .form-title {
                        font-size: 16px;
                        margin-bottom: 10px;
                        padding-bottom: 8px;
                    }

                    .input-group {
                        margin-bottom: 10px;
                    }

                    .input-group label {
                        font-size: 12px;
                    }

                    .input-group input {
                        padding: 8px 8px 8px 34px;
                        font-size: 12px;
                        border-radius: 8px;
                    }

                    .input-group i {
                        left: 10px;
                        top: 30px;
                        font-size: 13px;
                    }

                    .message {
                        padding: 10px 12px;
                        font-size: 12px;
                        margin: 8px 0 10px;
                    }

                    .btn {
                        padding: 10px;
                        font-size: 13px;
                        gap: 8px;
                    }

                    .btn .loading {
                        width: 16px;
                        height: 16px;
                    }

                    .verification-section {
                        padding: 16px;
                    }

                    .verification-icon {
                        font-size: 40px;
                    }

                    .verification-content h3 {
                        font-size: 18px;
                    }

                    .verification-content p {
                        font-size: 13px;
                    }

                    .email-display {
                        font-size: 13px;
                        padding: 6px 14px;
                    }

                    .upload-preview {
                        gap: 10px;
                    }

                    .logo-preview,
                    .profile-preview {
                        width: 50px;
                        height: 50px;
                    }

                    .upload-btn {
                        padding: 6px 12px;
                        font-size: 11px;
                    }

                    .upload-info p {
                        font-size: 11px;
                    }

                    .forgot-password {
                        font-size: 12px;
                        margin-top: 10px;
                    }

                    .toggle-link {
                        font-size: 12px;
                        margin-top: 10px;
                    }

                    .offline-indicator {
                        font-size: 10px;
                        padding: 4px 10px;
                        top: 8px;
                        right: 8px;
                    }
                }

                @media (max-width: 380px) {
                    .split-container {
                        border-radius: 12px;
                    }

                    .form-wrapper {
                        padding: 10px 10px 14px;
                    }
                }

                /* Scrollbar styling */
                .right-panel::-webkit-scrollbar {
                    width: 4px;
                }

                .right-panel::-webkit-scrollbar-track {
                    background: #f1f1f1;
                }

                .right-panel::-webkit-scrollbar-thumb {
                    background: var(--primary);
                    border-radius: 2px;
                }

                .right-panel::-webkit-scrollbar-thumb:hover {
                    background: var(--accent);
                }
            `}</style>
 </div>
    );
}
