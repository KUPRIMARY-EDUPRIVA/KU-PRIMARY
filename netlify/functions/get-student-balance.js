// netlify/functions/get-student-balance.js
const { withCors } = require('./_lib/cors');
const { initAdmin } = require('./_lib/firebaseAdmin');

exports.handler = withCors(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid JSON body' }) };
    }

    const { admissionNumber, schoolId } = body || {};

    if (
        typeof schoolId !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(schoolId)
        || !/^[A-Za-z0-9][A-Za-z0-9/-]{0,39}$/.test(String(admissionNumber || ''))
    ) {
        return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Invalid admission number or school.' }) };
    }

    try {
        const admin = initAdmin();
        const db = admin.firestore();

        const studentsSnapshot = await db.collection('students')
            .where('schoolId', '==', schoolId)
            .where('admissionNumber', '==', String(admissionNumber))
            .limit(1)
            .get();

        if (studentsSnapshot.empty) {
            return { statusCode: 404, body: JSON.stringify({ success: false, message: 'Student not found' }) };
        }

        const studentData = studentsSnapshot.docs[0].data();
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                balance: studentData.feeBalance || 0,
                // Include these so the dashboard can show more than just balance
                studentId: studentsSnapshot.docs[0].id,
                class: studentData.class || '',
                level: studentData.level || '',
                admissionNumber: studentData.admissionNumber || '',
            })
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ success: false, message: error.message }) };
    }
});
