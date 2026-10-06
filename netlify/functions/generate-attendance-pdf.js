const { withCors } = require('./_lib/cors');
// netlify/functions/generate-attendance-pdf.js
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');

// ------------------------------------------------------------
// Firebase Admin bootstrap (idempotent)
// ------------------------------------------------------------
if (!admin.apps.length) {
    try {
        const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
            ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
            : null;
        if (serviceAccount) {
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                }),
            });
        } else {
            admin.initializeApp();
        }
    } catch (e) {
        console.error('Firebase Admin init failed:', e);
    }
}

const db = admin.apps.length ? admin.firestore() : null;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
async function fetchImageBuffer(url) {
    if (!url) return null;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const arr = await res.arrayBuffer();
        return Buffer.from(arr);
    } catch (e) {
        console.warn('Image fetch failed:', url, e.message);
        return null;
    }
}

const fmtDate = (iso) => {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric',
        });
    } catch { return iso; }
};

// Draw the school header block — only called on page 1.
function drawSchoolHeader(doc, { school, logoBuf, reportTitle, reportSubtitle, classTeacher }) {
    const pageW = doc.page.width;
    const left = 50;
    const right = pageW - 50;
    let y = 50;

    // Logo (left)
    if (logoBuf) {
        try {
            doc.image(logoBuf, left, y, { fit: [70, 70] });
        } catch (e) {
            console.warn('Logo render failed:', e.message);
        }
    }

    // School details (center-right)
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1a237e')
        .text(school.name || 'School', left + 85, y, { width: right - left - 85 });
    doc.font('Helvetica').fontSize(10).fillColor('#555');
    if (school.motto) doc.text(school.motto, { width: right - left - 85 });
    const contactLine = [school.address, school.phone, school.email].filter(Boolean).join('  •  ');
    if (contactLine) doc.text(contactLine, { width: right - left - 85 });

    // Accent rule
    y = doc.y + 12;
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#1a237e').lineWidth(1.5).stroke();

    // Report title bar
    y += 10;
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a237e')
        .text(reportTitle, left, y, { width: right - left, align: 'center' });
    y = doc.y + 2;
    if (reportSubtitle) {
        doc.font('Helvetica').fontSize(10).fillColor('#555')
            .text(reportSubtitle, left, y, { width: right - left, align: 'center' });
        y = doc.y;
    }
    if (classTeacher?.name) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666')
            .text(`Class Teacher: ${classTeacher.name}`, left, y + 4, { width: right - left, align: 'center' });
        y = doc.y;
    }

    // Ready to render body ~30px below
    doc.y = y + 18;
}

// ------------------------------------------------------------
// Table renderer — flows pages naturally, no header on later pages.
// ------------------------------------------------------------
function drawTable(doc, columns, rows, opts = {}) {
    const left = 50;
    const right = doc.page.width - 50;
    const totalW = right - left;
    const totalFlex = columns.reduce((a, c) => a + (c.width || 1), 0);
    const widths = columns.map((c) => ((c.width || 1) / totalFlex) * totalW);

    const rowHeight = opts.rowHeight || 22;
    const headerHeight = 24;

    const drawHeader = () => {
        const y = doc.y;
        doc.rect(left, y, totalW, headerHeight).fill('#1a237e');
        doc.fillColor('white').font('Helvetica-Bold').fontSize(10);
        let x = left;
        columns.forEach((c, i) => {
            doc.text(String(c.label || ''), x + 6, y + 6, {
                width: widths[i] - 12,
                align: c.align || 'left',
                lineBreak: false,
            });
            x += widths[i];
        });
        doc.y = y + headerHeight;
        doc.x = left;
    };

    const ensureSpace = (needed) => {
        const bottom = doc.page.height - 50;
        if (doc.y + needed > bottom) {
            doc.addPage();
        }
    };

    drawHeader();

    doc.font('Helvetica').fontSize(9).fillColor('#111');

    rows.forEach((row, idx) => {
        ensureSpace(rowHeight);
        const y = doc.y;
        // zebra
        if (idx % 2 === 1) {
            doc.rect(left, y, totalW, rowHeight).fill('#f7f9fc');
        }
        doc.fillColor('#111');
        let x = left;
        columns.forEach((c, i) => {
            const text = c.render ? c.render(row) : (row[c.key] ?? '');
            doc.text(String(text), x + 6, y + 6, {
                width: widths[i] - 12,
                align: c.align || 'left',
                lineBreak: false,
            });
            x += widths[i];
        });
        doc.moveTo(left, y + rowHeight).lineTo(right, y + rowHeight)
            .strokeColor('#e0e0e0').lineWidth(0.5).stroke();
        doc.y = y + rowHeight;
    });

    // Summary row (optional)
    if (opts.summaryRow) {
        ensureSpace(rowHeight);
        const y = doc.y;
        doc.rect(left, y, totalW, rowHeight).fill('#eef2ff');
        doc.fillColor('#1a237e').font('Helvetica-Bold').fontSize(9);
        let x = left;
        columns.forEach((c, i) => {
            const text = opts.summaryRow[c.key] ?? '';
            doc.text(String(text), x + 6, y + 6, {
                width: widths[i] - 12,
                align: c.align || 'left',
                lineBreak: false,
            });
            x += widths[i];
        });
        doc.y = y + rowHeight;
    }
}

