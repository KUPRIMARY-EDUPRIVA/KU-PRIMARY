// src/services/pdf.js
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Capacitor, registerPlugin } from '@capacitor/core';

const DeviceSecurity = registerPlugin('DeviceSecurity');

// Common PDF configuration
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

    // Footer rule only — no page numbers.
    doc.setDrawColor(...PDF_COLORS.border);
    doc.line(10, pageHeight - 12, pageWidth - 10, pageHeight - 12);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Generated on ${new Date().toLocaleDateString()}`, 10, pageHeight - 7);
}

export async function downloadStudentReportCardPDF({ students, meta, subjects, term }) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const studentList = Array.isArray(students) ? students : [];
    if (!studentList.length) throw new Error('There are no student report cards to export.');
    const subjectList = Array.isArray(subjects) ? subjects : [];

    for (let index = 0; index < studentList.length; index++) {
        const student = studentList[index];
        if (index > 0) doc.addPage();

        await addSchoolHeader(doc, meta, 'ACADEMIC PROGRESS REPORT');

        doc.setFontSize(10);
        doc.setTextColor(...PDF_COLORS.text);
        doc.rect(10, 35, 190, 20);

        doc.text(`Name: ${[student.firstName, student.lastName].filter(Boolean).join(' ') || 'Student'}`, 15, 42);
        doc.text(`Adm No: ${student.admissionNumber || student.studentId || 'N/A'}`, 15, 48);
        doc.text(`Class: ${student.class || meta?.cls || '—'}`, 100, 42);
        doc.text(`Term: ${term}`, 100, 48);

        const tableData = subjectList.map(subject => [
            subject,
            (Array.isArray(student.scores?.[subject])
                ? student.scores[subject][student.scores[subject].length - 1]
                : student.scores?.[subject]) ?? '-',
            student.averages?.[subject] != null ? `${student.averages[subject]}%` : '-',
            '-',
            '-',
            '-'
        ]);

        autoTable(doc, {
            startY: 60,
            head: [['Subject', 'ETRM', 'Avg', 'Rank', 'Grade', 'Pts']],
            body: tableData,
            theme: 'grid',
            headStyles: { fillColor: PDF_COLORS.primary, fontSize: 10, halign: 'center' },
            bodyStyles: { fontSize: 9, halign: 'center' },
            columnStyles: { 0: { halign: 'left' } }
        });
    }

    return saveGeneratedPdf(doc, `ReportCard_${term}_${meta?.cls || 'Class'}.pdf`);
}

export async function downloadStudentReportPDF(student, scores, meta) {
    const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
    });

    const subjects = meta?.subjects || [];

    const school = {
        schoolName: meta?.schoolName || 'TOPLINK EDU',
        schoolAddress: meta?.schoolAddress || '',
        schoolPhone: meta?.schoolPhone || '',
        schoolLogo: meta?.schoolLogo || ''
    };

    await addSchoolHeader(doc, school, 'ACADEMIC PROGRESS REPORT');

    doc.setFontSize(10);
    doc.setTextColor(...PDF_COLORS.text);

    doc.rect(10, 35, 190, 24);

    doc.setFont('helvetica', 'bold');
    doc.text(`Name: ${student?.firstName || ''} ${student?.lastName || ''}`.trim(), 15, 42);
    doc.setFont('helvetica', 'normal');
    doc.text(`Adm No: ${student?.admissionNumber || student?.studentId || 'N/A'}`, 15, 49);
    doc.text(`Class: ${meta?.cls || 'N/A'}`, 105, 42);
    doc.text(`Level: ${meta?.level || 'N/A'}`, 105, 49);
    doc.text(`Term: ${meta?.term || 'N/A'}`, 15, 56);
    doc.text(`Assessment: ${meta?.assessmentType || 'N/A'}`, 105, 56);

    const studentScores = Array.isArray(scores) ? scores : [];

    const tableData = subjects.map(subject => {
        const subjectEntries = studentScores.filter(score => score?.subject === subject);
        const latest = subjectEntries.length ? subjectEntries[subjectEntries.length - 1] : null;
        const score = latest?.score ?? '-';
        return [
            subject,
            score,
            score !== '-' ? `${score}%` : '-',
            score !== '-' ? getGradeFromScore(score) : '-'
        ];
    });

    autoTable(doc, {
        startY: 65,
        head: [['Subject', 'Score', 'Percentage', 'Grade']],
        body: tableData,
        theme: 'grid',
        headStyles: {
            fillColor: PDF_COLORS.primary,
            textColor: 255,
            fontSize: 10,
            halign: 'center'
        },
        bodyStyles: { fontSize: 9, halign: 'center' },
        columnStyles: { 0: { halign: 'left' } },
        margin: { left: 10, right: 10 }
    });

    const finalY = doc.lastAutoTable?.finalY || 65;

    const numericScores = studentScores.map(s => Number(s?.score)).filter(score => Number.isFinite(score));
    const average = numericScores.length
        ? Math.round(numericScores.reduce((sum, score) => sum + score, 0) / numericScores.length)
        : null;

    const summaryY = Math.min(finalY + 12, 265);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...PDF_COLORS.primary);
    doc.text(`Overall Average: ${average !== null ? `${average}%` : 'N/A'}`, 15, summaryY);
    if (average !== null) {
        doc.text(`Overall Grade: ${getGradeFromScore(average)}`, 105, summaryY);
    }

    doc.setFont('helvetica', 'normal');
    const studentName = `${student?.firstName || ''}_${student?.lastName || ''}`.trim().replace(/\s+/g, '_');
    const safeName = studentName || 'Student';

    return saveGeneratedPdf(doc, `Student_Report_${safeName}_${meta?.term || 'Term'}.pdf`);
}

function getGradeFromScore(score) {
    const value = Number(score);
    if (!Number.isFinite(value)) return '-';
    if (value >= 80) return 'A';
    if (value >= 70) return 'B';
    if (value >= 60) return 'C';
    if (value >= 50) return 'D';
    return 'E';
}

export async function downloadRankingPDF(students, meta) {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    await addSchoolHeader(doc, meta, 'Student Ranking');
    doc.setFontSize(10);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(
        [meta?.level, meta?.cls, meta?.term, meta?.year, meta?.assessmentType].filter(Boolean).join(' | '),
        105,
        38,
        { align: 'center' }
    );
    const subjects = meta?.subjects || [];
    autoTable(doc, {
        startY: 44,
        head: [['Rank', 'Admission No.', 'Student', ...subjects, 'Total', 'Average', 'Grade']],
        body: (students || []).map((student, index) => [
            index + 1,
            student.admissionNumber || student.studentId || '—',
            `${student.firstName || ''} ${student.lastName || ''}`.trim() || student.name || '—',
            ...subjects.map((subject) => student.subjectScores?.[subject] ?? '—'),
            student.totalMarks ?? '—',
            `${Number(student.average || 0).toFixed(1)}%`,
            student.cbcGrade?.code || student.grade || '—'
        ]),
        theme: 'striped',
        headStyles: { fillColor: PDF_COLORS.primary, fontSize: 7 },
        bodyStyles: { fontSize: 7 },
        styles: { overflow: 'linebreak' },
        margin: { top: 44 }
    });
    return saveGeneratedPdf(doc, `Ranking_${meta?.cls || 'Class'}_${meta?.term || ''}.pdf`);
}

export async function downloadReceiptPDF(receipt, school) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    await addSchoolHeader(doc, school, 'Official Fee Receipt');
    autoTable(doc, {
        startY: 40,
        head: [['Payment receipt', 'Details']],
        body: [
            ['Receipt number', receipt?.receiptNumber || '—'],
            ['Student', receipt?.studentName || '—'],
            ['Admission number', receipt?.admissionNumber || '—'],
            ['Class', receipt?.studentClass || receipt?.class || '—'],
            ['Amount received', `KES ${Number(receipt?.amount || 0).toLocaleString()}`],
            ['Payment method', receipt?.paymentMethod || '—'],
            ['Payment date', receipt?.paymentDate || '—'],
            ['Reference', receipt?.reference || '—'],
            ['Term / year', [receipt?.term, receipt?.year].filter(Boolean).join(' ') || '—'],
            ['Balance after payment', `KES ${Number(receipt?.balance || 0).toLocaleString()}`]
        ],
        theme: 'grid',
        headStyles: { fillColor: PDF_COLORS.primary },
        bodyStyles: { fontSize: 10 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 } }
    });
    doc.setFontSize(10);
    doc.text('Thank you for your payment.', 105, (doc.lastAutoTable?.finalY || 100) + 15, { align: 'center' });
    return saveGeneratedPdf(doc, `Receipt_${receipt?.receiptNumber || Date.now()}.pdf`);
}

export async function downloadTeacherRecordPDF(record, meta, teacher) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    await addSchoolHeader(doc, meta, 'Teacher Assessment Record');
    autoTable(doc, {
        startY: 40,
        head: [['Field', 'Record']],
        body: [
            ['Teacher', `${teacher?.firstName || ''} ${teacher?.lastName || ''}`.trim() || teacher?.fullName || '—'],
            ['Student', record?.studentName || '—'],
            ['Admission number', record?.admissionNumber || '—'],
            ['Subject', record?.subject || '—'],
            ['Level / class', [record?.levelDisplay || record?.level, record?.class].filter(Boolean).join(' / ') || '—'],
            ['Score', `${record?.score ?? '—'}%`],
            ['Assessment', record?.assessmentType || '—'],
            ['Recorded', record?.recordedAtDisplay || '—'],
            ['Remarks', record?.remarks || '—']
        ],
        theme: 'grid',
        headStyles: { fillColor: PDF_COLORS.primary },
        bodyStyles: { fontSize: 10 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 } }
    });
    return saveGeneratedPdf(doc, `Teacher_Record_${record?.admissionNumber || 'Student'}.pdf`);
}

export async function downloadTeacherReportsAllPDF(records, meta, teacher) {
    if (!records?.length) throw new Error('There are no teacher records to export.');
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    await addSchoolHeader(doc, meta, 'Teacher Assessment Records');
    doc.setFontSize(9);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(`Teacher: ${teacher?.firstName || ''} ${teacher?.lastName || ''}`.trim(), 10, 38);
    autoTable(doc, {
        startY: 42,
        head: [['Student', 'Admission No.', 'Subject', 'Level', 'Class', 'Score', 'Assessment', 'Date', 'Remarks']],
        body: records.map((record) => [
            record.studentName || '—',
            record.admissionNumber || '—',
            record.subject || '—',
            record.levelDisplay || record.level || '—',
            record.class || '—',
            `${record.score ?? '—'}%`,
            record.assessmentType || '—',
            record.recordedAtDisplay || '—',
            record.remarks || '—'
        ]),
        theme: 'striped',
        headStyles: { fillColor: PDF_COLORS.primary, fontSize: 7 },
        bodyStyles: { fontSize: 7 },
        styles: { overflow: 'linebreak' }
    });
    return saveGeneratedPdf(doc, `Teacher_Reports_${new Date().toISOString().slice(0, 10)}.pdf`);
}

export async function downloadFeeStructurePDF(schedule, school, year) {
    const structures = Array.isArray(schedule) ? schedule : schedule ? [schedule] : [];
    if (!structures.length) throw new Error('There are no fee schedules to export.');
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    structures.forEach((structure, index) => {
        if (index) doc.addPage();
        const schoolName = school?.schoolName || school?.name || 'School';
        const targetName = structure.name || structure.targetKey || structure.className || structure.level || 'Fee Schedule';
        doc.setTextColor(...PDF_COLORS.primary);
        doc.setFontSize(18);
        doc.text(schoolName, 105, 17, { align: 'center' });
        doc.setFontSize(14);
        doc.text('FEE SCHEDULE', 105, 28, { align: 'center' });
        doc.setFontSize(10);
        doc.setTextColor(...PDF_COLORS.text);
        doc.text(`${targetName} | ${structure.term || 'All Terms'} | ${structure.year || year}`, 105, 36, { align: 'center' });
        const items = structure.items || [];
        autoTable(doc, {
            startY: 44,
            head: [['Description', 'Category', 'Type', 'Amount (KES)']],
            body: items.map((item) => [
                item.description || '—',
                item.category || '—',
                item.optional ? 'Optional' : 'Mandatory',
                Number(item.amount || 0).toLocaleString()
            ]),
            foot: [[
                'Schedule total',
                '',
                '',
                Number(structure.totalAmount ?? items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)).toLocaleString()
            ]],
            theme: 'striped',
            headStyles: { fillColor: PDF_COLORS.primary },
            footStyles: { fillColor: PDF_COLORS.accent, textColor: PDF_COLORS.primary, fontStyle: 'bold' }
        });
    });
    return saveGeneratedPdf(doc, `Fee_Schedules_${year || new Date().getFullYear()}.pdf`);
}

export async function downloadFeeReportPDF(reportData, school) {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const summary = reportData?.summary || {};
    const records = Array.isArray(reportData?.records) ? reportData.records : [];
    const schoolDetails = {
        schoolName: school?.schoolName || school?.name || 'School',
        schoolAddress: school?.schoolAddress || school?.address || '',
        schoolPhone: school?.schoolPhone || school?.phone || '',
        schoolLogo: school?.schoolLogo || school?.logoUrl || ''
    };

    doc.setTextColor(...PDF_COLORS.primary);
    doc.setFontSize(18);
    doc.text(schoolDetails.schoolName, 148, 15, { align: 'center' });
    doc.setFontSize(10);
    doc.setTextColor(...PDF_COLORS.text);
    const contact = [schoolDetails.schoolAddress, schoolDetails.schoolPhone].filter(Boolean).join(' | ');
    if (contact) doc.text(contact, 148, 22, { align: 'center' });
    doc.setFontSize(13);
    doc.text('FEE REPORT', 148, 31, { align: 'center' });

    autoTable(doc, {
        startY: 38,
        head: [['Total billed', 'Total collected', 'Outstanding balance']],
        body: [[
            `KES ${Number(summary.totalBilled || 0).toLocaleString()}`,
            `KES ${Number(summary.totalCollected || 0).toLocaleString()}`,
            `KES ${Number(summary.totalBalance || 0).toLocaleString()}`
        ]],
        theme: 'grid',
        headStyles: { fillColor: PDF_COLORS.primary, halign: 'center' },
        bodyStyles: { halign: 'center' }
    });

    autoTable(doc, {
        startY: (doc.lastAutoTable?.finalY || 55) + 8,
        head: [['Admission No.', 'Student', 'Class', 'Billed (KES)', 'Paid (KES)', 'Balance (KES)', 'Status']],
        body: records.map((record) => [
            record.admissionNumber || '—',
            record.studentName || '—',
            record.className || '—',
            Number(record.billed || 0).toLocaleString(),
            Number(record.paid || 0).toLocaleString(),
            Number(record.balance || 0).toLocaleString(),
            record.status || '—'
        ]),
        theme: 'striped',
        headStyles: { fillColor: PDF_COLORS.primary, fontSize: 8 },
        bodyStyles: { fontSize: 8 },
        styles: { overflow: 'linebreak' }
    });
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Generated ${new Date().toLocaleString()}`, 10, 203);
    const filename = `Fee_Report_${new Date().toISOString().slice(0, 10)}.pdf`;
    return saveGeneratedPdf(doc, filename);
}

