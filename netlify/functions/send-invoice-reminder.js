const axios = require('axios');
const nodemailer = require('nodemailer');
const { requireAuth, json, errorResponse } = require('./_lib/chatbotAuth');
const { initAdmin } = require('./_lib/firebaseAdmin');
const { withCors } = require('./_lib/cors');

const REMINDER_ROLES = new Set(['admin', 'school_admin', 'user', 'principal', 'finance', 'accountant', 'headteacher', 'deputy-headteacher']);

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return json(405, { success: false, error: 'Method not allowed' });
    }

    try {
        const user = await requireAuth(event);
        if (!REMINDER_ROLES.has(user.role)) {
            return json(403, { success: false, error: 'Administrator access is required.' });
        }

        const body = JSON.parse(event.body || '{}');
        if (!body.invoiceId || typeof body.invoiceId !== 'string') {
            return json(400, { success: false, error: 'invoiceId is required.' });
        }

        const admin = initAdmin();
        const db = admin.firestore();
        const invoiceRef = db.collection('invoices').doc(body.invoiceId);
        const invoiceSnapshot = await invoiceRef.get();
        if (!invoiceSnapshot.exists) return json(404, { success: false, error: 'Invoice not found.' });

        const invoice = invoiceSnapshot.data();
        if (invoice.schoolId !== user.schoolId) {
            return json(403, { success: false, error: 'School access denied.' });
        }

        const [schoolSnapshot, studentSnapshot] = await Promise.all([
            db.collection('schools').doc(user.schoolId).get(),
            db.collection('students').doc(invoice.studentId).get(),
        ]);
        if (!studentSnapshot.exists) return json(404, { success: false, error: 'Student not found.' });

        const school = schoolSnapshot.data() || {};
        const student = studentSnapshot.data() || {};
        const balance = Number(invoice.remainingBalance ?? (invoice.total - (invoice.paidAmount || 0)));
        const message = `Dear parent, fee balance for ${invoice.studentName || 'your child'} (${invoice.admissionNumber || ''}) is KES ${Math.max(0, balance).toLocaleString()}. Invoice ${invoice.invoiceNumber || body.invoiceId}, due ${invoice.dueDate || 'as advised'}.`;
        const results = { sms: null, email: null };
        const phone = student.parentPhone || student.guardianPhone || student.parentPhoneNumber || '';
        const email = student.parentEmail || student.guardianEmail || '';

        if (phone && process.env.AT_API_KEY && process.env.AT_USERNAME) {
            const response = await axios.post(
                'https://api.africastalking.com/version1/messaging',
                new URLSearchParams({
                    username: process.env.AT_USERNAME,
                    to: phone,
                    message,
                    from: process.env.AT_SENDER_ID || school.smsSenderId || 'EDUPRIVA',
                }).toString(),
                {
                    headers: {
                        apiKey: process.env.AT_API_KEY,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    timeout: 15000,
                }
            );
            results.sms = response.data;
        }

        if (email && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.GMAIL_USER,
                    pass: process.env.GMAIL_APP_PASSWORD,
                },
            });
            results.email = await transporter.sendMail({
                from: process.env.TEACHER_WELCOME_FROM || process.env.GMAIL_USER,
                to: email,
                subject: `Fee Reminder — ${invoice.studentName || 'Student'}`,
                text: message,
            });
        }

        if (!results.sms && !results.email) {
            return json(503, {
                success: false,
                error: 'No parent contact or SMS/email provider is configured for this invoice.',
            });
        }

        await invoiceRef.update({ lastReminderAt: admin.firestore.FieldValue.serverTimestamp() });
        return json(200, { success: true, results });
    } catch (error) {
        console.error('send-invoice-reminder failed:', error.message);
        return errorResponse(error);
    }
};

exports.handler = withCors(exports.handler);