// ------------------------------------------------------------
// Build the report payload from Firestore
// ------------------------------------------------------------
async function loadAttendance(schoolId, cls, from, to) {
    const snap = await db.collection('attendance')
        .where('schoolId', '==', schoolId)
        .where('class', '==', cls)
        .where('date', '>=', from)
        .where('date', '<=', to)
        .orderBy('date', 'asc')
        .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadRoster(schoolId, cls) {
    const snap = await db.collection('students')
        .where('schoolId', '==', schoolId)
        .where('class', '==', cls)
        .get();
    return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => !s.isDeleted)
        .sort((a, b) => {
            const aId = a.admissionNumber || a.studentId || '';
            const bId = b.admissionNumber || b.studentId || '';
            if (aId && bId) return String(aId).localeCompare(String(bId), undefined, { numeric: true });
            const an = `${a.firstName || ''} ${a.lastName || ''}`.toLowerCase();
            const bn = `${b.firstName || ''} ${b.lastName || ''}`.toLowerCase();
            return an.localeCompare(bn);
        });
}

// ------------------------------------------------------------
// Report builders
// ------------------------------------------------------------
function buildDailyReport(doc, { school, logoBuf, classTeacher, cls, date, record, roster }) {
    drawSchoolHeader(doc, {
        school, logoBuf,
        reportTitle: 'DAILY ATTENDANCE REPORT',
        reportSubtitle: `${cls}  •  ${fmtDate(date)}`,
        classTeacher,
    });

    if (!record) {
        doc.font('Helvetica').fontSize(12).fillColor('#888')
            .text('No attendance was recorded for this date.', { align: 'center' });
        return;
    }

    const rows = (record.entries || []).map((e) => ({
        adm: e.admissionNumber || '',
        name: e.name || '',
        status: (e.status || 'present').toUpperCase(),
        note: e.note || '',
    }));

    // Summary stats block
    const c = record.counts || {};
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a237e').text('Summary');
    doc.font('Helvetica').fontSize(10).fillColor('#111');
    doc.text(`Present: ${c.present || 0}   |   Absent: ${c.absent || 0}   |   Late: ${c.late || 0}   |   Excused: ${c.excused || 0}`);
    doc.moveDown(0.5);

    drawTable(doc,
        [
            { key: 'adm',    label: 'Adm No',  width: 2 },
            { key: 'name',   label: 'Name',    width: 5 },
            { key: 'status', label: 'Status',  width: 2, align: 'center' },
            { key: 'note',   label: 'Note',    width: 4 },
        ],
        rows
    );
}

