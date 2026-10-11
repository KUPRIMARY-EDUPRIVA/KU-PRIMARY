const { requireAuth, json, errorResponse } = require('./_lib/chatbotAuth');
const { initAdmin } = require('./_lib/firebaseAdmin');
const { withCors } = require('./_lib/cors');
const { cacheGet, cacheSet } = require('./_lib/blobCache');

const REPORT_ROLES = new Set(['admin', 'school_admin', 'user', 'principal', 'finance', 'headteacher', 'deputy-headteacher']);
const CACHE_TTL_SECONDS = 60;

function nairobiDate(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Nairobi',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function dateString(parts) {
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatKES(amount) {
    return `KES ${Math.round(amount).toLocaleString('en-KE')}`;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return json(405, { success: false, error: 'Method not allowed' });
    }

    try {
        const user = await requireAuth(event);
        if (!REPORT_ROLES.has(user.role)) {
            return json(403, { success: false, error: 'Administrator access is required.' });
        }

        const body = JSON.parse(event.body || '{}');
        if (body.schoolId !== user.schoolId) {
            return json(403, { success: false, error: 'School access denied.' });
        }

        const todayParts = nairobiDate(new Date());
        const today = dateString(todayParts);
        const cacheKey = `daily_collections:${user.schoolId}:${today}`;
        const cached = await cacheGet(cacheKey);
        if (cached) return json(200, cached);

        const admin = initAdmin();
        const weekStartDate = new Date(`${today}T00:00:00+03:00`);
        weekStartDate.setDate(weekStartDate.getDate() - 6);
        const weekStart = dateString(nairobiDate(weekStartDate));

        const snapshot = await admin.firestore()
            .collection('fee_transactions')
            .where('schoolId', '==', user.schoolId)
            .where('paymentDate', '>=', weekStart)
            .where('paymentDate', '<=', today)
            .get();

        let todayTotal = 0;
        let weekTotal = 0;
        snapshot.forEach((transaction) => {
            const data = transaction.data();
            if (!['completed', 'success', 'paid'].includes(String(data.status || '').toLowerCase())) return;
            if (data.type && data.type !== 'payment') return;
            const amount = Number(data.amount);
            if (!Number.isFinite(amount) || amount <= 0) return;
            weekTotal += amount;
            if (data.paymentDate === today) todayTotal += amount;
        });

        const payload = {
            success: true,
            today: formatKES(todayTotal),
            week: formatKES(weekTotal),
            asOf: today,
        };
        await cacheSet(cacheKey, payload, CACHE_TTL_SECONDS);
        return json(200, payload);
    } catch (error) {
        console.error('reports-rollup failed:', error.message);
        return errorResponse(error);
    }
};

exports.handler = withCors(exports.handler);
