// netlify/functions/_lib/chatbotAuth.js
//
// Shared auth helper for chatbot Netlify functions.
//
// Verifies a Firebase ID token and returns:
//   { uid, email, role, schoolId, fullName }
//
// Also verifies the caller has an active school membership.

const { initAdmin } = require('./firebaseAdmin');

const ADMIN_ROLES = new Set(['admin', 'school_admin', 'super-admin', 'platform_admin', 'user']);

/**
 * Extract and verify the caller's identity.
 * Throws on failure. The caller should catch and return a 401/403.
 */
async function requireAuth(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
        throw Object.assign(new Error('Missing bearer token'), { statusCode: 401 });
    }
    const token = authHeader.slice(7).trim();

    const admin = initAdmin();
    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(token);
    } catch (err) {
        throw Object.assign(new Error('Invalid or expired token'), { statusCode: 401 });
    }

    const db = admin.firestore();
    const userSnap = await db.collection('users').doc(decoded.uid).get();
    const userDoc = userSnap.exists ? userSnap.data() : {};

    const schoolId = userDoc.schoolId || decoded.schoolId || null;
    const role = userDoc.role || decoded.role || 'user';
    const fullName = userDoc.fullName
        || [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim()
        || decoded.name
        || decoded.email
        || 'User';

    if (!schoolId) {
        throw Object.assign(new Error('No school membership'), { statusCode: 403 });
    }

    return {
        uid: decoded.uid,
        email: decoded.email || userDoc.email || '',
        role,
        schoolId,
        fullName,
        isAdmin: ADMIN_ROLES.has(role),
    };
}

function json(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        },
        body: JSON.stringify(body),
    };
}

function errorResponse(err) {
    const statusCode = err.statusCode || 500;
    return json(statusCode, { success: false, error: err.message || 'Server error' });
}

module.exports = { requireAuth, json, errorResponse, ADMIN_ROLES };
