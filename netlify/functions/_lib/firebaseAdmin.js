// netlify/functions/_lib/firebaseAdmin.js
//
// Firebase Admin initializer for Netlify functions.
//
// Credential priority:
//   1. FIREBASE_SERVICE_ACCOUNT      — single-line JSON service account blob
//   2. FIREBASE_PROJECT_ID
//      FIREBASE_CLIENT_EMAIL
//      FIREBASE_PRIVATE_KEY          — three separate variables
//
// The module caches the initialized app so repeated calls across warm
// invocations are cheap and idempotent.

let admin = null;
let initialized = false;

/**
 * Turn the escaped "\n" sequences that come out of environment variables
 * back into real newline characters, and strip a leading/trailing pair of
 * double quotes if someone pasted the value with them.
 */
function normalizePrivateKey(key) {
    if (typeof key !== 'string') return '';
    let k = key.trim();

    // Some CLIs and copy/paste flows keep the JSON wrapper's quotes.
    if (k.startsWith('"') && k.endsWith('"')) {
        k = k.slice(1, -1);
    }

    // Env vars store real newlines as the two characters \ and n.
    // Convert them back so the PEM parser is happy.
    k = k.replace(/\\n/g, '\n');

    return k;
}

/**
 * Validate the shape of a parsed service account object.
 * Throws with a descriptive message if anything is missing.
 */
function validateServiceAccount(sa) {
    if (!sa || typeof sa !== 'object') {
        throw new Error('Service account is not an object');
    }
    const required = ['project_id', 'client_email', 'private_key'];
    const missing = required.filter((f) => !sa[f]);
    if (missing.length) {
        throw new Error(
            'Service account is missing required field(s): ' + missing.join(', ')
        );
    }
    return {
        projectId: sa.project_id,
        clientEmail: sa.client_email,
        privateKey: normalizePrivateKey(sa.private_key),
    };
}

function initAdmin() {
    // 1. Require the SDK (cached on the module after the first call).
    if (!admin) {
        try {
            admin = require('firebase-admin');
        } catch (e) {
            throw new Error('firebase-admin is not installed in this environment');
        }
    }

    // 2. If an app is already initialized on this warm container, reuse it.
    if (initialized && admin.apps && admin.apps.length) {
        return admin;
    }

    // 3. Preferred: single JSON blob.
    const blob = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (blob && blob.trim()) {
        let parsed;
        try {
            parsed = JSON.parse(blob);
        } catch (err) {
            throw new Error(
                'FIREBASE_SERVICE_ACCOUNT is not valid JSON: ' + err.message
            );
        }

        const { projectId, clientEmail, privateKey } = validateServiceAccount(parsed);

        admin.initializeApp({
            credential: admin.credential.cert({
                projectId,
                clientEmail,
                privateKey,
            }),
        });

        initialized = true;
        return admin;
    }

    // 4. Fallback: three separate variables.
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const rawKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !rawKey) {
        throw new Error(
            'Firebase Admin credentials missing. Set FIREBASE_SERVICE_ACCOUNT, ' +
            'or all three of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, ' +
            'FIREBASE_PRIVATE_KEY.'
        );
    }

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey: normalizePrivateKey(rawKey),
        }),
    });

    initialized = true;
    return admin;
}

module.exports = { initAdmin };
