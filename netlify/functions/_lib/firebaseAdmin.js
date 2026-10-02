// netlify/functions/_lib/firebaseAdmin.js
//
// Firebase Admin initializer for Netlify functions.
// Uses the LEGACY namespace API compatible with firebase-admin v11.x.
//
// Credential priority:
//   1. FIREBASE_SERVICE_ACCOUNT      — single-line JSON service account blob
//   2. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY

let admin = null;
let initialized = false;

function normalizePrivateKey(key) {
    if (typeof key !== 'string') return '';
    let k = key.trim();
    if (k.startsWith('"') && k.endsWith('"')) k = k.slice(1, -1);
    return k.replace(/\\n/g, '\n');
}

function buildServiceAccountFromEnv() {
    const blob = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (blob && blob.trim()) {
        let parsed;
        try {
            parsed = JSON.parse(blob);
        } catch (err) {
            throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON: ' + err.message);
        }
        const missing = ['project_id', 'client_email', 'private_key']
            .filter((f) => !parsed[f]);
        if (missing.length) {
            throw new Error(
                'FIREBASE_SERVICE_ACCOUNT is missing field(s): ' + missing.join(', ')
            );
        }
        return {
            projectId: parsed.project_id,
            clientEmail: parsed.client_email,
            privateKey: normalizePrivateKey(parsed.private_key),
        };
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const rawKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !rawKey) {
        throw new Error(
            'Firebase Admin credentials missing. Set FIREBASE_SERVICE_ACCOUNT, ' +
            'or all three of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.'
        );
    }

    return {
        projectId,
        clientEmail,
        privateKey: normalizePrivateKey(rawKey),
    };
}

/**
 * Return the initialized Firebase Admin namespace.
 * Idempotent across warm invocations.
 */
function initAdmin() {
    if (initialized && admin) return admin;

    if (!admin) {
        try {
            admin = require('firebase-admin');
        } catch (e) {
            throw new Error('firebase-admin is not installed: ' + e.message);
        }
    }

    if (admin.apps && admin.apps.length > 0) {
        initialized = true;
        return admin;
    }

    const serviceAccount = buildServiceAccountFromEnv();

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });

    initialized = true;
    return admin;
}

module.exports = { initAdmin };
