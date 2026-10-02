// netlify/functions/_lib/firebaseAdmin.js
//
// Firebase Admin initializer for Netlify functions.
// Uses the MODULAR API required by firebase-admin v13+.
//
// Credential priority:
//   1. FIREBASE_SERVICE_ACCOUNT      — single-line JSON service account blob
//   2. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY

const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

let cachedApp = null;

/**
 * Normalize a private key from an env var.
 * Strips wrapping quotes, trims, converts literal \n to real newlines.
 */
function normalizePrivateKey(key) {
    if (typeof key !== 'string') return '';
    let k = key.trim();
    if (k.startsWith('"') && k.endsWith('"')) k = k.slice(1, -1);
    return k.replace(/\\n/g, '\n');
}

function buildServiceAccountFromEnv() {
    // Preferred: one JSON blob
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

    // Fallback: three individual vars
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
 * Return the initialized Admin App. Idempotent across warm invocations.
 * Exposes { app, db, auth } so callers can use them directly.
 */
function initAdmin() {
    if (cachedApp) {
        return {
            app: cachedApp,
            db: getFirestore(cachedApp),
            auth: getAuth(cachedApp),
        };
    }

    // Reuse an app if the container is already warm and one exists.
    if (getApps().length > 0) {
        cachedApp = getApp();
        return {
            app: cachedApp,
            db: getFirestore(cachedApp),
            auth: getAuth(cachedApp),
        };
    }

    const serviceAccount = buildServiceAccountFromEnv();

    cachedApp = initializeApp({
        credential: cert(serviceAccount),
    });

    return {
        app: cachedApp,
        db: getFirestore(cachedApp),
        auth: getAuth(cachedApp),
    };
}

module.exports = { initAdmin };
