// netlify/functions/chatbot-cache-invalidate.js
//
// Small endpoint the client can call after a write to clear
// relevant cache keys. Only admins can invalidate their own school.

const { requireAuth, json, errorResponse } = require('./_lib/chatbotAuth');
const { cacheDel, cacheDelByPrefix } = require('./_lib/blobCache');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return json(405, { success: false, error: 'Method not allowed' });
    }
    try {
        const { schoolId, isAdmin } = await requireAuth(event);
        if (!isAdmin) {
            return json(403, { success: false, error: 'Admin only' });
        }

        let body = {};
        try { body = JSON.parse(event.body || '{}'); } catch {}

        const { keys = [], prefixes = [] } = body;

        // Never let a client clear another school's cache.
        const safeKeys = keys.filter((k) => typeof k === 'string' && k.includes(schoolId));
        const safePrefixes = prefixes.filter((p) => typeof p === 'string' && p.includes(schoolId));

        if (safeKeys.length > 0) {
            await cacheDel(...safeKeys);
        }
        for (const p of safePrefixes) {
            await cacheDelByPrefix(p);
        }

        return json(200, { success: true, cleared: safeKeys.length + safePrefixes.length });
    } catch (err) {
        console.error('[chatbot-cache-invalidate]', err);
        return errorResponse(err);
    }
};
