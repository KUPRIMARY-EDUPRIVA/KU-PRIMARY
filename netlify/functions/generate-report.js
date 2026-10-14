// netlify/functions/generate-report.js
const { withCors } = require('./_lib/cors');
//
// Generates a single-student Progress Report PDF (A4 portrait).
//
// Features:
//   - Letterhead-style header: logo left, school name / motto / contact stack,
//     coloured underline rule. When no logo is present, header text is
//     centred across the full content width.
//   - Info panel (student name, admission, class, gender / DOB)
//   - Score table with CBC level, points, and remark per subject
//   - Summary tiles (subjects assessed, total points, average points, overall)
//   - Class Teacher / Head Teacher / Principal comments. If the client does
//     NOT send `student.classTeacherComment` / `student.headTeacherComment` /
//     `student.principalComment`, the remarks are AUTO-GENERATED from the
//     score data (mean, coverage, strongest / weakest subject, position).
//   - Term & Signatory Information table (term dates, class teacher, principal)
//   - Signature line and footer
//   - NO page numbers anywhere.
//   - Times New Roman typography throughout (PDFKit standard-14 Times family).

const PDFDocument = require('pdfkit');
const axios = require('axios');

const FALLBACK_NAME = 'EDUPRIVA';
const FALLBACK_MOTTO = 'Powering Modern Education';

const PRIMARY = '#1a237e';
const PRIMARY_LIGHT = '#eef2ff';
const GRAY = '#666';
const BORDER = '#e0e6ed';
const DANGER = '#c62828';
const SUCCESS = '#1b5e20';

const HEADER_BLUE = '#1a4e8a';
const HEADER_RULE_WIDTH = 1.4;
const HEADER_MOTTO_GRAY = '#666';
const HEADER_CONTACT_GRAY = '#333';

// Times New Roman — PDFKit's standard-14 Times family names.
const FONT_REGULAR = 'Times-Roman';
const FONT_BOLD = 'Times-Bold';
const FONT_ITALIC = 'Times-Italic';

