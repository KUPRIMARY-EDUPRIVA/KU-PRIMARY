const { withCors } = require('./_lib/cors');
// netlify/functions/generate-receipt.js
const PDFDocument = require('pdfkit');
const axios = require('axios');

const FALLBACK_NAME = 'EDUPRIVA';
const FALLBACK_MOTTO = 'Powering Modern Education';

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return json(405, { error: 'Method Not Allowed' });
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { error: 'Invalid JSON body' });
    }

    const { receipt, school } = payload;
    if (!receipt || typeof receipt !== 'object') {
        return json(400, { error: 'receipt object is required' });
    }
    if (!receipt.receiptNumber) {
        return json(400, { error: 'receipt.receiptNumber is required' });
    }

    try {
        const pdfBuffer = await generateReceiptPDF(receipt, school || {});
        const safe = String(receipt.receiptNumber).replace(/[^\w-]/g, '');

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="receipt_${safe}.pdf"`
            },
            body: pdfBuffer.toString('base64'),
            isBase64Encoded: true
        };
    } catch (err) {
        console.error('Receipt PDF generation error:', err);
        return json(500, { error: err.message });
    }
};

// ---------------- Helpers ----------------

function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    };
}

function fmtKES(n) {
    return 'KES ' + Number(n || 0).toLocaleString('en-KE');
}

function numberToWords(num) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];

    function under1000(n) {
        if (n === 0) return '';
        if (n < 10) return ones[n];
        if (n < 20) return teens[n - 10];
        if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
        return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + under1000(n % 100) : '');
    }

    function convert(n) {
        if (n === 0) return 'Zero';
        if (n < 1000) return under1000(n);
        const scales = [
            { v: 1e9, name: 'Billion' },
            { v: 1e6, name: 'Million' },
            { v: 1e3, name: 'Thousand' }
        ];
        for (const { v, name } of scales) {
            if (n >= v) {
                const head = Math.floor(n / v);
                const tail = n % v;
                return convert(head) + ' ' + name + (tail ? ' ' + convert(tail) : '');
            }
        }
        return String(n);
    }

    if (!num || num === 0) return 'Zero Shillings Only';
    return convert(Math.round(num)) + ' Shillings Only';
}

function safeDate(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

async function fetchLogoBuffer(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 8000,
            headers: { 'User-Agent': 'EduPriva-PDF/1.0' }
        });
        const buf = Buffer.from(res.data);
        if (buf.length > 2 * 1024 * 1024) {
            console.warn('Logo too large, skipping:', buf.length);
            return null;
        }
        return buf;
    } catch (err) {
        console.warn('Logo fetch failed (continuing without it):', err.message);
        return null;
    }
}

/**
 * Draws the brand header at the top of the page.
 * Left: logo + school name + motto + contact line.
 * Right: "RECEIPT" badge with receipt number + year.
 * Returns Y coordinate to continue drawing below the divider.
 */
function drawHeader(doc, receipt, school, logoBuffer) {
    const PRIMARY = '#1a237e';
    const GRAY = '#666';
    const MARGIN = 40;
    const pageWidth = doc.page.width;

    const schoolName = school.schoolName || FALLBACK_NAME;
    const motto = school.schoolMotto || FALLBACK_MOTTO;
    const year = receipt.year || new Date().getFullYear();

    const headerY = MARGIN;
    const logoSize = 54;
    const textX = MARGIN + (logoBuffer ? logoSize + 12 : 0);

    // --- Logo ---
    if (logoBuffer) {
        try {
            doc.image(logoBuffer, MARGIN, headerY, { fit: [logoSize, logoSize] });
        } catch (e) {
            console.warn('Failed to embed logo:', e.message);
        }
    }

    // --- School name ---
    doc
        .fontSize(18)
        .fillColor(PRIMARY)
        .font('Helvetica-Bold')
        .text(schoolName, textX, headerY, {
            width: pageWidth - textX - MARGIN - 160
        });

    // --- Motto ---
    if (motto) {
        doc
            .fontSize(9)
            .fillColor(GRAY)
            .font('Helvetica-Oblique')
            .text(motto, textX, headerY + 26, {
                width: pageWidth - textX - MARGIN - 160
            });
    }

    // --- Contact line ---
    const contactBits = [
        school.schoolAddress,
        school.schoolPhone ? `Phone: ${school.schoolPhone}` : '',
        school.schoolEmail ? `Email: ${school.schoolEmail}` : ''
    ].filter(Boolean);

    if (contactBits.length) {
        doc
            .fontSize(8)
            .fillColor(GRAY)
            .font('Helvetica')
            .text(contactBits.join('   •   '), textX, headerY + 42, {
                width: pageWidth - textX - MARGIN - 160
            });
    }

    // --- Receipt badge ---
    const badgeW = 140;
    const badgeH = 54;
    const badgeX = pageWidth - MARGIN - badgeW;
    const badgeY = headerY;

    doc
        .roundedRect(badgeX, badgeY, badgeW, badgeH, 4)
        .lineWidth(2)
        .strokeColor(PRIMARY)
        .stroke();

    doc
        .fontSize(14)
        .fillColor(PRIMARY)
        .font('Helvetica-Bold')
        .text('RECEIPT', badgeX, badgeY + 8, { width: badgeW, align: 'center' });

    doc
        .fontSize(8)
        .fillColor(GRAY)
        .font('Helvetica')
        .text(`No: ${receipt.receiptNumber}`, badgeX, badgeY + 28, {
            width: badgeW,
            align: 'center',
            ellipsis: true
        });

    doc
        .fontSize(8)
        .fillColor(GRAY)
        .text(String(year), badgeX, badgeY + 40, { width: badgeW, align: 'center' });

    // --- Divider ---
    const dividerY = headerY + logoSize + 12;
    doc
        .moveTo(MARGIN, dividerY)
        .lineTo(pageWidth - MARGIN, dividerY)
        .lineWidth(2)
        .strokeColor(PRIMARY)
        .stroke();

    return dividerY + 20;
}

// ---------------- Main PDF builder ----------------

function generateReceiptPDF(receipt, school) {
    return fetchLogoBuffer(school.schoolLogo).then((logoBuffer) => {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', margin: 40 });
            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const PRIMARY = '#1a237e';
            const GRAY = '#666';
            const MARGIN = 40;
            const CONTENT_W = doc.page.width - MARGIN * 2;
            const RIGHT_EDGE = doc.page.width - MARGIN;

            // ---------- Header ----------
            let y = drawHeader(doc, receipt, school, logoBuffer);

            // ---------- Student info grid ----------
            const infoY = y;
            doc.rect(MARGIN, infoY, CONTENT_W, 78).fillAndStroke('#f5f5f5', '#e0e0e0');

            const label = (text, x, ly) =>
                doc.fontSize(8).fillColor(GRAY).font('Helvetica').text(text.toUpperCase(), x, ly);
            const value = (text, x, ly, width = 220) =>
                doc
                    .fontSize(11)
                    .fillColor('#000')
                    .font('Helvetica-Bold')
                    .text(String(text || 'N/A'), x, ly + 12, { width, ellipsis: true });

            const colLeftX = MARGIN + 15;
            const colRightX = MARGIN + Math.floor(CONTENT_W / 2);

            label('Student Name', colLeftX, infoY + 10);
            value(receipt.studentName, colLeftX, infoY + 10, CONTENT_W / 2 - 20);

            label('Admission No', colRightX, infoY + 10);
            value(receipt.admissionNumber, colRightX, infoY + 10, CONTENT_W / 2 - 15);

            label('Class', colLeftX, infoY + 46);
            value(receipt.studentClass, colLeftX, infoY + 46);

            const paymentDate = safeDate(receipt.paymentDate);
            label('Payment Date', colRightX, infoY + 46);
            value(
                paymentDate ? paymentDate.toLocaleString('en-KE') : 'N/A',
                colRightX,
                infoY + 46,
                CONTENT_W / 2 - 15
            );

            y = infoY + 78 + 20;

            // ---------- Payment table ----------
            const colWidths = [220, 90, 100, CONTENT_W - 220 - 90 - 100];
            const headers = ['Description', 'Method', 'Reference', 'Amount (KES)'];

            // Header row
            doc.rect(MARGIN, y, CONTENT_W, 22).fill(PRIMARY);
            doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold');
            let cx = MARGIN + 5;
            headers.forEach((h, i) => {
                doc.text(h, cx, y + 7, {
                    width: colWidths[i] - 10,
                    align: i === 3 ? 'right' : 'left'
                });
                cx += colWidths[i];
            });

            y += 22;

            // Data row
            const rowH = 26;
            doc.rect(MARGIN, y, CONTENT_W, rowH).strokeColor('#e0e0e0').stroke();
            doc.fillColor('#000').fontSize(10).font('Helvetica');
            cx = MARGIN + 5;
            const rowData = [
                receipt.description || 'Fee Payment',
                (receipt.paymentMethod || 'cash').toUpperCase(),
                receipt.reference || 'N/A',
                fmtKES(receipt.amount)
            ];
            rowData.forEach((val, i) => {
                doc.text(String(val), cx, y + 8, {
                    width: colWidths[i] - 10,
                    align: i === 3 ? 'right' : 'left',
                    ellipsis: true
                });
                cx += colWidths[i];
            });

            y += rowH;

            // Total row
            const totalH = 28;
            doc.rect(MARGIN, y, CONTENT_W, totalH).fill('#f5f5f5');
            doc
                .fillColor('#000')
                .fontSize(10)
                .font('Helvetica-Bold')
                .text('Total Paid', MARGIN + 5, y + 9, {
                    width: CONTENT_W - 15,
                    align: 'right'
                });
            doc
                .fontSize(13)
                .fillColor(PRIMARY)
                .text(fmtKES(receipt.amount), RIGHT_EDGE - 100, y + 7, {
                    width: 95,
                    align: 'right'
                });

            y += totalH + 16;

            // ---------- Amount in words ----------
            const wordsH = 40;
            doc.rect(MARGIN, y, CONTENT_W, wordsH).fill('#f9f9f9');
            doc.rect(MARGIN, y, 4, wordsH).fill(PRIMARY);

            doc
                .fontSize(8)
                .fillColor(GRAY)
                .font('Helvetica')
                .text('AMOUNT IN WORDS', MARGIN + 15, y + 7);
            doc
                .fontSize(11)
                .fillColor('#000')
                .font('Helvetica-Bold')
                .text(numberToWords(receipt.amount), MARGIN + 15, y + 20, {
                    width: CONTENT_W - 30,
                    ellipsis: true
                });

            y += wordsH + 16;

            // ---------- Summary box ----------
            const sumH = 66;
            doc.rect(MARGIN, y, CONTENT_W, sumH).fill('#e3f2fd');

            const sumCol = (lbl, val, x, color, width) => {
                doc.fontSize(8).fillColor(GRAY).font('Helvetica')
                   .text(lbl.toUpperCase(), x, y + 10, { width });
                doc.fontSize(13).fillColor(color || PRIMARY).font('Helvetica-Bold')
                   .text(val, x, y + 26, { width, ellipsis: true });
            };

            const colW = Math.floor(CONTENT_W / 3);
            sumCol('Total Paid to Date', fmtKES(receipt.totalPaid), MARGIN + 15, PRIMARY, colW - 20);
            sumCol(
                'Outstanding Balance',
                fmtKES(receipt.balance),
                MARGIN + colW + 5,
                receipt.balance > 0 ? '#d32f2f' : '#2e7d32',
                colW - 20
            );
            sumCol(
                'Term / Year',
                `${receipt.term || 'Term 1'} ${receipt.year || new Date().getFullYear()}`,
                MARGIN + colW * 2 + 5,
                PRIMARY,
                colW - 20
            );

            y += sumH + 24;

            // ---------- Footer ----------
            doc
                .moveTo(MARGIN, y)
                .lineTo(RIGHT_EDGE, y)
                .strokeColor('#e0e0e0')
                .lineWidth(1)
                .stroke();

            doc.fontSize(8).fillColor(GRAY).font('Helvetica');
            doc.text(`Generated: ${new Date().toLocaleString('en-KE')}`, MARGIN, y + 8);
            doc.text(`Receipt No: ${receipt.receiptNumber}`, MARGIN, y + 20);

            // Signature block on the right
            doc
                .moveTo(RIGHT_EDGE - 160, y + 40)
                .lineTo(RIGHT_EDGE, y + 40)
                .strokeColor('#333')
                .lineWidth(1)
                .stroke();
            doc
                .fontSize(9)
                .fillColor('#333')
                .font('Helvetica')
                .text('Authorized Signature', RIGHT_EDGE - 160, y + 44, {
                    width: 160,
                    align: 'center'
                });
            doc
                .fontSize(7)
                .fillColor(GRAY)
                .text('This is a computer-generated receipt', RIGHT_EDGE - 160, y + 58, {
                    width: 160,
                    align: 'center'
                });

            doc.end();
        });
    });
}

exports.handler = withCors(exports.handler);