export async function downloadExecutiveReportsPDF(kpis, school, term, year) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const schoolName = school?.schoolName || school?.name || 'School';
    const contact = [
        school?.schoolAddress || school?.address,
        school?.schoolPhone || school?.phone,
        school?.schoolEmail || school?.email
    ].filter(Boolean).join(' | ');

    doc.setTextColor(...PDF_COLORS.primary);
    doc.setFontSize(19);
    doc.text(schoolName, 105, 18, { align: 'center' });
    doc.setFontSize(10);
    doc.setTextColor(...PDF_COLORS.text);
    if (contact) doc.text(contact, 105, 25, { align: 'center', maxWidth: 185 });
    doc.setFontSize(14);
    doc.setTextColor(...PDF_COLORS.primary);
    doc.text('SCHOOL PERFORMANCE REPORT', 105, 37, { align: 'center' });
    doc.setFontSize(10);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(`${term} ${year}`, 105, 44, { align: 'center' });

    const percentage = (value) => value == null ? '—' : `${Number(value).toFixed(1)}%`;
    autoTable(doc, {
        startY: 55,
        head: [['Performance indicator', 'Result']],
        body: [
            ['School mean score', percentage(kpis?.avgScore)],
            ['Pass rate', percentage(kpis?.passRate)],
            ['Competency mastery', percentage(kpis?.competencyMastery)],
            ['Total students', String(kpis?.totalStudents ?? 0)],
            ['Students assessed', String(kpis?.studentsWithScores ?? 0)],
            ['Scores recorded', String(kpis?.totalScores ?? 0)]
        ],
        theme: 'grid',
        headStyles: { fillColor: PDF_COLORS.primary },
        bodyStyles: { fontSize: 10 }
    });
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`Generated ${new Date().toLocaleString()}`, 10, 285);
    const filename = `Performance_Report_${term.replace(/\s+/g, '_')}_${year}.pdf`;
    return saveGeneratedPdf(doc, filename);
}

