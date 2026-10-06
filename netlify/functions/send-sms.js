const axios = require('axios');
const { requireAuth, json, errorResponse } = require('./_lib/chatbotAuth');
const { withCors } = require('./_lib/cors');

const SMS_ROLES = new Set(['admin', 'school_admin', 'user', 'principal', 'finance', 'headteacher', 'deputy-headteacher']);
const KENYAN_PHONE = /^(?:(?:\+?254)|0)?[17]\d{8}$/;

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return json(405, { success: false, error: 'Method not allowed' });
    }

    try {
        const user = await requireAuth(event);
        if (!SMS_ROLES.has(user.role)) {
            return json(403, { success: false, error: 'Only school administrators can send SMS.' });
        }

        let body;
        try {
            body = JSON.parse(event.body || '{}');
        } catch {
            return json(400, { success: false, error: 'Request body must be valid JSON.' });
        }

        const numbers = [...new Set(
            (Array.isArray(body.numbers) ? body.numbers : [body.phoneNumber])
                .map((number) => String(number || '').replace(/[\s()-]/g, ''))
                .filter(Boolean)
        )];
        const message = typeof body.message === 'string' ? body.message.trim() : '';

        if (!numbers.length || numbers.length > 30 || numbers.some((number) => !KENYAN_PHONE.test(number))) {
            return json(400, { success: false, error: 'Provide 1 to 30 valid Kenyan phone numbers.' });
        }
        if (!message || message.length > 1600) {
            return json(400, { success: false, error: 'Message must contain 1 to 1,600 characters.' });
        }
        if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) {
            return json(503, { success: false, error: 'SMS delivery is not configured on the server.' });
        }

        const response = await axios.post(
            'https://api.africastalking.com/version1/messaging',
            new URLSearchParams({
                username: process.env.AT_USERNAME,
                to: numbers.join(','),
                message,
                ...(process.env.AT_SENDER_ID ? { from: process.env.AT_SENDER_ID } : {}),
            }).toString(),
            {
                headers: {
                    apiKey: process.env.AT_API_KEY,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: 15000,
            }
        );

        const recipients = response.data?.SMSMessageData?.Recipients || [];
        const results = numbers.map((number, index) => {
            const result = recipients[index];
            const succeeded = Boolean(result) && [100, 101, 102].includes(Number(result.statusCode));
            return {
                number,
                success: succeeded,
                ...(succeeded ? {} : { error: result?.status || 'SMS provider did not confirm delivery.' }),
            };
        });

        return json(200, {
            success: results.some((result) => result.success),
            results,
            error: results.every((result) => !result.success)
                ? (response.data?.SMSMessageData?.Message || 'SMS was not accepted by the provider.')
                : undefined,
        });
    } catch (error) {
        console.error('send-sms failed:', error.message);
        return errorResponse(error);
    }
};

exports.handler = withCors(exports.handler);
