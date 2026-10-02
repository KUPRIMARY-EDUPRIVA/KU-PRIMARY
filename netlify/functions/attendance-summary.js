// netlify/functions/attendance-summary.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
    try {
        const sa = process.env.FIREBASE_SERVICE_ACCOUNT
            ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
            : null;
        if (sa) {
            admin.initializeApp({ credential: admin.credential.cert(sa) });
        } else {
            admin.initializeApp();
        }
    } catch (e) {
        console.error('Admin init failed:', e);
    }
}
const db = admin.apps.length ? admin.firestore() : null;

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
    if (!db) return { statusCode: 500, body: 'Firestore not initialized' };

    const { schoolId, cls, from, to } = event.queryStringParameters || {};
    if (!schoolId) return { statusCode: 400, body: 'schoolId is required' };

    try {
        let q = db.collection('attendance').where('schoolId', '==', schoolId);
        if (cls) q = q.where('class', '==', cls);
        if (from) q = q.where('date', '>=', from);
        if (to) q = q.where('date', '<=', to);
        q = q.orderBy('date', 'asc');

        const snap = await q.get();
        const records = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

        const totals = { present: 0, absent: 0, late: 0, excused: 0, marks: 0 };
        const byClass = {};
        const byStudent = {};

        records.forEach((rec) => {
            byClass[rec.class] = byClass[rec.class] || { present: 0, absent: 0, late: 0, excused: 0, days: 0 };
            byClass[rec.class].days++;
            (rec.entries || []).forEach((e) => {
                const st = e.status || 'present';
                if (totals[st] !== undefined) totals[st]++;
                totals.marks++;
                if (byClass[rec.class][st] !== undefined) byClass[rec.class][st]++;

                byStudent[e.studentId] = byStudent[e.studentId] || {
                    name: e.name || '', admissionNumber: e.admissionNumber || '',
                    present: 0, absent: 0, late: 0, excused: 0, total: 0,
                };
                const row = byStudent[e.studentId];
                if (row[st] !== undefined) row[st]++;
                row.total++;
            });
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            body: JSON.stringify({ totals, byClass, byStudent, recordCount: records.length }),
        };
    } catch (e) {
        console.error('attendance-summary failed:', e);
        return { statusCode: 500, body: `Error: ${e.message}` };
    }
};
