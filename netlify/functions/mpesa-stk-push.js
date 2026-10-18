const { withCors } = require('./_lib/cors');
// netlify/functions/mpesa-stk-push.js
const axios = require('axios');
const { initAdmin } = require('./_lib/firebaseAdmin');
const { requireAuth } = require('./_lib/chatbotAuth');

const FEE_MANAGER_ROLES = new Set([
    'admin', 'user', 'school-admin', 'school_admin', 'principal',
    'headteacher', 'deputy-headteacher', 'finance', 'accountant',
    'super-admin', 'super_admin', 'platform-admin', 'platform_admin',
]);

const normalizeAdmissionNumber = (value) => {
    const admission = String(value || '').trim();
    return /^\d+$/.test(admission) ? admission.padStart(4, '0') : admission.toUpperCase();
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return json(405, { success: false, message: 'Method not allowed' });
    }

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { success: false, message: 'Invalid JSON body' });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(400, { success: false, message: 'Invalid request body' });
    }

    const {
        phoneNumber, amount, studentId, studentName, description, schoolId,
        admissionNumber, studentClass, level, term, year, invoiceId
    } = body;

    if (
        typeof phoneNumber !== 'string'
        || typeof studentId !== 'string'
        || typeof schoolId !== 'string'
        || !phoneNumber.trim()
        || !studentId.trim()
        || !schoolId.trim()
        || !/^[A-Za-z0-9_-]{1,128}$/.test(studentId)
        || !/^[A-Za-z0-9_-]{1,128}$/.test(schoolId)
        || !/^[A-Za-z0-9][A-Za-z0-9/-]{0,39}$/.test(String(admissionNumber || ''))
    ) {
        return json(400, {
            success: false, message: 'Invalid or missing phone number, student, admission number, or school.'
        });
    }

    const numericAmount = Number(amount);
    if (!Number.isSafeInteger(numericAmount) || numericAmount <= 10) {
        return json(400, { success: false, message: 'Amount must be a whole number greater than KES 10.' });
    }

    const submittedPhone = phoneNumber.trim().replace(/[\s-]/g, '');
    if (!/^(?:(?:\+?254)|0)?[17]\d{8}$/.test(submittedPhone)) {
        return json(400, { success: false, message: 'Invalid Kenyan mobile phone number.' });
    }

    let actor;
    try {
        actor = await requireAuth(event, { healProfile: false });
    } catch (error) {
        return json(error.statusCode || 401, {
            success: false,
            message: error.message || 'Authentication is required to initiate an M-Pesa payment.',
        });
    }
    const actorRole = String(actor.role || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    const isPlatformAdmin = ['super-admin', 'platform-admin'].includes(actorRole);
    if (!FEE_MANAGER_ROLES.has(actorRole) || (!isPlatformAdmin && actor.schoolId !== schoolId)) {
        return json(403, { success: false, message: 'You are not authorized to initiate payments for this school.' });
    }

    const paymentTerm = String(term || 'Term 1').trim();
    if (!['Term 1', 'Term 2', 'Term 3'].includes(paymentTerm)) {
        return json(400, { success: false, message: 'Select a valid school term.' });
    }
    const paymentYear = Number(year) || new Date().getFullYear();
    if (!Number.isInteger(paymentYear) || paymentYear < 2000 || paymentYear > 2100) {
        return json(400, { success: false, message: 'Select a valid academic year.' });
    }

    let admin, db, schoolName = body.schoolName || 'School';
    try {
        admin = initAdmin();
        db = admin.firestore();
    } catch (e) {
        console.error('Firebase Admin is required to verify the student before an STK push:', e.message);
        return json(503, { success: false, message: 'Student verification is temporarily unavailable.' });
    }

    try {
        const studentDoc = await db.collection('students').doc(studentId).get();
        if (!studentDoc.exists) {
            return json(404, { success: false, message: 'Student not found.' });
        }
        const verifiedStudent = studentDoc.data();
        const verifiedAdmission = normalizeAdmissionNumber(
            verifiedStudent.admissionNumber || verifiedStudent.studentId || ''
        );
        if (
            verifiedStudent.schoolId !== schoolId
            || verifiedAdmission !== normalizeAdmissionNumber(admissionNumber)
        ) {
            return json(400, { success: false, message: 'Student admission details do not match.' });
        }
        const verifiedStudentName = `${verifiedStudent.firstName || ''} ${verifiedStudent.lastName || ''}`.trim()
            || verifiedStudent.fullName || verifiedStudent.name || '';

        if (invoiceId) {
            const invoiceSnap = await db.collection('invoices').doc(String(invoiceId)).get();
            if (
                !invoiceSnap.exists
                || invoiceSnap.data().schoolId !== schoolId
                || invoiceSnap.data().studentId !== studentId
            ) {
                return json(400, { success: false, message: 'The selected invoice does not belong to this student and school.' });
            }
        }

        // ---- 1. Load credentials: from school's private Daraja doc or environment variables ----
        let daraja = {};
        if (db && schoolId) {
            try {
                const darajaDoc = await db
                    .doc(`schools/${schoolId}/private/daraja`)
                    .get();
                if (darajaDoc.exists) {
                    daraja = darajaDoc.data() || {};
                }
            } catch (err) {
                console.warn('Could not read school doc or private daraja doc:', err.message);
            }
        }

        const consumerKey = daraja.consumerKey || process.env.MPESA_CONSUMER_KEY;
        const consumerSecret = daraja.consumerSecret || process.env.MPESA_CONSUMER_SECRET || process.env.MPESA_SECRET_KEY;
        const shortcode = daraja.shortcode || process.env.MPESA_SHORTCODE;
        const passkey = daraja.passkey || process.env.MPESA_PASSKEY;
        const environment = daraja.environment || process.env.MPESA_ENVIRONMENT || 'sandbox';
        const schoolCallbackUrl = daraja.callbackUrl || process.env.MPESA_CALLBACK_URL;

        if (!consumerKey || !consumerSecret || !shortcode || !passkey) {
            return json(400, {
                success: false,
                message: 'M-Pesa credentials are not configured. Please configure M-Pesa in School Settings or environment variables.'
            });
        }

        // ---- 2. No more platform fee — the school receives the full amount ----
        const totalAmount = numericAmount;

        // ---- 3. Normalize phone number (Safaricom expects 254XXXXXXXXX) ----
        let formattedPhone = submittedPhone.replace(/^\+/, '');
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '254' + formattedPhone.slice(1);
        } else if (!formattedPhone.startsWith('254')) {
            formattedPhone = '254' + formattedPhone;
        }
        if (formattedPhone.length !== 12) {
            return json(400, { success: false, message: 'Invalid phone number' });
        }

        // ---- 4. OAuth token ----
        const baseUrl = environment === 'production'
            ? 'https://api.safaricom.co.ke'
            : 'https://sandbox.safaricom.co.ke';

        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

        let accessToken;
        try {
            const tokenRes = await axios.get(
                `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
                { headers: { Authorization: `Basic ${auth}` }, timeout: 15000 }
            );
            accessToken = tokenRes.data?.access_token;
        } catch (err) {
            console.error('Daraja OAuth failed:', err.response?.data || err.message);
            return json(502, {
                success: false,
                message: 'Failed to authenticate with M-Pesa. Please try again later.'
            });
        }

        if (!accessToken) {
            return json(502, {
                success: false,
                message: 'M-Pesa did not return an access token.'
            });
        }

        // ---- 5. Build STK push payload ----
        const timestamp = new Date()
            .toISOString()
            .replace(/[^0-9]/g, '')
            .slice(0, 14);

        const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

        const callbackUrl = schoolCallbackUrl
            || process.env.MPESA_CALLBACK_URL
            || (process.env.URL
                ? `${process.env.URL}/.netlify/functions/mpesa-callback`
                : 'https://kupri.netlify.app/.netlify/functions/mpesa-callback');

        const rawSchoolName = (schoolName || 'School').trim();
        const schoolFirstName = rawSchoolName.split(/\s+/)[0] || 'School';
        const cleanSchoolFirst = schoolFirstName.replace(/[^a-zA-Z0-9]/g, '');
        const accountRef = `${admissionNumber || studentId}-${cleanSchoolFirst}`.substring(0, 12).replace(/[^a-zA-Z0-9-]/g, '');

        const payload = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: totalAmount,
            PartyA: formattedPhone,
            PartyB: shortcode,
            PhoneNumber: formattedPhone,
            CallBackURL: callbackUrl,
            AccountReference: accountRef,
            TransactionDesc: description || 'School Fees Payment'
        };

        // ---- 6. Send STK push ----
        let stkRes;
        try {
            stkRes = await axios.post(
                `${baseUrl}/mpesa/stkpush/v1/processrequest`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 20000
                }
            );
        } catch (err) {
            console.error('STK push failed:', err.response?.data || err.message);
            return json(502, {
                success: false,
                message:
                    err.response?.data?.errorMessage
                    || err.response?.data?.ResponseDescription
                    || 'Failed to send STK push'
            });
        }

        const checkoutRequestId = stkRes.data?.CheckoutRequestID;
        const merchantRequestId = stkRes.data?.MerchantRequestID;

        if (!checkoutRequestId) {
            return json(502, {
                success: false,
                message: 'M-Pesa did not return a CheckoutRequestID'
            });
        }

        // ---- 7. Persist pending transaction (used by the callback) ----
        // Written BEFORE we respond, so the chatbot's poll never misses it.
        const transactionData = {
            idempotencyKey: `MPESA_${checkoutRequestId}`,
            studentId,
            studentName: verifiedStudentName || studentName || '',
            admissionNumber: verifiedAdmission,
            class: verifiedStudent.class || studentClass || '',
            level: verifiedStudent.level || level || '',
            term: paymentTerm,
            year: paymentYear,
            invoiceId: invoiceId || null,
            schoolId,
            amount: totalAmount,
            phoneNumber: formattedPhone,
            description: description || 'School Fees Payment',
            status: 'pending',
            type: 'payment',
            paymentMethod: 'mpesa',
            checkoutRequestID: checkoutRequestId,
            merchantRequestID: merchantRequestId || '',
            shortcode,
            environment,
            createdAt: new Date().toISOString(),
            recordedBy: actor.uid,
            recordedByName: actor.fullName || actor.email || 'School Fee Manager',
            initiatedBy: actor.uid,
        };

        try {
            let persistError;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const batch = db.batch();
                    const transactionRef = db.collection('fee_transactions').doc(`MPESA_${checkoutRequestId}`);
                    const pendingRef = db.collection('mpesa_pending_transactions').doc(checkoutRequestId);
                    const data = {
                        ...transactionData,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    };
                    batch.set(transactionRef, data);
                    batch.set(pendingRef, { ...data, timestamp });
                    await batch.commit();
                    persistError = null;
                    break;
                } catch (error) {
                    persistError = error;
                    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
                }
            }
            if (persistError) {
                console.error('STK request sent but pending transaction persistence failed:', persistError);
                return json(200, {
                    success: true,
                    trackingPersisted: false,
                    message: 'M-Pesa accepted the request, but payment tracking could not be saved. Do not retry this payment; contact the school office with the CheckoutRequestID.',
                    checkoutRequestID: checkoutRequestId,
                    merchantRequestID: merchantRequestId,
                    CheckoutRequestID: checkoutRequestId,
                    MerchantRequestID: merchantRequestId,
                });
            }
        } catch (dbErr) {
            console.error('Could not persist M-Pesa transaction after gateway acceptance:', dbErr);
            return json(200, {
                success: true,
                trackingPersisted: false,
                message: 'M-Pesa accepted the request, but payment tracking could not be saved. Do not retry this payment; contact the school office with the CheckoutRequestID.',
                checkoutRequestID: checkoutRequestId,
                merchantRequestID: merchantRequestId,
                CheckoutRequestID: checkoutRequestId,
                MerchantRequestID: merchantRequestId,
            });
        }

        console.log(
            `STK Push sent: ${checkoutRequestId} → ${studentId} (${formattedPhone}) KES ${totalAmount}`
        );

        return json(200, {
            success: true,
            message: 'STK push sent successfully',
            // camelCase keys for the client; the old PascalCase versions
            // are kept so any existing callers still work.
            checkoutRequestID: checkoutRequestId,
            merchantRequestID: merchantRequestId,
            CheckoutRequestID: checkoutRequestId,
            MerchantRequestID: merchantRequestId,
            ResponseCode: stkRes.data?.ResponseCode,
            ResponseDescription: stkRes.data?.ResponseDescription
        });
    } catch (err) {
        console.error('Unexpected error in mpesa-stk-push:', err);
        return json(500, {
            success: false,
            message: 'Unexpected server error. Please try again.'
        });
    }
};

function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}

exports.handler = withCors(exports.handler);
