// netlify/functions/provision-student-account.js
const { withCors } = require('./_lib/cors');
const { initAdmin } = require('./_lib/firebaseAdmin');

function deriveEmailDomain(schoolName) {
    if (!schoolName) return '';
    const firstWord = String(schoolName)
        .split(' ')[0]
        .toLowerCase()
        .replace(/[^a-z]/g, '');
    return firstWord ? `${firstWord}school.com` : '';
}

exports.handler = withCors(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
    }
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid JSON' }) }; }

    const { schoolId, admissionNumber } = body || {};
    if (!schoolId || !admissionNumber) {
        return { statusCode: 400, body: JSON.stringify({ success: false, message: 'schoolId and admissionNumber are required' }) };
    }

    try {
        const admin = initAdmin();
        const db = admin.firestore();

        // 1. Ensure the school has an emailDomain stamped.
        const schoolRef = db.collection('schools').doc(schoolId);
        const schoolSnap = await schoolRef.get();
        if (!schoolSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ success: false, message: 'School not found' }) };
        }
        const school = schoolSnap.data();
        if (!school.emailDomain) {
            const domain = deriveEmailDomain(school.schoolName || school.name || '');
            if (domain) {
                await schoolRef.update({
                    emailDomain: domain,
                    schoolDomain: domain.replace(/\.com$/, ''),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
        }

        // 2. Look up the student.
        const snap = await db.collection('students')
            .where('schoolId', '==', schoolId)
            .where('admissionNumber', '==', String(admissionNumber))
            .limit(1)
            .get();

        if (snap.empty) {
            return { statusCode: 404, body: JSON.stringify({ success: false, message: 'Student not found' }) };
        }

        const studentDoc = snap.docs[0];
        const student = studentDoc.data();
        const email = student.email;

        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Student has no email on file' }) };
        }

        // 3. Create/refresh the Firebase Auth user with the admission number as password.
        let authUser;
        try {
            authUser = await admin.auth().getUserByEmail(email);
        } catch {
            authUser = null;
        }
        if (!authUser) {
            authUser = await admin.auth().createUser({
                email,
                password: String(admissionNumber),
                displayName: `${student.firstName || ''} ${student.lastName || ''}`.trim() || email,
                emailVerified: true,
            });
        } else {
            await admin.auth().updateUser(authUser.uid, {
                password: String(admissionNumber),
                emailVerified: true,
            });
        }

        await studentDoc.ref.update({
            uid: authUser.uid,
            mustChangePassword: true,
            passwordChangedAt: null,
            authProvisionedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, uid: authUser.uid, email }),
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ success: false, message: error.message }) };
    }
});
