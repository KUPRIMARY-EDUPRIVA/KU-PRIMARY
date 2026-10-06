const { withCors } = require('./_lib/cors');
// netlify/functions/mpesa-test-connection.js
const axios = require('axios');

exports.handler = async (event) => {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const data = JSON.parse(event.body || '{}');
        const paybillNumber = data.paybillNumber || data.mpesaShortcode || process.env.MPESA_SHORTCODE;
        const accountNumber = data.accountNumber || 'TEST';
        const mpesaEnvironment = data.mpesaEnvironment || process.env.MPESA_ENVIRONMENT || 'sandbox';
        const mpesaConsumerKey = data.mpesaConsumerKey || process.env.MPESA_CONSUMER_KEY;
        const mpesaConsumerSecret = data.mpesaConsumerSecret || process.env.MPESA_CONSUMER_SECRET || process.env.MPESA_SECRET_KEY;
        const mpesaPasskey = data.mpesaPasskey || process.env.MPESA_PASSKEY;
        const mpesaShortcode = data.mpesaShortcode || paybillNumber || process.env.MPESA_SHORTCODE;

        // Validate required fields
        if (!mpesaConsumerKey || !mpesaConsumerSecret || !mpesaPasskey || !mpesaShortcode) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    success: false, 
                    message: 'Missing required M-Pesa credentials. Please check settings or environment variables.' 
                })
            };
        }

        // Get access token
        const auth = Buffer.from(`${mpesaConsumerKey}:${mpesaConsumerSecret}`).toString('base64');
        const tokenUrl = mpesaEnvironment === 'sandbox' 
            ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
            : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

        const tokenResponse = await axios.get(tokenUrl, {
            headers: {
                'Authorization': `Basic ${auth}`
            }
        });

        const accessToken = tokenResponse.data.access_token;

        if (!accessToken) {
            return {
                statusCode: 400,
                body: JSON.stringify({ 
                    success: false, 
                    message: 'Failed to get access token. Please check your Consumer Key and Secret.' 
                })
            };
        }

        // Test the connection by making a simple request
        const testUrl = mpesaEnvironment === 'sandbox'
            ? 'https://sandbox.safaricom.co.ke/mpesa/accountbalance/v1/query'
            : 'https://api.safaricom.co.ke/mpesa/accountbalance/v1/query';

        // This is a lightweight test - we'll just check if we can get a response
        const testResponse = await axios.get(testUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            params: {
                // Minimal params for testing
                shortcode: mpesaShortcode,
                identifiertype: '1',
                remarks: 'Connection Test'
            }
        });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: 'M-Pesa connection successful!',
                environment: mpesaEnvironment,
                paybillNumber: paybillNumber,
                accountNumber: accountNumber,
                shortcode: mpesaShortcode
            })
        };

    } catch (error) {
        console.error('M-Pesa Test Connection Error:', error.response?.data || error.message);
        
        let errorMessage = 'Failed to connect to M-Pesa. ';
        
        if (error.response?.data?.errorMessage) {
            errorMessage += error.response.data.errorMessage;
        } else if (error.response?.data?.errorCode) {
            errorMessage += `Error ${error.response.data.errorCode}: ${error.response.data.errorMessage || 'Unknown error'}`;
        } else {
            errorMessage += error.message;
        }
        
        return {
            statusCode: error.response?.status || 500,
            body: JSON.stringify({
                success: false,
                message: errorMessage
            })
        };
    }
};

exports.handler = withCors(exports.handler);
