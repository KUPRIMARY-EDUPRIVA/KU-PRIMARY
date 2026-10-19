// src/services/pdf.js
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Capacitor, registerPlugin } from '@capacitor/core';

const DeviceSecurity = registerPlugin('DeviceSecurity');

const PDF_COLORS = {
    primary: [26, 35, 126],
    text: [44, 62, 80],
    border: [203, 213, 225],
    accent: [248, 250, 252],
    gray: [120, 130, 145],
};

export async function saveGeneratedPdf(doc, filename) {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
        const dataUri = doc.output('datauristring');
        const base64 = dataUri.substring(dataUri.indexOf(',') + 1);
        return DeviceSecurity.savePdf({ filename, base64 });
    }
    doc.save(filename);
    return { filename };
}

async function addSchoolHeader(doc, school, title) {
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    if (school?.schoolLogo) {
        try {
            doc.addImage(school.schoolLogo, 'PNG', 10, 10, 20, 20);
        } catch (e) {
            console.error('Error adding logo:', e);
        }
    }

    doc.setTextColor(...PDF_COLORS.primary);
    doc.setFontSize(18);
    doc.text(school?.schoolName || school?.name || 'SCHOOL REPORT', pageWidth / 2, 15, { align: 'center' });

    doc.setFontSize(10);
    doc.setTextColor(...PDF_COLORS.text);
    const contact = [school?.schoolAddress || school?.address, school?.schoolPhone || school?.phone]
        .filter(Boolean).join(' | ');
    if (contact) doc.text(contact, pageWidth / 2, 22, { align: 'center' });
    doc.text(title.toUpperCase(), pageWidth / 2, 28, { align: 'center' });

    doc.setDrawColor(...PDF_COLORS.primary);
    doc.setLineWidth(0.5);
    doc.line(10, 32, pageWidth - 10, 32);

    doc.setDrawColor(...PDF_COLORS.border);
    doc.line(10, pageHeight - 12, pageWidth - 10, pageHeight - 12);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Generated on ${new Date().toLocaleDateString()}`, 10, pageHeight - 7);
}

/* ...unchanged top half of the file (downloadStudentReportCardPDF, downloadStudentReportPDF,
   getGradeFromScore, downloadRankingPDF, downloadReceiptPDF, downloadTeacherRecordPDF,
   downloadTeacherReportsAllPDF, downloadFeeStructurePDF, downloadFeeReportPDF,
   downloadExecutiveReportsPDF, downloadTranscriptPDF, downloadTimetablePDF,
   downloadStudentInvoicePDF, CBC_GRADES, cbcGrade, safeName, fmtDate,
   detectActiveAssessmentIndices, buildClassTeacherComment, drawCBCHeader) ... */

// ---------------------------------------------------------------------------
// Head-teacher name resolution
// ---------------------------------------------------------------------------
function resolveHeadTeacherName(meta) {
    if (!meta) return '—';
    const candidates = [
        meta.headTeacherName,
        meta.headteacherName,
        meta.head_teacher_name,
        meta.principalName,
        meta.headTeacher?.fullName,
        meta.headTeacher?.name,
        meta.principal?.fullName,
        meta.principal?.name,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return '—';
}

// ---------------------------------------------------------------------------
// Build head teacher comment WITHOUT the "Advisory:" prefix.
// ---------------------------------------------------------------------------
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
            return `Excellent term.${posText} Continue nurturing academic strengths.` +
                (weakest && weakest.average < 65 ? ` Add a small focus on ${weakest.subject} next term.` : '');
        case 'ME':
            return `Solid, consistent performance.${posText}` +
                (weakest && weakest.average < 50
                    ? ` A targeted focus on ${weakest.subject} will lift the overall grade.`
                    : ' Sustain the effort and broaden engagement.');
        case 'AE':
            return `Progress is being made.${posText}` +
                (weakest ? ` Emphasise ${weakest.subject} next term and provide guided practice.` : '');
        case 'BE':
            return `Results are below expectations.${posText} A structured support plan for this learner is recommended for next term.`;
        default:
            return `Report covers ${assessedCount} of ${totalSubjects} learning areas.`;
    }
}

/**
 * Draw student identity panel + Year / Current Year row.
 * This is the ONLY place student identity is written on the form.
 */
function drawStudentInfo(doc, student, meta, term, startY) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const MARGIN = 10;
    const CONTENT_W = pageWidth - MARGIN * 2;
    const boxH = 22;
    doc.setDrawColor(...PDF_COLORS.border);
    doc.setLineWidth(0.3);
    doc.rect(MARGIN, startY, CONTENT_W, boxH);

    const col2X = MARGIN + CONTENT_W / 2;

    doc.setFontSize(9);
    doc.setTextColor(...PDF_COLORS.text);

    const year = student?.academicYear || student?.year || meta?.academicYear?.start || meta?.year || '—';
    const currentYear = new Date().getFullYear();

    // Row 1
    doc.setFont('times', 'bold');
    doc.text('Name:', MARGIN + 3, startY + 6);
    doc.setFont('times', 'normal');
    doc.text(`${student.firstName || ''} ${student.lastName || ''}`.trim() || '—', MARGIN + 15, startY + 6);

    doc.setFont('times', 'bold');
    doc.text('Class:', col2X, startY + 6);
    doc.setFont('times', 'normal');
    doc.text(String(student.class || meta?.cls || '—'), col2X + 15, startY + 6);

    // Row 2
    doc.setFont('times', 'bold');
    doc.text('Adm No:', MARGIN + 3, startY + 12);
    doc.setFont('times', 'normal');
    doc.text(String(student.admissionNumber || student.studentId || '—'), MARGIN + 20, startY + 12);

    doc.setFont('times', 'bold');
    doc.text('Term:', col2X, startY + 12);
    doc.setFont('times', 'normal');
    doc.text(String(term || meta?.term || '—'), col2X + 15, startY + 12);

    // Row 3 — Year + Current Year
    doc.setFont('times', 'bold');
    doc.text('Year:', MARGIN + 3, startY + 18);
    doc.setFont('times', 'normal');
    doc.text(String(year), MARGIN + 15, startY + 18);

    doc.setFont('times', 'bold');
    doc.text('Current Year:', col2X, startY + 18);
    doc.setFont('times', 'normal');
    doc.text(String(currentYear), col2X + 27, startY + 18);

    return startY + boxH + 3;
}

// ------------------------------------------------------------
// TRANSCRIPTS (unchanged)
// ------------------------------------------------------------
export async function downloadTranscripts({ students, meta, subjects, term, assessmentIndex = 0 }) {
    // ... unchanged ...
}

// ------------------------------------------------------------
// 2. FULL REPORT FORMS — one student per A4 page
// ------------------------------------------------------------
export async function downloadClassReportForms({ students, meta, subjects, term }) {
    if (!Array.isArray(students) || students.length === 0) {
        throw new Error('No students supplied for report forms.');
    }
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const MARGIN = 10;
    const CONTENT_W = pageWidth - MARGIN * 2;

    const subjectList = Array.isArray(subjects) ? subjects : [];
    const paperConfigBySubject = meta?.paperConfigBySubject || {};
    const classTeacherName = meta?.classTeacherName || '—';
    // Accurately resolve head teacher/principal
    const principalName = resolveHeadTeacherName(meta);

    // Uploaded branding (transparent PNGs produced by prepareBrandingImage)
    const stampUrl = meta?.stampUrl || meta?.schoolStampUrl || '';
    const signatureUrl = meta?.principalSignatureUrl || meta?.headTeacherSignatureUrl || '';

    students.forEach((student, idx) => {
        if (idx > 0) doc.addPage();

        // ---- Header + student info ----
        let y = drawCBCHeader(doc, meta, 'STUDENT ACADEMIC PROGRESS REPORT');
        y = drawStudentInfo(doc, student, meta, term, y);

        // ---- Subject rows / aggregates ----
        const subjectRows = subjectList.map(subject => {
            const list = Array.isArray(student.scores?.[subject]) ? student.scores[subject] : [];
            const ass1 = list[0] ?? null;
            const ass2 = list[1] ?? null;
            const ass3 = list[2] ?? null;
            const provided = student.averages?.[subject];
            let average;
            if (provided != null && !isNaN(provided)) average = Math.round(provided);
            else {
                const valid = list.filter(v => v != null && !isNaN(v));
                average = valid.length > 0 ? Math.round(valid.reduce((a, b) => a + Number(b), 0) / valid.length) : null;
            }
            const cbc = cbcGrade(average);
            return { subject, ass1, ass2, ass3, average, cbc };
        });

        const assessedRows = subjectRows.filter(r => r.average != null);
        const assessedCount = assessedRows.length;
        const meanScore = assessedCount > 0
            ? Math.round(assessedRows.reduce((s, r) => s + r.average, 0) / assessedCount)
            : 0;
        const totalMarks = assessedCount * 100;
        const totalScore = assessedRows.reduce((s, r) => s + (r.average || 0), 0);
        const overall = cbcGrade(meanScore);

        const activeIndices = detectActiveAssessmentIndices(student);
        const assessmentCount = activeIndices.length;

        // ---- Main subject table ----
        const head = ['Learning Area'];
        for (let i = 0; i < assessmentCount; i++) head.push(`A${activeIndices[i] + 1}`);
        head.push('Avg', 'P.L', 'Points', 'Remark');

        const body = [];
        subjectRows.forEach((row) => {
            const subjectPapers = Array.isArray(paperConfigBySubject[row.subject])
                ? paperConfigBySubject[row.subject]
                : [];
            const paperScores = (student.papersBySubject && student.papersBySubject[row.subject]) || {};

            subjectPapers.forEach((paper) => {
                const p = paperScores[paper.name] || null;
                const branchScore = p && p.score != null ? Number(p.score) : null;
                const branchRow = [{ content: `    └ ${paper.name}`, styles: { textColor: PDF_COLORS.gray, fontStyle: 'italic' } }];
                for (let i = 0; i < assessmentCount; i++) branchRow.push('—');
                branchRow.push(branchScore != null ? String(branchScore) : '—', '', '', 'Branch');
                body.push(branchRow);
            });

            const assValues = [row.ass1, row.ass2, row.ass3];
            const totalRow = [{ content: subjectPapers.length > 0 ? `${row.subject} — TOTAL` : row.subject, styles: { fontStyle: subjectPapers.length > 0 ? 'bold' : 'normal' } }];
            for (let i = 0; i < assessmentCount; i++) {
                const v = assValues[activeIndices[i]];
                totalRow.push(v != null ? String(v) : '—');
            }
            totalRow.push(
                row.average != null ? String(row.average) : '—',
                row.cbc.code === 'NA' ? '—' : row.cbc.code,
                row.cbc.points != null ? row.cbc.points.toFixed(2) : '—',
                row.average == null ? 'Not assessed'
                    : row.cbc.level === 'EE' ? 'Exceeding Expectations'
                    : row.cbc.level === 'ME' ? 'Meeting Expectations'
                    : row.cbc.level === 'AE' ? 'Approaching Expectations'
                    : 'Below Expectations'
            );
            body.push(totalRow);
        });

        const columnStyles = {
            0: { halign: 'left', cellWidth: Math.max(38, CONTENT_W * 0.28) },
            [head.length - 1]: { halign: 'left' },
        };
        for (let i = 1; i <= assessmentCount; i++) columnStyles[i] = { halign: 'center', cellWidth: 12 };
        columnStyles[assessmentCount + 1] = { halign: 'center', cellWidth: 12 };
        columnStyles[assessmentCount + 2] = { halign: 'center', cellWidth: 12 };
        columnStyles[assessmentCount + 3] = { halign: 'center', cellWidth: 14 };

        autoTable(doc, {
            startY: y,
            head: [head],
            body,
            theme: 'grid',
            headStyles: { fillColor: PDF_COLORS.primary, textColor: [255, 255, 255], fontSize: 8, halign: 'center' },
            bodyStyles: { fontSize: 7.5, valign: 'middle' },
            columnStyles,
            styles: { font: 'times', lineColor: PDF_COLORS.border, lineWidth: 0.1 },
            margin: { left: MARGIN, right: MARGIN }
        });
        y = (doc.lastAutoTable?.finalY || y) + 4;

        // ---- Marks / position summary BELOW the table ----
        doc.setFont('times', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(0, 0, 0);
        doc.text(
            `Marks: ${totalScore}/${totalMarks}  |  Avg: ${meanScore.toFixed(2)}/100  |  ` +
            `Overall Pos.: ${student.position || '—'}/${student.classSize || '—'}  |  ` +
            `Grade: ${overall.code === 'NA' ? '—' : overall.code}`,
            pageWidth / 2, y, { align: 'center' }
        );
        y += 6;

        // ---- Term dates strip ----
        if (y > pageHeight - 40) { doc.addPage(); y = 15; }
        const infoRowH = 6;
        const infoLabelW = 30;
        const col2X = MARGIN + CONTENT_W / 2;

        const dateRows = [
            [
                { label: 'Term Started', value: fmtDate(meta?.currentTermStart || meta?.termStart) },
                { label: 'Closing Date', value: fmtDate(meta?.currentTermEnd) },
            ],
            [
                { label: 'Next Opening', value: fmtDate(meta?.nextTermStart) },
                { label: '', value: '' },
            ],
        ];

        doc.setFillColor(238, 242, 255);
        doc.rect(MARGIN, y, CONTENT_W, infoRowH, 'F');
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.3);
        doc.rect(MARGIN, y, CONTENT_W, infoRowH);
        doc.setFont('times', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(0, 0, 0);
        doc.text('Term Dates', MARGIN + 2, y + 4);
        y += infoRowH;

        dateRows.forEach((row, iIdx) => {
            if (iIdx % 2 === 1) {
                doc.setFillColor(250, 251, 254);
                doc.rect(MARGIN, y, CONTENT_W, infoRowH, 'F');
            }
            doc.setDrawColor(204, 204, 204);
            doc.setLineWidth(0.2);
            doc.rect(MARGIN, y, CONTENT_W, infoRowH);
            doc.line(col2X, y, col2X, y + infoRowH);

            const drawCell = (cx, cell, cw) => {
                if (!cell.label) return;
                doc.setFont('times', 'bold');
                doc.setFontSize(8);
                doc.setTextColor(51, 51, 51);
                doc.text(`${cell.label}:`, cx + 2, y + 4);
                doc.setFont('times', 'normal');
                doc.setTextColor(0, 0, 0);
                doc.text(String(cell.value || '—'), cx + 2 + infoLabelW, y + 4, { maxWidth: cw - infoLabelW - 4 });
            };

            drawCell(MARGIN, row[0], CONTENT_W / 2);
            drawCell(col2X, row[1], CONTENT_W / 2);

            y += infoRowH;
        });

        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.5);
        doc.rect(MARGIN, y - infoRowH * (dateRows.length + 1), CONTENT_W, infoRowH * (dateRows.length + 1));
        y += 6;

        // ---- CLASS TEACHER remark (now below the term dates table) ----
        const teacherComment = (student.teacherComment && String(student.teacherComment).trim())
            || buildClassTeacherComment({
                meanScore, assessedCount, totalSubjects: subjectList.length,
                subjectRows: subjectRows.map(r => ({ subject: r.subject, average: r.average })),
            });

        if (y > pageHeight - 45) { doc.addPage(); y = 15; }

        doc.setFont('times', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(0, 0, 0);
        doc.text(`CLASS TEACHER: ${classTeacherName}`, MARGIN, y);
        y += 5;

        doc.setFont('times', 'bold');
        doc.setFontSize(8.5);
        doc.text('REMARKS: ', MARGIN, y);
        doc.setFont('times', 'normal');
        const teacherLines = doc.splitTextToSize(teacherComment, CONTENT_W - 20);
        doc.text(teacherLines, MARGIN + 18, y);
        y += teacherLines.length * 4 + 3;

        doc.setDrawColor(51, 51, 51);
        doc.setLineWidth(0.4);
        doc.line(MARGIN, y + 4, MARGIN + 50, y + 4);
        doc.setFont('times', 'italic');
        doc.setFontSize(7);
        doc.setTextColor(...PDF_COLORS.gray);
        doc.text('Signature / Date', MARGIN, y + 7);
        y += 11;

        // ---- HEAD TEACHER remark + stamp + principal signature ----
        const headTeacherComment = (student.principalComment && String(student.principalComment).trim())
            || buildHeadTeacherComment({
                meanScore, assessedCount, totalSubjects: subjectList.length,
                subjectRows: subjectRows.map(r => ({ subject: r.subject, average: r.average })),
                student,
            });

        // Reserve enough room for remarks + signature block with images
        if (y > pageHeight - 60) { doc.addPage(); y = 15; }

        doc.setFont('times', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(0, 0, 0);
        doc.text(`HEAD TEACHER: ${principalName}`, MARGIN, y);
        y += 5;

        doc.setFont('times', 'bold');
        doc.setFontSize(8.5);
        doc.text('REMARKS: ', MARGIN, y);
        doc.setFont('times', 'normal');
        const headTeacherLines = doc.splitTextToSize(headTeacherComment, CONTENT_W - 20);
        doc.text(headTeacherLines, MARGIN + 18, y);
        const headBlockTop = y;
        y += headTeacherLines.length * 4 + 6;

        // Signature line on the left; stamp drawn on the right
        const sigLineY = y + 4;
        doc.setDrawColor(51, 51, 51);
        doc.setLineWidth(0.4);
        doc.line(MARGIN, sigLineY, MARGIN + 50, sigLineY);
        doc.setFont('times', 'italic');
        doc.setFontSize(7);
        doc.setTextColor(...PDF_COLORS.gray);
        doc.text('Signature / Date', MARGIN, sigLineY + 3);
        doc.text(principalName, MARGIN, sigLineY - 1);

        // Draw uploaded principal signature ABOVE the line (left side)
        if (signatureUrl) {
            try {
                const sigW = 32;
                const sigH = 12;
                doc.addImage(
                    signatureUrl, 'PNG',
                    MARGIN + 2, sigLineY - sigH - 1,
                    sigW, sigH,
                    undefined, 'FAST'
                );
            } catch (e) {
                console.warn('Could not embed principal signature:', e?.message || e);
            }
        }

        // Draw stamp on the RIGHT side of the head-teacher block, near the line
        if (stampUrl) {
            try {
                const stampSize = 22;
                const stampX = pageWidth - MARGIN - stampSize;
                // Align vertically with the signature line
                const stampY = sigLineY - stampSize + 3;
                doc.addImage(stampUrl, 'PNG', stampX, stampY, stampSize, stampSize, undefined, 'FAST');
            } catch (e) {
                console.warn('Could not embed school stamp:', e?.message || e);
            }
        }

        // Advance past the signature area (leave room for image height)
        y = sigLineY + 8;

        // ---- Footer ----
        doc.setDrawColor(153, 153, 153);
        doc.setLineWidth(0.2);
        doc.line(MARGIN, pageHeight - 10, pageWidth - MARGIN, pageHeight - 10);
        doc.setFont('times', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(102, 102, 102);
        doc.text(
            `© ${new Date().getFullYear()} ${meta?.schoolName || 'EDUPRIVA'}. All rights reserved.  |  System designed and maintained by Edupriva  |  info.edupriva@gmail.com`,
            pageWidth / 2, pageHeight - 5, { align: 'center' }
        );
    });

    const safeTerm = String(term || meta?.term || 'Term').replace(/\s+/g, '_');
    return saveGeneratedPdf(doc, `ReportForms_${safeTerm}_${meta?.cls || 'Class'}.pdf`);
}

// ------------------------------------------------------------
// 3. SINGLE STUDENT REPORT FORM — thin wrapper
// ------------------------------------------------------------
export async function downloadStudentReportForm({ student, meta, subjects, term }) {
    return downloadClassReportForms({ students: [student], meta, subjects, term });
}
