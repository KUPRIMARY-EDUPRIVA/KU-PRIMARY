const { withCors } = require('./_lib/cors');
// netlify/functions/generate-report.js
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
    if (score >= 80) return { code: 'EE', label: 'Exceeding Expectation', points: 8 };
    if (score >= 65) return { code: 'ME', label: 'Meeting Expectation', points: 6 };
    if (score >= 50) return { code: 'AE', label: 'Approaching Expectation', points: 4 };
    if (score >= 40) return { code: 'BE', label: 'Below Expectation', points: 2 };
    return { code: 'BE', label: 'Below Expectation', points: 1 };
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
 * Draws the brand header at the top of a page.
 * Left: logo + school name + motto + contact line.
 * Right: "PROGRESS REPORT" badge with year.
 * Returns the Y coordinate to continue drawing below the divider.
 */
function drawHeader(doc, meta, logoBuffer) {
    const PRIMARY = '#1a237e';
    const GRAY = '#666';
    const MARGIN = 40;
    const pageWidth = doc.page.width;

    const schoolName = meta.schoolName || FALLBACK_NAME;
    const motto = meta.schoolMotto || FALLBACK_MOTTO;
    const year = meta.year || new Date().getFullYear();

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
        meta.schoolAddress,
        meta.schoolPhone ? `Phone: ${meta.schoolPhone}` : '',
        meta.schoolEmail ? `Email: ${meta.schoolEmail}` : ''
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

    // --- Report badge ---
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
        .fontSize(10)
        .fillColor(PRIMARY)
        .font('Helvetica-Bold')
        .text('PROGRESS REPORT', badgeX, badgeY + 10, {
            width: badgeW,
            align: 'center'
        });

    doc
        .fontSize(9)
        .fillColor(GRAY)
        .font('Helvetica')
        .text(String(year), badgeX, badgeY + 32, {
            width: badgeW,
            align: 'center'
        });

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

function generateStudentPDF(student, scores, meta) {
    return fetchLogoBuffer(meta.schoolLogo).then((logoBuffer) => {
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
            let y = drawHeader(doc, meta, logoBuffer);

            // ---------- Sub-header: level | class | term | assessment ----------
            doc
                .fontSize(10)
                .fillColor('#333')
                .font('Helvetica-Bold')
                .text(
                    `${meta.level || ''}   |   Class: ${meta.cls || ''}   |   ${meta.term || ''}   |   ${meta.assessmentType || ''}`,
                    MARGIN,
                    y,
                    { width: CONTENT_W, align: 'center' }
                );

            y += 22;

            // ---------- Student info panel ----------
            const infoH = 78;
            doc.rect(MARGIN, y, CONTENT_W, infoH).fillAndStroke('#f5f5f5', '#e0e0e0');

            const label = (text, x, ly) =>
                doc.fontSize(8).fillColor(GRAY).font('Helvetica')
                   .text(text.toUpperCase(), x, ly);
            const value = (text, x, ly, width) =>
                doc.fontSize(11).fillColor('#000').font('Helvetica-Bold')
                   .text(String(text || 'N/A'), x, ly + 12, { width, ellipsis: true });

            const colLeftX = MARGIN + 15;
            const colRightX = MARGIN + Math.floor(CONTENT_W / 2);

            label('Student Name', colLeftX, y + 10);
            value(
                `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                colLeftX, y + 10, CONTENT_W / 2 - 20
            );

            label('Admission No', colRightX, y + 10);
            value(student.admissionNumber || student.studentId, colRightX, y + 10, CONTENT_W / 2 - 15);

            label('Class', colLeftX, y + 46);
            value(student.class || meta.cls, colLeftX, y + 46, CONTENT_W / 2 - 20);

            label('Gender / DOB', colRightX, y + 46);
            const gender = student.gender || 'N/A';
            const dob = student.dob || 'N/A';
            value(`${gender} / ${dob}`, colRightX, y + 46, CONTENT_W / 2 - 15);

            y += infoH + 20;

            // ---------- Score table ----------
            const allSubjects = Array.isArray(meta.subjects) ? meta.subjects : [];
            const scoreMap = {};
            (scores || []).forEach((s) => {
                if (s && s.subject != null) scoreMap[s.subject] = s.score;
            });

            // Column widths
            const colWidths = [170, 70, 80, 60, CONTENT_W - 170 - 70 - 80 - 60];
            const headers = ['Subject', 'Score', 'CBC Level', 'Points', 'Remark'];

            const drawTableHeader = (topY) => {
                doc.rect(MARGIN, topY, CONTENT_W, 22).fill(PRIMARY);
                doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold');
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

            // Rows
            allSubjects.forEach((subject, idx) => {
                const score = scoreMap[subject];
                const grade = score != null ? cbcGrade(score) : null;

                // Page break
                if (y > doc.page.height - 100) {
                    doc.addPage();
                    y = drawHeader(doc, meta, logoBuffer);
                    y = drawTableHeader(y);
                }

                const rowH = 20;

                // Zebra
                if (idx % 2 === 1) {
                    doc.rect(MARGIN, y, CONTENT_W, rowH).fill('#f7f9fc');
                    doc.fillColor('#000');
                }

                doc.fontSize(9).font('Helvetica').fillColor('#000');
                let cx = MARGIN + 5;
                const row = [
                    subject,
                    score != null ? `${score}%` : '-',
                    grade ? grade.code : '-',
                    grade ? grade.points.toFixed(1) : '-',
                    grade ? grade.label : 'Not assessed'
                ];
                row.forEach((val, i) => {
                    doc.text(String(val), cx, y + 6, {
                        width: colWidths[i] - 10,
                        align: i === 4 ? 'left' : 'center',
                        ellipsis: true
                    });
                    cx += colWidths[i];
                });

                y += rowH;
                doc.moveTo(MARGIN, y).lineTo(RIGHT_EDGE, y)
                   .lineWidth(0.5).strokeColor('#e6e6e6').stroke();
            });

            // ---------- Summary ----------
            y += 12;
            if (y > doc.page.height - 180) {
                doc.addPage();
                y = drawHeader(doc, meta, logoBuffer);
            }

            const scored = (scores || []).filter((s) => s && s.score != null);
            const total = scored.reduce((a, s) => a + s.score, 0);
            const avg = scored.length ? Math.round(total / scored.length) : 0;
            const overall = cbcGrade(avg);
            const totalPoints = allSubjects.reduce((sum, sub) => {
                const sc = scoreMap[sub];
                if (sc == null) return sum;
                return sum + cbcGrade(sc).points;
            }, 0);
            const avgPoints = scored.length
                ? (totalPoints / scored.length).toFixed(1)
                : 'N/A';

            // Summary tiles
            const sumH = 70;
            doc.rect(MARGIN, y, CONTENT_W, sumH).fill('#e3f2fd');

            const tile = (lbl, val, x, color, width) => {
                doc.fontSize(8).fillColor(GRAY).font('Helvetica')
                   .text(lbl.toUpperCase(), x, y + 10, { width });
                doc.fontSize(14).fillColor(color || PRIMARY).font('Helvetica-Bold')
                   .text(String(val), x, y + 28, { width, ellipsis: true });
            };

            const tW = Math.floor(CONTENT_W / 4);
            tile('Subjects Assessed', `${scored.length} / ${allSubjects.length}`, MARGIN + 10, PRIMARY, tW - 15);
            tile('Total Points', totalPoints.toFixed(1), MARGIN + tW + 5, PRIMARY, tW - 15);
            tile('Average Points', avgPoints, MARGIN + tW * 2 + 5, PRIMARY, tW - 15);
            tile('Overall Grade', `${avg}% (${overall.code})`, MARGIN + tW * 3 + 5, PRIMARY, tW - 15);

            y += sumH + 20;

            // ---------- Comment blocks ----------
            const commentBlock = (heading, text) => {
                const blockH = 46;
                if (y > doc.page.height - 100) {
                    doc.addPage();
                    y = drawHeader(doc, meta, logoBuffer);
                }
                doc.rect(MARGIN, y, CONTENT_W, blockH).fill('#f9f9f9');
                doc.rect(MARGIN, y, 4, blockH).fill(PRIMARY);

                doc.fontSize(9).fillColor(PRIMARY).font('Helvetica-Bold')
                   .text(heading, MARGIN + 15, y + 8);
                doc.fontSize(9).fillColor('#333').font('Helvetica-Oblique')
                   .text(text || '—', MARGIN + 15, y + 24, {
                       width: CONTENT_W - 30,
                       ellipsis: true
                   });

                y += blockH + 8;
            };

            commentBlock(
                "Class Teacher's Comment",
                student.classTeacherComment || 'Enter class teacher comment here…'
            );
            commentBlock(
                "Head Teacher's Comment",
                student.headTeacherComment || 'Enter head teacher comment here…'
            );
            commentBlock(
                "Principal's Comment",
                student.principalComment || 'Enter principal comment here…'
            );

            // ---------- Signature / footer ----------
            y += 12;
            if (y > doc.page.height - 80) {
                doc.addPage();
                y = drawHeader(doc, meta, logoBuffer);
            }

            // Signature line
            doc
                .moveTo(RIGHT_EDGE - 180, y + 30)
                .lineTo(RIGHT_EDGE, y + 30)
                .strokeColor('#333')
                .lineWidth(1)
                .stroke();
            doc
                .fontSize(9)
                .fillColor('#333')
                .font('Helvetica')
                .text('Class Teacher Signature', RIGHT_EDGE - 180, y + 34, {
                    width: 180,
                    align: 'center'
                });

            // Footer
            doc
                .fontSize(8)
                .fillColor('#999')
                .font('Helvetica')
                .text(
                    `Generated: ${new Date().toLocaleString('en-KE')}   •   ${meta.schoolName || FALLBACK_NAME}   •   ${meta.year || new Date().getFullYear()}`,
                    MARGIN,
                    doc.page.height - 40,
                    { width: CONTENT_W, align: 'center' }
                );

            doc.end();
        });
    });
}

exports.handler = withCors(exports.handler);
