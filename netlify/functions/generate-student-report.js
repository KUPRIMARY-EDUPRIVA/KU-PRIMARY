const { withCors } = require('./_lib/cors');
// netlify/functions/generate-student-report.js
//
// Generates student PDFs in two modes:
//   docType = 'transcript'   → 4 landscape cards per A4 landscape page
//   docType = 'report-form'  → 1 full report card per A4 portrait page
//
// Features:
//   - Letterhead-style header (logo left, school name / motto / contact stack)
//     with a coloured underline rule, matching the printed school letterhead
//   - Dynamic table columns based on assessments recorded (1-3 columns)
//   - Bar chart reflects actual per-assessment averages
//   - School logo, stamp, and principal signature embedded when available
//   - Full printable-space utilisation on the report form
//   - Times New Roman typography throughout (PDFKit standard-14 Times family)
//
// Size strategy:
//   - Images (logo / stamp / signature) are fetched ONCE per request and
//     opened as reusable PDF XObjects via doc.openImage(). Every page then
//     references the same XObject instead of re-embedding the bytes, which
//     cuts multi-page PDF size by roughly 5–10×.
//   - An early estimate rejects oversized batches with a 413 BEFORE PDFKit
//     starts streaming, so callers get a clear "split into smaller batches"
//     message instead of an opaque mid-stream 500.

const PDFDocument = require('pdfkit');
const axios = require('axios');

const FALLBACK_NAME = 'EDUPRIVA';
const FALLBACK_MOTTO = 'Powering Modern Education';

const MAX_RESPONSE_BYTES = 5_500_000;
const MAX_STUDENTS_PER_REQUEST = 300;
const MAX_ASSESSMENTS = 3;

// Per-student size estimate (bytes) used for the early guard.
// Values are conservative — the client batches well below these ceilings.
const EST_BYTES_PER_STUDENT = {
    'transcript': 60_000,   // ~40 KB/card × 4 cards/sheet
    'report-form': 150_000, // ~1 portrait page with tables + chart
};
const ESTIMATE_HEADROOM = 0.7; // budget only 70% of MAX_RESPONSE_BYTES

const PRIMARY = '#1a237e';
const PRIMARY_SOFT = '#3949ab';
const PRIMARY_LIGHT = '#eef2ff';
const GRAY = '#666';
const LIGHT = '#f5f7fb';
const BORDER = '#e0e6ed';
const DANGER = '#c62828';
const SUCCESS = '#1b5e20';

// Letterhead-style header colours (mirrors the HTML letterhead styling)
const HEADER_BLUE = '#1a4e8a';        // school name + underline rule
const HEADER_RULE_WIDTH = 1.4;         // pt — 2px equivalent on A4
const HEADER_MOTTO_GRAY = '#666';
const HEADER_CONTACT_GRAY = '#333';

// Times New Roman family — PDFKit's standard-14 names.
// NOTE: PDFKit does NOT accept "Times New Roman" as a font name. The
// standard-14 Times family is registered as Times-Roman / Times-Bold /
// Times-Italic / Times-BoldItalic. These map to Adobe's Times core fonts,
// which every PDF reader renders as Times New Roman.
const FONT_REGULAR = 'Times-Roman';
const FONT_BOLD = 'Times-Bold';
const FONT_ITALIC = 'Times-Italic';
const FONT_BOLD_ITALIC = 'Times-BoldItalic';

// Stamp and signature footprints (PDF points)
const STAMP_SIZE = 62;
const SIGNATURE_W = 113;
const SIGNATURE_H = 40;

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

    const {
        mode = 'class',
        docType = 'report-form',
        students,
        meta,
        subjects,
        term,
        assessmentIndex = 0,
    } = payload;

    if (!Array.isArray(students) || students.length === 0) {
        return json(400, { error: 'students array is required' });
    }
    if (students.length > MAX_STUDENTS_PER_REQUEST) {
        return json(413, {
            error: `Too many students in one request (${students.length}). ` +
                   `Split into batches of ${MAX_STUDENTS_PER_REQUEST}.`,
        });
    }
    if (!['transcript', 'report-form'].includes(docType)) {
        return json(400, { error: "docType must be 'transcript' or 'report-form'" });
    }
    if (!Array.isArray(subjects) || subjects.length === 0) {
        return json(400, { error: 'subjects array is required' });
    }
    if (docType === 'transcript' && (assessmentIndex < 0 || assessmentIndex > 2)) {
        return json(400, { error: 'assessmentIndex must be 0, 1, or 2' });
    }

    // Early size guard — reject before any PDF work so the client can chunk.
    // Base64 in the response inflates by ~33%, so we budget only 70% of the
    // raw PDF ceiling here.
    const estBytes = students.length * (EST_BYTES_PER_STUDENT[docType] || 150_000);
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
        // --- LOGO FIX ---
        // Pull from ALL plausible field names the school doc might use.
        // SchoolProfile writes `logoUrl`, but AuthContext may forward it
        // as `schoolLogo`. We accept both, plus `logo`, as a safety net.
        const logoUrl = meta?.schoolLogo || meta?.logoUrl || meta?.logo || '';
        const stampUrl = meta?.schoolStamp || meta?.stampUrl || '';
        const signatureUrl = meta?.principalSignature || meta?.principalSignatureUrl || '';

        const [logoBuffer, stampBuffer, signatureBuffer] = await Promise.all([
            fetchImageBuffer(logoUrl, 2 * 1024 * 1024),   // 2 MB cap for logo
            fetchImageBuffer(stampUrl, 512 * 1024),
            fetchImageBuffer(signatureUrl, 512 * 1024),
        ]);

        // Debug logging — visible in Netlify function logs
        console.log('[PDF] image fetch status', {
            hasLogoUrl: !!logoUrl,
            logoBytes: logoBuffer ? logoBuffer.length : 0,
            hasStampUrl: !!stampUrl,
            stampBytes: stampBuffer ? stampBuffer.length : 0,
            hasSignatureUrl: !!signatureUrl,
            signatureBytes: signatureBuffer ? signatureBuffer.length : 0,
        });

        const pdfBuffer = await buildPDF({
            docType,
            assessmentIndex,
            students,
            meta: meta || {},
            subjects,
            term: term || '',
            logoBuffer,
            stampBuffer,
            signatureBuffer,
        });

        if (pdfBuffer.length > MAX_RESPONSE_BYTES) {
            return json(413, {
                error:
                    `Generated PDF is ${(pdfBuffer.length / 1_048_576).toFixed(1)} MB, ` +
                    `exceeding the ${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(1)} MB limit. ` +
                    `Generate per student or a smaller class.`,
            });
        }

        const filename = buildFilename({ docType, students, meta, term, assessmentIndex });

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
        console.error('Student report PDF error:', err);
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