export async function downloadTranscriptPDF(student, scores, school) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    await addSchoolHeader(doc, school, 'Official Academic Transcript');
    const fullName = [student?.firstName, student?.lastName].filter(Boolean).join(' ') || 'Student';
    const promotions = (student?.historicalRecords || student?.history || []).filter(
        (record) => record.type === 'promotion'
    );

    autoTable(doc, {
        startY: 38,
        head: [['Student information', 'Details']],
        body: [
            ['Student name', fullName],
            ['Admission number', student?.admissionNumber || student?.studentId || '—'],
            ['Class / level', [student?.class, student?.level].filter(Boolean).join(' / ') || '—'],
            ['Academic year', student?.academicYear || '—'],
            ['Gender', student?.gender || '—'],
            ['Status', student?.status || 'Archived']
        ],
        theme: 'grid',
        headStyles: { fillColor: PDF_COLORS.primary },
        bodyStyles: { fontSize: 9 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 48 } }
    });

    const scoreRows = (scores || []).map((score) => [
        score.year || score.academicYear || '—',
        score.term || '—',
        score.assessmentType || score.assessment || '—',
        score.subject || score.subjectName || '—',
        score.score ?? '—',
        score.outOf || 100,
        score.grade || getGradeFromScore(score.score)
    ]);
    let sectionY = (doc.lastAutoTable?.finalY || 80) + 10;
    doc.setFontSize(11);
    doc.setTextColor(...PDF_COLORS.primary);
    doc.text('Academic results', 14, sectionY);
    autoTable(doc, {
        startY: sectionY + 4,
        head: [['Year', 'Term', 'Assessment', 'Subject', 'Score', 'Out of', 'Grade']],
        body: scoreRows.length ? scoreRows : [['—', '—', '—', 'No marks found', '—', '—', '—']],
        theme: 'striped',
        headStyles: { fillColor: PDF_COLORS.primary, fontSize: 8 },
        bodyStyles: { fontSize: 8 },
        styles: { overflow: 'linebreak' }
    });

    if (promotions.length) {
        sectionY = (doc.lastAutoTable?.finalY || 100) + 10;
        doc.setFontSize(11);
        doc.setTextColor(...PDF_COLORS.primary);
        doc.text('Promotion history', 14, sectionY);
        autoTable(doc, {
            startY: sectionY + 4,
            head: [['Year', 'From', 'Promoted to', 'Date']],
            body: promotions.map((record) => [
                record.year || record.academicYear || '—',
                [record.fromLevel, record.fromClass].filter(Boolean).join(' / ') || '—',
                [record.toLevel, record.toClass].filter(Boolean).join(' / ') || '—',
                record.date ? new Date(record.date).toLocaleDateString() : '—'
            ]),
            theme: 'grid',
            headStyles: { fillColor: PDF_COLORS.primary },
            bodyStyles: { fontSize: 8 }
        });
    }

    const safeName = fullName.trim().replace(/[^A-Za-z0-9_-]+/g, '_') || 'Student';
    return saveGeneratedPdf(doc, `Transcript_${safeName}_${student?.academicYear || 'Archive'}.pdf`);
}

