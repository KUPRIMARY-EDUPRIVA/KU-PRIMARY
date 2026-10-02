// netlify/functions/send-teacher-welcome.js
//
// Sends a styled welcome email to a newly created teacher via Gmail SMTP.
//
// Environment variables required (all scoped to Functions):
//   GMAIL_USER              your Gmail address, e.g. "you@gmail.com"
//   GMAIL_APP_PASSWORD      16-char App Password from Google
//   TEACHER_WELCOME_FROM    optional, display name + address
//   TEACHER_WELCOME_REPLY_TO optional, where replies go
//
// The caller (Teachers.jsx) generates the password client-side and passes
// it here. This function NEVER stores the password — it just relays it.

const nodemailer = require('nodemailer');
const { initAdmin } = require('./_lib/firebaseAdmin');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const FROM_EMAIL = process.env.TEACHER_WELCOME_FROM || (GMAIL_USER ? `EduPriva <${GMAIL_USER}>` : 'EduPriva <noreply@edupriva.com>');
const REPLY_TO = process.env.TEACHER_WELCOME_REPLY_TO || GMAIL_USER || undefined;

// Reuse a single transporter across warm invocations. Creating one per
// request adds 100–200ms of TCP + TLS handshake to every send.
let transporter = null;
function getTransporter() {
    if (transporter) return transporter;

    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
        throw new Error(
            'Gmail SMTP credentials missing. Set GMAIL_USER and GMAIL_APP_PASSWORD ' +
            'in Netlify → Environment variables (Functions scope).'
        );
    }

    transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,           // TLS from the first byte
        auth: {
            user: GMAIL_USER,
            pass: GMAIL_APP_PASSWORD.replace(/\s+/g, ''),   // strip any spaces
        },
        // Gmail accepts up to ~30s; keep this under Netlify's 26s function limit.
        connectionTimeout: 12000,
        greetingTimeout: 8000,
        socketTimeout: 15000,
        pool: true,             // reuse sockets across sends on the same container
        maxConnections: 2,
        maxMessages: 50,
    });

    return transporter;
}

// Simple in-memory rate limiter (per warm container).
const recentSends = new Map();
const RATE_LIMIT_MS = 30 * 1000;

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return json(405, { success: false, error: 'Method not allowed' });
    }

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { success: false, error: 'Invalid JSON body' });
    }

    const {
        teacherEmail,
        teacherName,
        tempPassword,
        schoolName,
        schoolId,
        loginUrl,
        invitedByName
    } = body;

    // -------- Validation --------
    if (typeof teacherEmail !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(teacherEmail)) {
        return json(400, { success: false, error: 'Valid teacherEmail is required' });
    }
    if (typeof tempPassword !== 'string' || tempPassword.length < 6) {
        return json(400, { success: false, error: 'A temporary password is required' });
    }
    if (typeof schoolId !== 'string' || !schoolId.trim()) {
        return json(400, { success: false, error: 'schoolId is required' });
    }

    // -------- Rate limit --------
    const key = teacherEmail.toLowerCase();
    const now = Date.now();
    const last = recentSends.get(key);
    if (last && now - last < RATE_LIMIT_MS) {
        return json(429, {
            success: false,
            error: 'A welcome email was just sent to this address. Please wait before retrying.'
        });
    }

    // -------- Verify the teacher exists in Firestore --------
    try {
        const admin = initAdmin();
        const db = admin.firestore();
        const snap = await db
            .collection('teachers')
            .where('email', '==', teacherEmail)
            .where('schoolId', '==', schoolId)
            .limit(1)
            .get();

        if (snap.empty) {
            return json(404, {
                success: false,
                error: 'Teacher record not found for this school.'
            });
        }
    } catch (err) {
        console.error('[teacher-welcome] Firestore verification failed:', err.message);
        return json(503, {
            success: false,
            error: 'Could not verify the teacher record.'
        });
    }

    // -------- Compose the email --------
    const safeName = (teacherName || '').trim() || 'Teacher';
    const safeSchool = (schoolName || 'your school').trim();
    const safeInviter = (invitedByName || 'the school administrator').trim();
    const safeLogin = loginUrl || 'https://toplink-edu.netlify.app/login';

    const subject = `Welcome to ${safeSchool} — Your Teacher Account`;

    const html = buildWelcomeHtml({
        teacherName: safeName,
        schoolName: safeSchool,
        invitedByName: safeInviter,
        loginUrl: safeLogin,
        teacherEmail,
        tempPassword
    });

    const text = [
        `Welcome to ${safeSchool}, ${safeName}!`,
        '',
        `${safeInviter} has created a teacher account for you.`,
        '',
        `Login page: ${safeLogin}`,
        `Email:      ${teacherEmail}`,
        `Password:   ${tempPassword}`,
        '',
        'Please log in and change your password from the account settings.',
        '',
        '— EduPriva'
    ].join('\n');

    // -------- Send via Gmail SMTP --------
    let info;
    try {
        const tx = getTransporter();
        info = await tx.sendMail({
            from: FROM_EMAIL,
            to: teacherEmail,
            replyTo: REPLY_TO,
            subject,
            text,
            html,
            headers: {
                'X-EduPriva-Function': 'teacher-welcome',
            },
        });
    } catch (err) {
        console.error('[teacher-welcome] SMTP send failed', {
            code: err.code,
            responseCode: err.responseCode,
            command: err.command,
            message: err.message,
        });

        // Map common SMTP errors to friendlier messages.
        let friendly = 'Failed to send the welcome email.';
        if (err.code === 'EAUTH' || err.responseCode === 535) {
            friendly = 'Gmail authentication failed. Check GMAIL_USER and GMAIL_APP_PASSWORD.';
        } else if (err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT') {
            friendly = 'Could not reach Gmail SMTP. Try again in a moment.';
        } else if (err.responseCode === 550 || err.responseCode === 553) {
            friendly = 'Gmail rejected the recipient address or sender configuration.';
        }

        return json(502, { success: false, error: friendly });
    }

    recentSends.set(key, now);
    console.log(`[teacher-welcome] Sent to ${teacherEmail} (messageId=${info?.messageId})`);

    return json(200, {
        success: true,
        id: info?.messageId || null,
        message: `Welcome email sent to ${teacherEmail}`
    });
};