function buildFilename({ docType, students, meta, term, assessmentIndex }) {
    const safe = (s) => String(s || '').replace(/[^\w-]/g, '');
    const date = new Date().toISOString().slice(0, 10);
    if (docType === 'transcript') {
        return `transcripts_${safe(meta.cls)}_${safe(term)}_A${assessmentIndex + 1}_${date}.pdf`;
    }
    if (students.length === 1) {
        const s = students[0];
        return `report_${safe(s.admissionNumber || s.studentId || 'student')}_${date}.pdf`;
    }
    return `class_reports_${safe(meta.cls)}_${safe(term)}_${date}.pdf`;
}

// ============================================================
// Grading — CBC levels
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

function subjectRemark(avg, cbc) {
    if (avg == null) return 'Not assessed';
    if (cbc.level === 'EE') return 'Exceeding Expectations';
    if (cbc.level === 'ME') return 'Meeting Expectations';
    if (cbc.level === 'AE') return 'Approaching Expectations';
    if (cbc.level === 'BE') return 'Below Expectations';
    return '—';
}

function buildTeacherComment(report) {
    const { meanScore, assessedCount, totalSubjects, subjectRows } = report;
    if (assessedCount === 0) {
        return 'No assessments recorded for this student this term.';
    }
    const overall = cbcGrade(meanScore);
    const assessed = subjectRows.filter((r) => r.average != null);
    const sorted = [...assessed].sort((a, b) => b.average - a.average);
    const best = sorted[0];
    const weakest = sorted[sorted.length - 1];

    const strength = best && best.average >= 65
        ? ` Strongest in ${best.subject} (${best.average}%).` : '';
    const improvement = weakest && weakest.average < 50 && weakest.subject !== best?.subject
        ? ` Support needed in ${weakest.subject} (${weakest.average}%).` : '';
    const coverageRatio = totalSubjects > 0 ? assessedCount / totalSubjects : 0;
    const caveat = coverageRatio < 0.7
        ? ` Covers ${assessedCount}/${totalSubjects} learning areas.` : '';

    switch (overall.level) {
        case 'EE': return `Exceeding expectations.${strength}${improvement}${caveat}`;
        case 'ME': return `Meeting expectations across most areas.${strength}${improvement}${caveat}`;
        case 'AE': return `Approaching expectations. Practice will raise achievement.${strength}${improvement}${caveat}`;
        case 'BE': return `Below expectations. Targeted intervention required.${strength}${improvement}${caveat}`;
        default: return `Report covers ${assessedCount}/${totalSubjects} learning areas.${caveat}`;
    }
}

/**
 * Determine the number of assessments actually recorded for a student.
 * Returns 1, 2, or 3 based on how many non-null scores exist across all subjects.
 */
function detectAssessmentCount(students) {
    let max = 0;
    for (const student of students) {
        const scores = student.scores || {};
        for (const subject of Object.keys(scores)) {
            const list = scores[subject] || [];
            const nonNull = list.filter((v) => v != null && v !== '' && !isNaN(v));
            if (nonNull.length > max) max = nonNull.length;
        }
    }
    return Math.min(Math.max(max, 1), MAX_ASSESSMENTS);
}

/**
 * Compute per-assessment overall averages across all subjects.
 * Example: assessmentAvgs[0] = average of A1 scores across all subjects.
 * Returns an array of length assessmentCount, each element a rounded number or null.
 */
function computeAssessmentAverages(student, subjects, assessmentCount) {
    const result = [];
    for (let i = 0; i < assessmentCount; i++) {
        let sum = 0;
        let count = 0;
        for (const subject of subjects) {
            const scores = (student.scores && student.scores[subject]) || [];
            const raw = scores[i];
            if (raw != null && raw !== '' && !isNaN(raw)) {
                sum += Number(raw);
                count++;
            }
        }
        result.push(count > 0 ? Math.round(sum / count) : null);
    }
    return result;
}

