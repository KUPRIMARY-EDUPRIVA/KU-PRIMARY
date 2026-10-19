// src/services/individualStudentReport.js
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';
import { saveGeneratedPdf } from './pdf';

// Consistent branding colors
const COLORS = {
    primary: [26, 35, 126],
    text: [44, 62, 80],
    gray: [120, 130, 145],
    border: [203, 213, 225],
    background: [248, 250, 252],
    white: [255, 255, 255],
    rule: [26, 78, 138],
};

const PRIMARY_HEX = '#1a237e';
const HEADER_BLUE_HEX = '#1a4e8a';
const RULE_COLOR = [26, 78, 138];

// ============================================================
// CBC grading
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

function gradeColor(level) {
    return level === 'EE' ? [21, 87, 36]
        : level === 'ME' ? [12, 84, 96]
        : level === 'AE' ? [133, 100, 4]
        : level === 'NA' ? [148, 163, 184]
        : [114, 28, 36];
}

function fmtDate(d) {
    if (!d) return '—';
    try {
        return new Date(d).toLocaleDateString('en-KE', {
            day: '2-digit', month: 'short', year: 'numeric',
        });
    } catch { return '—'; }
}

// ============================================================
// Remarks — auto-generated from performance
// ============================================================
function buildClassTeacherComment({ meanScore, assessedCount, totalSubjects, subjectRows }) {
    if (assessedCount === 0) {
        return 'No assessments recorded for this student this term.';
    }
    const overall = cbcGrade(meanScore);
    const assessed = subjectRows.filter((r) => r.average != null);
    const sorted = [...assessed].sort((a, b) => b.average - a.average);
    const best = sorted[0];
    const weakest = sorted[sorted.length - 1];

    const strength = best
        ? ` Strongest in ${best.subject} (${best.average}%).`
        : '';
    const weakness = (weakest && weakest.subject !== best?.subject && weakest.average < 65)
        ? ` Weakest in ${weakest.subject} (${weakest.average}%); needs attention.`
        : '';
    const coverageRatio = totalSubjects > 0 ? assessedCount / totalSubjects : 0;
    const caveat = coverageRatio < 0.7
        ? ` Covers ${assessedCount}/${totalSubjects} learning areas.` : '';

    const head = overall.level === 'EE' ? 'Exceeding expectations. '
        : overall.level === 'ME' ? 'Meeting expectations across most areas. '
        : overall.level === 'AE' ? 'Approaching expectations. Practice will raise achievement. '
        : 'Below expectations. Targeted intervention required. ';

    return `${head}${strength}${weakness}${caveat}`.trim();
}

function buildHeadTeacherComment({ meanScore, assessedCount, totalSubjects, subjectRows, student }) {
    if (assessedCount === 0) {
        return 'Awaiting assessments for the term. Please ensure the learner is assessed across all learning areas.';
    }
    const overall = cbcGrade(meanScore);
    const assessed = subjectRows.filter((r) => r.average != null);
    const sorted = [...assessed].sort((a, b) => b.average - a.average);
    const weakest = sorted[sorted.length - 1];

    const posText = (student?.position && student?.classSize)
        ? ` Position ${student.position} of ${student.classSize}.` : '';

    switch (overall.level) {
        case 'EE':
            return `Advisory: excellent term.${posText} Continue nurturing academic strengths.` +
                (weakest && weakest.average < 65 ? ` Add a small focus on ${weakest.subject} next term.` : '');
        case 'ME':
            return `Advisory: solid, consistent performance.${posText}` +
                (weakest && weakest.average < 50
                    ? ` A targeted focus on ${weakest.subject} will lift the overall grade.`
                    : ' Sustain the effort and broaden engagement.');
        case 'AE':
            return `Advisory: progress is being made.${posText}` +
                (weakest ? ` Emphasise ${weakest.subject} next term and provide guided practice.` : '');
        case 'BE':
            return `Advisory: results are below expectations.${posText} A structured support plan for this learner is recommended for next term.`;
        default:
            return `Advisory: report covers ${assessedCount} of ${totalSubjects} learning areas.`;
    }
}