// ---------------------------------------------------------------------------
// HTML template — same design as before, inline CSS only
// ---------------------------------------------------------------------------
function buildWelcomeHtml({
    teacherName, schoolName, invitedByName, loginUrl, teacherEmail, tempPassword
}) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to ${escapeHtml(schoolName)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1f2937;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 12px;">
<tr><td align="center">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border-radius:16px;box-shadow:0 4px 20px rgba(26,35,126,0.08);overflow:hidden;">

    <tr>
      <td style="background:linear-gradient(135deg,#1a237e 0%,#3949ab 100%);padding:36px 40px 30px;text-align:center;">
        <div style="display:inline-block;background:rgba(255,255,255,0.15);border-radius:12px;padding:8px 14px;margin-bottom:16px;">
          <span style="font-size:11px;font-weight:700;color:#e8eaf6;letter-spacing:1.5px;text-transform:uppercase;">EduPriva Teacher Portal</span>
        </div>
        <h1 style="margin:0;font-size:26px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;line-height:1.2;">
          Welcome to ${escapeHtml(schoolName)}
        </h1>
        <p style="margin:10px 0 0;font-size:14px;color:#c5cae9;line-height:1.4;">
          Your teacher account is ready
        </p>
      </td>
    </tr>

    <tr>
      <td style="padding:36px 40px 8px;">
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1f2937;">
          Hello <strong>${escapeHtml(teacherName)}</strong>,
        </p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#4b5563;">
          <strong>${escapeHtml(invitedByName)}</strong> has created a teacher account for you at
          <strong>${escapeHtml(schoolName)}</strong>. Use the credentials below to sign in.
        </p>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;margin:0 0 24px;">
          <tr>
            <td style="padding:20px 24px;">
              <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;">
                Your login credentials
              </div>

              <div style="margin-bottom:14px;">
                <div style="font-size:12px;font-weight:600;color:#6b7280;margin-bottom:4px;">Email</div>
                <div style="font-size:15px;font-weight:600;color:#1f2937;font-family:'SF Mono',Consolas,Monaco,monospace;word-break:break-all;">
                  ${escapeHtml(teacherEmail)}
                </div>
              </div>

              <div>
                <div style="font-size:12px;font-weight:600;color:#6b7280;margin-bottom:4px;">Temporary password</div>
                <div style="font-size:16px;font-weight:700;color:#1a237e;font-family:'SF Mono',Consolas,Monaco,monospace;background:#eef2ff;border:1px dashed #c7d2fe;border-radius:8px;padding:10px 14px;letter-spacing:0.5px;word-break:break-all;">
                  ${escapeHtml(tempPassword)}
                </div>
              </div>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border-left:4px solid #f59e0b;border-radius:8px;margin:0 0 24px;">
          <tr>
            <td style="padding:14px 18px;">
              <div style="font-size:13px;line-height:1.55;color:#92400e;">
                <strong>Security tip:</strong> Please log in and change this password
                from your account settings as soon as possible. Never share these
                credentials with anyone.
              </div>
            </td>
          </tr>
        </table>

        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
          <tr>
            <td align="center" style="border-radius:10px;background:#1a237e;">
              <a href="${escapeAttr(loginUrl)}"
                 style="display:inline-block;padding:14px 36px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:0.2px;">
                Sign in to your account &rarr;
              </a>
            </td>
          </tr>
        </table>

        <p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#6b7280;">
          If the button doesn't work, copy and paste this link into your browser:
        </p>
        <p style="margin:0 0 28px;font-size:13px;line-height:1.6;word-break:break-all;">
          <a href="${escapeAttr(loginUrl)}" style="color:#3949ab;text-decoration:underline;">${escapeHtml(loginUrl)}</a>
        </p>
      </td>
    </tr>

    <tr><td style="padding:0 40px;"><div style="border-top:1px solid #e5e7eb;"></div></td></tr>

    <tr>
      <td style="padding:24px 40px 32px;">
        <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
          Need help? Contact your school administrator or reply to this email.
        </p>
        <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
          &copy; ${new Date().getFullYear()} ${escapeHtml(schoolName)} &nbsp;•&nbsp; Powered by
          <strong style="color:#1a237e;">EduPriva</strong>
        </p>
      </td>
    </tr>

  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin-top:16px;">
    <tr>
      <td style="text-align:center;padding:8px 12px;">
        <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.5;">
          You are receiving this email because a teacher account was created for you.
        </p>
      </td>
    </tr>
  </table>

</td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/\r?\n/g, '');
}

function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}