function computeReport(student, subjects, assessmentIndex) {
    const subjectRows = subjects.map((subject) => {
        const scores = (student.scores && student.scores[subject]) || [];
        const ass1 = scores[0] ?? null;
        const ass2 = scores[1] ?? null;
        const ass3 = scores[2] ?? null;

        let average;
        if (assessmentIndex != null) {
            const raw = scores[assessmentIndex];
            average = raw != null && !isNaN(raw) ? Math.round(Number(raw)) : null;
        } else {
            const provided = student.averages && student.averages[subject];
            if (provided != null && !isNaN(provided)) {
                average = Math.round(provided);
            } else if (scores.length > 0) {
                const valid = scores.filter((v) => v != null && !isNaN(v));
                average = valid.length > 0
                    ? Math.round(valid.reduce((a, b) => a + Number(b), 0) / valid.length)
                    : null;
            } else {
                average = null;
            }
        }

        const cbc = cbcGrade(average);
        return {
            subject,
            ass1, ass2, ass3,
            average,
            cbc,
            remark: subjectRemark(average, cbc),
        };
    });

    const assessed = subjectRows.filter((r) => r.average != null);
    const assessedCount = assessed.length;
    const totalSubjects = subjectRows.length;
    const meanScore = assessedCount > 0
        ? Math.round(assessed.reduce((s, r) => s + r.average, 0) / assessedCount)
        : 0;
    const totalMarks = assessedCount * 100;
    const totalScore = assessed.reduce((s, r) => s + (r.average || 0), 0);
    const totalPoints = assessed.reduce((s, r) => s + (r.cbc.points || 0), 0);
    const avgPoints = assessedCount > 0 ? (totalPoints / assessedCount).toFixed(1) : null;
    const overall = cbcGrade(assessedCount > 0 ? meanScore : null);

    const report = {
        student, subjectRows, assessedCount, totalSubjects,
        meanScore, totalMarks, totalScore, totalPoints, avgPoints, overall, 
    };
    report.teacherComment = buildTeacherComment(report);
    return report;
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
function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.substring(0, 2), 16),
        parseInt(h.substring(2, 4), 16),
        parseInt(h.substring(4, 6), 16),
    ];
}

