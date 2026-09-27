// netlify/functions/generate-teacher-reports.js
//
// Generates teacher assessment PDFs in two modes:
//   mode = 'single' → one full A4 portrait page per record (detail view)
//   mode = 'all'    → one A4 landscape table listing every record
//
// Styling matches generate-student-report.js:
//   - Letterhead-style header (logo left, school name / motto / contact stack)
//     with a coloured underline rule
//   - Times New Roman typography (PDFKit standard-14 Times family)
//   - Same CBC level colour palette and grade bands
//   - Images opened once as reusable PDF XObjects (multi-page size win)
//   - Early size guard rejects oversized batches with a 413 before PDFKit
//     starts streaming

const PDFDocument = require('pdfkit');
const axios = require('axios');

const FALLBACK_NAME = 'EDUPRIVA';
const FALLBACK_MOTTO = 'Powering Modern Education';

const MAX_RESPONSE_BYTES = 5_500_000;
const MAX_RECORDS_PER_REQUEST = 500;

// Per-record size estimate (bytes) for the early guard.
const EST_BYTES_PER_RECORD = {
    single: 90_000,  // full portrait page with grid + remarks
    all: 4_000,      // one table row, but repeated header/footer per page
};
const ESTIMATE_HEADROOM = 0.7;

const PRIMARY = '#1a237e';
const PRIMARY_SOFT = '#3949ab';
const PRIMARY_LIGHT = '#eef2ff';
const GRAY = '#666';
const LIGHT = '#f5f7fb';
const BORDER = '#e0e6ed';
const DANGER = '#c62828';
const SUCCESS = '#1b5e20';

// Letterhead colours (shared with the student report)
const HEADER_BLUE = '#1a4e8a';
const HEADER_RULE_WIDTH = 1.4;
const HEADER_MOTTO_GRAY = '#666';
const HEADER_CONTACT_GRAY = '#333';

// Times New Roman family (PDFKit standard-14 names)
const FONT_REGULAR = 'Times-Roman';
const FONT_BOLD = 'Times-Bold';
const FONT_ITALIC = 'Times-Italic';
const FONT_BOLD_ITALIC = 'Times-BoldItalic';

// ============================================================
// Handler
// ============================================================
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { error: 'Invalid JSON body' });
    }

    const { mode, records, meta, teacher } = payload;

    if (!Array.isArray(records) || records.length === 0) {
        return json(400, { error: 'records array is required and must not be empty' });
    }
    if (records.length > MAX_RECORDS_PER_REQUEST) {
        return json(413, {
            error: `Too many records in one request (${records.length}). ` +
                   `Split into batches of ${MAX_RECORDS_PER_REQUEST}.`,
        });
    }
    if (mode !== 'single' && mode !== 'all') {
        return json(400, { error: 'mode must be "single" or "all"' });
    }
    if (!meta || typeof meta !== 'object') {
        return json(400, { error: 'meta object is required' });
    }

    // Early size guard — reject before PDFKit starts streaming.
    const estBytes = records.length * (EST_BYTES_PER_RECORD[mode] || 90_000);
    const safeBudget = MAX_RESPONSE_BYTES * ESTIMATE_HEADROOM;
    if (estBytes > safeBudget) {
        return json(413, {
            error:
                `Too many records for one request (${records.length}). ` +
                `Estimated ${(estBytes / 1_048_576).toFixed(1)} MB exceeds the ` +
                `${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(1)} MB response budget. ` +
                `Split into smaller batches.`,
        });
    }

    try {
        // Accept every plausible logo field name
        const logoUrl = meta.schoolLogo || meta.logoUrl || meta.logo || '';
        const logoBuffer = await fetchImageBuffer(logoUrl, 2 * 1024 * 1024);

        console.log('[TeacherPDF] image fetch status', {
            hasLogoUrl: !!logoUrl,
            logoBytes: logoBuffer ? logoBuffer.length : 0,
        });

        const pdfBuffer = mode === 'single'
            ? await generateSingleRecordPDF(records[0], meta, teacher, logoBuffer)
            : await generateAllRecordsPDF(records, meta, teacher, logoBuffer);

        if (pdfBuffer.length > MAX_RESPONSE_BYTES) {
            return json(413, {
                error:
                    `Generated PDF is ${(pdfBuffer.length / 1_048_576).toFixed(1)} MB, ` +
                    `exceeding the ${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(1)} MB limit. ` +
                    `Generate per record or a smaller batch.`,
            });
        }

        const filename = buildFilename({ mode, records, meta });

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': String(pdfBuffer.length),
                'Cache-Control': 'no-store',
            },
            body: pdfBuffer.toString('base64'),
            isBase64Encoded: true,
        };
    } catch (err) {
        console.error('Teacher reports PDF error:', err);
        return json(500, { error: err.message || 'PDF generation failed' });
    }
};

