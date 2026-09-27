// netlify/functions/generate-ranking.js
//
// Generates a class ranking PDF (A4 landscape):
//   - Ranked table of every student in the class
//   - Per-subject score columns
//   - Total, Average, CBC Grade
//   - Class summary band (mean, highest, lowest, pass rate)
//
// Styling matches generate-student-report.js and generate-teacher-reports.js:
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
const MAX_STUDENTS_PER_REQUEST = 500;

// Per-student size estimate (bytes) for the early guard.
const EST_BYTES_PER_STUDENT = 4_500;
const ESTIMATE_HEADROOM = 0.7;

const PRIMARY = '#1a237e';
const PRIMARY_SOFT = '#3949ab';
const PRIMARY_LIGHT = '#eef2ff';
const GRAY = '#666';
const LIGHT = '#f5f7fb';
const BORDER = '#e0e6ed';
const DANGER = '#c62828';
const SUCCESS = '#1b5e20';

// Letterhead colours (shared with the other reports)
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
    if (event.httpMethod !== 'POST') {
        return json(405, { error: 'Method Not Allowed' });
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch {
        return json(400, { error: 'Invalid JSON body' });
    }

    const { students, meta } = payload;

    if (!Array.isArray(students) || students.length === 0) {
        return json(400, { error: 'students array is required and must not be empty' });
    }
    if (students.length > MAX_STUDENTS_PER_REQUEST) {
        return json(413, {
            error: `Too many students in one request (${students.length}). ` +
                   `Split into batches of ${MAX_STUDENTS_PER_REQUEST}.`,
        });
    }
    if (!meta || typeof meta !== 'object') {
        return json(400, { error: 'meta object is required' });
    }

    // Early size guard — reject before PDFKit starts streaming.
    const estBytes = students.length * EST_BYTES_PER_STUDENT;
    const safeBudget = MAX_RESPONSE_BYTES * ESTIMATE_HEADROOM;
    if (estBytes > safeBudget) {
        return json(413, {
            error:
                `Too many students for one request (${students.length}). ` +
                `Estimated ${(estBytes / 1_048_576).toFixed(1)} MB exceeds the ` +
                `${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(1)} MB response budget. ` +
                `Split into smaller batches.`,
        });
    }

    try {
        // Accept every plausible logo field name
        const logoUrl = meta.schoolLogo || meta.logoUrl || meta.logo || '';
        const logoBuffer = await fetchImageBuffer(logoUrl, 2 * 1024 * 1024);

        console.log('[RankingPDF] image fetch status', {
            hasLogoUrl: !!logoUrl,
            logoBytes: logoBuffer ? logoBuffer.length : 0,
        });

        const pdfBuffer = await generateRankingPDF(students, meta, logoBuffer);

        if (pdfBuffer.length > MAX_RESPONSE_BYTES) {
            return json(413, {
                error:
                    `Generated PDF is ${(pdfBuffer.length / 1_048_576).toFixed(1)} MB, ` +
                    `exceeding the ${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(1)} MB limit. ` +
                    `Generate a smaller class or split into batches.`,
            });
        }

        const filename = buildFilename({ meta });

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
        console.error('Ranking PDF generation error:', err);
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

function buildFilename({ meta }) {
    const safe = (s) => String(s || '').replace(/\s+/g, '_').replace(/[^\w-]/g, '');
    const date = new Date().toISOString().slice(0, 10);
    return `ranking_${safe(meta.cls)}_${safe(meta.term)}_${safe(meta.year || new Date().getFullYear())}_${date}.pdf`;
}

// ============================================================
// Grading — CBC levels (shared with the other reports)
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

/**
 * Compose a letterhead-style header and return the y below the rule.
 * Identical geometry to the student / teacher reports so all documents match.
 */
function drawLetterheadHeader(doc, {
    x, y, w,
    meta, logoImg,
    logoSize = 50,
    padding = 10,
    nameSize = 14,
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
// Main PDF builder
// ============================================================
function generateRankingPDF(students, meta, logoBuffer) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            layout: 'landscape',
            margin: 0,
            autoFirstPage: false,
            compress: true,
            info: {
                Title: `Ranking Report — ${meta.cls || ''} ${meta.term || ''}`.trim(),
                Author: meta.schoolName || FALLBACK_NAME,
                Subject: `${meta.term || ''} ${meta.year || ''}`.trim(),
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

        const MARGIN = 30;
        const PAGE_W = doc.page.width;   // 841.89 landscape
        const PAGE_H = doc.page.height;  // 595.28 landscape
        const CONTENT_W = PAGE_W - MARGIN * 2;

        // ---- Build columns ----
        const allSubjects = Array.isArray(meta.subjects) ? meta.subjects : [];

        const rankW = 34;
        const nameW = 130;
        const admW = 70;
        const totalW = 46;
        const avgW = 46;
        const gradeW = 44;

        const fixedW = rankW + nameW + admW + totalW + avgW + gradeW;
        const subjectW = Math.max(44, Math.min(70, Math.floor(
            (CONTENT_W - fixedW) / Math.max(1, allSubjects.length)
        )));

        const cols = [
            { key: 'rank',  w: rankW,  h: 'Rank',  align: 'center' },
            { key: 'name',  w: nameW,  h: 'Name',  align: 'left'   },
            { key: 'adm',   w: admW,   h: 'Adm No', align: 'center' },
            ...allSubjects.map((s) => ({
                key: `sub:${s}`,
                w: subjectW,
                h: String(s).length > 9 ? String(s).slice(0, 8) + '…' : String(s),
                align: 'center',
            })),
            { key: 'total', w: totalW, h: 'Total', align: 'center' },
            { key: 'avg',   w: avgW,   h: 'Avg',   align: 'center' },
            { key: 'grade', w: gradeW, h: 'Grade', align: 'center' },
        ];

        const totalColsWidth = cols.reduce((a, c) => a + c.w, 0);
        const startX = (PAGE_W - totalColsWidth) / 2;

        // ---- Pre-compute ranks ----
        // Rank by average descending; fall back to totalMarks if average missing.
        // Ties share the same rank (standard competition ranking).
        const ranked = students.map((s) => {
            const totalMarks = Number(s.totalMarks) || 0;
            const avg = s.average != null && !isNaN(s.average)
                ? Number(s.average)
                : (allSubjects.length > 0 ? totalMarks / allSubjects.length : 0);
            return { student: s, totalMarks, avg };
        });

        ranked.sort((a, b) => {
            if (b.avg !== a.avg) return b.avg - a.avg;
            return b.totalMarks - a.totalMarks;
        });

        let currentRank = 0;
        let prevAvg = null;
        ranked.forEach((r, i) => {
            if (prevAvg === null || r.avg !== prevAvg) {
                currentRank = i + 1;
                prevAvg = r.avg;
            }
            r.rank = currentRank;
        });

        // ---- Page header + table header helpers ----
        const drawPageHeader = () => {
            let y = drawLetterheadHeader(doc, {
                x: MARGIN, y: MARGIN, w: CONTENT_W,
                meta, logoImg,
                logoSize: 48,
                padding: 10,
                nameSize: 14,
                mottoSize: 8.5,
                contactSize: 7.5,
            });

            // Sub-header line
            doc.font(FONT_BOLD).fontSize(11).fillColor('#000')
                .text('CLASS RANKING REPORT', MARGIN, y, {
                    width: CONTENT_W, align: 'center',
                });
            y += 14;

            const subBits = [
                meta.level,
                meta.cls ? `Class: ${meta.cls}` : '',
                meta.term,
                meta.assessmentType,
                meta.year,
            ].filter(Boolean).join('   |   ');

            doc.font(FONT_REGULAR).fontSize(9).fillColor('#333')
                .text(subBits, MARGIN, y, {
                    width: CONTENT_W, align: 'center',
                });
            y += 14;

            return y;
        };

        const drawTableHeader = (topY) => {
            doc.rect(startX, topY, totalColsWidth, 22).fill(PRIMARY);
            doc.font(FONT_BOLD).fontSize(8.5).fillColor('#fff');
            let cx = startX + 4;
            cols.forEach((c) => {
                doc.text(c.h, cx, topY + 7, {
                    width: c.w - 8,
                    align: c.align,
                    ellipsis: true,
                });
                cx += c.w;
            });
            return topY + 22;
        };

        // ---- Page 1 ----
        doc.addPage({ layout: 'landscape' });
        let y = drawPageHeader();
        y = drawTableHeader(y);

        // ---- Rows ----
        const rowH = 17;
        const bottomCutoff = PAGE_H - 40;

        ranked.forEach((r, idx) => {
            if (y + rowH > bottomCutoff) {
                doc.addPage({ layout: 'landscape' });
                y = drawPageHeader();
                y = drawTableHeader(y);
            }

            const s = r.student;
            const grade = s.cbcGrade?.code
                ? { code: s.cbcGrade.code, level: s.cbcGrade.level || s.cbcGrade.code }
                : cbcGrade(r.avg);

            // Zebra stripe
            if (idx % 2 === 1) {
                doc.rect(startX, y, totalColsWidth, rowH).fill(LIGHT);
            }

            // Build cell values in column order
            const cells = [
                { t: String(r.rank), align: 'center', bold: true, color: PRIMARY },
                { t: `${s.firstName || ''} ${s.lastName || ''}`.trim() || '—', align: 'left', bold: true },
                { t: s.admissionNumber || s.studentId || '—', align: 'center' },
                ...allSubjects.map((sub) => {
                    const sc = (s.subjectScores || {})[sub];
                    return {
                        t: sc != null && !isNaN(sc) ? String(sc) : '—',
                        align: 'center',
                    };
                }),
                { t: String(r.totalMarks || 0), align: 'center' },
                { t: `${Math.round(r.avg)}%`, align: 'center', bold: true },
                {
                    t: grade.code === 'NA' ? '—' : grade.code,
                    align: 'center',
                    bold: true,
                    color: gradeFg(grade.level),
                },
            ];

            let rx = startX + 4;
            cells.forEach((c, i) => {
                const col = cols[i];
                doc.font(c.bold ? FONT_BOLD : FONT_REGULAR)
                    .fontSize(8)
                    .fillColor(c.color || '#000')
                    .text(String(c.t), rx, y + (rowH - 9) / 2, {
                        width: col.w - 8,
                        align: c.align,
                        ellipsis: true,
                    });
                rx += col.w;
            });

            // Row divider
            y += rowH;
            doc.moveTo(startX, y)
                .lineTo(startX + totalColsWidth, y)
                .lineWidth(0.4).strokeColor('#e6e6e6').stroke();
        });

        // ---- Outer border around the table ----
        // (drawn last so it sits on top of striping)
        const tableTopY = y - (ranked.length * rowH) - 22;
        doc.rect(startX, tableTopY, totalColsWidth, ranked.length * rowH + 22)
            .lineWidth(0.8).strokeColor(PRIMARY).stroke();

        // ---- Summary footer band ----
        y += 10;
        if (y + 40 > PAGE_H - 30) {
            doc.addPage({ layout: 'landscape' });
            y = MARGIN + 10;
        }

        const scored = ranked.filter((r) => r.avg > 0);
        const classMean = scored.length > 0
            ? Math.round(scored.reduce((a, r) => a + r.avg, 0) / scored.length)
            : 0;
        const highest = scored.length > 0 ? Math.max(...scored.map((r) => r.avg)) : 0;
        const lowest = scored.length > 0 ? Math.min(...scored.map((r) => r.avg)) : 0;
        const passCount = scored.filter((r) => r.avg >= 50).length;
        const passRate = scored.length > 0
            ? Math.round((passCount / scored.length) * 100)
            : 0;
        const overall = cbcGrade(scored.length > 0 ? classMean : null);

        doc.rect(MARGIN, y, CONTENT_W, 34).fillAndStroke(LIGHT, BORDER);

        doc.font(FONT_BOLD).fontSize(9).fillColor(PRIMARY)
            .text(
                `Students: ${students.length}   |   ` +
                `Assessed: ${scored.length}   |   ` +
                `Class Mean: ${classMean}% (${overall.code})   |   ` +
                `Highest: ${highest}%   |   ` +
                `Lowest: ${lowest}%   |   ` +
                `Pass Rate: ${passRate}%`,
                MARGIN + 10, y + 12,
                { width: CONTENT_W - 20, align: 'center' }
            );

        y += 44;

        // ---- Footer ----
        const footerY = PAGE_H - 22;
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