function buildSummaryReport(doc, { school, logoBuf, classTeacher, cls, from, to, records, roster, title }) {
    // Aggregate
    const totals = { present: 0, absent: 0, late: 0, excused: 0, marks: 0 };
    const perStudent = new Map();
    roster.forEach((s) => perStudent.set(s.id, {
        adm: s.admissionNumber || s.studentId || '',
        name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
        present: 0, absent: 0, late: 0, excused: 0, total: 0,
    }));

    records.forEach((rec) => {
        (rec.entries || []).forEach((e) => {
            const st = e.status || 'present';
            if (totals[st] !== undefined) totals[st]++;
            totals.marks++;
            const row = perStudent.get(e.studentId);
            if (row) {
                if (row[st] !== undefined) row[st]++;
                row.total++;
            }
        });
    });

    drawSchoolHeader(doc, {
        school, logoBuf,
        reportTitle: title.toUpperCase(),
        reportSubtitle: `${cls}  •  ${fmtDate(from)}  →  ${fmtDate(to)}`,
        classTeacher,
    });

    // Overview block
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a237e').text('Overview');
    doc.font('Helvetica').fontSize(10).fillColor('#111');
    const rate = totals.marks > 0 ? Math.round(((totals.present + totals.late) / totals.marks) * 100) : 0;
    doc.text(`Days recorded: ${records.length}`);
    doc.text(`Marks: ${totals.marks}`);
    doc.text(`Present: ${totals.present}   |   Absent: ${totals.absent}   |   Late: ${totals.late}   |   Excused: ${totals.excused}`);
    doc.text(`Overall attendance rate: ${rate}%`);
    doc.moveDown(0.8);

    const rows = [...perStudent.values()].map((r) => ({
        ...r,
        rate: r.total > 0 ? Math.round(((r.present + r.late) / r.total) * 100) : 0,
    }));

    drawTable(doc,
        [
            { key: 'adm',      label: 'Adm No',  width: 2 },
            { key: 'name',     label: 'Name',    width: 5 },
            { key: 'present',  label: 'P',       width: 1, align: 'center' },
            { key: 'absent',   label: 'A',       width: 1, align: 'center' },
            { key: 'late',     label: 'L',       width: 1, align: 'center' },
            { key: 'excused',  label: 'E',       width: 1, align: 'center' },
            { key: 'total',    label: 'Days',    width: 1, align: 'center' },
            { key: 'rate',     label: 'Rate %',  width: 1, align: 'right',
              render: (r) => `${r.rate}%` },
        ],
        rows
    );
}

function buildPerStudentReport(doc, { school, logoBuf, classTeacher, cls, from, to, records, roster }) {
    drawSchoolHeader(doc, {
        school, logoBuf,
        reportTitle: 'PER-STUDENT ATTENDANCE',
        reportSubtitle: `${cls}  •  ${fmtDate(from)}  →  ${fmtDate(to)}`,
        classTeacher,
    });

    // Map student -> array of {date, status, note}
    const byStudent = new Map();
    roster.forEach((s) => byStudent.set(s.id, []));
    records.forEach((rec) => {
        (rec.entries || []).forEach((e) => {
            const list = byStudent.get(e.studentId);
            if (list) list.push({
                date: rec.date,
                status: e.status || 'present',
                note: e.note || '',
            });
        });
    });

    roster.forEach((s) => {
        const events = (byStudent.get(s.id) || []).sort((a, b) => a.date.localeCompare(b.date));
        if (events.length === 0) return;

        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a237e')
            .text(`${s.firstName || ''} ${s.lastName || ''}`.trim());
        doc.font('Helvetica').fontSize(10).fillColor('#555')
            .text(`Adm No: ${s.admissionNumber || s.studentId || '—'}`);
        doc.moveDown(0.4);

        drawTable(doc,
            [
                { key: 'date',   label: 'Date',   width: 3 },
                { key: 'status', label: 'Status', width: 2, align: 'center',
                  render: (r) => r.status.toUpperCase() },
                { key: 'note',   label: 'Note',   width: 5 },
            ],
            events
        );
    });
}