// ============================================================
// Per-student helpers
// ============================================================
function detectActiveAssessmentIndices(student) {
    const active = new Set();
    const scores = student.scores || {};
    for (const subject of Object.keys(scores)) {
        const list = scores[subject] || [];
        for (let i = 0; i < 3; i++) {
            const v = list[i];
            if (v != null && v !== '' && !isNaN(v)) active.add(i);
        }
    }
    const out = [...active].sort((a, b) => a - b);
    return out.length ? out : [0];
}

function computeSubjectRows(student, subjects) {
    return subjects.map((subject) => {
        const list = (student.scores && student.scores[subject]) || [];
        const ass1 = list[0] ?? null;
        const ass2 = list[1] ?? null;
        const ass3 = list[2] ?? null;

        const provided = student.averages && student.averages[subject];
        let average;
        if (provided != null && !isNaN(provided)) {
            average = Math.round(provided);
        } else {
            const valid = list.filter((v) => v != null && !isNaN(v));
            average = valid.length > 0
                ? Math.round(valid.reduce((a, b) => a + Number(b), 0) / valid.length)
                : null;
        }

        const cbc = cbcGrade(average);
        return {
            subject,
            ass1, ass2, ass3,
            average,
            cbc,
            remark: average == null ? 'Not assessed'
                : cbc.level === 'EE' ? 'Exceeding Expectations'
                : cbc.level === 'ME' ? 'Meeting Expectations'
                : cbc.level === 'AE' ? 'Approaching Expectations'
                : 'Below Expectations',
        };
    });
}

function computeAssessmentAverages(student, subjects, activeIndices) {
    return activeIndices.map((idx) => {
        let sum = 0;
        let count = 0;
        for (const subject of subjects) {
            const list = (student.scores && student.scores[subject]) || [];
            const v = list[idx];
            if (v != null && !isNaN(v)) {
                sum += Number(v);
                count++;
            }
        }
        return {
            index: idx,
            value: count > 0 ? Math.round(sum / count) : null,
        };
    });
}

// ============================================================
// Header — measured so nothing overlaps and text aligns cleanly
// ============================================================
async function addBranding(doc, meta) {
    const logoUrl = meta?.schoolLogo || meta?.logoUrl || meta?.logo || '';
    const schoolName = (meta?.schoolName || 'EDUPRIVA').toUpperCase();
    const motto = meta?.schoolMotto || '';
    const address = meta?.schoolAddress || '';
    const phone = meta?.schoolPhone || '';
    const email = meta?.schoolEmail || '';
    const website = meta?.website || '';

    const MARGIN_X = 10;
    const CONTENT_W = 190;
    const LOGO_SIZE = 22;
    const HEADER_TOP = 10;

    let hasLogo = false;
    if (logoUrl) {
        try {
            const ext = String(logoUrl).toLowerCase().endsWith('.jpg')
                || String(logoUrl).toLowerCase().endsWith('.jpeg')
                ? 'JPEG'
                : 'PNG';
            doc.addImage(logoUrl, ext, MARGIN_X, HEADER_TOP, LOGO_SIZE, LOGO_SIZE, undefined, 'FAST');
            hasLogo = true;
        } catch (e) {
            console.warn('Logo could not be embedded:', e?.message || e);
            hasLogo = false;
        }
    }

    // Aligned text block: starts at the left margin when no logo, or to the
    // right of the logo when a logo is present.
    const textX = hasLogo ? MARGIN_X + LOGO_SIZE + 6 : MARGIN_X;
    const textW = hasLogo ? CONTENT_W - LOGO_SIZE - 6 : CONTENT_W;
    const textCentre = textX + textW / 2;

    // School name
    doc.setFont('times', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...HEX_TO_RGB(HEADER_BLUE_HEX));
    doc.text(schoolName, textX, HEADER_TOP + 6, { maxWidth: textW });
    let cy = HEADER_TOP + 12;

    // Motto
    if (motto) {
        doc.setFont('times', 'italic');
        doc.setFontSize(9);
        doc.setTextColor(...COLORS.gray);
        doc.text(`Motto: ${motto}`, textX, cy, { maxWidth: textW });
        cy += 5;
    }

    // Contact stack — left aligned under the school name
    doc.setFont('times', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(51, 51, 51);
    const contactLines = [];
    if (address) contactLines.push(address);
    if (phone) contactLines.push(`Tel: ${phone}`);
    if (email) contactLines.push(`Email: ${email}`);
    if (website) contactLines.push(`Website: ${website}`);
    if (meta?.schoolCode) contactLines.push(`School Code: ${meta.schoolCode}`);

    for (const line of contactLines) {
        doc.text(line, textX, cy, { maxWidth: textW });
        cy += 4;
    }

    // Rule under the letterhead
    const ruleY = Math.max(cy, HEADER_TOP + (hasLogo ? LOGO_SIZE : 0)) + 2;
    doc.setDrawColor(...RULE_COLOR);
    doc.setLineWidth(0.6);
    doc.line(MARGIN_X, ruleY, MARGIN_X + CONTENT_W, ruleY);

    return { bottom: ruleY + 4, textX, textW, textCentre };
}

function HEX_TO_RGB(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.substring(0, 2), 16),
        parseInt(h.substring(2, 4), 16),
        parseInt(h.substring(4, 6), 16),
    ];
}