function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}

function buildFilename({ mode, records, meta }) {
    const safe = (s) => String(s || '').replace(/[^\w-]/g, '');
    const date = new Date().toISOString().slice(0, 10);
    if (mode === 'single') {
        const r = records[0] || {};
        const who = r.studentName || r.admissionNumber || 'student';
        return `assessment_${safe(who)}_${date}.pdf`;
    }
    const year = meta.year || new Date().getFullYear();
    const term = meta.term ? `_${safe(meta.term)}` : '';
    return `teacher_report_${safe(meta.schoolName || FALLBACK_NAME)}${term}_${year}_${date}.pdf`;
}

// ============================================================
// Grading — CBC levels (shared with student report)
// ============================================================
function cbcGrade(score) {
    if (score == null || isNaN(score)) {
        return { code: 'NA', label: 'Not Assessed', points: null, level: 'NA' };
    }
    if (score >= 80) return { code: 'EE', label: 'Exceeding Expectations', points: 8, level: 'EE' };
    if (score >= 65) return { code: 'ME', label: 'Meeting Expectations', points: 6, level: 'ME' };
    if (score >= 50) return { code: 'AE', label: 'Approaching Expectations', points: 4, level: 'AE' };
    if (score >= 40) return { code: 'BE', label: 'Below Expectations', points: 2, level: 'BE' };
    return { code: 'BE', label: 'Below Expectations', points: 1, level: 'BE' };
}

function gradeBg(level) {
    return level === 'EE' ? '#d4edda'
        : level === 'ME' ? '#d1ecf1'
        : level === 'AE' ? '#fff3cd'
        : level === 'NA' ? '#eef2f7'
        : '#f8d7da';
}

function gradeFg(level) {
    return level === 'EE' ? '#155724'
        : level === 'ME' ? '#0c5460'
        : level === 'AE' ? '#856404'
        : level === 'NA' ? '#94a3b8'
        : '#721c24';
}

// ============================================================
// Image fetch
// ============================================================
async function fetchImageBuffer(url, maxBytes = 1 * 1024 * 1024) {
    if (!url || typeof url !== 'string') return null;
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: { 'User-Agent': 'EduPriva-PDF/5.0' },
            maxRedirects: 5,
        });
        const buf = Buffer.from(res.data);
        if (buf.length === 0) {
            console.warn(`Empty image response from ${url}`);
            return null;
        }
        if (buf.length > maxBytes) {
            console.warn(`Image too large (${buf.length} bytes) — skipping`);
            return null;
        }
        return buf;
    } catch (e) {
        console.warn(`Image fetch failed for ${url}:`, e.message);
        return null;
    }
}

// ============================================================
// Primitives
// ============================================================
function drawImage(doc, img, cx, cy, w, h) {
    if (!img) return false;
    try {
        doc.image(img, cx, cy, { fit: [w, h], align: 'center', valign: 'center' });
        return true;
    } catch (e) {
        console.warn('Image embed failed:', e.message);
        return false;
    }
}

function fmtDate(d) {
    if (!d) return '—';
    try {
        return new Date(d).toLocaleDateString('en-KE', {
            day: '2-digit', month: 'short', year: 'numeric',
        });
    } catch {
        return '—';
    }
}

function fmtDateTime(d) {
    if (!d) return '—';
    try {
        return new Date(d).toLocaleString('en-KE');
    } catch {
        return '—';
    }
}

/**
 * Compose a letterhead-style header and return the y below the rule.
 * Identical geometry to the student report so both documents match.
 */
