// netlify/functions/_lib/chatbotAuth.js
const { initAdmin } = require('./firebaseAdmin');

const ADMIN_ROLES = new Set(['admin', 'school_admin', 'super-admin', 'platform_admin', 'user']);

// Same fallback order as src/context/AuthContext.jsx → resolveUser().
// A user's document can live in any of these collections depending on
// how the account was created:
//   - users:      admins, super-admins, users backfilled by AuthContext
//   - teachers:   accounts created via the Teachers page (REST API signUp)
//   - students:   student accounts
// We try them in order and stop at the first one that has a schoolId.
const USER_COLLECTIONS = ['users', 'teachers', 'students'];

async function requireAuth(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
        throw Object.assign(new Error('Missing Authorization header'), { statusCode: 401 });
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
        throw Object.assign(new Error('Empty bearer token'), { statusCode: 401 });
    }

    let admin;
    try {
        admin = initAdmin();
    } catch (initErr) {
        console.error('[chatbotAuth] initAdmin failed:', initErr.message);
        throw Object.assign(
            new Error('Auth backend unavailable: ' + initErr.message),
            { statusCode: 503 }
        );
    }

    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(token);
    } catch (verifyErr) {
        console.error('[chatbotAuth] verifyIdToken failed', {
            code: verifyErr.code,
            message: verifyErr.message,
            tokenPrefix: token.slice(0, 20),
            tokenLength: token.length,
        });
        throw Object.assign(
            new Error(`Auth failed: ${verifyErr.code || verifyErr.message}`),
            { statusCode: 401 }
        );
    }

    const db = admin.firestore();

    // ----------------------------------------------------------------
    // Resolve the caller's profile from any of the candidate collections.
    // Mirrors AuthContext.resolveUser() so the chatbot works for the same
    // users the rest of the app works for.
    // ----------------------------------------------------------------
    let userDoc = {};
    let resolvedCollection = null;

    for (const name of USER_COLLECTIONS) {
        try {
            const snap = await db.collection(name).doc(decoded.uid).get();
            if (snap.exists) {
                const data = snap.data() || {};
                // Prefer the first doc we find, but keep looking if it has
                // no schoolId — a `users` stub without schoolId is useless
                // here, and the actual record may live in `teachers`.
                if (!resolvedCollection) {
                    userDoc = data;
                    resolvedCollection = name;
                }
                if (data.schoolId || data.school_id) {
                    userDoc = data;
                    resolvedCollection = name;
                    break;
                }
            }
        } catch (dbErr) {
            console.error('[chatbotAuth] Firestore read failed', {
                collection: name,
                uid: decoded.uid,
                code: dbErr.code,
                message: dbErr.message,
            });
        }
    }

    // schoolId can come from the user doc OR from a Firebase Auth custom claim.
    const schoolId = userDoc.schoolId || userDoc.school_id || decoded.schoolId || null;
    const role = userDoc.role || decoded.role || 'user';
    const fullName = userDoc.fullName
        || [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim()
        || decoded.name
        || decoded.email
        || 'User';

    if (!schoolId) {
        console.warn('[chatbotAuth] No school membership', {
            uid: decoded.uid,
            email: decoded.email,
            resolvedCollection,
            userDocKeys: Object.keys(userDoc || {}),
        });
        throw Object.assign(new Error('No school membership'), { statusCode: 403 });
    }

    // ----------------------------------------------------------------
    // Self-heal: if we had to read from a non-`users` collection (or the
    // `users` doc was missing schoolId), mirror the profile into
    // `users/{uid}` so every consumer — chatbotAuth, other Netlify
    // functions, and future page reads that only look at `users` — sees
    // a consistent record.
    //
    // Fire-and-forget: never blocks the request, and any failure is
    // logged but not surfaced.
    // ----------------------------------------------------------------
    const needsHeal =
        resolvedCollection !== 'users' ||
        !userDoc.schoolId ||
        !userDoc.fullName;

    if (needsHeal) {
        setImmediate(() => {
            const healPayload = {
                uid: decoded.uid,
                email: decoded.email || userDoc.email || '',
                role,
                schoolId,
                fullName,
                updatedAt: new Date(),
            };

            // Copy through the fields other pages rely on, only when present.
            const passthrough = [
                'firstName', 'lastName',
                'assignments', 'classes', 'subjects', 'levels', 'level',
                'status', 'phone', 'qualification', 'address',
                'profileImageUrl',
            ];
            for (const key of passthrough) {
                if (userDoc[key] !== undefined) healPayload[key] = userDoc[key];
            }

            db.collection('users').doc(decoded.uid)
                .set(healPayload, { merge: true })
                .catch((e) => {
                    console.warn(
                        '[chatbotAuth] users/{uid} self-heal failed (non-fatal):',
                        e.message
                    );
                });
        });
    }

    return {
        uid: decoded.uid,
        email: decoded.email || userDoc.email || '',
        role,
        schoolId,
        fullName,
        isAdmin: ADMIN_ROLES.has(role),
        // Useful for debugging; harmless if unused by callers.
        source: resolvedCollection || (decoded.schoolId ? 'claims' : 'unknown'),
    };
}

function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(body),
    };
}

function errorResponse(err) {
    const statusCode = err.statusCode || 500;
    return json(statusCode, { success: false, error: err.message || 'Server error' });
}

module.exports = { requireAuth, json, errorResponse, ADMIN_ROLES };