// ============================================================
// Term & Signatory table
// ============================================================
function drawTermInfoTable(doc, startY, meta, classTeacherName, principalName) {
    const MARGIN_X = 10;
    const CONTENT_W = 190;
    const COL_W = CONTENT_W / 2;
    const ROW_H = 6;
    const LABEL_W = 28;

    const rows = [
        [
            { label: 'Term Started', value: fmtDate(meta.currentTermStart || meta.termStart) },
            { label: 'Class Teacher', value: classTeacherName || '—' },
        ],
        [
            { label: 'Closing Date', value: fmtDate(meta.currentTermEnd) },
            { label: 'Head Teacher', value: principalName || '—' },
        ],
        [
            { label: 'Next Opening', value: fmtDate(meta.nextTermStart) },
            { label: '', value: '' },
        ],
    ];

    doc.setFillColor(238, 242, 255);
    doc.setTextColor(0, 0, 0);
    doc.setFont('times', 'bold');
    doc.setFontSize(9);
    doc.rect(MARGIN_X, startY, CONTENT_W, ROW_H, 'F');
    doc.text('Term & Signatory Information', MARGIN_X + 2, startY + 4);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.4);
    doc.rect(MARGIN_X, startY, CONTENT_W, ROW_H);

    let y = startY + ROW_H;
    rows.forEach((row, idx) => {
        if (idx % 2 === 1) {
            doc.setFillColor(250, 251, 254);
            doc.rect(MARGIN_X, y, CONTENT_W, ROW_H, 'F');
        }
        doc.setDrawColor(204, 204, 204);
        doc.setLineWidth(0.2);
        doc.rect(MARGIN_X, y, CONTENT_W, ROW_H);
        doc.line(MARGIN_X + COL_W, y, MARGIN_X + COL_W, y + ROW_H);

        const drawCell = (cellX, cell, cellW) => {
            if (!cell.label) return;
            doc.setFont('times', 'bold');
            doc.setFontSize(8.5);
            doc.setTextColor(51, 51, 51);
            doc.text(`${cell.label}:`, cellX + 2, y + 4);

            doc.setFont('times', 'normal');
            doc.setTextColor(0, 0, 0);
            doc.text(String(cell.value || '—'), cellX + 2 + LABEL_W, y + 4, {
                maxWidth: cellW - LABEL_W - 4,
            });
        };

        drawCell(MARGIN_X, row[0], COL_W);
        drawCell(MARGIN_X + COL_W, row[1], COL_W);

        y += ROW_H;
    });

    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.6);
    doc.rect(MARGIN_X, startY, CONTENT_W, y - startY);

    return y + 4;
}

