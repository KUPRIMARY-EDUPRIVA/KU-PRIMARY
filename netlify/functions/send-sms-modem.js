// netlify/functions/send-sms-modem.js
// Server-side bridge for USB / GSM modems.
//
// Env vars expected on the Netlify site:
//   SMS_MODEM_PORT   e.g. /dev/ttyUSB0 (Linux) or COM3 (Windows)
//   SMS_MODEM_BAUD   e.g. 9600
//   SMS_MODEM_PIN    optional SIM PIN
//
// This stub returns a well-formed shape so the front-end can be developed
// in parallel. Replace `sendThroughModem()` with serialport + AT-command code.

const SMS_MODEM_PORT = process.env.SMS_MODEM_PORT || '';
const SMS_MODEM_BAUD = parseInt(process.env.SMS_MODEM_BAUD || '9600', 10);

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const json = (statusCode, body) => ({
    statusCode,
    headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
});

// ------------------------------------------------------------
// Replace this with real serialport code.
// ------------------------------------------------------------
async function getModemStatus() {
    if (!SMS_MODEM_PORT) {
        return { connected: false, port: '', signal: 0, error: 'SMS_MODEM_PORT not set' };
    }
    // TODO: open serial port, send "AT+CSQ" and read signal.
    return {
        connected: true,           // assume reachable if the port is configured
        port: SMS_MODEM_PORT,
        signal: 80
    };
}

async function sendThroughModem(number, message) {
    // TODO: open serial port, switch to TEXT mode (AT+CMGF=1),
    // send AT+CMGS="<number>", write message, terminate with 0x1A.
    // For now, simulate success.
    return { success: true };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            },
            body: ''
        };
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }

    const action = payload.action || 'send';

    if (action === 'status') {
        try {
            const status = await getModemStatus();
            return json(200, status);
        } catch (e) {
            return json(200, { connected: false, port: '', signal: 0, error: e.message });
        }
    }

    if (action !== 'send') return json(400, { error: 'Unknown action' });

    const numbers = Array.isArray(payload.numbers) ? payload.numbers : [];
    const message = String(payload.message || '').trim();
    if (numbers.length === 0 || !message) {
        return json(400, { error: 'numbers and message are required' });
    }

    const results = [];
    for (const raw of numbers) {
        const number = String(raw).replace(/\D/g, '');
        try {
            const r = await sendThroughModem(number, message);
            results.push({ number, success: !!r.success, error: r.error });
        } catch (e) {
            results.push({ number, success: false, error: e.message });
        }
        // Small pause between SMS to avoid overrunning the modem buffer.
        await new Promise(res => setTimeout(res, 400));
    }

    const sent = results.filter(r => r.success).length;
    return json(200, {
        success: sent > 0,
        sent,
        failed: results.length - sent,
        results
    });
};
