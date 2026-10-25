// netlify/functions/backfill-email-domains.js
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

exports.handler = withCors(async () => {
    const admin = initAdmin();
    const db = admin.firestore();
    try {
        const schools = await db.collection('schools').get();
        let updated = 0;
        let skipped = 0;
        for (const doc of schools.docs) {
            const data = doc.data();
            if (data.emailDomain) { skipped++; continue; }
            const domain = deriveEmailDomain(data.schoolName || data.name || '');
            if (!domain) { skipped++; continue; }
            await doc.ref.update({
                emailDomain: domain,
                schoolDomain: domain.replace(/\.com$/, ''),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            updated++;
        }
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, scanned: schools.size, updated, skipped }),
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ success: false, message: error.message }) };
    }
});
