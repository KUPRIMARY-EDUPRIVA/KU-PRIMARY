// netlify/functions/_lib/blobCache.js
//
// Thin wrapper around Netlify Blobs used as a cache.
//
// Blobs has no built-in TTL, so we store an `expiresAt` timestamp
// inside the value and check it on every read. This gives us
// serverless-friendly caching with zero external services and
// zero extra cost on the current Netlify plan.
//
// Usage:
//     const { cacheGet, cacheSet, cacheDel } = require('./_lib/blobCache');
//
//     const key = `school_info:${schoolId}`;
//     const hit = await cacheGet(key);
//     if (hit) return json(200, hit);
//
//     // ... do the work ...
//
//     await cacheSet(key, payload, 12 * 60 * 60);  // 12 hours
//     return json(200, payload);

const { getStore } = require('@netlify/blobs');

// A single named store. Netlify creates it on first write.
const STORE_NAME = 'chatbot-cache';

let storeInstance = null;
function getCacheStore() {
    if (!storeInstance) {
        storeInstance = getStore({
            name: STORE_NAME,
            // Chatbot answers benefit from consistency — when we
            // explicitly invalidate, we want the delete visible
            // immediately on the next read in the same region.
            // `strong` gives us that guarantee at the cost of a
            // slightly slower read on cache misses.
            consistency: 'strong',
        });
    }
    return storeInstance;
}

/**
 * Read a cached value.
 * @param {string} key
 * @returns {Promise<any|null>} parsed value, or null on miss/expired/error
 */
async function cacheGet(key) {
    if (!key) return null;
    try {
        const store = getCacheStore();
        const entry = await store.get(key, { type: 'json' });
        if (!entry || typeof entry !== 'object') return null;
        if (entry.expiresAt && entry.expiresAt < Date.now()) {
            // Expired — do not delete, let the next set overwrite.
            return null;
        }
        return entry.value ?? null;
    } catch (err) {
        // A cache failure must never break the caller.
        console.warn('[blobCache] get failed:', key, err.message);
        return null;
    }
}

/**
 * Write a value to the cache.
 * @param {string} key
 * @param {any} value
 * @param {number} ttlSeconds  e.g. 12 * 60 * 60 for 12 hours
 */
async function cacheSet(key, value, ttlSeconds) {
    if (!key) return;
    try {
        const store = getCacheStore();
        const payload = {
            value,
            cachedAt: Date.now(),
            expiresAt: ttlSeconds
                ? Date.now() + ttlSeconds * 1000
                : null,
        };
        await store.setJSON(key, payload);
    } catch (err) {
        console.warn('[blobCache] set failed:', key, err.message);
    }
}

/**
 * Invalidate one or more keys.
 * Call this from write paths (e.g. SchoolProfile save) so admins
 * see their changes immediately instead of waiting out the TTL.
 */
async function cacheDel(...keys) {
    if (keys.length === 0) return;
    try {
        const store = getCacheStore();
        // list() + delete() per key — Blobs has no multi-del in the SDK.
        await Promise.all(keys.filter(Boolean).map((k) => store.delete(k)));
    } catch (err) {
        console.warn('[blobCache] del failed:', keys, err.message);
    }
}

/**
 * Invalidate every key whose name starts with `prefix`.
 * Useful when a single write must clear many derived caches
 * (e.g. any score change should blow away every perf:* key
 * for that school).
 */
async function cacheDelByPrefix(prefix) {
    if (!prefix) return;
    try {
        const store = getCacheStore();
        const { blobs } = await store.list({ prefix });
        await Promise.all(blobs.map((b) => store.delete(b.key)));
    } catch (err) {
        console.warn('[blobCache] delByPrefix failed:', prefix, err.message);
    }
}

module.exports = { cacheGet, cacheSet, cacheDel, cacheDelByPrefix, STORE_NAME };