export async function downloadTimetablePDF(scheduleData, title, school, term, year) {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    await addSchoolHeader(doc, school, title || 'Timetable');
    const rows = Array.isArray(scheduleData) ? scheduleData : scheduleData?.rows || [];
    autoTable(doc, {
        startY: 40,
        head: [['Day', 'Time', 'Class', 'Subject', 'Teacher', 'Room']],
        body: rows.map((row) => [
            row.day || row.dayName || '—',
            row.time || row.period || '—',
            row.className || row.class || '—',
            row.subject || '—',
            row.teacherName || row.teacher || '—',
            row.room || row.venue || '—'
        ]),
        theme: 'grid',
        headStyles: { fillColor: PDF_COLORS.primary },
        styles: { fontSize: 8 }
    });
    return saveGeneratedPdf(doc, `Timetable_${term || ''}_${year || ''}.pdf`);
}

export async function downloadStudentInvoicePDF(invoice, school) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    await addSchoolHeader(doc, school, 'Student Fee Invoice');
    doc.setFontSize(10);
    doc.setTextColor(...PDF_COLORS.text);
    doc.text(`Invoice: ${invoice?.invoiceNumber || invoice?.id || '—'}`, 14, 40);
    doc.text(`Student: ${invoice?.studentName || '—'}`, 14, 48);
    doc.text(`Admission number: ${invoice?.admissionNumber || '—'}`, 14, 56);
    doc.text(`Class: ${invoice?.studentClass || invoice?.class || '—'}`, 110, 48);
    doc.text(`Term / year: ${[invoice?.term, invoice?.academicYear || invoice?.year].filter(Boolean).join(' ') || '—'}`, 110, 56);
    doc.text(`Due date: ${invoice?.dueDate || '—'}`, 14, 64);
    autoTable(doc, {
        startY: 72,
        head: [['Description', 'Quantity', 'Unit price (KES)', 'Amount (KES)']],
        body: (invoice?.items || []).map((item) => [
            item.description || 'Fee item',
            Number(item.quantity || 1),
            Number(item.unitPrice ?? item.amount ?? 0).toLocaleString(),
            (Number(item.amount || 0) * Number(item.quantity || 1)).toLocaleString()
        ]),
        theme: 'striped',
        headStyles: { fillColor: PDF_COLORS.primary }
    });
    const finalY = doc.lastAutoTable?.finalY || 90;
    autoTable(doc, {
        startY: finalY + 6,
        body: [
            ['Subtotal', `KES ${Number(invoice?.subtotal ?? invoice?.total ?? 0).toLocaleString()}`],
            ['Tax', `KES ${Number(invoice?.tax || 0).toLocaleString()}`],
            ['Discount', `KES ${Number(invoice?.discount || 0).toLocaleString()}`],
            ['Total due', `KES ${Number(invoice?.total || 0).toLocaleString()}`],
            ['Amount paid', `KES ${Number(invoice?.paidAmount || 0).toLocaleString()}`],
            ['Balance', `KES ${Number(invoice?.remainingBalance ?? (Number(invoice?.total || 0) - Number(invoice?.paidAmount || 0))).toLocaleString()}`]
        ],
        theme: 'plain',
        styles: { fontSize: 10 },
        columnStyles: { 0: { fontStyle: 'bold' }, 1: { halign: 'right' } }
    });
    return saveGeneratedPdf(doc, `Invoice_${invoice?.invoiceNumber || invoice?.id || Date.now()}.pdf`);
}