function interpolateHex(a, b, t) {
    const [r1, g1, b1] = hexToRgb(a);
    const [r2, g2, b2] = hexToRgb(b);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const bl = Math.round(b1 + (b2 - b1) * t);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

function gradientBand(doc, x, y, w, h, from, to) {
    const stops = [
        interpolateHex(from, to, 0),
        interpolateHex(from, to, 0.5),
        interpolateHex(from, to, 1),
    ];
    const bandW = w / 3;
    stops.forEach((color, i) => {
        doc.rect(x + i * bandW, y, bandW + 0.5, h).fill(color);
    });
}

/**
 * Open the incoming image Buffers as reusable PDF XObjects.
 * Called once per PDFDocument; every subsequent doc.image(openImg, ...)
 * only writes a transform matrix, not the image bytes again.
 */
function openImages(doc, { logoBuffer, stampBuffer, signatureBuffer }) {
    const safeOpen = (buf, label) => {
        if (!buf) return null;
        try {
            return doc.openImage(buf);
        } catch (e) {
            console.warn(`openImage failed for ${label}:`, e.message);
            return null;
        }
    };
    return {
        logoImg: safeOpen(logoBuffer, 'logo'),
        stampImg: safeOpen(stampBuffer, 'stamp'),
        signatureImg: safeOpen(signatureBuffer, 'signature'),
    };
}

// drawImage / drawRotatedImage now take an *opened* image (from openImages),
// not a raw Buffer. This is what makes the multi-page PDF small.
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

function drawRotatedImage(doc, img, cx, cy, w, h, angleDeg) {
    if (!img) return false;
    try {
        doc.save();
        doc.translate(cx, cy);
        doc.rotate(angleDeg);
        doc.image(img, -w / 2, -h / 2, { fit: [w, h] });
        doc.restore();
        return true;
    } catch (e) {
        console.warn('Rotated image embed failed:', e.message);
        try { doc.restore(); } catch { /* noop */ }
        return false;
    }
}

/**
 * Compose a letterhead-style header inside the given box and return the y
 * coordinate immediately below it (after the coloured underline rule).
 *
 * Layout (mirrors the printed letterhead):
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ [LOGO]   SCHOOL NAME (bold, blue, large)                     │
 *   │          Motto: … (italic, gray)                             │
 *   │          P.O BOX …                                           │
 *   │          Tel: …                                              │
 *   │          Email: …                                            │
 *   │          Website: …                                          │
 *   ├──────────────────────────────────────────────────────────────┤  ← blue rule
 *
 * Options tune sizes for portrait report vs. landscape transcript card.
 */
function drawLetterheadHeader(doc, {
    x, y, w,
    meta, logoImg,
    logoSize = 58,
    padding = 6,
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

    // School name (dominant, blue)
    doc.font(FONT_BOLD).fontSize(nameSize).fillColor(HEADER_BLUE)
        .text((meta.schoolName || FALLBACK_NAME).toUpperCase(), textX, y + 1, {
            width: textW, align: 'left', ellipsis: true,
        });
    let cy = y + nameSize + 3;

    // Motto (italic, gray)
    const motto = meta.schoolMotto || FALLBACK_MOTTO;
    doc.font(FONT_ITALIC).fontSize(mottoSize).fillColor(HEADER_MOTTO_GRAY)
        .text(`Motto: ${motto}`, textX, cy, {
            width: textW, align: 'left', ellipsis: true,
        });
    cy += mottoSize + lineGap;

    // Contact stack — one item per line, left aligned
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

    // Coloured rule under the header block, matching the letterhead
    const blockBottom = Math.max(cy, logoY + logoSize) + ruleGap;
    doc.moveTo(x, blockBottom).lineTo(x + w, blockBottom)
        .lineWidth(HEADER_RULE_WIDTH).strokeColor(HEADER_BLUE).stroke();

    return blockBottom + 4;
}

function contactLine(meta) {
    // Kept for backwards compatibility with transcript mini-cards that still
    // want a single-line contact string.
    return [
        meta.schoolAddress,
        meta.schoolPhone ? `Tel: ${meta.schoolPhone}` : '',
        meta.schoolEmail,
        meta.website,
    ].filter(Boolean).join('  •  ');
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

// ============================================================
// Transcript card
// ============================================================
function drawTranscriptCard(doc, {
    student, meta, subjects, term, assessmentIndex,
    logoImg, stampImg, signatureImg,
    x, y, w, h,
}) {
    const report = computeReport(student, subjects, assessmentIndex);

    doc.rect(x, y, w, h).lineWidth(0.8).strokeColor(PRIMARY).stroke();

    // Letterhead-styled header inside the card.
    // The card is smaller than A4, so the logo + text sizes are scaled down
    // proportionally and the contact stack is condensed to a single line to
    // fit the narrower space.
    const logoSize = 30;
    const padding = 8;
    const textX = x + 6 + logoSize + padding;
    const textW = w - 12 - logoSize - padding;

    drawImage(doc, logoImg, x + 6, y + 5, logoSize, logoSize);
    if (!logoImg) {
        doc.rect(x + 6, y + 5, logoSize, logoSize)
            .lineWidth(0.5).strokeColor(BORDER).stroke();
        doc.font(FONT_REGULAR).fontSize(4.5).fillColor('#bbb')
            .text('LOGO', x + 6, y + 5 + logoSize / 2 - 3, {
                width: logoSize, align: 'center',
            });
    }

    doc.font(FONT_BOLD).fontSize(9.5).fillColor(HEADER_BLUE)
        .text((meta.schoolName || FALLBACK_NAME).toUpperCase(), textX, y + 5, {
            width: textW, align: 'left', ellipsis: true,
        });
    doc.font(FONT_ITALIC).fontSize(6).fillColor(HEADER_MOTTO_GRAY)
        .text(`Motto: ${meta.schoolMotto || FALLBACK_MOTTO}`, textX, y + 16, {
            width: textW, align: 'left', ellipsis: true,
        });

    const contact = contactLine(meta);
    if (contact) {
        doc.font(FONT_REGULAR).fontSize(5.3).fillColor(HEADER_CONTACT_GRAY)
            .text(contact, textX, y + 25, {
                width: textW, align: 'left', ellipsis: true, lineBreak: false,
            });
    }

    // Coloured rule under the card header
    const headerRuleY = y + 5 + logoSize + 2;
    doc.moveTo(x + 6, headerRuleY).lineTo(x + w - 6, headerRuleY)
        .lineWidth(1).strokeColor(HEADER_BLUE).stroke();

    // Student info — starts right below the rule
    let cy = headerRuleY + 5;
    const name = `${student.firstName || ''} ${student.lastName || ''}`.trim() || '—';
    doc.font(FONT_BOLD).fontSize(8).fillColor('#111')
        .text(name, x + 6, cy, { width: w - 12, ellipsis: true });

    doc.font(FONT_REGULAR).fontSize(6).fillColor(GRAY)
        .text(
            `Adm: ${student.admissionNumber || student.studentId || '—'}   |   Class: ${student.class || meta.cls || '—'}`,
            x + 6, cy, { width: w - 12, ellipsis: true, align: 'right' }
        );
    cy += 11;

    doc.font(FONT_ITALIC).fontSize(5.8).fillColor('#555')
        .text(
            `Assessment ${assessmentIndex + 1} • ${term || ''} • ${meta.year || new Date().getFullYear()}`,
            x + 6, cy, { width: w - 12, ellipsis: true }
        );
    cy += 11;

    // Subjects table (single assessment)
    const tableX = x + 6;
    const tableW = w - 12;
    const colW = [tableW * 0.46, tableW * 0.13, tableW * 0.14, tableW * 0.13, tableW * 0.14];
    const headers = ['Learning Area', 'Score', 'Level', 'Pts', 'Remark'];

    const headerRowH = 11;
    doc.rect(tableX, cy, tableW, headerRowH).fill(PRIMARY_LIGHT);
    doc.font(FONT_BOLD).fontSize(6).fillColor(PRIMARY);
    let hx = tableX + 2;
    headers.forEach((h, i) => {
        const align = i === 0 || i === 4 ? 'left' : 'center';
        doc.text(h, hx, cy + 3, { width: colW[i] - 4, align, ellipsis: true });
        hx += colW[i];
    });
    cy += headerRowH;

    const rowH = 10;
    const maxRows = Math.floor((y + h - 22 - cy) / rowH);
    const rows = report.subjectRows.slice(0, maxRows);

    rows.forEach((r, idx) => {
        if (idx % 2 === 1) doc.rect(tableX, cy, tableW, rowH).fill('#fafbfe');
        let rx = tableX + 2;
        const cells = [
            { t: r.subject, align: 'left', bold: true, size: 6.3 },
            { t: r.average != null ? String(r.average) : '—', align: 'center', size: 6.3 },
            { t: r.cbc.code, align: 'center', size: 6.3, fg: gradeFg(r.cbc.level), bg: gradeBg(r.cbc.level) },
            { t: r.cbc.points != null ? r.cbc.points.toFixed(1) : '—', align: 'center', size: 6.3, bold: true },
            { t: r.remark, align: 'left', size: 5.3, color: '#555' },
        ];
        cells.forEach((c, i) => {
            if (c.bg) doc.rect(rx, cy + 1, colW[i] - 4, rowH - 2).fill(c.bg);
            doc.font(c.bold ? FONT_BOLD : FONT_REGULAR).fontSize(c.size)
                .fillColor(c.fg || c.color || '#000')
                .text(c.t, rx, cy + 2, { width: colW[i] - 4, align: c.align, ellipsis: true });
            rx += colW[i];
        });
        cy += rowH;
    });

    // Summary bar
    const summaryY = y + h - 22;
    doc.rect(x + 6, summaryY, w - 12, 16).fillAndStroke('#f5f7fb', BORDER);
    const summaryCellW = (w - 12) / 3;
    const summaryItems = [
        { lbl: 'MEAN', val: report.assessedCount > 0 ? `${report.meanScore}%` : '—', color: PRIMARY },
        {
            lbl: 'OVERALL',
            val: report.assessedCount > 0 ? report.overall.code : '—',
            color: report.overall.level === 'EE' ? SUCCESS
                : report.overall.level === 'BE' ? DANGER : PRIMARY,
        },
        { lbl: 'COVERED', val: `${report.assessedCount}/${report.totalSubjects}`, color: PRIMARY },
    ];
    summaryItems.forEach((item, i) => {
        const sx = x + 6 + summaryCellW * i;
        doc.font(FONT_REGULAR).fontSize(5).fillColor(GRAY)
            .text(item.lbl, sx + 4, summaryY + 2, { width: summaryCellW - 8 });
        doc.font(FONT_BOLD).fontSize(8).fillColor(item.color)
            .text(item.val, sx + 4, summaryY + 7, { width: summaryCellW - 8 });
    });

    if (stampImg) {
        drawRotatedImage(
            doc, stampImg,
            x + w - 34, y + h - 40,
            STAMP_SIZE * 0.5, STAMP_SIZE * 0.5,
            45
        );
    }
    if (signatureImg) {
        drawImage(doc, signatureImg, x + 8, y + h - 22, 60, 16);
    }

    // Cut guides
    const cornerLen = 6;
    doc.lineWidth(0.4).strokeColor('#bbb');
    doc.moveTo(x, y + cornerLen).lineTo(x, y).lineTo(x + cornerLen, y).stroke();
    doc.moveTo(x + w - cornerLen, y).lineTo(x + w, y).lineTo(x + w, y + cornerLen).stroke();
    doc.moveTo(x, y + h - cornerLen).lineTo(x, y).lineTo(x + cornerLen, y + h).stroke();
    doc.moveTo(x + w - cornerLen, y + h).lineTo(x + w, y + h).lineTo(x + w, y + h - cornerLen).stroke();
}

// ============================================================
// Report form — full page per student
// ============================================================
function drawReportForm(doc, {
    student, meta, subjects, term,
    logoImg, stampImg, signatureImg,
    assessmentCount = MAX_ASSESSMENTS,
}) {
    const MARGIN = 28;
    const PAGE_W = doc.page.width;
    const PAGE_H = doc.page.height;
    const CONTENT_W = PAGE_W - MARGIN * 2;

    const report = computeReport(student, subjects, null);
    const assessmentAverages = computeAssessmentAverages(student, subjects, assessmentCount);

    // ---- Letterhead-style header ----
    const headerBottom = drawLetterheadHeader(doc, {
        x: MARGIN,
        y: MARGIN,
        w: CONTENT_W,
        meta,
        logoImg,
        logoSize: 58,
        padding: 10,
        nameSize: 15,
        mottoSize: 8.5,
        contactSize: 7.5,
        lineGap: 2.5,
        ruleGap: 6,
    });

    let y = headerBottom + 2;

    // Term title
    doc.font(FONT_BOLD).fontSize(11.5).fillColor('#000')
        .text(`${(term || 'TERM').toUpperCase()} - ${meta.year || new Date().getFullYear()}`,
            MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += 13;
    doc.font(FONT_BOLD).fontSize(8).fillColor('#000')
        .text('MID TERM', MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += 12;

    // Student line
    const fullName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || '—';
    const admissionNo = student.admissionNumber || student.studentId || '—';
    const grade = student.class || meta.cls || '—';

    doc.font(FONT_BOLD).fontSize(9.5).fillColor('#000')
        .text(`Student: ${fullName}  |  Adm No: ${admissionNo}  |  Grade: ${grade}`,
            MARGIN, y, { width: CONTENT_W, align: 'center' });
    y += 12;

    // Marks line
 const marksText =
    `Marks: ${report.totalScore}/${report.totalMarks}  |  ` +
    `Avg: ${report.assessedCount > 0 ? report.meanScore.toFixed(2) : '0.00'}/100  |  ` +
    `Overall Pos.: ${student.position || '—'}/${student.classSize || '—'}  |  ` +
    `Grade: ${report.overall.code === 'NA' ? '—' : report.overall.code}`;

doc.font(FONT_BOLD)
    .fontSize(8.5)
    .fillColor('#000')
    .text(marksText, MARGIN, y, {
        width: CONTENT_W,
        align: 'center'
    });

y += 12;

    // ---- Dynamic marks table ----
    const tableTop = y;
    const colSubject = Math.floor(CONTENT_W * 0.28);
    const colRemark = Math.floor(CONTENT_W * 0.18);
    const colAvg = 38;
    const colPl = 40;
    const colPoints = 45;
    const remainingW = CONTENT_W - colSubject - colRemark - colAvg - colPl - colPoints;
    const colAss = Math.floor(remainingW / assessmentCount);
    const widthDiff = CONTENT_W - (colSubject + colAss * assessmentCount + colAvg + colPl + colPoints + colRemark);

    const columns = [
        { key: 'subject', w: colSubject, label: 'Learning Area/Subject', align: 'left' },
    ];
    for (let i = 0; i < assessmentCount; i++) {
        columns.push({
            key: `a${i + 1}`,
            w: colAss,
            label: `A${i + 1}`,
            align: 'center',
        });
    }
    columns.push(
        { key: 'avg', w: colAvg, label: 'Avg', align: 'center' },
        { key: 'pl', w: colPl, label: 'P.L', align: 'center' },
        { key: 'points', w: colPoints, label: 'Points', align: 'center' },
        { key: 'remark', w: colRemark + widthDiff, label: 'Remark', align: 'left' }
    );

    const headerH2 = 20;
    doc.rect(MARGIN, tableTop, CONTENT_W, headerH2).fillAndStroke('#eef2f7', '#000');
    doc.fillColor('#000').font(FONT_BOLD).fontSize(8.5);
    let cx = MARGIN + 4;
    columns.forEach((c) => {
        doc.text(c.label, cx, tableTop + 6, { width: c.w - 8, align: c.align });
        cx += c.w;
    });

    let ry = tableTop + headerH2;
    const tableMaxBottom = PAGE_H - 240;
    const availableTableHeight = tableMaxBottom - ry;
    const baseRowH = 15;
    const minRowH = 15;
    const maxRowH = 22;
    const idealRowH = Math.floor(availableTableHeight / (report.subjectRows.length + 2));
    const rowH = Math.max(minRowH, Math.min(maxRowH, idealRowH || baseRowH));

    // Rows
    report.subjectRows.forEach((row, idx) => {
        doc.rect(MARGIN, ry, CONTENT_W, rowH)
            .fillAndStroke(idx % 2 === 1 ? '#f7f9fc' : '#ffffff', '#cccccc');

        const cells = [{ t: row.subject, align: 'left' }];
        const assValues = [row.ass1, row.ass2, row.ass3];
        for (let i = 0; i < assessmentCount; i++) {
            cells.push({
                t: assValues[i] != null ? String(assValues[i]) : '—',
                align: 'center',
            });
        }
        cells.push(
            { t: row.average != null ? String(row.average) : '—', align: 'center', bold: true },
            { t: row.cbc.code === 'NA' ? '—' : row.cbc.code, align: 'center', color: gradeFg(row.cbc.level), bold: true },
            { t: row.cbc.points != null ? row.cbc.points.toFixed(2) : '—', align: 'center' },
            { t: row.remark, align: 'left', size: 8 }
        );

        let rx = MARGIN + 4;
        cells.forEach((c, i) => {
            const col = columns[i];
            doc.fontSize(c.size || 8.5)
                .font(c.bold ? FONT_BOLD : FONT_REGULAR)
                .fillColor(c.color || '#000')
                .text(c.t, rx, ry + (rowH - 10) / 2, {
                    width: col.w - 8, align: c.align, ellipsis: true,
                });
            rx += col.w;
        });

        // Vertical separators
        let sepX = MARGIN + colSubject;
        doc.moveTo(sepX, ry).lineTo(sepX, ry + rowH).lineWidth(0.3).strokeColor('#cccccc').stroke();
        for (let i = 0; i < assessmentCount; i++) {
            sepX += colAss;
            doc.moveTo(sepX, ry).lineTo(sepX, ry + rowH).stroke();
        }
        sepX += colAvg;
        doc.moveTo(sepX, ry).lineTo(sepX, ry + rowH).stroke();
        sepX += colPl;
        doc.moveTo(sepX, ry).lineTo(sepX, ry + rowH).stroke();
        sepX += colPoints;
        doc.moveTo(sepX, ry).lineTo(sepX, ry + rowH).stroke();

        ry += rowH;
    });

    // TOTAL row
    doc.rect(MARGIN, ry, CONTENT_W, rowH).fillAndStroke('#f5f7fb', '#000');
    doc.font(FONT_BOLD).fontSize(8.5).fillColor('#000')
        .text('TOTAL', MARGIN + 4, ry + (rowH - 10) / 2, { width: colSubject - 8 });

    let tx = MARGIN + 4 + colSubject;
    for (let i = 0; i < assessmentCount; i++) {
        let sum = 0;
        let hasAny = false;
        for (const r of report.subjectRows) {
            const v = [r.ass1, r.ass2, r.ass3][i];
            if (v != null && !isNaN(v)) { sum += Number(v); hasAny = true; }
        }
        doc.text(hasAny ? String(Math.round(sum)) : '—', tx, ry + (rowH - 10) / 2, {
            width: colAss - 8, align: 'center',
        });
        tx += colAss;
    }
    doc.text(String(report.totalMarks), tx, ry + (rowH - 10) / 2, {
        width: colAvg - 8, align: 'center',
    });
    tx += colAvg;
    doc.text('', tx, ry + (rowH - 10) / 2, { width: colPl - 8 });
    tx += colPl;
    doc.text(String(report.totalPoints), tx, ry + (rowH - 10) / 2, {
        width: colPoints - 8, align: 'center',
    });
    ry += rowH;

    // AVG row
    doc.rect(MARGIN, ry, CONTENT_W, rowH).fillAndStroke('#f5f7fb', '#000');
    doc.font(FONT_BOLD).fontSize(8.5).fillColor('#000')
        .text('AVG', MARGIN + 4, ry + (rowH - 10) / 2, { width: colSubject - 8 });

    tx = MARGIN + 4 + colSubject;
    for (let i = 0; i < assessmentCount; i++) {
        const v = assessmentAverages[i];
        doc.text(v != null ? String(v) : '—', tx, ry + (rowH - 10) / 2, {
            width: colAss - 8, align: 'center',
        });
        tx += colAss;
    }
    const avgScore = report.assessedCount > 0 ? report.meanScore.toFixed(2) : '—';
    doc.text(avgScore, tx, ry + (rowH - 10) / 2, { width: colAvg - 8, align: 'center' });
    tx += colAvg;
    doc.text('', tx, ry + (rowH - 10) / 2, { width: colPl - 8 });
    tx += colPl;
    doc.text(report.avgPoints || '—', tx, ry + (rowH - 10) / 2, {
        width: colPoints - 8, align: 'center',
    });
    ry += rowH + 4;

    // Outer table border
    doc.rect(MARGIN, tableTop, CONTENT_W, ry - tableTop - 4)
        .lineWidth(1).strokeColor('#000').stroke();

    // ---- Remarks ----
    doc.font(FONT_BOLD).fontSize(9).fillColor('#000')
        .text(`Class Teacher's Remark: `, MARGIN, ry, { continued: true });
    doc.font(FONT_REGULAR).fontSize(9)
        .text(report.teacherComment, { width: CONTENT_W - 130 });
    ry += 13;

    doc.font(FONT_BOLD).fontSize(9).fillColor('#000')
        .text(`Principal's Remark: `, MARGIN, ry, { continued: true });
    doc.font(FONT_REGULAR).fontSize(9)
        .text(student.principalComment || 'Good', { width: CONTENT_W - 110 });
    ry += 16;

    // ---- Performance bar chart ----
    const chartH = 55;
    const chartTop = ry;
    const chartW = CONTENT_W * 0.55;
    const legendX = MARGIN + chartW + 20;

    const assessLabels = ['A1', 'A2', 'A3'].slice(0, assessmentCount);
    const barSpacing = 8;
    const barW = (chartW - barSpacing * (assessmentCount - 1)) / assessmentCount;

    assessmentAverages.forEach((val, i) => {
        const bx = MARGIN + i * (barW + barSpacing);
        const displayVal = val != null ? val : 0;
        const barH = Math.max(6, (displayVal / 100) * chartH);
        doc.rect(bx, chartTop + chartH - barH, barW, barH).fill(PRIMARY);
        doc.font(FONT_BOLD).fontSize(7.5).fillColor('#000')
            .text(val != null ? String(val) : '—', bx, chartTop + chartH - barH - 9, {
                width: barW, align: 'center',
            });
        doc.font(FONT_REGULAR).fontSize(7).fillColor('#000')
            .text(assessLabels[i] || '', bx, chartTop + chartH + 3, {
                width: barW, align: 'center',
            });
    });

    // Legend
    doc.font(FONT_BOLD).fontSize(8.5).fillColor('#000')
        .text('PERFORMANCE LEVEL (P.L)', legendX, chartTop);
    const legendItems = [
        { code: 'BE', label: 'Below Expectations' },
        { code: 'AE', label: 'Approaching Expectations' },
        { code: 'ME', label: 'Meeting Expectations' },
        { code: 'EE', label: 'Exceeding Expectations' },
    ];
    legendItems.forEach((item, i) => {
        const ly = chartTop + 13 + i * 10;
        doc.font(FONT_BOLD).fontSize(8).fillColor(gradeFg(item.code))
            .text(item.code, legendX, ly, { continued: true });
        doc.font(FONT_REGULAR).fillColor('#000').text(` - ${item.label}`);
    });

    ry = chartTop + chartH + 18;

    // ---- Term dates ----
    doc.font(FONT_BOLD).fontSize(9).fillColor('#000')
        .text(
            `Term Started: ${fmtDate(meta.currentTermStart || meta.termStart)}  |  ` +
            `Closing Date: ${fmtDate(meta.currentTermEnd)}  |  ` +
            `Next Opening Date: ${fmtDate(meta.nextTermStart)}`,
            MARGIN, ry, { width: CONTENT_W, align: 'center' }
        );
    ry += 18;

    // ---- Signatures ----
    const sigY = Math.max(ry, PAGE_H - 110);
    const sigW = (CONTENT_W - 40) / 2;

    doc.font(FONT_BOLD).fontSize(8.5).fillColor('#000')
        .text('Class Teacher', MARGIN, sigY, { width: sigW, align: 'center' });
    doc.font(FONT_REGULAR).fontSize(8.5).fillColor('#000')
        .text(meta.classTeacherName || '—', MARGIN, sigY + 34, {
            width: sigW, align: 'center',
        });

    const rightX = MARGIN + sigW + 40;
    doc.font(FONT_BOLD).fontSize(8.5).fillColor('#000')
        .text('Head Of Institution (HOI)', rightX, sigY, { width: sigW, align: 'center' });

    if (signatureImg) {
        drawImage(
            doc, signatureImg,
            rightX + sigW / 2 - SIGNATURE_W / 2, sigY + 10,
            SIGNATURE_W, SIGNATURE_H * 0.7
        );
    }
    doc.font(FONT_REGULAR).fontSize(8.5).fillColor('#000')
        .text(meta.principalName || '—', rightX, sigY + 34, {
            width: sigW, align: 'center',
        });

    if (stampImg) {
        drawRotatedImage(
            doc, stampImg,
            MARGIN + CONTENT_W - 70, sigY + 22,
            STAMP_SIZE * 0.9, STAMP_SIZE * 0.9,
            45
        );
    }

    // ---- Footer ----
    const footerY = PAGE_H - 26;
    doc.moveTo(MARGIN, footerY)
        .lineTo(MARGIN + CONTENT_W, footerY)
        .lineWidth(0.5).strokeColor('#999').stroke();

    const year = new Date().getFullYear();
    doc.font(FONT_REGULAR).fontSize(7).fillColor('#666')
        .text(
            `© ${year} ${meta.schoolName || FALLBACK_NAME}. All rights reserved.  |  ` +
            `System designed and maintained by Edupriva  |  info.edupriva@gmail.com`,
            MARGIN, footerY + 4,
            { width: CONTENT_W, align: 'center' }
        );
}

// ============================================================
// Main builder
// ============================================================
async function buildPDF({
    docType, assessmentIndex, students, meta, subjects, term,
    logoBuffer, stampBuffer, signatureBuffer,
}) {
    return new Promise((resolve, reject) => {
        const isTranscript = docType === 'transcript';
        const doc = new PDFDocument({
            size: 'A4',
            layout: isTranscript ? 'landscape' : 'portrait',
            margin: 0,
            autoFirstPage: false,
            compress: true,
            info: {
                Title: isTranscript
                    ? `Transcripts — Assessment ${assessmentIndex + 1}`
                    : `Student Progress Report${meta.cls ? ' — ' + meta.cls : ''}`,
                Author: meta.schoolName || FALLBACK_NAME,
                Subject: `${term || ''} ${docType}`,
                Creator: 'EduPriva',
            },
        });

        // Set the document-wide default font once so any stray doc.text()
        // that doesn't explicitly set a font still lands in Times.
        doc.font(FONT_REGULAR);

        // Open images ONCE — every page reuses the same XObjects.
        const { logoImg, stampImg, signatureImg } = openImages(doc, {
            logoBuffer, stampBuffer, signatureBuffer,
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

        if (isTranscript) {
            const PAGE_W = 841.89;
            const PAGE_H = 595.28;
            const MARGIN = 20;
            const GAP = 12;
            const cardW = (PAGE_W - MARGIN * 2 - GAP) / 2;
            const cardH = (PAGE_H - MARGIN * 2 - GAP) / 2;

            const positions = [
                { x: MARGIN, y: MARGIN },
                { x: MARGIN + cardW + GAP, y: MARGIN },
                { x: MARGIN, y: MARGIN + cardH + GAP },
                { x: MARGIN + cardW + GAP, y: MARGIN + cardH + GAP },
            ];

            students.forEach((student, idx) => {
                const slot = idx % 4;
                if (slot === 0) doc.addPage();
                const pos = positions[slot];
                drawTranscriptCard(doc, {
                    student, meta, subjects, term,
                    assessmentIndex,
                    logoImg, stampImg, signatureImg,
                    x: pos.x, y: pos.y, w: cardW, h: cardH,
                });
            });
        } else {
            const assessmentCount = detectAssessmentCount(students);
            console.log(`[PDF] Detected assessment count: ${assessmentCount}`);

            students.forEach((student) => {
                doc.addPage();
                drawReportForm(doc, {
                    student, meta, subjects, term,
                    logoImg, stampImg, signatureImg,
                    assessmentCount,
                });
            });
        }

        doc.end();
    });
}

exports.handler = withCors(exports.handler);
