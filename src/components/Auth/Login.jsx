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
                                            <p>Checking automatically in <span className="timer">{verificationTimer}</span> seconds…</
