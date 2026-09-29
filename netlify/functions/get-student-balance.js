// netlify/functions/get-student-balance.js
const { initAdmin } = require('./_lib/firebaseAdmin');

exports.handler = async (event) => {
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
        
        // Find student by admissionNumber
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
            body: JSON.stringify({ success: true, balance: studentData.feeBalance || 0 })
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ success: false, message: error.message }) };
    }
};
