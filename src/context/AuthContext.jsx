// src/context/AuthContext.jsx
import React, {
    createContext, useState, useEffect, useContext, useCallback, useRef
} from 'react';
import { auth, db } from '../firebase';
import { onAuthStateChanged, signOut, getIdTokenResult } from 'firebase/auth';
import {
    doc, getDoc, setDoc, updateDoc, serverTimestamp
} from 'firebase/firestore';
import { useSync } from './SyncContext';
import { getBiometricLoginStatus, isDeviceBiometricAvailable } from '../services/deviceSecurity';

const AuthContext = createContext();

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
    return ctx;
}

// ---------------------------------------------------------------------------
// School branding: read once per session, merged into userData so every PDF
// and every page can access it without additional Firestore reads.
// ---------------------------------------------------------------------------
async function fetchSchoolBranding(schoolId) {
    if (!schoolId) return null;
    try {
        const snap = await getDoc(doc(db, 'schools', schoolId));
        if (!snap.exists()) return null;
        const s = snap.data();
        return {
            schoolName: s.name || s.schoolName || '',
            schoolMotto: s.motto || '',
            schoolLogo: s.logoUrl || '',
            schoolAddress: s.address || '',
            schoolPhone: s.phone || '',
            schoolEmail: s.email || '',
            schoolFeatures: s.features || null,
            schoolPaybill: s.paybillNumber || ''
        };
    } catch (e) {
        console.warn('fetchSchoolBranding failed:', e);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Profile hydration: read the user's profile document from users/teachers/students
// so we can pick up fields that aren't part of the JWT — profileImageUrl,
// phone, firstName, lastName, fullName, photoURL, etc.
//
// Returns { data, collection } where collection is the Firestore collection
// name we found the doc in, or { data: null, collection: null } if none exists.
// ---------------------------------------------------------------------------
async function fetchUserProfileDoc(uid, isOnline) {
    if (!uid) return { data: null, collection: null };

    if (isOnline) {
        for (const name of ['users', 'teachers', 'students']) {
            try {
                const snap = await getDoc(doc(db, name, uid));
                if (snap.exists()) {
                    return { data: snap.data(), collection: name };
                }
            } catch (e) {
                // Silent — a missing doc or a permission error just means we
                // skip to the next collection.
                console.warn(`Profile lookup failed for ${name}/${uid}:`, e);
            }
        }
    }

    return { data: null, collection: null };
}

export function AuthProvider({ children }) {
    const [currentUser, setCurrentUser] = useState(null);
    const [userData, setUserData] = useState(null);
    const [userRole, setUserRole] = useState(null);
    const [userCollection, setUserCollection] = useState(null);
    const [claims, setClaims] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [sessionLocked, setSessionLocked] = useState(false);

    const { isOnline, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();

    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // ---- IndexedDB cache ----
    const cacheUserData = useCallback(async (uid, data) => {
        try {
            await saveToIndexedDB(`cached_user_${uid}`, {
                ...data,
                cachedAt: new Date().toISOString()
            });
        } catch (e) {
            console.warn('cacheUserData failed:', e);
        }
    }, [saveToIndexedDB]);

    const getCachedUserData = useCallback(async (uid) => {
        try {
            return await getFromIndexedDB(`cached_user_${uid}`);
        } catch (e) {
            console.warn('getCachedUserData failed:', e);
            return null;
        }
    }, [getFromIndexedDB]);

    // -----------------------------------------------------------------------
    // Resolve user document
    //  1. Custom claims (fast) + profile doc read for non-JWT fields
    //  2. Firestore fallback (users → teachers → students)
    //  3. Offline cache
    //  4. Minimal shell
    // -----------------------------------------------------------------------
    const resolveUser = useCallback(async (user, email) => {
        const uid = user.uid;

        if (!isOnline) {
            const cached = await getCachedUserData(uid);
            if (cached) {
                return {
                    data: cached,
                    role: cached.role || 'user',
                    collection: cached.collection || 'users',
                    schoolId: cached.schoolId || null,
                    claims: {},
                    source: 'cache'
                };
            }
        }

        // ---- 1. Custom claims ----
        let tokenClaims = {};
        try {
            const tokenResult = await getIdTokenResult(user);
            tokenClaims = tokenResult.claims || {};
        } catch (e) {
            console.warn('getIdTokenResult failed:', e);
        }

        if (tokenClaims.role && tokenClaims.schoolId) {
            const branding = await fetchSchoolBranding(tokenClaims.schoolId);

            // One extra read to hydrate profile-only fields (photo, phone, names).
            // Falls back to the IndexedDB cache when offline.
            let profileData = null;
            let profileCollection = 'claims';

            const fetched = await fetchUserProfileDoc(uid, isOnline);
            if (fetched.data) {
                profileData = fetched.data;
                profileCollection = fetched.collection;
            } else {
                const cached = await getCachedUserData(uid);
                if (cached) {
                    profileData = cached;
                    profileCollection = cached.collection || 'claims';
                }
            }

            return {
                data: {
                    uid,
                    email: email || user.email || '',

                    // Claims win for identity + scope
                    role: tokenClaims.role,
                    schoolId: tokenClaims.schoolId,
                    level: tokenClaims.level || profileData?.level || '',
                    classes: tokenClaims.classes || profileData?.classes || [],
                    subjects: tokenClaims.subjects || profileData?.subjects || [],

                    // Profile-doc fields — everything the JWT doesn't carry
                    firstName: profileData?.firstName || '',
                    lastName: profileData?.lastName || '',
                    fullName:
                        profileData?.fullName
                        || user.displayName
                        || email
                        || '',
                    phone: profileData?.phone || '',
                    profileImageUrl: profileData?.profileImageUrl || '',
                    photoURL: profileData?.photoURL || user.photoURL || '',

                    // School branding
                    ...(branding || {})
                },
                role: tokenClaims.role,
                collection: profileCollection,
                schoolId: tokenClaims.schoolId,
                claims: tokenClaims,
                source: 'claims+profile'
            };
        }

        // ---- 2. Firestore fallback ----
        if (isOnline) {
            const collections = ['users', 'teachers', 'students'];
            for (const name of collections) {
                try {
                    const snap = await getDoc(doc(db, name, uid));
                    if (snap.exists()) {
                        const data = snap.data();
                        const role = data.role
                            || (name === 'teachers' ? 'teacher'
                                : name === 'students' ? 'student'
                                : 'user');
                        const schoolId = data.schoolId || data.school_id || null;

                        const branding = await fetchSchoolBranding(schoolId);

                        return {
                            data: {
                                ...data,
                                uid,
                                email: email || data.email || '',
                                profileImageUrl:
                                    data.profileImageUrl
                                    || data.photoURL
                                    || '',
                                ...(branding || {})
                            },
                            role,
                            collection: name,
                            schoolId,
                            claims: tokenClaims,
                            source: 'firestore'
                        };
                    }
                } catch (e) {
                    console.warn(`Firestore ${name} lookup failed:`, e);
                }
            }
        }

        // ---- 3. Offline cache ----
        const cached = await getCachedUserData(uid);
        if (cached) {
            return {
                data: cached,
                role: cached.role || 'user',
                collection: cached.collection || 'users',
                schoolId: cached.schoolId || null,
                claims: tokenClaims,
                source: 'cache'
            };
        }

        // ---- 4. Minimal shell ----
        return {
            data: {
                uid,
                email: email || user.email || '',
                role: 'user',
                schoolId: null
            },
            role: 'user',
            collection: 'users',
            schoolId: null,
            claims: tokenClaims,
            source: 'fallback'
        };
    }, [getCachedUserData, isOnline]);

    // ---- Auth state listener ----
    useEffect(() => {
        const unsub = onAuthStateChanged(auth, async (user) => {
            if (!user) {
                if (!mountedRef.current) return;
                setCurrentUser(null);
                setUserData(null);
                setUserRole(null);
                setUserCollection(null);
                setClaims({});
                setSessionLocked(false);
                setLoading(false);
                return;
            }

            try {
                if (!navigator.onLine && isDeviceBiometricAvailable()) {
                    try {
                        const biometric = await getBiometricLoginStatus();
                        setSessionLocked(biometric.available);
                    } catch (biometricError) {
                        console.warn('Could not check offline session protection:', biometricError);
                        setSessionLocked(true);
                    }
                } else {
                    setSessionLocked(false);
                }

                const resolved = await resolveUser(user, user.email);

                // Backfill users doc only when we had to fall back to Firestore
                if (
                    isOnline
                    && resolved.source === 'firestore'
                    && (!resolved.claims.role || !resolved.claims.schoolId)
                ) {
                    try {
                        await setDoc(doc(db, 'users', user.uid), {
                            uid: user.uid,
                            email: user.email || '',
                            role: resolved.role,
                            schoolId: resolved.schoolId,
                            lastLogin: serverTimestamp(),
                            updatedAt: serverTimestamp()
                        }, { merge: true });
                    } catch (e) {
                        console.warn('User doc backfill failed (non-fatal):', e);
                    }
                }

                await cacheUserData(user.uid, {
                    ...resolved.data,
                    role: resolved.role,
                    collection: resolved.collection,
                    schoolId: resolved.schoolId
                });

                if (!mountedRef.current) return;
                setCurrentUser(user);
                setUserData(resolved.data);
                setUserRole(resolved.role);
                setUserCollection(resolved.collection);
                setClaims(resolved.claims || {});
            } catch (e) {
                console.error('Auth bootstrap failed:', e);
                if (mountedRef.current) setError(e.message);
            } finally {
                if (mountedRef.current) setLoading(false);
            }
        });

        return () => unsub();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const unlockSession = useCallback(() => {
        setSessionLocked(false);
    }, []);

    // ---- Update user data ----
    const updateUserData = useCallback(async (updates) => {
        if (!currentUser) throw new Error('No user logged in');

        const uid = currentUser.uid;
        const collectionName = userCollection && userCollection !== 'claims'
            ? userCollection
            : 'users';
        const updated = { ...userData, ...updates };

        // If branding fields are in `updates`, they belong to the school doc,
        // not the user doc. Split them out.
        const {
            schoolName, schoolMotto, schoolLogo, schoolAddress,
            schoolPhone, schoolEmail, schoolFeatures, schoolPaybill,
            ...userOnlyUpdates
        } = updates;

        const hasBrandingUpdates = Object.keys({
            schoolName, schoolMotto, schoolLogo, schoolAddress,
            schoolPhone, schoolEmail, schoolFeatures, schoolPaybill
        }).some((k) => updates[k] !== undefined);

        if (isOnline) {
            try {
                if (Object.keys(userOnlyUpdates).length > 0) {
                    await updateDoc(doc(db, collectionName, uid), {
                        ...userOnlyUpdates,
                        updatedAt: serverTimestamp()
                    });
                }

                if (hasBrandingUpdates && userData?.schoolId) {
                    const schoolUpdates = {};
                    if (schoolName !== undefined) schoolUpdates.name = schoolName;
                    if (schoolMotto !== undefined) schoolUpdates.motto = schoolMotto;
                    if (schoolLogo !== undefined) schoolUpdates.logoUrl = schoolLogo;
                    if (schoolAddress !== undefined) schoolUpdates.address = schoolAddress;
                    if (schoolPhone !== undefined) schoolUpdates.phone = schoolPhone;
                    if (schoolEmail !== undefined) schoolUpdates.email = schoolEmail;
                    if (schoolFeatures !== undefined) schoolUpdates.features = schoolFeatures;
                    if (schoolPaybill !== undefined) schoolUpdates.paybillNumber = schoolPaybill;
                    schoolUpdates.updatedAt = serverTimestamp();

                    if (Object.keys(schoolUpdates).length > 0) {
                        await updateDoc(
                            doc(db, 'schools', userData.schoolId),
                            schoolUpdates
                        );
                    }
                }
            } catch (e) {
                console.warn('updateDoc failed, queueing:', e);
                await addToSyncQueue(collectionName, 'update', { id: uid, ...userOnlyUpdates });
            }
        } else {
            if (Object.keys(userOnlyUpdates).length > 0) {
                await addToSyncQueue(collectionName, 'update', { id: uid, ...userOnlyUpdates });
            }
        }

        setUserData(updated);
        await cacheUserData(uid, {
            ...updated,
            role: userRole,
            collection: collectionName
        });
        return updated;
    }, [
        currentUser, userCollection, userData, userRole,
        isOnline, addToSyncQueue, cacheUserData
    ]);

    // ---- Logout ----
    const logout = useCallback(async () => {
        try {
            if (isOnline && currentUser) {
                const uid = currentUser.uid;
                const collectionName = userCollection && userCollection !== 'claims'
                    ? userCollection
                    : 'users';
                updateDoc(doc(db, collectionName, uid), { lastLogout: serverTimestamp() })
                    .catch((e) => console.warn('lastLogout update failed:', e));
            }
            await signOut(auth);
            setCurrentUser(null);
            setUserData(null);
            setUserRole(null);
            setUserCollection(null);
            setClaims({});
            setSessionLocked(false);
        } catch (e) {
            console.error('Logout error:', e);
            throw e;
        }
    }, [currentUser, userCollection, isOnline]);

    const value = {
        currentUser,
        userData,
        userRole,
        userCollection,
        claims,
        loading,
        error,
        isOnline,
        sessionLocked,
        unlockSession,
        logout,
        updateUserData
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export default AuthContext;