function buildChronicReport(doc, { school, logoBuf, classTeacher, cls, from, to, records, roster }) {
    const THRESHOLD = 20; // percent absent or lower => chronic

    const totals = new Map();
    roster.forEach((s) => totals.set(s.id, {
        adm: s.admissionNumber || s.studentId || '',
        name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
        present: 0, late: 0, absent: 0, excused: 0, total: 0,
    }));

    records.forEach((rec) => {
        (rec.entries || []).forEach((e) => {
            const row = totals.get(e.studentId);
            if (!row) return;
            const st = e.status || 'present';
            if (row[st] !== undefined) row[st]++;
            row.total++;
        });
    });

    const chronic = [...totals.values()]
        .map((r) => ({ ...r, rate: r.total > 0 ? Math.round(((r.present + r.late) / r.total) * 100) : 0 }))
        .filter((r) => r.total > 0 && r.rate < 100 - THRESHOLD)
        .sort((a, b) => a.rate - b.rate);

    drawSchoolHeader(doc, {
        school, logoBuf,
        reportTitle: 'CHRONIC ABSENTEE REPORT',
        reportSubtitle: `${cls}  •  ${fmtDate(from)}  →  ${fmtDate(to)}  •  Threshold: <${THRESHOLD}% presence`,
        classTeacher,
    });

    if (chronic.length === 0) {
        doc.font('Helvetica').fontSize(12).fillColor('#16a34a')
            .text('No chronic absentees in this period.', { align: 'center' });
        return;
    }

    drawTable(doc,
        [
            { key: 'adm',      label: 'Adm No',   width: 2 },
            { key: 'name',     label: 'Name',     width: 5 },
            { key: 'present',  label: 'Present',  width: 1, align: 'center' },
            { key: 'absent',   label: 'Absent',   width: 1, align: 'center' },
            { key: 'total',    label: 'Days',     width: 1, align: 'center' },
            { key: 'rate',     label: 'Rate %',   width: 1, align: 'right',
              render: (r) => `${r.rate}%` },
        ],
        chronic
    );
}

// ------------------------------------------------------------
// HTTP handler
// ------------------------------------------------------------
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method not allowed' };
    }
    if (!db) {
        return { statusCode: 500, body: 'Firestore not initialized' };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { schoolId, cls, reportType, from, to, school, classTeacher } = body;
        if (!schoolId || !cls || !reportType) {
            return { statusCode: 400, body: 'Missing schoolId, cls or reportType' };
        }

        const [records, roster, logoBuf] = await Promise.all([
            loadAttendance(schoolId, cls, from, to),
            loadRoster(schoolId, cls),
            fetchImageBuffer(school?.logoUrl),
        ]);

        const doc = new PDFDocument({
            size: 'A4',
            margin: 50,
            bufferPages: true,
            info: {
                Title: `Attendance Report — ${cls}`,
                Author: school?.name || 'EduPriva',
            },
        });

        const chunks = [];
        doc.on('data', (c) => chunks.push(c));

        const done = new Promise((resolve) => doc.on('end', resolve));

        const ctx = { school: school || {}, logoBuf, classTeacher, cls, from, to, records, roster };

        if (reportType === 'daily') {
            const rec = records.find((r) => r.date === (body.reportDate || from)) || records[0] || null;
            buildDailyReport(doc, {
                ...ctx,
                date: body.reportDate || from,
                record: rec,
            });
        } else if (reportType === 'weekly') {
            buildSummaryReport(doc, { ...ctx, title: 'Weekly Attendance Summary' });
        } else if (reportType === 'monthly') {
            buildSummaryReport(doc, { ...ctx, title: 'Monthly Attendance Summary' });
        } else if (reportType === 'term') {
            buildSummaryReport(doc, { ...ctx, title: 'Term Attendance Summary' });
        } else if (reportType === 'perStudent') {
            buildPerStudentReport(doc, ctx);
        } else if (reportType === 'chronic') {
            buildChronicReport(doc, ctx);
        } else {
            return { statusCode: 400, body: `Unknown report type: ${reportType}` };
        }

        doc.end();
        await done;

        const buffer = Buffer.concat(chunks);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="attendance_${reportType}_${cls}.pdf"`,
                'Cache-Control': 'no-store, max-age=0',
            },
            isBase64Encoded: true,
            body: buffer.toString('base64'),
        };
    } catch (e) {
        console.error('generate-attendance-pdf failed:', e);
        return { statusCode: 500, body: `Error: ${e.message}` };
    }
};

exports.handler = withCors(exports.handler);