// ============================================================
// Main export
// ============================================================
export async function exportIndividualStudentReport(
    student,
    subjects,
    term,
    meta,
    getCBCGrade, // kept for backwards compatibility; we use our own cbcGrade below
) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const MARGIN_X = 10;
    const CONTENT_W = 190;
    const PAGE_H = doc.internal.pageSize.getHeight();

    const paperConfigBySubject = meta?.paperConfigBySubject || {};
    const classTeacherName = meta?.classTeacherName || '—';
    const principalName = meta?.principalName || '—';

    // ---- Letterhead header ----
    const header = await addBranding(doc, meta);
    let y = header.bottom;

    // ---- Title ----
    doc.setFont('times', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    doc.text(
        `${(term || 'TERM').toUpperCase()} - ${meta?.year || new Date().getFullYear()}`,
        MARGIN_X + CONTENT_W / 2,
        y + 4,
        { align: 'center' }
    );
    y += 6;

    doc.setFont('times', 'bold');
    doc.setFontSize(8);
    doc.text('MID TERM', MARGIN_X + CONTENT_W / 2, y, { align: 'center' });
    y += 5;

    // ---- Student identity line (single occurrence) ----
    const fullName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || '—';
    const admissionNo = student.admissionNumber || student.studentId || '—';
    const grade = student.class || meta?.cls || '—';

    doc.setFont('times', 'bold');
    doc.setFontSize(9.5);
    doc.text(
        `Student: ${fullName}   |   Adm No: ${admissionNo}   |   Grade: ${grade}`,
        MARGIN_X + CONTENT_W / 2,
        y,
        { align: 'center' }
    );
    y += 4;

    // ---- Compute rows and totals ----
    const subjectRows = computeSubjectRows(student, subjects);
    const assessed = subjectRows.filter((r) => r.average != null);
    const assessedCount = assessed.length;
    const totalSubjects = subjectRows.length;
    const meanScore = assessedCount > 0
        ? Math.round(assessed.reduce((s, r) => s + r.average, 0) / assessedCount)
        : 0;
    const totalMarks = assessedCount * 100;
    const totalScore = assessed.reduce((s, r) => s + (r.average || 0), 0);
    const totalPoints = assessed.reduce((s, r) => s + (r.cbc.points || 0), 0);
    const overall = cbcGrade(assessedCount > 0 ? meanScore : null);

    const activeIndices = detectActiveAssessmentIndices(student);
    const assessmentAverages = computeAssessmentAverages(student, subjects, activeIndices);

    // ---- Score table (built dynamically) ----
    const head = ['Learning Area', ...activeIndices.map((i) => `A${i + 1}`), 'Avg', 'P.L', 'Points', 'Remark'];
    const columnStyles = {
        0: { halign: 'left', cellWidth: 45 },
        [head.length - 1]: { halign: 'left', cellWidth: 40 },
    };
    for (let i = 1; i <= activeIndices.length; i++) {
        columnStyles[i] = { halign: 'center', cellWidth: 12 };
    }
    columnStyles[activeIndices.length + 1] = { halign: 'center', cellWidth: 12 };
    columnStyles[activeIndices.length + 2] = { halign: 'center', cellWidth: 12 };
    columnStyles[activeIndices.length + 3] = { halign: 'center', cellWidth: 14 };

    const body = [];
    subjectRows.forEach((row) => {
        const subjectPapers = Array.isArray(paperConfigBySubject[row.subject])
            ? paperConfigBySubject[row.subject]
            : [];
        const paperScores = (student.papersBySubject && student.papersBySubject[row.subject]) || {};

        // Branch rows
        subjectPapers.forEach((paper) => {
            const p = paperScores[paper.name] || null;
            const branchScore = p && p.score != null ? Number(p.score) : null;
            const branchRow = [
                { content: `    └ ${paper.name}`, styles: { textColor: COLORS.gray, fontStyle: 'italic' } },
                ...activeIndices.map(() => '—'),
                branchScore != null ? String(branchScore) : '—',
                '',
                '',
                'Branch',
            ];
            body.push(branchRow);
        });

        // Subject total row
        const assValues = [row.ass1, row.ass2, row.ass3];
        const totalRow = [{
            content: subjectPapers.length > 0 ? `${row.subject} — TOTAL` : row.subject,
            styles: { fontStyle: subjectPapers.length > 0 ? 'bold' : 'normal' },
        }];
        for (let i = 0; i < activeIndices.length; i++) {
            const v = assValues[activeIndices[i]];
            totalRow.push(v != null ? String(v) : '—');
        }
        totalRow.push(
            row.average != null ? String(row.average) : '—',
            row.cbc.code === 'NA' ? '—' : row.cbc.code,
            row.cbc.points != null ? row.cbc.points.toFixed(2) : '—',
            row.remark,
        );
        body.push(totalRow);
    });

    doc.autoTable({
        startY: y,
        head: [head],
        body,
        theme: 'grid',
        headStyles: {
            fillColor: COLORS.primary,
            textColor: COLORS.white,
            fontSize: 8.5,
            fontStyle: 'bold',
            halign: 'center',
        },
        bodyStyles: { fontSize: 8, valign: 'middle' },
        columnStyles,
        styles: { font: 'times', lineColor: COLORS.border, lineWidth: 0.1 },
        margin: { left: MARGIN_X, right: MARGIN_X },
    });

    y = doc.lastAutoTable.finalY + 3;

    // ---- Marks summary line — AFTER the score table ----
    doc.setFont('times', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(0, 0, 0);
    doc.text(
        `Marks: ${totalScore}/${totalMarks}   |   ` +
        `Avg: ${meanScore.toFixed(2)}/100   |   ` +
        `Overall Pos.: ${student.position || '—'}/${student.classSize || '—'}   |   ` +
        `Grade: ${overall.code === 'NA' ? '—' : overall.code}`,
        MARGIN_X + CONTENT_W / 2,
        y + 4,
        { align: 'center' }
    );
    y += 8;

    // ---- Class Teacher remark (once) ----
    const teacherComment = (student.teacherComment && String(student.teacherComment).trim())
        || buildClassTeacherComment({ meanScore, assessedCount, totalSubjects, subjectRows });

    doc.setFont('times', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text(`CLASS TEACHER: ${classTeacherName}`, MARGIN_X, y);
    y += 5;

    doc.setFont('times', 'bold');
    doc.setFontSize(8.5);
    doc.text('REMARKS: ', MARGIN_X, y);
    doc.setFont('times', 'normal');
    const teacherLines = doc.splitTextToSize(teacherComment, CONTENT_W - 20);
    doc.text(teacherLines, MARGIN_X + 18, y);
    y += teacherLines.length * 4 + 2;

    doc.setDrawColor(51, 51, 51);
    doc.setLineWidth(0.4);
    doc.line(MARGIN_X, y + 4, MARGIN_X + 50, y + 4);
    doc.setFont('times', 'italic');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.gray);
    doc.text('Signature / Date', MARGIN_X, y + 7);
    y += 11;

    // ---- Head Teacher remark (once) ----
    const headTeacherComment = (student.principalComment && String(student.principalComment).trim())
        || buildHeadTeacherComment({ meanScore, assessedCount, totalSubjects, subjectRows, student });

    doc.setFont('times', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text(`HEAD TEACHER: ${principalName}`, MARGIN_X, y);
    y += 5;

    doc.setFont('times', 'bold');
    doc.setFontSize(8.5);
    doc.text('REMARKS: ', MARGIN_X, y);
    doc.setFont('times', 'normal');
    const headTeacherLines = doc.splitTextToSize(headTeacherComment, CONTENT_W - 20);
    doc.text(headTeacherLines, MARGIN_X + 18, y);
    y += headTeacherLines.length * 4 + 2;

    doc.setDrawColor(51, 51, 51);
    doc.setLineWidth(0.4);
    doc.line(MARGIN_X, y + 4, MARGIN_X + 50, y + 4);
    doc.setFont('times', 'italic');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.gray);
    doc.text('Signature / Date', MARGIN_X, y + 7);
    y += 11;

    // ---- Term & Signatory table ----
    y = drawTermInfoTable(doc, y, meta || {}, classTeacherName, principalName);

    // ---- Bar chart of per-assessment averages ----
    const chartH = 22;
    if (y + chartH + 15 < PAGE_H - 20) {
        const chartW = CONTENT_W * 0.55;
        const chartX = MARGIN_X;
        const chartTop = y + 4;

        doc.setFont('times', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(0, 0, 0);
        doc.text('PERFORMANCE LEVEL (P.L)', chartX + chartW + 6, chartTop + 2);

        const legendItems = [
            { code: 'BE', label: 'Below Expectations' },
            { code: 'AE', label: 'Approaching Expectations' },
            { code: 'ME', label: 'Meeting Expectations' },
            { code: 'EE', label: 'Exceeding Expectations' },
        ];
        legendItems.forEach((item, i) => {
            const ly = chartTop + 8 + i * 3.5;
            doc.setFont('times', 'bold');
            doc.setFontSize(7.5);
            doc.setTextColor(...gradeColor(item.code));
            doc.text(item.code, chartX + chartW + 6, ly);
            doc.setFont('times', 'normal');
            doc.setTextColor(0, 0, 0);
            doc.text(` - ${item.label}`, chartX + chartW + 6 + 7, ly);
        });

        const count = Math.max(assessmentAverages.length, 1);
        const gap = 4;
        const barW = (chartW - gap * (count - 1)) / count;

        doc.setDrawColor(153, 153, 153);
        doc.setLineWidth(0.2);
        doc.line(chartX, chartTop + chartH, chartX + chartW, chartTop + chartH);

        assessmentAverages.forEach((d, i) => {
            const bx = chartX + i * (barW + gap);
            const value = d.value != null ? d.value : 0;
            const barHeight = Math.max(1, (value / 100) * (chartH - 3));
            const by = chartTop + chartH - barHeight;

            doc.setFillColor(...COLORS.primary);
            doc.rect(bx, by, barW, barHeight, 'F');

            doc.setFont('times', 'bold');
            doc.setFontSize(7);
            doc.setTextColor(0, 0, 0);
            doc.text(d.value != null ? String(d.value) : '—', bx + barW / 2, by - 1, { align: 'center' });

            doc.setFont('times', 'normal');
            doc.setFontSize(6.5);
            doc.text(`A${d.index + 1}`, bx + barW / 2, chartTop + chartH + 3, { align: 'center' });
        });

        y = chartTop + chartH + 8;
    }

    // ---- Footer ----
    doc.setDrawColor(153, 153, 153);
    doc.setLineWidth(0.2);
    doc.line(MARGIN_X, PAGE_H - 12, MARGIN_X + CONTENT_W, PAGE_H - 12);

    doc.setFont('times', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(102, 102, 102);
    doc.text(
        `© ${new Date().getFullYear()} ${meta?.schoolName || 'EDUPRIVA'}. All rights reserved.  |  ` +
        `System designed and maintained by Edupriva  |  info.edupriva@gmail.com`,
        MARGIN_X + CONTENT_W / 2, PAGE_H - 7, { align: 'center' }
    );

    return saveGeneratedPdf(
        doc,
        `ReportCard_${student.firstName || ''}_${student.lastName || ''}.pdf`
    );
}