function drawLetterheadHeader(doc, {
    x, y, w,
    meta, logoImg,
    logoSize = 58,
    padding = 10,
    nameSize = 15,
    mottoSize = 8.5,
    contactSize = 7.5,
    lineGap = 2.5,
    ruleGap = 6,
}) {
    const logoX = x;
    const logoY = y;
    const hasLogo = drawImage(doc, logoImg, logoX, logoY, logoSize, logoSize);

    if (!hasLogo) {
        doc.rect(logoX, logoY, logoSize, logoSize)
            .lineWidth(0.6).strokeColor(BORDER).stroke();
        doc.font(FONT_REGULAR).fontSize(6.5).fillColor('#bbb')
            .text('NO\nLOGO', logoX, logoY + logoSize / 2 - 6, {
                width: logoSize, align: 'center', lineGap: 2,
            });
    }

    const textX = logoX + logoSize + padding;
    const textW = w - logoSize - padding;

    doc.font(FONT_BOLD).fontSize(nameSize).fillColor(HEADER_BLUE)
        .text((meta.schoolName || FALLBACK_NAME).toUpperCase(), textX, y + 1, {
            width: textW, align: 'left', ellipsis: true,
        });
    let cy = y + nameSize + 3;

    const motto = meta.schoolMotto || FALLBACK_MOTTO;
    doc.font(FONT_ITALIC).fontSize(mottoSize).fillColor(HEADER_MOTTO_GRAY)
        .text(`Motto: ${motto}`, textX, cy, {
            width: textW, align: 'left', ellipsis: true,
        });
    cy += mottoSize + lineGap;

    doc.font(FONT_REGULAR).fontSize(contactSize).fillColor(HEADER_CONTACT_GRAY);
    const contactLines = [];
    if (meta.schoolAddress) contactLines.push(String(meta.schoolAddress));
    if (meta.schoolPhone) contactLines.push(`Tel: ${meta.schoolPhone}`);
    if (meta.schoolEmail) contactLines.push(`Email: ${meta.schoolEmail}`);
    if (meta.website) contactLines.push(`Website: ${meta.website}`);
    if (meta.schoolCode || meta.schoolId) {
        contactLines.push(`School Code: ${meta.schoolCode || meta.schoolId}`);
    }

    for (const line of contactLines) {
        doc.text(line, textX, cy, {
            width: textW, align: 'left', ellipsis: true, lineBreak: false,
        });
        cy += contactSize + lineGap;
    }

    const blockBottom = Math.max(cy, logoY + logoSize) + ruleGap;
    doc.moveTo(x, blockBottom).lineTo(x + w, blockBottom)
        .lineWidth(HEADER_RULE_WIDTH).strokeColor(HEADER_BLUE).stroke();

    return blockBottom + 6;
}

