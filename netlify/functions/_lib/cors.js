const ALLOWED_ORIGINS = new Set([
    'https://localhost',
    'capacitor://localhost',
    'https://kupri.netlify.app',
    'http://localhost:3000',
    'http://localhost:8888',
]);

function withCors(handler) {
    return async (event = {}, ...args) => {
        const requestHeaders = event.headers || {};
        const origin = requestHeaders.origin || requestHeaders.Origin || '';
        const headers = ALLOWED_ORIGINS.has(origin)
            ? {
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Access-Control-Expose-Headers': 'Content-Disposition',
                Vary: 'Origin',
            }
            : {};

        if (event.httpMethod === 'OPTIONS') {
            return { statusCode: 204, headers, body: '' };
        }

        const response = await handler(event, ...args);
        if (!response || typeof response !== 'object') return response;
        return {
            ...response,
            headers: {
                ...(response.headers || {}),
                ...headers,
            },
        };
    };
}

module.exports = { withCors };
