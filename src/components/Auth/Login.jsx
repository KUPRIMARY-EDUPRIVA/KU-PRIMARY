// src/components/Auth/Login.jsx  (updated)
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import {
    getAuth, signInWithEmailAndPassword, sendPasswordResetEmail,
    createUserWithEmailAndPassword, updateProfile, sendEmailVerification,
    updatePassword,
} from 'firebase/auth';
import { db } from '../../firebase';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp, collection, query, where, getDocs } from 'firebase/firestore';
import { useSync } from '../../context/SyncContext';
import { AuditLogService } from '../../services/auditService';
import {
    authenticateWithBiometrics, getBiometricLoginStatus, isDeviceBiometricAvailable,
    enableBiometricUnlock
} from '../../services/deviceSecurity';
import { fetchNetlifyFunction } from '../../services/netlifyApi';

const CLOUDINARY_CLOUD_NAME = process.env.REACT_APP_CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_UPLOAD_PRESET = process.env.REACT_APP_CLOUDINARY_UPLOAD_PRESET;

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
    form.append('folder', 'edupriva/schools');
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.json())?.error?.message || ''; } catch {}
        throw new Error(`Cloudinary upload failed (${res.status}) ${detail}`.trim());
    }
    const data = await res.json();
    return data.secure_url || data.url;
}

