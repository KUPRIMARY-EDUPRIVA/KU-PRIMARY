const CACHE_NAME = 'edupriva-v2';
const RUNTIME_CACHE = 'edupriva-runtime-v2';
const CORE_ASSETS = [
    '/',
    '/index.html',
    '/Logo.png',
    '/manifest.json',
    '/asset-manifest.json',
    '/icons/icon-192.webp'
];

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        const manifestResponse = await fetch('/asset-manifest.json');
        if (!manifestResponse.ok) {
            throw new Error(`Unable to load build asset manifest (${manifestResponse.status})`);
        }

        const manifest = await manifestResponse.json();
        const buildAssets = Object.values(manifest.files || {})
            .filter((file) => typeof file === 'string' && file.startsWith('/static/'));

        await cache.addAll([...new Set([...CORE_ASSETS, ...buildAssets])]);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter((name) => ![CACHE_NAME, RUNTIME_CACHE].includes(name))
            .map((name) => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);

    if (url.origin !== self.location.origin || request.method !== 'GET') return;

    if (request.mode === 'navigate') {
        event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
        return;
    }

    event.respondWith((async () => {
        const cached = await caches.match(request);
        if (cached) return cached;

        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(RUNTIME_CACHE);
            await cache.put(request, response.clone());
        }
        return response;
    })());
});

self.addEventListener('sync', (event) => {
    if (event.tag !== 'sync-data') return;

    event.waitUntil(self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({
            type: 'SYNC_TRIGGERED',
            timestamp: Date.now()
        }));
    }));
});

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();

    if (event.data?.type === 'GET_VERSION') {
        event.ports[0]?.postMessage({ version: CACHE_NAME, timestamp: Date.now() });
    }
});

self.addEventListener('push', (event) => {
    const data = event.data?.json() || {};
    event.waitUntil(self.registration.showNotification(data.title || 'Edupriva', {
        body: data.body || 'New notification from Edupriva',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { url: data.url || '/', timestamp: Date.now() },
        actions: [
            { action: 'view', title: 'View' },
            { action: 'dismiss', title: 'Dismiss' }
        ]
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;

    event.waitUntil(self.clients.matchAll({ type: 'window' }).then((clients) => {
        const existing = clients.find((client) => client.url === targetUrl);
        return existing ? existing.focus() : self.clients.openWindow(targetUrl);
    }));
});