// ============================================================
// CBC STUDENT REPORTS — consumed by src/pages/StudentReports.jsx
// ============================================================

// Aligned with the canonical key in src/utils/constants.js and
// netlify/functions/generate-student-report.js.
// BE is "Below Expectations" (never "Beginning").
const CBC_GRADES = [
    { min: 80, code: 'EE', level: 'EE', label: 'Exceeding Expectations',   points: 8 },
    { min: 65, code: 'ME', level: 'ME', label: 'Meeting Expectations',      points: 6 },
    { min: 50, code: 'AE', level: 'AE', label: 'Approaching Expectations',  points: 4 },
    { min: 40, code: 'BE', level: 'BE', label: 'Below Expectations',        points: 2 },
    { min: 0,  code: 'BE', level: 'BE', label: 'Below Expectations',        points: 1 },
];

function cbcGrade(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) {
        return { code: 'NA', level: 'NA', label: 'Not Assessed', points: null };
    }
    return CBC_GRADES.find(g => n >= g.min) || CBC_GRADES[CBC_GRADES.length - 1];
}

function safeName(student) {
    const n = `${student?.firstName || ''}_${student?.lastName || ''}`.trim();
    return (n || 'Student').replace(/[^A-Za-z0-9_-]+/g, '_');
}

function fmtDate(d) {
    if (!d) return '—';
    try {
        return new Date(d).toLocaleDateString('en-KE', {
            day: '2-digit', month: 'short', year: 'numeric',
        });
    } catch { return '—'; }
}

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