const SIGNATURE_W = 180;

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

    const { student, scores, meta } = payload;

    if (!student || typeof student !== 'object') {
        return json(400, { error: 'student object is required' });
    }
    if (!meta || typeof meta !== 'object') {
        return json(400, { error: 'meta object is required' });
    }

    try {
        const pdfBuffer = await generateStudentPDF(student, scores || [], meta);

        const safe = String(student.admissionNumber || student.id || 'student')
            .replace(/[^\w-]/g, '');
        const filename = `report_${safe}.pdf`;

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${filename}"`
            },
            body: pdfBuffer.toString('base64'),
            isBase64Encoded: true
        };
    } catch (err) {
        console.error('PDF generation error:', err);
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

function cbcGrade(score) {
    if (score == null || isNaN(score)) {
        return { code: 'NA', label: 'Not Assessed', points: null, level: 'NA' };
    }
    if (score >= 80) return { code: 'EE', label: 'Exceeding Expectation', points: 8, level: 'EE' };
    if (score >= 65) return { code: 'ME', label: 'Meeting Expectation', points: 6, level: 'ME' };
    if (score >= 50) return { code: 'AE', label: 'Approaching Expectation', points: 4, level: 'AE' };
    if (score >= 40) return { code: 'BE', label: 'Below Expectation', points: 2, level: 'BE' };
    return { code: 'BE', label: 'Below Expectation', points: 1, level: 'BE' };
}

function gradeFg(level) {
    return level === 'EE' ? '#155724'
        : level === 'ME' ? '#0c5460'
        : level === 'AE' ? '#856404'
        : level === 'NA' ? '#94a3b8'
        : '#721c24';
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

async function fetchLogoBuffer(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 8000,
            headers: { 'User-Agent': 'EduPriva-PDF/1.0' }
        });
        const buf = Buffer.from(res.data);
        if (buf.length === 0) {
            console.warn('Empty logo response');
            return null;
        }
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

// ---------------- Auto-generated remarks ----------------

/**
 * Class Teacher's Comment — derived from the score data.
 * Mentioned: overall performance, strongest subject, weakest subject
 * (only if below 50), and coverage.
 */
function buildClassTeacherComment({ meanScore, assessedCount, totalSubjects, subjectRows }) {
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
 * Head Teacher's Comment — mid-level framing: recognises consistency and
 * calls out which subject to focus on next term.
 */
function buildHeadTeacherComment({ meanScore, assessedCount, subjectRows }) {
    if (assessedCount === 0) {
        return 'Awaiting assessment data for the term.';
    }
    const overall = cbcGrade(meanScore);
    const assessed = subjectRows.filter((r) => r.average != null);
    const sorted = [...assessed].sort((a, b) => b.average - a.average);
    const best = sorted[0];
    const weakest = sorted[sorted.length - 1];

    switch (overall.level) {
        case 'EE':
            return `Excellent term overall.${best ? ` Particularly strong in ${best.subject}.` : ''}` +
                (weakest && weakest.average < 65 ? ` Continued effort in ${weakest.subject} will round off the year.` : '');
        case 'ME':
            return `Consistent performance across most areas.${best ? ` Noted improvement in ${best.subject}.` : ''}` +
                (weakest && weakest.average < 50 ? ` More focus on ${weakest.subject} recommended.` : '');
        case 'AE':
            return `Progress is being made.` +
                (weakest ? ` Emphasis on ${weakest.subject} next term will improve the overall result.` : '');
        case 'BE':
            return `Performance is below the required level. A structured intervention plan is advised.`;
        default:
            return `Report covers ${assessedCount} of ${subjectRows.length} learning areas.`;
    }
}

/**
 * Principal's Comment — top-level, outcome-focused, references overall
 * standing (position) when available.
 */
function buildPrincipalComment({ meanScore, assessedCount, subjectRows, position, classSize }) {
    if (assessedCount === 0) {
        return 'Awaiting assessments for the term. Please ensure the learner is assessed across all learning areas.';
    }
    const overall = cbcGrade(meanScore);
    const assessed = subjectRows.filter((r) => r.average != null);
    const sorted = [...assessed].sort((a, b) => b.average - a.average);
    const best = sorted[0];
    const weakest = sorted[sorted.length - 1];

    const posText = (position && classSize)
        ? ` Position ${position} of ${classSize} in class.` : '';

    switch (overall.level) {
        case 'EE':
            return `An excellent term overall.${posText}` +
                (best ? ` Continue to nurture the strong performance in ${best.subject}.` : '') +
                (weakest && weakest.average < 65 ? ` A little extra polish in ${weakest.subject} will complete the picture.` : '');
        case 'ME':
            return `A solid, consistent term.${posText}` +
                (best ? ` The learner performs well in ${best.subject}.` : '') +
                (weakest && weakest.average < 50 ? ` Targeted support in ${weakest.subject} will lift the overall grade.` : ' Continue the steady effort.');
        case 'AE':
            return `Progress is being made, but more consistency is needed.${posText}` +
                (weakest ? ` Focus next term should be on ${weakest.subject}.` : '');
        case 'BE':
            return `Results are below expectations and require attention.${posText} A structured support plan for the learner is recommended for next term.`;
        default:
            return `Report covers ${assessedCount} of ${subjectRows.length} learning areas.`;
    }
}

// ---------------- Letterhead header ----------------

/**
 * Letterhead-style header: logo on the left, school name / motto / contact
 * stack, coloured underline rule.
 *
 * When `logoImg` is null, NOTHING is drawn in the logo slot and all text
 * is CENTER-aligned across the full content width.
 *
 * Returns the y coordinate immediately below the rule.
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
    let textX = x;
    let textW = w;
    let logoBottom = y;
    let hasLogo = false;

    if (logoImg) {
        try {
            doc.image(logoImg, x, y, { fit: [logoSize, logoSize], align: 'center', valign: 'center' });
            textX = x + logoSize + padding;
            textW = w - logoSize - padding;
            logoBottom = y + logoSize;
            hasLogo = true;
        } catch (e) {
            console.warn('Logo embed failed:', e.message);
        }
    }

    const align = hasLogo ? 'left' : 'center';

    doc.font(FONT_BOLD).fontSize(nameSize).fillColor(HEADER_BLUE)
        .text((meta.schoolName || FALLBACK_NAME).toUpperCase(), textX, y + 1, {
            width: textW, align, ellipsis: true,
        });
    let cy = y + nameSize + 3;

    const motto = meta.schoolMotto || FALLBACK_MOTTO;
    doc.font(FONT_ITALIC).fontSize(mottoSize).fillColor(HEADER_MOTTO_GRAY)
        .text(`Motto: ${motto}`, textX, cy, {
            width: textW, align, ellipsis: true,
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
            width: textW, align, ellipsis: true, lineBreak: false,
        });
        cy += contactSize + lineGap;
    }

    const blockBottom = Math.max(cy, logoBottom) + ruleGap;
    doc.moveTo(x, blockBottom).lineTo(x + w, blockBottom)
        .lineWidth(HEADER_RULE_WIDTH).strokeColor(HEADER_BLUE).stroke();

    return blockBottom + 6;
}

// ---------------- Main PDF builder ----------------

function generateStudentPDF(student, scores, meta) {
    return fetchLogoBuffer(meta.schoolLogo).then((logoBuffer) => {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 0,
                autoFirstPage: true,
                compress: true,
                info: {
                    Title: `Progress Report — ${student.firstName || ''} ${student.lastName || ''}`.trim(),
                    Author: meta.schoolName || FALLBACK_NAME,
                    Subject: `${meta.term || ''} Progress Report`,
                    Creator: 'EduPriva',
                },
            });

            doc.font(FONT_REGULAR);

            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const MARGIN = 40;
            const PAGE_W = doc.page.width;
            const PAGE_H = doc.page.height;
            const CONTENT_W = PAGE_W - MARGIN * 2;
            const RIGHT_EDGE = PAGE_W - MARGIN;

            // Open the logo image once so it can be reused on every page
            // (if the document ever adds a page break).
            let logoImg = null;
            if (logoBuffer) {
                try {
                    logoImg = doc.openImage(logoBuffer);
                } catch (e) {
                    console.warn('openImage failed for logo:', e.message);
                }
            }

            // ---------- Letterhead header ----------
            let y = drawLetterheadHeader(doc, {
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

            // ---------- Report title ----------
            doc.font(FONT_BOLD).fontSize(12).fillColor('#000')
                .text('PROGRESS REPORT', MARGIN, y, { width: CONTENT_W, align: 'center' });
            y += 16;

            doc.font(FONT_BOLD).fontSize(9.5).fillColor('#333')
                .text(
                    `${(meta.term || '').toString().toUpperCase()} ${meta.year ? ' • ' + meta.year : ''}`,
                    MARGIN, y, { width: CONTENT_W, align: 'center' }
                );
            y += 14;

            doc.font(FONT_ITALIC).fontSize(8.5).fillColor(GRAY)
                .text(
                    `${meta.level || ''}   |   Class: ${meta.cls || ''}   |   ${meta.term || ''}   |   ${meta.assessmentType || ''}`,
                    MARGIN, y, { width: CONTENT_W, align: 'center' }
                );
            y += 16;

            // ---------- Student info panel ----------
            const infoH = 68;
            doc.rect(MARGIN, y, CONTENT_W, infoH).fillAndStroke('#f5f7fb', BORDER);

            const label = (text, x, ly, w) =>
                doc.fontSize(7.5).fillColor(GRAY).font(FONT_REGULAR)
                   .text(text.toUpperCase(), x, ly, { width: w });
            const value = (text, x, ly, w) =>
                doc.fontSize(10.5).fillColor('#000').font(FONT_BOLD)
                   .text(String(text || 'N/A'), x, ly + 10, { width: w, ellipsis: true });

            const colLeftX = MARGIN + 14;
            const colRightX = MARGIN + Math.floor(CONTENT_W / 2) + 6;
            const halfW = Math.floor(CONTENT_W / 2) - 20;

            label('Student Name', colLeftX, y + 10, halfW);
            value(
                `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                colLeftX, y + 10, halfW
            );

            label('Admission No', colRightX, y + 10, halfW);
            value(student.admissionNumber || student.studentId, colRightX, y + 10, halfW);

            label('Class', colLeftX, y + 40, halfW);
            value(student.class || meta.cls, colLeftX, y + 40, halfW);

            label('Gender / DOB', colRightX, y + 40, halfW);
            const gender = student.gender || 'N/A';
            const dob = student.dob || 'N/A';
            value(`${gender} / ${dob}`, colRightX, y + 40, halfW);

            y += infoH + 14;

            // ---------- Score table ----------
            const allSubjects = Array.isArray(meta.subjects) ? meta.subjects : [];
            const scoreMap = {};
            (scores || []).forEach((s) => {
                if (s && s.subject != null) scoreMap[s.subject] = s.score;
            });

            const colWidths = [170, 70, 80, 60, CONTENT_W - 170 - 70 - 80 - 60];
            const headers = ['Subject', 'Score', 'CBC Level', 'Points', 'Remark'];

            const drawTableHeader = (topY) => {
                doc.rect(MARGIN, topY, CONTENT_W, 22).fill(PRIMARY);
                doc.fillColor('#fff').fontSize(9).font(FONT_BOLD);
                let cx = MARGIN + 5;
                headers.forEach((h, i) => {
                    doc.text(h, cx, topY + 7, {
                        width: colWidths[i] - 10,
                        align: i === 4 ? 'left' : 'center'
                    });
                    cx += colWidths[i];
                });
                return topY + 22;
            };

            y = drawTableHeader(y);

            allSubjects.forEach((subject, idx) => {
                const score = scoreMap[subject];
                const grade = score != null ? cbcGrade(score) : null;

                // Page break
                if (y > PAGE_H - 100) {
                    doc.addPage();
                    y = drawLetterheadHeader(doc, {
                        x: MARGIN, y: MARGIN, w: CONTENT_W, meta, logoImg,
                        logoSize: 58, padding: 10, nameSize: 15, mottoSize: 8.5,
                        contactSize: 7.5, lineGap: 2.5, ruleGap: 6,
                    });
                    y = drawTableHeader(y);
                }

                const rowH = 20;

                if (idx % 2 === 1) {
                    doc.rect(MARGIN, y, CONTENT_W, rowH).fill('#f7f9fc');
                }

                doc.fontSize(9).font(FONT_REGULAR).fillColor('#000');
                let cx = MARGIN + 5;
                const row = [
                    subject,
                    score != null ? `${score}%` : '-',
                    grade ? grade.code : '-',
                    grade && grade.points != null ? grade.points.toFixed(1) : '-',
                    grade ? grade.label : 'Not assessed'
                ];
                row.forEach((val, i) => {
                    const colour = (i === 2 && grade) ? gradeFg(grade.level) : '#000';
                    doc.fillColor(colour)
                       .font(i === 2 && grade ? FONT_BOLD : FONT_REGULAR)
                       .text(String(val), cx, y + 6, {
                            width: colWidths[i] - 10,
                            align: i === 4 ? 'left' : 'center',
                            ellipsis: true
                        });
                    cx += colWidths[i];
                });

                y += rowH;
                doc.moveTo(MARGIN, y).lineTo(RIGHT_EDGE, y)
                   .lineWidth(0.5).strokeColor(BORDER).stroke();
            });

            // ---------- Summary tiles ----------
            y += 12;
            if (y > PAGE_H - 220) {
                doc.addPage();
                y = drawLetterheadHeader(doc, {
                    x: MARGIN, y: MARGIN, w: CONTENT_W, meta, logoImg,
                    logoSize: 58, padding: 10, nameSize: 15, mottoSize: 8.5,
                    contactSize: 7.5, lineGap: 2.5, ruleGap: 6,
                });
            }

            const scored = (scores || []).filter((s) => s && s.score != null);
            const total = scored.reduce((a, s) => a + Number(s.score), 0);
            const avg = scored.length ? Math.round(total / scored.length) : 0;
            const overall = cbcGrade(avg);
            const totalPoints = allSubjects.reduce((sum, sub) => {
                const sc = scoreMap[sub];
                if (sc == null) return sum;
                return sum + (cbcGrade(sc).points || 0);
            }, 0);
            const avgPoints = scored.length
                ? (totalPoints / scored.length).toFixed(1)
                : 'N/A';

            const sumH = 70;
            doc.rect(MARGIN, y, CONTENT_W, sumH).fill('#e3f2fd');

            const tile = (lbl, val, x, width) => {
                doc.fontSize(8).fillColor(GRAY).font(FONT_REGULAR)
                   .text(lbl.toUpperCase(), x, y + 10, { width });
                doc.fontSize(14).fillColor(PRIMARY).font(FONT_BOLD)
                   .text(String(val), x, y + 28, { width, ellipsis: true });
            };

            const tW = Math.floor(CONTENT_W / 4);
            tile('Subjects Assessed', `${scored.length} / ${allSubjects.length}`, MARGIN + 10, tW - 15);
            tile('Total Points', totalPoints.toFixed(1), MARGIN + tW + 5, tW - 15);
            tile('Average Points', avgPoints, MARGIN + tW * 2 + 5, tW - 15);
            tile('Overall Grade', `${avg}% (${overall.code})`, MARGIN + tW * 3 + 5, tW - 15);

            y += sumH + 18;

            // ---------- Comments (client-supplied OR auto-generated) ----------
            // Build the report data used by the auto-generators.
            const subjectRows = allSubjects.map((sub) => {
                const sc = scoreMap[sub];
                return {
                    subject: sub,
                    average: sc != null ? Math.round(Number(sc)) : null,
                };
            });
            const assessedRows = subjectRows.filter((r) => r.average != null);
            const meanScore = assessedRows.length
                ? Math.round(assessedRows.reduce((a, r) => a + r.average, 0) / assessedRows.length)
                : 0;

            const remarkContext = {
                meanScore,
                assessedCount: assessedRows.length,
                totalSubjects: allSubjects.length,
                subjectRows,
                position: student.position || null,
                classSize: student.classSize || null,
            };

            const classTeacherComment =
                (student.classTeacherComment && String(student.classTeacherComment).trim())
                || buildClassTeacherComment(remarkContext);

            const headTeacherComment =
                (student.headTeacherComment && String(student.headTeacherComment).trim())
                || buildHeadTeacherComment(remarkContext);

            const principalComment =
                (student.principalComment && String(student.principalComment).trim())
                || buildPrincipalComment(remarkContext);

            const commentBlock = (heading, text) => {
                const blockH = 46;
                if (y > PAGE_H - 100) {
                    doc.addPage();
                    y = drawLetterheadHeader(doc, {
                        x: MARGIN, y: MARGIN, w: CONTENT_W, meta, logoImg,
                        logoSize: 58, padding: 10, nameSize: 15, mottoSize: 8.5,
                        contactSize: 7.5, lineGap: 2.5, ruleGap: 6,
                    });
                }
                doc.rect(MARGIN, y, CONTENT_W, blockH).fill('#f9f9f9');
                doc.rect(MARGIN, y, 4, blockH).fill(PRIMARY);

                doc.fontSize(9).fillColor(PRIMARY).font(FONT_BOLD)
                   .text(heading, MARGIN + 15, y + 8);
                doc.fontSize(9).fillColor('#333').font(FONT_ITALIC)
                   .text(text || '—', MARGIN + 15, y + 24, {
                       width: CONTENT_W - 30,
                       ellipsis: true
                   });

                y += blockH + 8;
            };

            commentBlock("Class Teacher's Comment", classTeacherComment);
            commentBlock("Head Teacher's Comment", headTeacherComment);
            commentBlock("Principal's Comment", principalComment);

            // ---------- Term dates + signatory info table ----------
            y += 6;
            if (y > PAGE_H - 140) {
                doc.addPage();
                y = drawLetterheadHeader(doc, {
                    x: MARGIN, y: MARGIN, w: CONTENT_W, meta, logoImg,
                    logoSize: 58, padding: 10, nameSize: 15, mottoSize: 8.5,
                    contactSize: 7.5, lineGap: 2.5, ruleGap: 6,
                });
            }

            const infoTop = y;
            const infoRowH = 12;
            const infoLabelW = 78;
            const infoValueW = (CONTENT_W / 2) - infoLabelW;
            const col2X = MARGIN + (CONTENT_W / 2);

            const infoRows = [
                {
                    left: { label: 'Term Started', value: fmtDate(meta.currentTermStart || meta.termStart) },
                    right: { label: 'Class Teacher', value: meta.classTeacherName || '—' },
                },
                {
                    left: { label: 'Closing Date', value: fmtDate(meta.currentTermEnd) },
                    right: { label: 'Principal', value: meta.principalName || '—' },
                },
                {
                    left: { label: 'Next Opening', value: fmtDate(meta.nextTermStart) },
                    right: { label: '', value: '' },
                },
            ];

            doc.rect(MARGIN, infoTop, CONTENT_W, infoRowH).fillAndStroke('#eef2f7', '#000');
            doc.font(FONT_BOLD).fontSize(8.5).fillColor('#000');
            doc.text('Term & Signatory Information', MARGIN + 4, infoTop + 2, {
                width: CONTENT_W - 8, align: 'left',
            });

            let iy = infoTop + infoRowH;
            infoRows.forEach((row, idx) => {
                doc.rect(MARGIN, iy, CONTENT_W, infoRowH)
                    .fillAndStroke(idx % 2 === 1 ? '#fafbfe' : '#ffffff', '#cccccc');

                doc.moveTo(col2X, iy).lineTo(col2X, iy + infoRowH)
                    .lineWidth(0.3).strokeColor('#cccccc').stroke();

                if (row.left.label) {
                    doc.font(FONT_BOLD).fontSize(8.5).fillColor('#333')
                        .text(`${row.left.label}:`, MARGIN + 4, iy + 2, {
                            width: infoLabelW - 6, align: 'left',
                        });
                    doc.font(FONT_REGULAR).fontSize(8.5).fillColor('#000')
                        .text(row.left.value || '—', MARGIN + 4 + infoLabelW, iy + 2, {
                            width: infoValueW - 4, align: 'left', ellipsis: true,
                        });
                }

                if (row.right.label) {
                    doc.font(FONT_BOLD).fontSize(8.5).fillColor('#333')
                        .text(`${row.right.label}:`, col2X + 4, iy + 2, {
                            width: infoLabelW - 6, align: 'left',
                        });
                    doc.font(FONT_REGULAR).fontSize(8.5).fillColor('#000')
                        .text(row.right.value || '—', col2X + 4 + infoLabelW, iy + 2, {
                            width: infoValueW - 4, align: 'left', ellipsis: true,
                        });
                }

                iy += infoRowH;
            });

            doc.rect(MARGIN, infoTop, CONTENT_W, iy - infoTop)
                .lineWidth(0.8).strokeColor('#000').stroke();

            y = iy + 14;

            // ---------- Signature line ----------
            if (y > PAGE_H - 80) {
                doc.addPage();
                y = drawLetterheadHeader(doc, {
                    x: MARGIN, y: MARGIN, w: CONTENT_W, meta, logoImg,
                    logoSize: 58, padding: 10, nameSize: 15, mottoSize: 8.5,
                    contactSize: 7.5, lineGap: 2.5, ruleGap: 6,
                });
            }

            doc.moveTo(RIGHT_EDGE - SIGNATURE_W, y + 30)
                .lineTo(RIGHT_EDGE, y + 30)
                .strokeColor('#333')
                .lineWidth(1)
                .stroke();
            doc.fontSize(9).fillColor('#333').font(FONT_REGULAR)
                .text('Class Teacher Signature', RIGHT_EDGE - SIGNATURE_W, y + 34, {
                    width: SIGNATURE_W,
                    align: 'center'
                });

            // ---------- Footer ----------
            // No page numbers. Plain credit line only.
            doc.fontSize(8).fillColor('#999').font(FONT_REGULAR)
                .text(
                    `Generated: ${new Date().toLocaleString('en-KE')}   •   ${meta.schoolName || FALLBACK_NAME}   •   ${meta.year || new Date().getFullYear()}`,
                    MARGIN,
                    PAGE_H - 40,
                    { width: CONTENT_W, align: 'center' }
                );

            doc.end();
        });
    });
}

exports.handler = withCors(exports.handler);
