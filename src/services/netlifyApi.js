import { Capacitor, CapacitorHttp } from '@capacitor/core';

const NETLIFY_FUNCTIONS_ORIGIN = 'https://kupri.netlify.app/.netlify/functions';

const FUNCTION_ALIASES = {
    '/api/': '',
    '/.netlify/functions/': '',
};

export function netlifyFunctionUrl(path) {
    const input = String(path || '').trim();
    const prefix = Object.keys(FUNCTION_ALIASES)
        .find((candidate) => input.startsWith(candidate));
    const functionName = prefix ? input.slice(prefix.length) : input;
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(functionName)) {
        throw new Error(`Invalid Netlify function name: ${input}`);
    }
    return `${NETLIFY_FUNCTIONS_ORIGIN}/${functionName}`;
}

export function fetchNetlifyFunction(path, options) {
    const url = netlifyFunctionUrl(path);
    if (!Capacitor.isNativePlatform()) return fetch(url, options);

    const {
        body,
        headers = {},
        method = 'GET',
        responseType = 'text',
        ...requestOptions
    } = options || {};
    let data = body;
    if (typeof body === 'string' && headers['Content-Type']?.includes('application/json')) {
        data = JSON.parse(body);
    }

    return CapacitorHttp.request({
        url,
        method,
        headers,
        data,
        responseType,
        ...requestOptions,
    }).then((response) => {
        const responseBody = response.data;
        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            async json() {
                if (responseBody && typeof responseBody === 'object') return responseBody;
                return JSON.parse(String(responseBody || 'null'));
            },
            async text() {
                return typeof responseBody === 'string'
                    ? responseBody
                    : JSON.stringify(responseBody ?? '');
            },
            async blob() {
                if (responseBody instanceof Blob) return responseBody;
                const binary = atob(String(responseBody || ''));
                const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
                const contentType = Object.entries(response.headers || {})
                    .find(([name]) => name.toLowerCase() === 'content-type')?.[1] || 'application/octet-stream';
                return new Blob([bytes], { type: contentType });
            },
        };
    });
}