// ============================================================
// Single record PDF (A4 portrait)
// ============================================================
function generateSingleRecordPDF(record, meta, teacher, logoBuffer) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margin: 0,
            autoFirstPage: false,
            compress: true,
            info: {
                Title: `Assessment Record — ${record.studentName || 'Student'}`,
                Author: meta.schoolName || FALLBACK_NAME,
                Creator: 'EduPriva',
            },
        });

        const chunks = [];
        let total = 0;
        let aborted = false;
        doc.on('data', (c) => {
            if (aborted) return;
            chunks.push(c);
            total += c.length;
            if (total > MAX_RESPONSE_BYTES) {
                aborted = true;
                doc.destroy(new Error(
                    `PDF exceeded ${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(1)} MB limit`
                ));
            }
        });
        doc.on('end', () => resolve(Buffer.concat(chunks, total)));
        doc.on('error', reject);

        doc.font(FONT_REGULAR);

        // Open logo once as a reusable XObject
        let logoImg = null;
        if (logoBuffer) {
            try { logoImg = doc.openImage(logoBuffer); }
            catch (e) { console.warn('openImage failed for logo:', e.message); }
        }

        doc.addPage();

        const MARGIN = 36;
        const PAGE_W = doc.page.width;
        const PAGE_H = doc.page.height;
        const CONTENT_W = PAGE_W - MARGIN * 2;

        let y = drawLetterheadHeader(doc, {
            x: MARGIN, y: MARGIN, w: CONTENT_W,
            meta, logoImg,
        });

        // Title block
        doc.font(FONT_BOLD).fontSize(13).fillColor('#000')
            .text('ASSESSMENT RECORD', MARGIN, y, {
                width: CONTENT_W, align: 'center',
            });
        y += 16;
        doc.font(FONT_ITALIC).fontSize(9).fillColor(GRAY)
            .text(`${meta.term || ''} ${meta.year || new Date().getFullYear()}`.trim() ||
                  String(new Date().getFullYear()),
                MARGIN, y, { width: CONTENT_W, align: 'center' });
        y += 16;

        // CBC grade for the score
        const score = record.score != null && !isNaN(record.score)
            ? Number(record.score) : null;
        const grade = cbcGrade(score);

        // ---- Score badge ----
        const badgeW = 150;
        const badgeH = 74;
        const badgeX = MARGIN + (CONTENT_W - badgeW) / 2;
        const badgeY = y;

        doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 6)
            .lineWidth(1.2).strokeColor(PRIMARY).stroke();
        doc.rect(badgeX, badgeY, badgeW, 22).fill(PRIMARY);
        doc.font(FONT_BOLD).fontSize(10).fillColor('#fff')
            .text('OVERALL SCORE', badgeX, badgeY + 6, {
                width: badgeW, align: 'center',
            });
        doc.font(FONT_BOLD).fontSize(26).fillColor(PRIMARY)
            .text(score != null ? `${score}%` : '—', badgeX, badgeY + 26, {
                width: badgeW, align: 'center',
            });
        doc.font(FONT_BOLD).fontSize(9).fillColor(gradeFg(grade.level))
            .text(`${grade.code} — ${grade.label}`, badgeX, badgeY + 56, {
                width: badgeW, align: 'center',
            });

        y = badgeY + badgeH + 18;

        // ---- Info grid ----
        const teacherName = teacher
            ? `${teacher.firstName || ''} ${teacher.lastName || ''}`.trim()
            : 'N/A';

        const infoRows = [
            ['Student', record.studentName || 'N/A', 'Admission No', record.admissionNumber || 'N/A'],
            ['Subject', record.subject || 'N/A', 'Class', record.class || 'N/A'],
            ['Assessment Type', record.assessmentType || 'N/A',
             'Level', record.levelDisplay || record.level || grade.code],
            ['CBC Points', grade.points != null ? grade.points.toFixed(1) : '—',
             'Recorded', record.recordedAtDisplay || fmtDateTime(record.recordedAt)],
            ['Teacher', teacherName, 'School', meta.schoolName || FALLBACK_NAME],
        ];

        const rowH = 30;
        const gridH = infoRows.length * rowH + 8;
        doc.rect(MARGIN, y, CONTENT_W, gridH).fillAndStroke(LIGHT, BORDER);

        let rowY = y + 4;
        infoRows.forEach(([l1, v1, l2, v2], idx) => {
            if (idx % 2 === 1) {
                doc.rect(MARGIN + 1, rowY, CONTENT_W - 2, rowH).fill('#ffffff');
            }
            doc.font(FONT_REGULAR).fontSize(7.5).fillColor(GRAY)
                .text(String(l1).toUpperCase(), MARGIN + 14, rowY + 4, {
                    width: CONTENT_W / 2 - 24,
                });
            doc.font(FONT_BOLD).fontSize(10.5).fillColor('#000')
                .text(String(v1), MARGIN + 14, rowY + 14, {
                    width: CONTENT_W / 2 - 24, ellipsis: true,
                });

            doc.font(FONT_REGULAR).fontSize(7.5).fillColor(GRAY)
                .text(String(l2).toUpperCase(), MARGIN + CONTENT_W / 2 + 4, rowY + 4, {
                    width: CONTENT_W / 2 - 14,
                });
            doc.font(FONT_BOLD).fontSize(10.5).fillColor('#000')
                .text(String(v2), MARGIN + CONTENT_W / 2 + 4, rowY + 14, {
                    width: CONTENT_W / 2 - 14, ellipsis: true,
                });

            rowY += rowH;
        });

        y = rowY + 18;

        // ---- Remarks block ----
        if (record.remarks) {
            const remarksH = 74;
            doc.rect(MARGIN, y, CONTENT_W, remarksH).fillAndStroke('#f9f9f9', BORDER);
            doc.rect(MARGIN, y, 4, remarksH).fill(PRIMARY);
            doc.font(FONT_BOLD).fontSize(8.5).fillColor(PRIMARY)
                .text('TEACHER REMARKS', MARGIN + 15, y + 8);
            doc.font(FONT_ITALIC).fontSize(10).fillColor('#333')
                .text(record.remarks, MARGIN + 15, y + 24, {
                    width: CONTENT_W - 30,
                    height: remarksH - 30,
                    ellipsis: true,
                });
            y += remarksH + 16;
        }

        // ---- Performance band ----
        const bandY = Math.max(y, PAGE_H - 130);
        doc.rect(MARGIN, bandY, CONTENT_W, 26).fillAndStroke(LIGHT, BORDER);
        doc.font(FONT_BOLD).fontSize(9).fillColor(PRIMARY)
            .text('CBC PERFORMANCE BANDS', MARGIN + 10, bandY + 8);

        const bands = [
            { code: 'BE', range: '<40' },
            { code: 'AE', range: '40–49' },
            { code: 'ME', range: '50–64' },
            { code: 'EE', range: '65+' },
        ];
        const bandCellW = (CONTENT_W - 20) / bands.length;
        bands.forEach((b, i) => {
            const bx = MARGIN + 10 + i * bandCellW;
            doc.font(FONT_BOLD).fontSize(8.5).fillColor(gradeFg(b.code))
                .text(`${b.code} ${b.range}`, bx, bandY + 14, {
                    width: bandCellW, align: 'center',
                });
        });

        // ---- Footer ----
        const footerY = PAGE_H - 30;
        doc.moveTo(MARGIN, footerY)
            .lineTo(MARGIN + CONTENT_W, footerY)
            .lineWidth(0.5).strokeColor('#999').stroke();

        const year = new Date().getFullYear();
        doc.font(FONT_REGULAR).fontSize(7).fillColor('#666')
            .text(
                `Generated: ${new Date().toLocaleString('en-KE')}   |   ` +
                `© ${year} ${meta.schoolName || FALLBACK_NAME}   |   ` +
                `System designed and maintained by Edupriva`,
                MARGIN, footerY + 4,
                { width: CONTENT_W, align: 'center' }
            );

        doc.end();
    });
}