function buildClassTeacherComment({ meanScore, assessedCount, totalSubjects, subjectRows }) {
    if (assessedCount === 0) return 'No assessments recorded for this student this term.';
    const overall = cbcGrade(meanScore);
    const assessed = subjectRows.filter((r) => r.average != null);
    const sorted = [...assessed].sort((a, b) => b.average - a.average);
    const best = sorted[0];
    const weakest = sorted[sorted.length - 1];

    const strength = best ? ` Strongest in ${best.subject} (${best.average}%).` : '';
    const weakness = (weakest && weakest.subject !== best?.subject && weakest.average < 65)
        ? ` Weakest in ${weakest.subject} (${weakest.average}%); needs attention.` : '';
    const coverageRatio = totalSubjects > 0 ? assessedCount / totalSubjects : 0;
    const caveat = coverageRatio < 0.7 ? ` Covers ${assessedCount}/${totalSubjects} learning areas.` : '';

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

/**
 * Letterhead header for the jsPDF-based CBC report form.
 * Draws logo (left) or centres text when no logo. Returns the y coordinate
 * of the bottom rule.
 */
function drawCBCHeader(doc, meta, titleLine) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const MARGIN = 10;
    const HEADER_TOP = 10;
    const LOGO_SIZE = 20;

    const logoUrl = meta?.schoolLogo || meta?.logoUrl || meta?.logo || '';
    let hasLogo = false;
    if (logoUrl) {
        try {
            const ext = String(logoUrl).toLowerCase().endsWith('.jpg') || String(logoUrl).toLowerCase().endsWith('.jpeg')
                ? 'JPEG'
                : 'PNG';
            doc.addImage(logoUrl, ext, MARGIN, HEADER_TOP, LOGO_SIZE, LOGO_SIZE);
            hasLogo = true;
        } catch (e) {
            console.warn('Logo could not be embedded:', e?.message || e);
        }
    }

    const textX = hasLogo ? MARGIN + LOGO_SIZE + 6 : MARGIN;
    const textW = pageWidth - textX - MARGIN;
    const align = hasLogo ? 'left' : 'center';
    const centerX = hasLogo ? textX + textW / 2 : pageWidth / 2;

    doc.setTextColor(...PDF_COLORS.primary);
    doc.setFont('times', 'bold');
    doc.setFontSize(15);
    doc.text((meta?.schoolName || 'SCHOOL').toUpperCase(), centerX, HEADER_TOP + 6, { align, maxWidth: textW });

    let cy = HEADER_TOP + 12;
    if (meta?.schoolMotto) {
        doc.setFont('times', 'italic');
        doc.setFontSize(9);
        doc.setTextColor(...PDF_COLORS.gray);
        doc.text(`Motto: ${meta.schoolMotto}`, centerX, cy, { align, maxWidth: textW });
        cy += 5;
    }

    doc.setFont('times', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(51, 51, 51);
    const contactLines = [
        meta?.schoolAddress,
        meta?.schoolPhone ? `Tel: ${meta.schoolPhone}` : '',
        meta?.schoolEmail ? `Email: ${meta.schoolEmail}` : '',
        meta?.website ? `Website: ${meta.website}` : '',
        meta?.schoolCode ? `School Code: ${meta.schoolCode}` : '',
    ].filter(Boolean);

    for (const line of contactLines) {
        doc.text(line, centerX, cy, { align, maxWidth: textW });
        cy += 4;
    }

    const blockBottom = Math.max(cy, HEADER_TOP + (hasLogo ? LOGO_SIZE : 0)) + 2;
    doc.setDrawColor(...PDF_COLORS.primary);
    doc.setLineWidth(0.6);
    doc.line(MARGIN, blockBottom, pageWidth - MARGIN, blockBottom);

    // Title line
    doc.setFont('times', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    doc.text(titleLine, pageWidth / 2, blockBottom + 6, { align: 'center' });

    return blockBottom + 10;
}

/**
 * Draws the student info panel; returns y below the block.
 */
function drawStudentInfo(doc, student, meta, term, startY) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const MARGIN = 10;
    const CONTENT_W = pageWidth - MARGIN * 2;
    const boxH = 16;
    doc.setDrawColor(...PDF_COLORS.border);
    doc.setLineWidth(0.3);
    doc.rect(MARGIN, startY, CONTENT_W, boxH);

    doc.setFontSize(9);
    doc.setTextColor(...PDF_COLORS.text);
    doc.setFont('times', 'bold');
    doc.text('Name:', MARGIN + 3, startY + 6);
    doc.setFont('times', 'normal');
    doc.text(`${student.firstName || ''} ${student.lastName || ''}`.trim() || '—', MARGIN + 15, startY + 6);

    doc.setFont('times', 'bold');
    doc.text('Adm No:', MARGIN + 3, startY + 12);
    doc.setFont('times', 'normal');
    doc.text(String(student.admissionNumber || student.studentId || '—'), MARGIN + 20, startY + 12);

    doc.setFont('times', 'bold');
    doc.text('Class:', MARGIN + CONTENT_W / 2, startY + 6);
    doc.setFont('times', 'normal');
    doc.text(String(student.class || meta?.cls || '—'), MARGIN + CONTENT_W / 2 + 15, startY + 6);

    doc.setFont('times', 'bold');
    doc.text('Term:', MARGIN + CONTENT_W / 2, startY + 12);
    doc.setFont('times', 'normal');
    doc.text(String(term || meta?.term || '—'), MARGIN + CONTENT_W / 2 + 15, startY + 12);

    return startY + boxH + 3;
}

// ------------------------------------------------------------
// 1. TRANSCRIPTS — 4 students per A4 portrait page.
//    Each card is measured so it never overlaps the next.
// ------------------------------------------------------------
export async function downloadTranscripts({ students, meta, subjects, term, assessmentIndex = 0 }) {
    if (!Array.isArray(students) || students.length === 0) {
        throw new Error('No students supplied for transcripts.');
    }
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    const PER_PAGE = 4;
    const MARGIN_X = 8;
    const MARGIN_Y = 8;
    const GAP = 6;
    const contentH = pageHeight - MARGIN_Y * 2 - GAP * (PER_PAGE - 1);
    const cardH = contentH / PER_PAGE;
    const subjectList = Array.isArray(subjects) ? subjects : [];

    students.forEach((student, idx) => {
        const slot = idx % PER_PAGE;
        if (idx > 0 && slot === 0) doc.addPage();

        const cardTop = MARGIN_Y + slot * (cardH + GAP);
        const cardLeft = MARGIN_X;
        const cardW = pageWidth - MARGIN_X * 2;

        // Card border
        doc.setDrawColor(...PDF_COLORS.primary);
        doc.setLineWidth(0.4);
        doc.rect(cardLeft, cardTop, cardW, cardH);

        // Header band
        doc.setFillColor(...PDF_COLORS.primary);
        doc.rect(cardLeft, cardTop, cardW, 7, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('times', 'bold');
        doc.setFontSize(8.5);
        doc.text(
            `${(meta?.schoolName || 'SCHOOL').toUpperCase()} • TRANSCRIPT • ${term || meta?.term || ''}`,
            cardLeft + 3,
            cardTop + 4.8
        );
        doc.text(`Assessment ${assessmentIndex + 1}`, cardLeft + cardW - 3, cardTop + 4.8, { align: 'right' });

        // Student info
        doc.setTextColor(...PDF_COLORS.text);
        doc.setFont('times', 'bold');
        doc.setFontSize(8);
        doc.text(
            `${student.firstName || ''} ${student.lastName || ''}`.trim() || '—',
            cardLeft + 3,
            cardTop + 11
        );
        doc.setFont('times', 'normal');
        doc.setFontSize(7);
        doc.text(
            `Adm: ${student.admissionNumber || student.studentId || '—'}   Class: ${student.class || meta?.cls || '—'}`,
            cardLeft + 3,
            cardTop + 15
        );

        // Subject table — bounded by card
        const body = subjectList.map(subject => {
            const list = Array.isArray(student.scores?.[subject]) ? student.scores[subject] : [];
            const score = list[assessmentIndex] ?? list[0] ?? null;
            const avg = student.averages?.[subject] ?? null;
            const grade = cbcGrade(avg);
            return [
                subject,
                score != null ? String(score) : '—',
                avg != null ? `${avg}%` : '—',
                avg != null ? grade.code : '—',
                avg != null && grade.points != null ? grade.points.toFixed(1) : '—'
            ];
        });

        const tableStartY = cardTop + 17;
        const tableBottomReserve = 10; // for the footer summary inside the card
        const tableMaxBottom = cardTop + cardH - tableBottomReserve;

        autoTable(doc, {
            startY: tableStartY,
            margin: { left: cardLeft + 2, right: cardLeft + 2, top: tableStartY, bottom: pageHeight - tableMaxBottom },
            head: [[`Subject`, `A${assessmentIndex + 1}`, 'Avg %', 'CBC', 'Pts']],
            body: body.length ? body : [['No subjects', '—', '—', '—', '—']],
            theme: 'grid',
            headStyles: { fillColor: PDF_COLORS.primary, fontSize: 6.5, halign: 'center', cellPadding: 0.6 },
            bodyStyles: { fontSize: 6.5, cellPadding: 0.6 },
            columnStyles: {
                0: { halign: 'left' },
                1: { halign: 'center' },
                2: { halign: 'center' },
                3: { halign: 'center' },
                4: { halign: 'center' }
            },
            styles: { overflow: 'linebreak' }
        });

        // Summary line inside card
        const overall = student.overallAverage || 0;
        const og = cbcGrade(overall);
        doc.setFont('times', 'bold');
        doc.setFontSize(6.8);
        doc.setTextColor(...PDF_COLORS.primary);
        doc.text(
            `Overall: ${overall}%   CBC: ${og.code}   Points: ${og.points != null ? og.points.toFixed(1) : '—'}   Assessed: ${student.assessedCount || 0}/${student.totalSubjects || subjectList.length}`,
            cardLeft + 3,
            cardTop + cardH - 3
        );
    });

    // No page numbers.

    const safeTerm = String(term || meta?.term || 'Term').replace(/\s+/g, '_');
    return saveGeneratedPdf(
        doc,
        `Transcripts_${safeTerm}_A${assessmentIndex + 1}_${meta?.cls || 'Class'}.pdf`
    );
}

// ------------------------------------------------------------
// 2. FULL REPORT FORMS — one student per A4 page, flowing layout
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
    const principalName = meta?.principalName || '—';

    students.forEach((student, idx) => {
        if (idx > 0) doc.addPage();

        let y = drawCBCHeader(doc, meta, 'CBC ACADEMIC PROGRESS REPORT');
        y = drawStudentInfo(doc, student, meta, term, y);

        // Student-line
        const fullName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || '—';
        const admissionNo = student.admissionNumber || student.studentId || '—';
        const grade = student.class || meta?.cls || '—';
        doc.setFont('times', 'bold');
        doc.setFontSize(9.5);
        doc.setTextColor(0, 0, 0);
        doc.text(
            `Student: ${fullName}  |  Adm No: ${admissionNo}  |  Grade: ${grade}`,
            pageWidth / 2, y + 2, { align: 'center' }
        );
        y += 8;

        // Compute rows
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
        const totalPoints = assessedRows.reduce((s, r) => s + (r.cbc.points || 0), 0);
        const avgPoints = assessedCount > 0 ? (totalPoints / assessedCount).toFixed(1) : '—';
        const overall = cbcGrade(meanScore);

        // Active indices per student
        const activeIndices = detectActiveAssessmentIndices(student);
        const assessmentCount = activeIndices.length;

        // Marks line
        doc.setFont('times', 'bold');
        doc.setFontSize(8.5);
        doc.text(
            `Marks: ${totalScore}/${totalMarks}  |  Avg: ${meanScore.toFixed(2)}/100  |  ` +
            `Overall Pos.: ${student.position || '—'}/${student.classSize || '—'}  |  ` +
            `Grade: ${overall.code === 'NA' ? '—' : overall.code}`,
            pageWidth / 2, y, { align: 'center' }
        );
        y += 4;

        // Main table (dynamic columns per student)
        const head = ['Learning Area'];
        for (let i = 0; i < assessmentCount; i++) head.push(`A${activeIndices[i] + 1}`);
        head.push('Avg', 'P.L', 'Points', 'Remark');

        const body = [];
        subjectRows.forEach((row, sIdx) => {
            const subjectPapers = Array.isArray(paperConfigBySubject[row.subject])
                ? paperConfigBySubject[row.subject]
                : [];
            const paperScores = (student.papersBySubject && student.papersBySubject[row.subject]) || {};

            // Branch rows
            subjectPapers.forEach((paper) => {
                const p = paperScores[paper.name] || null;
                const branchScore = p && p.score != null ? Number(p.score) : null;
                const branchRow = [{ content: `    └ ${paper.name}`, styles: { textColor: PDF_COLORS.gray, fontStyle: 'italic' } }];
                for (let i = 0; i < assessmentCount; i++) branchRow.push('—');
                branchRow.push(branchScore != null ? String(branchScore) : '—', '', '', 'Branch');
                body.push(branchRow);
            });

            // Subject total row
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
        for (let i = 1; i <= assessmentCount; i++) {
            columnStyles[i] = { halign: 'center', cellWidth: 12 };
        }
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

        // TOTAL / AVG summary rows are implicit in the subject totals; skip
        // explicit totals to keep flow clean — the "Marks" line already
        // carries the overall total.

        // Remarks — class teacher
        const teacherComment = (student.teacherComment && String(student.teacherComment).trim())
            || buildClassTeacherComment({
                meanScore, assessedCount, totalSubjects: subjectList.length,
                subjectRows: subjectRows.map(r => ({ subject: r.subject, average: r.average })),
            });

        if (y > pageHeight - 60) { doc.addPage(); y = 15; }

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

        // Head teacher remark
        const headTeacherComment = (student.principalComment && String(student.principalComment).trim())
            || buildHeadTeacherComment({
                meanScore, assessedCount, totalSubjects: subjectList.length,
                subjectRows: subjectRows.map(r => ({ subject: r.subject, average: r.average })),
                student,
            });

        if (y > pageHeight - 50) { doc.addPage(); y = 15; }

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
        y += headTeacherLines.length * 4 + 3;

        doc.setDrawColor(51, 51, 51);
        doc.setLineWidth(0.4);
        doc.line(MARGIN, y + 4, MARGIN + 50, y + 4);
        doc.setFont('times', 'italic');
        doc.setFontSize(7);
        doc.setTextColor(...PDF_COLORS.gray);
        doc.text('Signature / Date', MARGIN, y + 7);
        y += 11;

        // Term & Signatory table
        if (y > pageHeight - 40) { doc.addPage(); y = 15; }
        const infoRowH = 6;
        const infoLabelW = 32;
        const col2X = MARGIN + CONTENT_W / 2;
        const infoRows = [
            [
                { label: 'Term Started', value: fmtDate(meta?.currentTermStart || meta?.termStart) },
                { label: 'Class Teacher', value: classTeacherName },
            ],
            [
                { label: 'Closing Date', value: fmtDate(meta?.currentTermEnd) },
                { label: 'Head Teacher', value: principalName },
            ],
            [
                { label: 'Next Opening', value: fmtDate(meta?.nextTermStart) },
                { label: '', value: '' },
            ],
        ];

        // Header strip
        doc.setFillColor(238, 242, 255);
        doc.rect(MARGIN, y, CONTENT_W, infoRowH, 'F');
        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.3);
        doc.rect(MARGIN, y, CONTENT_W, infoRowH);
        doc.setFont('times', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(0, 0, 0);
        doc.text('Term & Signatory Information', MARGIN + 2, y + 4);
        y += infoRowH;

        infoRows.forEach((row, iIdx) => {
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
                doc.text(String(cell.value || '—'), cx + 2 + infoLabelW, y + 4, {
                    maxWidth: cw - infoLabelW - 4,
                });
            };

            drawCell(MARGIN, row[0], CONTENT_W / 2);
            drawCell(col2X, row[1], CONTENT_W / 2);

            y += infoRowH;
        });

        doc.setDrawColor(0, 0, 0);
        doc.setLineWidth(0.5);
        doc.rect(MARGIN, y - infoRowH * (infoRows.length + 1), CONTENT_W, infoRowH * (infoRows.length + 1));
        y += 5;

        // Final signatures
        if (y > pageHeight - 30) { doc.addPage(); y = 15; }
        const sigW = (CONTENT_W - 20) / 2;
        doc.setFont('times', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(0, 0, 0);
        doc.text('Class Teacher', MARGIN, y, { align: 'left' });
        doc.text('Head Of Institution (HOI)', col2X + 10, y, { align: 'left' });
        y += 4;
        doc.setFont('times', 'normal');
        doc.text(classTeacherName, MARGIN, y + 30);
        doc.text(principalName, col2X + 10, y + 30);

        // Footer (no page numbers)
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
// 3. SINGLE STUDENT REPORT FORM — thin wrapper over the above
// ------------------------------------------------------------
export async function downloadStudentReportForm({ student, meta, subjects, term }) {
    return downloadClassReportForms({ students: [student], meta, subjects, term });
}
