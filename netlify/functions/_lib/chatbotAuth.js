// netlify/functions/_lib/chatbotAuth.js
const { initAdmin } = require('./firebaseAdmin');

const ADMIN_ROLES = new Set(['admin', 'school_admin', 'super-admin', 'platform_admin', 'user']);

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

    let userDoc = {};
    try {
        const db = admin.firestore();
        const userSnap = await db.collection('users').doc(decoded.uid).get();
        userDoc = userSnap.exists ? userSnap.data() : {};
    } catch (dbErr) {
        console.error('[chatbotAuth] Firestore read failed', {
            uid: decoded.uid,
            code: dbErr.code,
            message: dbErr.message,
        });
    }

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
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(body),
    };
}

function errorResponse(err) {
    const statusCode = err.statusCode || 500;
    return json(statusCode, { success: false, error: err.message || 'Server error' });
}

module.exports = { requireAuth, json, errorResponse, ADMIN_ROLES };