// ============================================================
// All records PDF (A4 landscape table)
// ============================================================
function generateAllRecordsPDF(records, meta, teacher, logoBuffer) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            layout: 'landscape',
            margin: 0,
            autoFirstPage: false,
            compress: true,
            info: {
                Title: `Teacher Assessment Report`,
                Author: meta.schoolName || FALLBACK_NAME,
                Creator: 'EduPriva',
            },
        });

        const chunks = [];
        let total = 0;
        let aborted = false;
        doc.on('data', (c) => {
            if (aborted) return;
            chunks.push(c);
            total += c.length;
            if (total > MAX_RESPONSE_BYTES) {
                aborted = true;
                doc.destroy(new Error(
                    `PDF exceeded ${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(1)} MB limit`
                ));
            }
        });
        doc.on('end', () => resolve(Buffer.concat(chunks, total)));
        doc.on('error', reject);

        doc.font(FONT_REGULAR);

        let logoImg = null;
        if (logoBuffer) {
            try { logoImg = doc.openImage(logoBuffer); }
            catch (e) { console.warn('openImage failed for logo:', e.message); }
        }

        const MARGIN = 30;
        const PAGE_W = doc.page.width;
        const PAGE_H = doc.page.height;
        const CONTENT_W = PAGE_W - MARGIN * 2;
        const RIGHT_EDGE = PAGE_W - MARGIN;

        // Column widths (total must be <= CONTENT_W)
        const colWidths = [26, 120, 70, 90, 48, 40, 38, 95, 72];
        const colSum = colWidths.reduce((a, b) => a + b, 0);
        const extra = CONTENT_W - colSum;
        if (extra > 0) colWidths[1] += extra; // widen student column
        const headers = ['#', 'Student', 'Adm No', 'Subject', 'Score', 'CBC', 'Pts', 'Assessment', 'Date'];
        const alignments = ['center', 'left', 'left', 'left', 'center', 'center', 'center', 'left', 'left'];

        const teacherName = teacher
            ? `${teacher.firstName || ''} ${teacher.lastName || ''}`.trim()
            : 'Teacher';

        const startPage = () => {
            doc.addPage({ layout: 'landscape' });
            let y = drawLetterheadHeader(doc, {
                x: MARGIN, y: MARGIN, w: CONTENT_W,
                meta, logoImg,
                logoSize: 46,
                padding: 10,
                nameSize: 13,
                mottoSize: 8,
                contactSize: 7,
            });

            doc.font(FONT_BOLD).fontSize(11).fillColor('#000')
                .text('TEACHER ASSESSMENT REPORT', MARGIN, y, {
                    width: CONTENT_W, align: 'center',
                });
            y += 14;
            doc.font(FONT_REGULAR).fontSize(8.5).fillColor('#333')
                .text(
                    `Teacher: ${teacherName}   |   ` +
                    `Records: ${records.length}   |   ` +
                    `${meta.term || ''} ${meta.year || new Date().getFullYear()}`.trim(),
                    MARGIN, y, { width: CONTENT_W, align: 'center' }
                );
            y += 14;

            return y;
        };

        const drawTableHeader = (topY) => {
            doc.rect(MARGIN, topY, CONTENT_W, 22).fill(PRIMARY);
            doc.font(FONT_BOLD).fontSize(8.5).fillColor('#fff');
            let cx = MARGIN + 4;
            headers.forEach((h, i) => {
                doc.text(h, cx, topY + 7, {
                    width: colWidths[i] - 8,
                    align: alignments[i],
                });
                cx += colWidths[i];
            });
            return topY + 22;
        };

        let y = startPage();
        y = drawTableHeader(y);

        const rowH = 17;
        const bottomCutoff = PAGE_H - 34;

        records.forEach((r, idx) => {
            if (y + rowH > bottomCutoff) {
                y = startPage();
                y = drawTableHeader(y);
            }

            if (idx % 2 === 1) {
                doc.rect(MARGIN, y, CONTENT_W, rowH).fill('#f7f9fc');
            }

            const grade = cbcGrade(
                r.score != null && !isNaN(r.score) ? Number(r.score) : null
            );
            const row = [
                String(idx + 1),
                r.studentName || 'Unknown',
                r.admissionNumber || '—',
                r.subject || '—',
                r.score != null ? `${r.score}%` : '—',
                grade.code,
                grade.points != null ? grade.points.toFixed(1) : '—',
                r.assessmentType || '—',
                r.recordedAtDisplay || fmtDate(r.recordedAt),
            ];

            let cx = MARGIN + 4;
            row.forEach((val, i) => {
                const isCbc = i === 5;
                doc.font(isCbc ? FONT_BOLD : FONT_REGULAR)
                    .fontSize(8)
                    .fillColor(isCbc ? gradeFg(grade.level) : '#000')
                    .text(String(val), cx, y + 5, {
                        width: colWidths[i] - 8,
                        align: alignments[i],
                        ellipsis: true,
                    });
                cx += colWidths[i];
            });

            y += rowH;
            doc.moveTo(MARGIN, y).lineTo(RIGHT_EDGE, y)
                .lineWidth(0.4).strokeColor('#e6e6e6').stroke();
        });

        // Summary footer row
        y += 6;
        if (y + 26 > bottomCutoff) {
            y = startPage();
            y = drawTableHeader(y);
            // re-draw summary directly under header if we broke page
            y += 6;
        }

        const scored = records.filter(
            (r) => r.score != null && !isNaN(r.score)
        );
        const avg = scored.length > 0
            ? Math.round(scored.reduce((s, r) => s + Number(r.score), 0) / scored.length)
            : null;
        const overall = cbcGrade(avg);

        doc.rect(MARGIN, y, CONTENT_W, 24).fillAndStroke(LIGHT, BORDER);
        doc.font(FONT_BOLD).fontSize(9).fillColor(PRIMARY)
            .text(
                `Records: ${records.length}   |   Assessed: ${scored.length}   |   ` +
                `Mean Score: ${avg != null ? avg + '%' : '—'}   |   ` +
                `Overall CBC Level: ${overall.code} — ${overall.label}`,
                MARGIN + 10, y + 8,
                { width: CONTENT_W - 20, align: 'center' }
            );

        // Footer on every page (only final page is drawn here; previous pages
        // get their own footer just before the page break)
        const footerY = PAGE_H - 22;
        doc.font(FONT_REGULAR).fontSize(7).fillColor('#666')
            .text(
                `Generated: ${new Date().toLocaleString('en-KE')}   •   ` +
                `${meta.schoolName || FALLBACK_NAME}   •   ` +
                `${meta.year || new Date().getFullYear()}`,
                MARGIN, footerY, { width: CONTENT_W, align: 'center' }
            );

        doc.end();
    });
}