// --------------------------------------------------------------
// Student first-login password change modal
// --------------------------------------------------------------
function StudentPasswordChangeModal({ onDone, onCancel }) {
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const valid = newPassword.length >= 6 && newPassword === confirmPassword;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (newPassword.length < 6) { setError('Password must be at least 6 characters.'); return; }
        if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
        setBusy(true);
        try {
            const user = getAuth().currentUser;
            if (!user) throw new Error('Session expired. Please sign in again.');
            await updatePassword(user, newPassword);
            await updateDoc(doc(db, 'students', user.uid), {
                mustChangePassword: false,
                passwordChangedAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            }).catch(() => { /* student doc might not exist yet; ignore */ });
            onDone();
        } catch (err) {
            console.error('Password change failed:', err);
            setError(
                err.code === 'auth/requires-recent-login'
                    ? 'Please re-login and try again. For security, we need a fresh sign-in.'
                    : err.message || 'Could not update password.'
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20, zIndex: 9999,
        }}>
            <div style={{
                background: 'white', borderRadius: 16, maxWidth: 480, width: '100%',
                padding: 28, boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
            }}>
                <h2 style={{ marginTop: 0, color: '#1e293b' }}>
                    <i className="fas fa-shield-halved" style={{ color: '#2563eb', marginRight: 8 }} />
                    Set a new password
                </h2>
                <p style={{ fontSize: 14, color: '#475569', lineHeight: 1.55 }}>
                    For your security, you must change the admission-number password before you
                    can use the dashboard.
                </p>

                {error && (
                    <div style={{
                        background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
                        padding: '10px 12px', borderRadius: 8, marginBottom: 12, fontSize: 13,
                    }}>{error}</div>
                )}

                <form onSubmit={handleSubmit}>
                    <div style={{ marginBottom: 12 }}>
                        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 5 }}>
                            New password
                        </label>
                        <input
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            autoFocus
                            style={{
                                width: '100%', padding: '10px 12px', border: '2px solid #e2e8f0',
                                borderRadius: 8, fontSize: 14,
                            }}
                        />
                    </div>
                    <div style={{ marginBottom: 16 }}>
                        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 5 }}>
                            Confirm new password
                        </label>
                        <input
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            style={{
                                width: '100%', padding: '10px 12px', border: '2px solid #e2e8f0',
                                borderRadius: 8, fontSize: 14,
                            }}
                        />
                    </div>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                        <button
                            type="button"
                            onClick={onCancel}
                            disabled={busy}
                            className="btn btn-outline"
                            style={{ width: 'auto' }}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={busy || !valid}
                            className="btn"
                            style={{ width: 'auto' }}
                        >
                            {busy ? 'Saving…' : 'Save password'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

export default function Login() {
    const navigate = useNavigate();
    const { currentUser, userRole, userCollection, unlockSession } = useAuth();
    const { isOnline, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();
    const auth = getAuth();

    // ---- form state ----
    const [loginEmail, setLoginEmail] = useState('');
    const [loginPassword, setLoginPassword] = useState('');

    // ---- student login state ----
    const [loginMode, setLoginMode] = useState('staff'); // 'staff' | 'student'
    const [studentEmail, setStudentEmail] = useState('');
    const [studentAdmissionNumber, setStudentAdmissionNumber] = useState('');
    const [studentSchoolId, setStudentSchoolId] = useState('');

    // ---- signup ----
    const [signupSchoolName, setSignupSchoolName] = useState('');
    const [signupAdminFullName, setSignupAdminFullName] = useState('');
    const [signupEmail, setSignupEmail] = useState('');
    const [signupPassword, setSignupPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [termsAgreement, setTermsAgreement] = useState(false);

    // ---- ui ----
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState({ text: '', type: '' });
    const [emailValid, setEmailValid] = useState(null);
    const [signupEmailValid, setSignupEmailValid] = useState(null);
    const [passwordsMatch, setPasswordsMatch] = useState(null);
    const [showVerification, setShowVerification] = useState(false);
    const [verificationEmail, setVerificationEmail] = useState('');
    const [verificationTimer, setVerificationTimer] = useState(30);
    const [showRegister, setShowRegister] = useState(false);
    const [biometricReady, setBiometricReady] = useState(false);
    const [pendingBiometricRole, setPendingBiometricRole] = useState('');

    // ---- student first-login ----
    const [pendingPasswordChange, setPendingPasswordChange] = useState(false);

    const [logoFile, setLogoFile] = useState(null);
    const [profileFile, setProfileFile] = useState(null);
    const [logoPreview, setLogoPreview] = useState(null);
    const [profilePreview, setProfilePreview] = useState(null);
    const [cachedUsers, setCachedUsers] = useState([]);

    const verificationIntervalRef = useRef(null);
    const timerIntervalRef = useRef(null);
    const biometricAttemptRef = useRef(false);

    useEffect(() => {
        if (!isOnline) loadCachedUsers();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOnline]);

    useEffect(() => {
        let active = true;
        getBiometricLoginStatus()
            .then(({ enabled }) => { if (active) setBiometricReady(enabled); })
            .catch((err) => console.warn('Biometric status check failed:', err.message));
        return () => { active = false; };
    }, []);

    useEffect(() => () => {
        if (verificationIntervalRef.current) clearInterval(verificationIntervalRef.current);
        if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    }, []);

    const loadCachedUsers = async () => {
        try {
            const cached = await getFromIndexedDB('cached_users');
            if (cached) setCachedUsers(cached);
        } catch (e) { console.error(e); }
    };

    const cacheUserData = async (userData) => {
        try {
            const cached = (await getFromIndexedDB('cached_users')) || [];
            const i = cached.findIndex((u) => u.uid === userData.uid);
            if (i >= 0) cached[i] = { ...cached[i], ...userData, cachedAt: new Date().toISOString() };
            else cached.push({ ...userData, cachedAt: new Date().toISOString() });
            await saveToIndexedDB('cached_users', cached);
            setCachedUsers(cached);
        } catch (e) { console.error(e); }
    };

    const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    const showMessage = (text, type = 'info') => setMessage({ text, type });
    const clearMessages = () => setMessage({ text: '', type: '' });

    const generateSchoolId = (schoolName) => {
        const t = Date.now().toString(36);
        const r = Math.random().toString(36).substring(2, 6);
        const c = schoolName.substring(0, 3).toUpperCase();
        return `${c}-${t}-${r}`;
    };

    const findUserDocument = async (uid, email) => {
        if (isOnline) {
            try {
                for (const coll of ['users', 'teachers', 'students']) {
                    const snap = await getDoc(doc(db, coll, uid));
                    if (snap.exists()) {
                        const data = snap.data();
                        await cacheUserData({ uid, ...data, collection: coll });
                        return { collection: coll, docId: uid, data };
                    }
                }
            } catch (e) { console.error(e); }
        }
        const cached = cachedUsers.find((u) => u.uid === uid || u.email === email);
        if (cached) return { collection: cached.collection || 'users', docId: cached.uid, data: cached };
        return null;
    };

    const sendVerificationEmail = async (user) => {
        try { await sendEmailVerification(user); return true; }
        catch (e) { console.error(e); return false; }
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
            if (!user.emailVerified) return;
            if (verificationIntervalRef.current) clearInterval(verificationIntervalRef.current);
            if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
            const userData = await findUserDocument(user.uid, user.email);
            if (userData) {
                if (isOnline) {
                    await updateDoc(doc(db, userData.collection, userData.docId), {
                        emailVerified: true,
                        verifiedAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    }).catch(() => {});
                }
                await cacheUserData({ ...userData.data, uid: user.uid, email: user.email, emailVerified: true, collection: userData.collection });
                sessionStorage.setItem('userRole', userData.collection);
                sessionStorage.setItem('userId', userData.docId);
                showMessage('✅ Email verified successfully! Redirecting…', 'success');
                setTimeout(() => navigateToDashboard(userData.collection), 2000);
            }
        } catch (e) {
            console.error(e);
            showMessage('Error checking verification status.', 'error');
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
            setVerificationTimer((p) => {
                if (p <= 1) {
                    clearInterval(timerIntervalRef.current);
                    checkEmailVerification();
                    return 0;
                }
                return p - 1;
            });
        }, 1000);
        verificationIntervalRef.current = setInterval(checkEmailVerification, 30000);
    };

    const handleResendVerification = async () => {
        const user = auth.currentUser;
        if (!user) { showMessage('Session expired.', 'error'); setShowVerification(false); return; }
        try {
            await sendEmailVerification(user);
            showMessage('✅ Verification email resent!', 'success');
            setVerificationTimer(30);
        } catch { showMessage('Failed to resend.', 'error'); }
    };

    const toggleRegister = () => {
        setShowRegister(!showRegister);
        clearMessages();
        if (!showRegister) {
            setSignupSchoolName(''); setSignupAdminFullName('');
            setSignupEmail(''); setSignupPassword(''); setConfirmPassword('');
            setTermsAgreement(false);
            setLogoFile(null); setProfileFile(null);
            setLogoPreview(null); setProfilePreview(null);
            setSignupEmailValid(null); setPasswordsMatch(null);
        }
    };

    // ---------------------------------------------------------------
    // STUDENT LOGIN
    // ---------------------------------------------------------------
    const handleStudentLogin = async (e) => {
        e.preventDefault();
        clearMessages();

        if (!isOnline) {
            showMessage('Connect to the internet for your first sign-in.', 'error');
            return;
        }
        if (!validateEmail(studentEmail)) {
            showMessage('Please enter a valid email address.', 'error');
            return;
        }
        if (!studentAdmissionNumber.trim()) {
            showMessage('Please enter your admission number.', 'error');
            return;
        }
        if (!studentSchoolId.trim()) {
            showMessage('Please enter your school ID.', 'error');
            return;
        }

        setLoading(true);
        try {
            // 1. Find the student's user record via admission number + school
            const studentSnap = await getDocs(
                query(
                    collection(db, 'students'),
                    where('schoolId', '==', studentSchoolId.trim()),
                    where('admissionNumber', '==', studentAdmissionNumber.trim())
                )
            );

            if (studentSnap.empty) {
                showMessage('No student found with that admission number for this school.', 'error');
                setLoading(false);
                return;
            }

            const studentDoc = studentSnap.docs[0];
            const student = studentDoc.data();
            const studentUid = student.uid || studentDoc.id;

            // 2. Attempt Firebase sign-in using email + admission number as password
            //    (Provisional "password" before first change).
            let credential;
            try {
                credential = await signInWithEmailAndPassword(auth, studentEmail.trim(), studentAdmissionNumber.trim());
            } catch (err) {
                // If the student already changed their password, retry is impossible here
                // — instruct them to use the staff login tab with their real password.
                if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
                    showMessage(
                        'Your password has already been changed. Sign in with your new password using the "Staff / Admin Login" tab, or reset it from "Forgot Password".',
                        'error'
                    );
                } else if (err.code === 'auth/user-not-found') {
                    showMessage(
                        'Your login account has not been provisioned yet. Ask your school administrator to create it.',
                        'error'
                    );
                } else {
                    showMessage('Sign-in failed: ' + (err.message || err.code), 'error');
                }
                setLoading(false);
                return;
            }

            const user = credential.user;

            // 3. Persist the session
            const roleColl = 'students';
            sessionStorage.setItem('userRole', roleColl);
            sessionStorage.setItem('userId', user.uid);

            await cacheUserData({
                uid: user.uid,
                email: user.email,
                collection: roleColl,
                ...student,
            });

            // Update lastLogin (best-effort)
            if (isOnline) {
                try {
                    await updateDoc(doc(db, 'students', studentDoc.id), {
                        lastLogin: serverTimestamp(),
                    });
                } catch (e) { console.warn('lastLogin update failed:', e.message); }
            }

            // Audit log
            const schoolId = student.schoolId;
            if (isOnline && schoolId) {
                AuditLogService.logAction(
                    schoolId,
                    {
                        uid: user.uid,
                        fullName: student.fullName || `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                        email: user.email,
                        role: 'student',
                    },
                    'LOGIN',
                    { message: 'Student sign-in' }
                ).catch((e) => console.warn('Audit log failed:', e.message));
            }

            unlockSession();

            // 4. Force password change on first login
            const mustChange = student.mustChangePassword === true
                || student.passwordChangedAt == null;
            if (mustChange) {
                setPendingPasswordChange(true);
                setLoading(false);
                return;
            }

            // 5. Otherwise go straight to the dashboard
            showMessage('Welcome back! Redirecting…', 'success');
            setTimeout(() => navigateToDashboard(roleColl), 1200);
        } catch (err) {
            console.error('Student login error:', err);
            showMessage(err.message || 'Student sign-in failed.', 'error');
        } finally {
            setLoading(false);
        }
    };

    const completeStudentPasswordChange = () => {
        setPendingPasswordChange(false);
        showMessage('Password updated. Redirecting…', 'success');
        const role = sessionStorage.getItem('userRole') || 'students';
        setTimeout(() => navigateToDashboard(role), 1200);
    };

    // ---------------------------------------------------------------
    // STAFF LOGIN (unchanged except student is not valid here)
    // ---------------------------------------------------------------
    const offerBiometricSetup = async (role) => {
        if (biometricReady || !isDeviceBiometricAvailable()) return false;
        try {
            const status = await getBiometricLoginStatus();
            if (!status.available || status.enabled) return false;
            setPendingBiometricRole(role);
            return true;
        } catch (err) {
            console.warn('Biometric setup availability check failed:', err.message);
            return false;
        }
    };

    const finishBiometricSetup = async (enable) => {
        const role = pendingBiometricRole;
        if (!role) return;
        setLoading(true);
        try {
            if (enable) {
                await authenticateWithBiometrics();
                await enableBiometricUnlock();
                setBiometricReady(true);
                showMessage('Biometric unlock enabled.', 'success');
            }
            unlockSession();
            setPendingBiometricRole('');
            navigateToDashboard(role);
        } catch (err) {
            console.warn('Biometric setup failed:', err.message);
            showMessage(err.message || 'Biometric setup failed.', 'error');
        } finally { setLoading(false); }
    };

    const handleBiometricLogin = async () => {
        if (biometricAttemptRef.current) return;
        biometricAttemptRef.current = true;
        const bioPromise = authenticateWithBiometrics();
        setLoading(true);
        try {
            await bioPromise;
            if (!currentUser && !auth.currentUser) {
                throw new Error('No saved sign-in session. Connect to the internet and sign in first.');
            }
            unlockSession();
            const collection = userCollection || (userRole === 'teacher' ? 'teachers' : userRole === 'student' ? 'students' : 'users');
            navigateToDashboard(collection);
        } catch (err) {
            showMessage(err.message || 'Unable to sign in with biometrics.', 'error');
        } finally {
            biometricAttemptRef.current = false;
            setLoading(false);
        }
    };

    const handleLogin = async (e, savedCredentials = null) => {
        e?.preventDefault();
        clearMessages();
        const email = savedCredentials?.email || loginEmail;
        const password = savedCredentials?.password || loginPassword;
        if (!validateEmail(email)) { showMessage('Please enter a valid email address', 'error'); setLoading(false); return; }
        if (password.length < 6) { showMessage('Password must be at least 6 characters', 'error'); setLoading(false); return; }
        setLoading(true);
        try {
            if (!isOnline) {
                showMessage('Connect to the internet for your first sign-in.', 'error');
                return;
            }
            const credential = await signInWithEmailAndPassword(auth, email, password);
            const user = credential.user;

            if (!user.emailVerified) {
                showMessage('⚠️ Please verify your email address to access the dashboard.', 'warning');
                startVerificationCheck(user.email);
                await sendVerificationEmail(user);
                return;
            }

            const userData = await findUserDocument(user.uid, email);
            if (userData) {
                const { collection, docId, data } = userData;
                const schoolId = data?.schoolId || data?.school_id;
                if (schoolId) {
                    AuditLogService.logAction(
                        schoolId,
                        { uid: user.uid, fullName: data?.fullName || user.displayName || email, email, role: data?.role || collection },
                        'LOGIN',
                        { message: 'Successful sign-in' }
                    ).catch(() => {});
                }
                try { await updateDoc(doc(db, collection, docId), { lastLogin: serverTimestamp() }); }
                catch (e) { console.warn('lastLogin update failed:', e.code || e.message); }
                await cacheUserData({ uid: user.uid, email, collection, ...data });
                sessionStorage.setItem('userRole', collection);
                sessionStorage.setItem('userId', docId);
                unlockSession();
                if (await offerBiometricSetup(collection)) { setLoading(false); return; }
                showMessage('Welcome! Redirecting…', 'success');
                setTimeout(() => navigateToDashboard(collection), 1500);
            } else {
                if (isOnline) {
                    await setDoc(doc(db, 'users', user.uid), {
                        uid: user.uid, email, role: 'user',
                        fullName: user.displayName || 'User',
                        emailVerified: true,
                        lastLogin: serverTimestamp(),
                        createdAt: serverTimestamp(),
                        updatedAt: serverTimestamp(),
                    });
                }
                await cacheUserData({ uid: user.uid, email, role: 'user', fullName: user.displayName || 'User', collection: 'users' });
                sessionStorage.setItem('userRole', 'users');
                sessionStorage.setItem('userId', user.uid);
                unlockSession();
                if (await offerBiometricSetup('users')) { setLoading(false); return; }
                showMessage('Welcome! Redirecting…', 'success');
                setTimeout(() => navigateToDashboard('users'), 1500);
            }
        } catch (error) {
            const errorMessage =
                error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password' ? 'Invalid email or password' :
                error.code === 'auth/user-not-found' ? 'No account found with this email' :
                error.code === 'auth/too-many-requests' ? 'Too many attempts. Try again later' :
                error.code === 'auth/network-request-failed' ? 'Network error. Check connection' :
                'Login failed. Please check your connection and try again';
            showMessage(errorMessage, 'error');
        } finally {
            setLoading(false);
        }
    };

    // ---------------------------------------------------------------
    // SIGNUP (unchanged) — kept for completeness
    // ---------------------------------------------------------------
    const handleSignup = async (e) => {
        e.preventDefault();
        clearMessages();
        if (!isOnline) { showMessage('You are offline. Connect to register.', 'error'); return; }
        if (!signupSchoolName) return showMessage('Please enter school name', 'error');
        if (!signupAdminFullName) return showMessage('Please enter admin full name', 'error');
        if (!logoFile) return showMessage('Please upload school logo', 'error');
        if (!profileFile) return showMessage('Please upload admin profile picture', 'error');
        if (!validateEmail(signupEmail)) return showMessage('Please enter a valid email', 'error');
        if (signupPassword.length < 6) return showMessage('Password must be at least 6 characters', 'error');
        if (signupPassword !== confirmPassword) return showMessage('Passwords do not match', 'error');
        if (!termsAgreement) return showMessage('Please agree to the terms', 'error');

        setLoading(true);
        try {
            let logoUrl = '', profileUrl = '';
            try {
                logoUrl = await uploadToCloudinary(logoFile);
                profileUrl = await uploadToCloudinary(profileFile);
            } catch (uploadErr) {
                showMessage(`Image upload failed: ${uploadErr.message}`, 'error');
                return;
            }
            const credential = await createUserWithEmailAndPassword(auth, signupEmail, signupPassword);
            const user = credential.user;
            await updateProfile(user, { displayName: signupAdminFullName });

            const schoolId = generateSchoolId(signupSchoolName);
            await setDoc(doc(db, 'schools', schoolId), {
                schoolId,
                schoolName: signupSchoolName,
                logoUrl, schoolLogo: logoUrl,
                adminName: signupAdminFullName,
                adminImageUrl: profileUrl,
                adminEmail: signupEmail,
                subscriptionStatus: 'inactive',
                trialStartDate: serverTimestamp(),
                trialEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                emailVerified: false,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                settings: { theme: 'default', language: 'en', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            });

            const userData = {
                uid: user.uid, schoolId,
                fullName: signupAdminFullName,
                email: signupEmail, role: 'admin',
                profileImageUrl: profileUrl,
                emailVerified: false,
                lastLogin: serverTimestamp(),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                permissions: {
                    canManageUsers: true, canManageStudents: true, canManageTeachers: true,
                    canManageClasses: true, canManageFinance: true, canManageSettings: true,
                },
            };
            await setDoc(doc(db, 'users', user.uid), userData);
            await cacheUserData({ ...userData, collection: 'users' });

            const emailSent = await sendVerificationEmail(user);
            setSignupSchoolName(''); setSignupAdminFullName(''); setSignupEmail('');
            setSignupPassword(''); setConfirmPassword('');
            setLogoFile(null); setProfileFile(null);
            setLogoPreview(null); setProfilePreview(null);
            setTermsAgreement(false);

            if (emailSent) showMessage(`✅ School account created! Verification email sent to ${signupEmail}`, 'success');
            else showMessage('Account created but verification email failed.', 'warning');
            startVerificationCheck(signupEmail);
        } catch (error) {
            showMessage(error.message || 'Registration failed.', 'error');
        } finally { setLoading(false); }
    };

    const handleForgotPassword = async () => {
        if (!isOnline) { alert('You are offline. Connect to reset your password.'); return; }
        const email = prompt('Enter your email address to reset password:');
        if (email && validateEmail(email)) {
            try {
                await sendPasswordResetEmail(auth, email);
                alert('✅ Password reset email sent!');
            } catch (err) {
                alert(err.code === 'auth/user-not-found' ? 'No account found with this email' : 'Error sending reset email.');
            }
        } else if (email) alert('Please enter a valid email address');
    };

    const handleLogout = async () => {
        try {
            await auth.signOut();
            setShowVerification(false);
            clearMessages();
            showMessage('Logged out successfully', 'info');
        } catch (e) { console.error(e); }
    };

    // ---------------------------------------------------------------
    // RENDER
    // ---------------------------------------------------------------
    return (
        <div className="login-container">
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
                            <div className="logo-container">
                                <img className="logo" src="/Logo.png" alt="EduPriva logo" />
                            </div>
                            <h1 className="system-title">EDUPRIVA</h1>
                            <div className="system-subtitle">School Management System</div>
                        </div>

                        <div className="form-container">
                            {pendingPasswordChange && (
                                <StudentPasswordChangeModal
                                    onDone={completeStudentPasswordChange}
                                    onCancel={() => {
                                        // Sign them out so they can't skip the mandatory change
                                        auth.signOut().then(() => {
                                            setPendingPasswordChange(false);
                                            showMessage('Password change is required to continue. Sign in again.', 'warning');
                                        });
                                    }}
                                />
                            )}

                            {showVerification ? (
                                <div className="verification-section">
                                    <div className="verification-icon"><i className="fas fa-envelope-circle-check"></i></div>
                                    <div className="verification-content">
                                        <h3>Verify Your Email Address</h3>
                                        <p>We've sent a verification email to:</p>
                                        <div className="email-display">{verificationEmail}</div>
                                        <p>Check your inbox and click the verification link.</p>
                                        <div className="verification-timer">
                                            <p>Checking automatically in <span className="timer">{verificationTimer}</span> seconds…</p>
                                        </div>
                                        <div className="resend-link">
                                            Didn't receive it? <span onClick={handleResendVerification}>Resend Verification Email</span>
                                        </div>
                                        <button type="button" className="btn warning" onClick={checkEmailVerification}>
                                            <i className="fas fa-sync-alt"></i><span>Check Verification Status</span>
                                        </button>
                                        <button type="button" className="btn danger" onClick={handleLogout} style={{ marginTop: '10px' }}>
                                            <i className="fas fa-sign-out-alt"></i><span>Logout</span>
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <h2 className="form-title">
                                        {showRegister ? 'Register School' : (loginMode === 'student' ? 'Student Portal' : 'School Portal')}
                                    </h2>

                                    {message.text && (
                                        <div className={`message ${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>
                                            <span>{message.text}</span>
                                            <button type="button" aria-label="Dismiss" onClick={clearMessages}>×</button>
                                        </div>
                                    )}

                                    {/* --- Mode toggle --- */}
                                    {!showRegister && (
                                        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                                            <button
                                                type="button"
                                                onClick={() => { setLoginMode('staff'); clearMessages(); }}
                                                className={`btn ${loginMode === 'staff' ? '' : 'btn-outline'}`}
                                                style={{ flex: 1 }}
                                            >
                                                <i className="fas fa-user-tie"></i> Staff / Admin
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => { setLoginMode('student'); clearMessages(); }}
                                                className={`btn ${loginMode === 'student' ? '' : 'btn-outline'}`}
                                                style={{ flex: 1 }}
                                            >
                                                <i className="fas fa-user-graduate"></i> Student
                                            </button>
                                        </div>
                                    )}

                                    {/* --- Student login form --- */}
                                    {!showRegister && loginMode === 'student' && (
                                        <form className="form active" onSubmit={handleStudentLogin}>
                                            <div className="input-group">
                                                <label htmlFor="studentEmail">Student Email</label>
                                                <i className="fas fa-envelope"></i>
                                                <input
                                                    type="email" id="studentEmail"
                                                    value={studentEmail}
                                                    onChange={(e) => setStudentEmail(e.target.value)}
                                                    placeholder="your.name@school.com" required
                                                />
                                            </div>
                                            <div className="input-group">
                                                <label htmlFor="studentAdmissionNumber">Admission Number</label>
                                                <i className="fas fa-id-card"></i>
                                                <input
                                                    type="text" id="studentAdmissionNumber"
                                                    value={studentAdmissionNumber}
                                                    onChange={(e) => setStudentAdmissionNumber(e.target.value)}
                                                    placeholder="e.g. 00123"
                                                    required
                                                />
                                            </div>
                                            <div className="input-group">
                                                <label htmlFor="studentSchoolId">School ID</label>
                                                <i className="fas fa-school"></i>
                                                <input
                                                    type="text" id="studentSchoolId"
                                                    value={studentSchoolId}
                                                    onChange={(e) => setStudentSchoolId(e.target.value)}
                                                    placeholder="e.g. TOP-ab12-xyz9"
                                                    required
                                                />
                                                <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                                                    Ask your school office if you don't know your School ID.
                                                </div>
                                            </div>
                                            <button type="submit" className="btn" disabled={loading}>
                                                {loading ? (<><div className="loading"></div><span>Signing in…</span></>) : (<><i className="fas fa-sign-in-alt"></i><span>Sign In as Student</span></>)}
                                            </button>
                                            <div style={{ fontSize: 12, color: '#64748b', textAlign: 'center', marginTop: 10, lineHeight: 1.5 }}>
                                                <i className="fas fa-info-circle"></i>{' '}
                                                On your first login, use your <strong>admission number</strong> as the password.
                                                You'll be asked to set a new password.
                                            </div>
                                            <div className="forgot-password" onClick={handleForgotPassword}>Forgot Password?</div>
                                        </form>
                                    )}

                                    {/* --- Staff login form --- */}
                                    {!showRegister && loginMode === 'staff' && (
                                        <form className="form active" onSubmit={handleLogin}>
                                            <div className="input-group">
                                                <label htmlFor="loginEmail">Email Address</label>
                                                <i className="fas fa-envelope"></i>
                                                <input
                                                    type="email" id="loginEmail" value={loginEmail}
                                                    onChange={(e) => { setLoginEmail(e.target.value); setEmailValid(e.target.value === '' ? null : validateEmail(e.target.value)); }}
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
                                            <button type="submit" className="btn" disabled={loading}>
                                                {loading ? (<><div className="loading"></div><span>Logging in...</span></>) : (<><i className="fas fa-sign-in-alt"></i><span>Login to Dashboard</span></>)}
                                            </button>
                                            {biometricReady && (currentUser || auth.currentUser) && (
                                                <button
                                                    type="button" className="btn"
                                                    onPointerDown={(e) => { if (e.isPrimary && e.button === 0) handleBiometricLogin(); }}
                                                    onClick={handleBiometricLogin}
                                                    disabled={loading}
                                                >
                                                    {loading ? <><div className="loading"></div><span>Verifying…</span></> : <><i className="fas fa-fingerprint"></i><span>Continue with biometrics</span></>}
                                                </button>
                                            )}
                                            {pendingBiometricRole && (
                                                <section role="dialog" aria-modal="true" style={{ marginTop: 18, padding: 18, border: '1px solid #cbd5e1', borderRadius: 12, background: '#f8fafc', color: '#172033' }}>
                                                    <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>Enable biometric unlock?</h3>
                                                    <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.5 }}>
                                                        Use your device fingerprint or face to reopen your saved session offline.
                                                    </p>
                                                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                                        <button type="button" className="btn" onClick={() => finishBiometricSetup(true)} disabled={loading} style={{ width: 'auto' }}>
                                                            Enable securely
                                                        </button>
                                                        <button type="button" className="btn btn-outline" onClick={() => finishBiometricSetup(false)} disabled={loading} style={{ width: 'auto' }}>
                                                            Continue without it
                                                        </button>
                                                    </div>
                                                </section>
                                            )}
                                            <div className="forgot-password" onClick={handleForgotPassword}>Forgot Password?</div>
                                        </form>
                                    )}

                                    {showRegister && (
                                        <form className="form active" onSubmit={handleSignup}>
                                            <div className="input-group">
                                                <label htmlFor="schoolName">School Name</label>
                                                <i className="fas fa-school"></i>
                                                <input type="text" id="schoolName" value={signupSchoolName}
                                                    onChange={(e) => setSignupSchoolName(e.target.value)}
                                                    placeholder="Enter school name" required />
                                            </div>
                                            <div className="input-group">
                                                <label htmlFor="adminFullName">Admin Full Name</label>
                                                <i className="fas fa-user-tie"></i>
                                                <input type="text" id="adminFullName" value={signupAdminFullName}
                                                    onChange={(e) => setSignupAdminFullName(e.target.value)}
                                                    placeholder="Enter admin full name" required />
                                            </div>
                                            <div className="file-upload-container">
                                                <label>School Logo</label>
                                                <div className="upload-preview">
                                                    <div className="logo-preview">
                                                        {logoPreview ? <img src={logoPreview} alt="School Logo" /> : <i className="fas fa-school fa-2x" style={{ color: '#ccc' }}></i>}
                                                    </div>
                                                    <div className="upload-info">
                                                        <p>Upload your school logo (Max 2MB)</p>
                                                        <button type="button" className="upload-btn" onClick={() => {
                                                            const input = document.createElement('input');
                                                            input.type = 'file';
                                                            input.accept = 'image/jpeg,image/png,image/gif,image/webp';
                                                            input.onchange = (ev) => {
                                                                const file = ev.target.files?.[0];
                                                                if (!file) return;
                                                                if (file.size > 2 * 1024 * 1024) return showMessage('Image must be under 2MB', 'error');
                                                                setLogoFile(file);
                                                                const r = new FileReader();
                                                                r.onloadend = () => setLogoPreview(r.result);
                                                                r.readAsDataURL(file);
                                                            };
                                                            input.click();
                                                        }}>
                                                            <i className="fas fa-upload"></i><span>Upload Logo</span>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="file-upload-container">
                                                <label>Admin Profile Picture</label>
                                                <div className="upload-preview">
                                                    <div className="profile-preview">
                                                        {profilePreview ? <img src={profilePreview} alt="Admin Profile" /> : <i className="fas fa-user fa-2x" style={{ color: '#ccc' }}></i>}
                                                    </div>
                                                    <div className="upload-info">
                                                        <p>Upload admin profile picture (Max 2MB)</p>
                                                        <button type="button" className="upload-btn" onClick={() => {
                                                            const input = document.createElement('input');
                                                            input.type = 'file';
                                                            input.accept = 'image/jpeg,image/png,image/gif,image/webp';
                                                            input.onchange = (ev) => {
                                                                const file = ev.target.files?.[0];
                                                                if (!file) return;
                                                                if (file.size > 2 * 1024 * 1024) return showMessage('Image must be under 2MB', 'error');
                                                                setProfileFile(file);
                                                                const r = new FileReader();
                                                                r.onloadend = () => setProfilePreview(r.result);
                                                                r.readAsDataURL(file);
                                                            };
                                                            input.click();
                                                        }}>
                                                            <i className="fas fa-upload"></i><span>Upload Profile</span>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="input-group">
                                                <label htmlFor="signupEmail">Admin Email Address</label>
                                                <i className="fas fa-envelope"></i>
                                                <input type="email" id="signupEmail" value={signupEmail}
                                                    onChange={(e) => { setSignupEmail(e.target.value); setSignupEmailValid(e.target.value === '' ? null : validateEmail(e.target.value)); }}
                                                    placeholder="Enter admin email" required />
                                            </div>
                                            <div className="input-group">
                                                <label htmlFor="signupPassword">Password</label>
                                                <i className="fas fa-lock"></i>
                                                <input type="password" id="signupPassword" value={signupPassword}
                                                    onChange={(e) => setSignupPassword(e.target.value)}
                                                    placeholder="Create a strong password" required />
                                            </div>
                                            <div className="input-group">
                                                <label htmlFor="confirmPassword">Confirm Password</label>
                                                <i className="fas fa-lock"></i>
                                                <input type="password" id="confirmPassword" value={confirmPassword}
                                                    onChange={(e) => { setConfirmPassword(e.target.value); setPasswordsMatch(e.target.value === '' ? null : signupPassword === e.target.value); }}
                                                    placeholder="Confirm your password" required />
                                            </div>
                                            <div className="input-group" style={{ marginBottom: '10px' }}>
                                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                                                    <input type="checkbox" id="termsAgreement" checked={termsAgreement}
                                                        onChange={(e) => setTermsAgreement(e.target.checked)}
                                                        style={{ width: 'auto', marginTop: '3px' }} />
                                                    <label htmlFor="termsAgreement" style={{ fontSize: '13px', color: '#666', cursor: 'pointer' }}>
                                                        I agree to the <a href="#" style={{ color: 'var(--primary)' }}>Terms of Service</a> and <a href="#" style={{ color: 'var(--primary)' }}>Privacy Policy</a>.
                                                    </label>
                                                </div>
                                            </div>
                                            <button type="submit" className="btn warning" disabled={loading || !isOnline}>
                                                {loading ? (<><div className="loading"></div><span>Creating account…</span></>) : (<><i className="fas fa-school"></i><span>Register School</span></>)}
                                            </button>
                                            <div className="toggle-link" onClick={toggleRegister}>
                                                Already have an account? <span>Login</span>
                                            </div>
                                        </form>
                                    )}

                                    {!showRegister && (
                                        <div className="toggle-link" onClick={toggleRegister}>
                                            Don't have a school account? <span>Register</span>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

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
                    object-fit: contain;
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
