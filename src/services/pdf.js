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

// Head teacher comment WITHOUT the "Advisory:" prefix.
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
 * Resolve head teacher / principal name with the same precedence the
 * SchoolProfile page uses (role: 'headteacher' → user.fullName).
 */
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

/**
 * Letterhead header for the jsPDF-based CBC report form.
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
            const lower = String(logoUrl).toLowerCase();
            const ext = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'JPEG' : 'PNG';
            doc.addImage(logoUrl, ext, MARGIN, HEADER_TOP, LOGO_SIZE, LOGO_SIZE);
            hasLogo = true;
        } catch (e) {
            console.warn('Logo could not be embedded:', e?.message || e);
        }
    }

    const textLeft = hasLogo ? MARGIN + LOGO_SIZE + 4 : MARGIN;
    const textWidth = pageWidth - textLeft - MARGIN;
    const centreX = hasLogo ? textLeft + textWidth / 2 : pageWidth / 2;
    const align = 'center';

    let cy = HEADER_TOP + 1;

    doc.setTextColor(...PDF_COLORS.primary);
    doc.setFont('times', 'bold');
    doc.setFontSize(14);
    const schoolNameLines = doc.splitTextToSize(
        (meta?.schoolName || 'SCHOOL').toUpperCase(),
        textWidth
    );
    schoolNameLines.forEach(line => {
        doc.text(line, centreX, cy, { align });
        cy += 5.5;
    });

    if (meta?.schoolMotto) {
        doc.setFont('times', 'italic');
        doc.setFontSize(8.5);
        doc.setTextColor(...PDF_COLORS.gray);
        doc.text(`Motto: ${meta.schoolMotto}`, centreX, cy, { align, maxWidth: textWidth });
        cy += 4.5;
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
        doc.text(line, centreX, cy, { align, maxWidth: textWidth });
        cy += 4;
    }

    const logoBottom = hasLogo ? HEADER_TOP + LOGO_SIZE : 0;
    const blockBottom = Math.max(cy, logoBottom) + 2;

    doc.setDrawColor(...PDF_COLORS.primary);
    doc.setLineWidth(0.6);
    doc.line(MARGIN, blockBottom, pageWidth - MARGIN, blockBottom);

    doc.setFont('times', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    doc.text(titleLine, pageWidth / 2, blockBottom + 6, { align: 'center' });

    return blockBottom + 10;
}

/**
 * Student identity panel + Year / Current Year row.
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

    

    return startY + boxH + 3;
}

// ------------------------------------------------------------
// 1. TRANSCRIPTS — 4 landscape slips per portrait A4 page.
//    Each slip reads left→right. Includes cutting marks.
//    Table is drawn FIRST so bio + summary can never be erased.
//    Extra subjects that cannot fit overflow to a continuation card.
// ------------------------------------------------------------
export async function downloadTranscripts({ students, meta, subjects, term, assessmentIndex = 0 }) {
    if (!Array.isArray(students) || students.length === 0) {
        throw new Error('No students supplied for transcripts.');
    }
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();     // 210
    const pageHeight = doc.internal.pageSize.getHeight();   // 297

    // ---- Sheet layout ----
    const PER_PAGE = 4;
    const SIDE_MARGIN = 10;
    const PRINT_LEFT = SIDE_MARGIN;
    const PRINT_RIGHT = pageWidth - SIDE_MARGIN;
    const PRINT_TOP = 10;
    const PRINT_BOTTOM = pageHeight - 10;
    const PRINT_W = PRINT_RIGHT - PRINT_LEFT;               // 190 mm
    const PRINT_H = PRINT_BOTTOM - PRINT_TOP;               // 277 mm
    const CARD_H = PRINT_H / PER_PAGE;                      // ≈ 69.25 mm
    const CARD_W = PRINT_W;                                 // 190 mm

    // ---- Inside each slip ----
    const HEADER_H = 7;
    const SUMMARY_H = 14;
    const BIO_W = 52;
    const TABLE_LEFT = PRINT_LEFT + BIO_W;
    const TABLE_RIGHT = PRINT_LEFT + CARD_W - 2;
    const TABLE_W = TABLE_RIGHT - TABLE_LEFT;               // ≈ 136 mm
    const TABLE_TOP_OFF = HEADER_H + 1;
    const TABLE_BOTTOM_RESERVE = SUMMARY_H + 1;

    // Cut mark geometry
    const TICK = 3;
    const DASH = 1.5;
    const GAP = 1.2;

    const subjectList = Array.isArray(subjects) ? subjects : [];
    const subjectCount = subjectList.length;

    // ---- Row-height model for autoTable (mm) ----
    // A single-line row at fontSize F with cellPadding P is roughly
    // (F * 0.35) + (P * 2) + line border. autoTable's default row height
    // is close to 5mm at fontSize 8/padding 1. We model it directly.
    const HEAD_ROW_H = (fontSize, padding) => fontSize * 0.42 + padding * 2 + 0.4;
    const BODY_ROW_H = (fontSize, padding) => fontSize * 0.42 + padding * 2 + 0.2;

    // Table body is inside the card between header-band and summary-band.
    const availableTableH = CARD_H - TABLE_TOP_OFF - TABLE_BOTTOM_RESERVE;

    // Try progressively smaller fonts until everything fits.
    const layoutCandidates = [
        { fontSize: 7.2, cellPadding: 0.8 },
        { fontSize: 6.8, cellPadding: 0.7 },
        { fontSize: 6.4, cellPadding: 0.6 },
        { fontSize: 6.0, cellPadding: 0.5 },
        { fontSize: 5.6, cellPadding: 0.4 },
        { fontSize: 5.2, cellPadding: 0.35 },
    ];

    const pickLayout = (rowCount) => {
        for (const c of layoutCandidates) {
            const need = HEAD_ROW_H(c.fontSize, c.cellPadding)
                + rowCount * BODY_ROW_H(c.fontSize, c.cellPadding);
            if (need <= availableTableH) return c;
        }
        return null; // cannot fit → paginate
    };

    // How many subject rows fit at the smallest font?
    const smallest = layoutCandidates[layoutCandidates.length - 1];
    const maxRowsAtSmallest = Math.max(
        1,
        Math.floor(
            (availableTableH - HEAD_ROW_H(smallest.fontSize, smallest.cellPadding))
            / BODY_ROW_H(smallest.fontSize, smallest.cellPadding)
        )
    );

    // Chunk the subject list for this student so each chunk fits a card.
    const chunkSubjects = (rowCount) => {
        if (rowCount <= maxRowsAtSmallest) return [subjectList];
        // No — try the largest font that fits everything, else chunk.
        if (pickLayout(rowCount)) return [subjectList];
        const chunks = [];
        let start = 0;
        while (start < subjectList.length) {
            const end = Math.min(subjectList.length, start + maxRowsAtSmallest);
            chunks.push(subjectList.slice(start, end));
            start = end;
        }
        return chunks;
    };

    // ---- Summary computation ----
    const buildSummary = (student) => {
        const scores = student.scores || {};
        const averages = student.averages || {};

        let totalMarks = 0;
        let totalMax = 0;
        let assessedAtThisIndex = 0;
        subjectList.forEach((subject) => {
            const list = Array.isArray(scores[subject]) ? scores[subject] : [];
            const v = list[assessmentIndex] ?? null;
            if (v != null && !isNaN(v)) {
                totalMarks += Number(v);
                totalMax += 100;
                assessedAtThisIndex += 1;
            }
        });

        const assessedAvgs = subjectList
            .map((s) => averages[s])
            .filter((v) => v != null && !isNaN(v));
        const overallAverage = assessedAvgs.length
            ? Math.round(assessedAvgs.reduce((a, b) => a + b, 0) / assessedAvgs.length)
            : 0;

        const grade = cbcGrade(overallAverage);

        const year = student.academicYear
            || student.year
            || meta?.academicYear?.start
            || meta?.year
            || new Date().getFullYear();
        const currentYear = new Date().getFullYear();

        return {
            totalMarks,
            totalMax: totalMax || subjectList.length * 100,
            assessedAtThisIndex,
            overallAverage,
            grade,
            position: student.position || null,
            classSize: student.classSize || null,
            year,
            currentYear,
        };
    };

    // ---- Cutting guides ----
    const drawCropMarks = (top, bottom) => {
        doc.setDrawColor(90, 90, 90);
        doc.setLineWidth(0.15);
        doc.line(PRINT_LEFT - TICK, top, PRINT_LEFT, top);
        doc.line(PRINT_LEFT - TICK, bottom, PRINT_LEFT, bottom);
        doc.line(PRINT_RIGHT, top, PRINT_RIGHT + TICK, top);
        doc.line(PRINT_RIGHT, bottom, PRINT_RIGHT + TICK, bottom);
    };

    const drawHorizontalCut = (y) => {
        doc.setDrawColor(165, 165, 165);
        doc.setLineWidth(0.2);
        let x = PRINT_LEFT - TICK;
        const xEnd = PRINT_RIGHT + TICK;
        while (x < xEnd) {
            const nx = Math.min(x + DASH, xEnd);
            doc.line(x, y, nx, y);
            x = nx + GAP;
        }
    };

    // ---- Ellipsis helper ----
    const ellipsize = (text, maxWidth, fontSize, fontStyle) => {
        const s = String(text ?? '—');
        doc.setFont('times', fontStyle || 'normal');
        doc.setFontSize(fontSize);
        if (doc.getTextWidth(s) <= maxWidth) return s;
        let lo = 0;
        let hi = s.length;
        while (lo < hi) {
            const mid = Math.floor((lo + hi + 1) / 2);
            const candidate = s.slice(0, mid) + '…';
            if (doc.getTextWidth(candidate) <= maxWidth) lo = mid;
            else hi = mid - 1;
        }
        return s.slice(0, lo) + '…';
    };

    // ---- Draw the header band ----
    const drawHeaderBand = (cardTop, student, isContinuation) => {
        doc.setFillColor(...PDF_COLORS.primary);
        doc.rect(PRINT_LEFT, cardTop, CARD_W, HEADER_H, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('times', 'bold');
        doc.setFontSize(7.8);
        const headerParts = [
            (meta?.schoolName || 'SCHOOL').toUpperCase(),
            `Class: ${student.class || meta?.cls || '—'}`,
            `Term: ${term || meta?.term || '—'}`,
            `Assessment ${assessmentIndex + 1}`,
            `Year: ${student.academicYear || student.year || meta?.year || new Date().getFullYear()}`,
        ];
        const line = headerParts.join('   •   ');
        doc.text(line, PRINT_LEFT + 3, cardTop + HEADER_H - 2.4, { maxWidth: CARD_W - 30 });
        doc.setFont('times', 'italic');
        doc.setFontSize(6.3);
        doc.text(
            isContinuation ? 'TRANSCRIPT (cont.)' : 'TRANSCRIPT',
            PRINT_LEFT + CARD_W - 3,
            cardTop + HEADER_H - 2.4,
            { align: 'right' }
        );
    };

    // ---- Draw bio column ----
    const drawBioColumn = (cardTop, cardBottom, student) => {
        const bioLeft = PRINT_LEFT + 3;
        const bioMaxW = BIO_W - 6;
        let bioY = cardTop + HEADER_H + 5;

        doc.setTextColor(...PDF_COLORS.primary);
        doc.setFont('times', 'bold');
        doc.setFontSize(8.5);
        const fullName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || '—';
        const nameLines = doc.splitTextToSize(fullName, bioMaxW);
        nameLines.slice(0, 2).forEach((line) => {
            doc.text(line, bioLeft, bioY);
            bioY += 4.0;
        });

        doc.setTextColor(...PDF_COLORS.text);
        doc.setFont('times', 'normal');
        doc.setFontSize(6.4);

        const labelW = 15;
        const valueW = BIO_W - 6 - labelW - 1;
        const bioRows = [
            ['Adm', student.admissionNumber || student.studentId || '—'],
            ['Class', student.class || meta?.cls || '—'],
            ['Term', term || meta?.term || '—'],
            ['Year', String(student.academicYear || student.year || meta?.year || new Date().getFullYear())],
        ];
        bioRows.forEach(([label, value]) => {
            doc.setFont('times', 'bold');
            doc.text(`${label}:`, bioLeft, bioY);
            doc.setFont('times', 'normal');
            doc.text(
                ellipsize(value, valueW, 6.4, 'normal'),
                bioLeft + labelW,
                bioY
            );
            bioY += 3.5;
        });

        // Bottom-of-column "assessed" caption — anchored to cardBottom, so
        // it always sits above the summary strip.
        const summary = buildSummary(student);
        doc.setFont('times', 'italic');
        doc.setFontSize(6.0);
        doc.setTextColor(...PDF_COLORS.gray);
        doc.text(
            `Assessed: ${summary.assessedAtThisIndex}/${subjectCount}`,
            bioLeft,
            cardBottom - SUMMARY_H - 1.5
        );
    };

    // ---- Draw summary strip ----
    const drawSummaryStrip = (cardTop, cardBottom, student) => {
        const stripTop = cardBottom - SUMMARY_H;

        // Solid white backing so nothing under it leaks through
        doc.setFillColor(255, 255, 255);
        doc.rect(PRINT_LEFT, stripTop, CARD_W, SUMMARY_H, 'F');

        // Top divider
        doc.setDrawColor(...PDF_COLORS.border);
        doc.setLineWidth(0.25);
        doc.line(PRINT_LEFT + 2, stripTop, PRINT_LEFT + CARD_W - 2, stripTop);

        const summary = buildSummary(student);
        const stripMidY = stripTop + 5;
        const stripLowY = stripTop + 10;

        doc.setFont('times', 'bold');
        doc.setFontSize(7);
        doc.setTextColor(...PDF_COLORS.primary);
        const summaryLine =
            `Total: ${summary.totalMarks}/${summary.totalMax}` +
            `   •   Avg: ${summary.overallAverage}%` +
            `   •   CBC: ${summary.grade.code}` +
            `   •   Pts: ${summary.grade.points != null ? summary.grade.points.toFixed(1) : '—'}` +
            `   •   Pos: ${summary.position ?? '—'}/${summary.classSize ?? '—'}`;
        doc.text(summaryLine, PRINT_LEFT + 3, stripMidY, { maxWidth: CARD_W - 20 });

        doc.setFont('times', 'italic');
        doc.setFontSize(6.2);
        doc.setTextColor(...PDF_COLORS.gray);
        doc.text(
            `Assessed ${summary.assessedAtThisIndex}/${subjectCount}   •   Current Year ${summary.currentYear}   •   ${summary.grade.label}`,
            PRINT_LEFT + 3,
            stripLowY,
            { maxWidth: CARD_W - 40 }
        );

    };

    // ---- Draw the subject table (drawn FIRST so it can't erase anything) ----
    const drawSubjectTable = (cardTop, cardBottom, student, subjectsForThisCard, layout) => {
        const { fontSize, cellPadding } = layout;
        const tableStartY = cardTop + TABLE_TOP_OFF;
        const tableMaxBottom = cardBottom - TABLE_BOTTOM_RESERVE;

        const body = subjectsForThisCard.map((subject) => {
            const list = Array.isArray(student.scores?.[subject]) ? student.scores[subject] : [];
            const score = list[assessmentIndex] ?? list[0] ?? null;
            const avg = student.averages?.[subject] ?? null;
            const grade = cbcGrade(avg);
            return [
                subject,
                score != null ? String(score) : '—',
                avg != null ? `${avg}%` : '—',
                avg != null ? grade.code : '—',
                avg != null && grade.points != null ? grade.points.toFixed(1) : '—',
            ];
        });

        autoTable(doc, {
            startY: tableStartY,
            margin: {
                left: TABLE_LEFT,
                right: pageWidth - TABLE_RIGHT,
                top: tableStartY,
                bottom: pageHeight - tableMaxBottom,
            },
            tableWidth: TABLE_W,
            head: [[`Subject`, `A${assessmentIndex + 1}`, 'Avg %', 'CBC', 'Pts']],
            body,
            theme: 'grid',
            headStyles: {
                fillColor: PDF_COLORS.primary,
                textColor: [255, 255, 255],
                fontSize,
                halign: 'center',
                cellPadding,
                overflow: 'linebreak',
                fontStyle: 'bold',
            },
            bodyStyles: {
                fontSize,
                cellPadding,
                overflow: 'linebreak',
                valign: 'middle',
            },
            columnStyles: {
                0: { halign: 'left', cellWidth: TABLE_W * 0.46 },
                1: { halign: 'center', cellWidth: TABLE_W * 0.13 },
                2: { halign: 'center', cellWidth: TABLE_W * 0.14 },
                3: { halign: 'center', cellWidth: TABLE_W * 0.13 },
                4: { halign: 'center', cellWidth: TABLE_W * 0.14 },
            },
            styles: { font: 'times', overflow: 'linebreak', lineColor: PDF_COLORS.border, lineWidth: 0.1 },
        });
    };

    // ---- Draw a single card ----
    const drawCard = (student, cardTop, subjectsForThisCard, layout, isContinuation) => {
        const cardBottom = cardTop + CARD_H;

        // 1. Card border
        doc.setDrawColor(...PDF_COLORS.primary);
        doc.setLineWidth(0.4);
        doc.rect(PRINT_LEFT, cardTop, CARD_W, CARD_H);

        // 2. Header band
        drawHeaderBand(cardTop, student, isContinuation);

        // 3. Table (first)
        drawSubjectTable(cardTop, cardBottom, student, subjectsForThisCard, layout);

        // 4. Vertical divider + bio block (over the table's left edge)
        doc.setDrawColor(...PDF_COLORS.border);
        doc.setLineWidth(0.2);
        doc.line(TABLE_LEFT - 1, cardTop + HEADER_H + 1, TABLE_LEFT - 1, cardBottom - SUMMARY_H - 1);
        drawBioColumn(cardTop, cardBottom, student);

        // 5. Summary strip (last)
        drawSummaryStrip(cardTop, cardBottom, student);

        // 6. Crop marks (in gutters)
        drawCropMarks(cardTop, cardBottom);
    };

    // ---- Paginate students × (rows per student's continuation chunks) ----
    let slot = 0;      // 0..PER_PAGE-1 within a page
    students.forEach((student, idx) => {
        const rowCount = subjectList.length;
        const layout = pickLayout(rowCount);
        const chunks = layout ? [subjectList] : chunkSubjects(rowCount);
        chunks.forEach((chunk, chunkIdx) => {
            const isContinuation = chunkIdx > 0;
            const thisLayout = pickLayout(chunk.length)
                || layoutCandidates[layoutCandidates.length - 1];

            if (slot === 0 && (idx > 0 || chunkIdx > 0)) {
                // Start a new page only if not the very first card of the run
                if (doc.internal.getNumberOfPages() > 0 && slot === 0 && !(idx === 0 && chunkIdx === 0)) {
                    // will fall through below to addPage when slot wraps
                }
            }

            if (slot === 0 && (idx > 0 || chunkIdx > 0)) {
                doc.addPage();
            }

            const cardTop = PRINT_TOP + slot * CARD_H;
            drawCard(student, cardTop, chunk, thisLayout, isContinuation);
            if (slot > 0) drawHorizontalCut(cardTop);

            slot = (slot + 1) % PER_PAGE;
        });
    });

    const safeTerm = String(term || meta?.term || 'Term').replace(/\s+/g, '_');
    return saveGeneratedPdf(
        doc,
        `Transcripts_${safeTerm}_A${assessmentIndex + 1}_${meta?.cls || 'Class'}.pdf`
    );
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
    const principalName = resolveHeadTeacherName(meta);

    // Uploaded branding (transparent PNGs produced by prepareBrandingImage).
    const stampUrl = meta?.stampUrl || meta?.schoolStampUrl || '';
    const signatureUrl = meta?.principalSignatureUrl || meta?.headTeacherSignatureUrl || '';

    students.forEach((student, idx) => {
        if (idx > 0) doc.addPage();

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

        // ---- CLASS TEACHER remark (below the term dates table) ----
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
        

        // Uploaded principal signature ABOVE the line (left side)
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

        // Stamp on the RIGHT side, vertically aligned with the signature line
        if (stampUrl) {
            try {
                const stampSize = 22;
                const stampX = pageWidth - MARGIN - stampSize;
                const stampY = sigLineY - stampSize + 3;
                doc.addImage(stampUrl, 'PNG', stampX, stampY, stampSize, stampSize, undefined, 'FAST');
            } catch (e) {
                console.warn('Could not embed school stamp:', e?.message || e);
            }
        }

        y = sigLineY + 8;

        // ---- Footer ----
        doc.setDrawColor(153, 153, 153);
        doc.setLineWidth(0.2);
        doc.line(MARGIN, pageHeight - 10, pageWidth - MARGIN, pageHeight - 10);
        doc.setFont('times', 'normal');
        doc.setFontSize(7);
        doc.setTextColor(102, 102, 102);
        doc.text(
            `© ${new Date().getFullYear()} ${meta?.schoolName || 'EDUPRIVA'}.   |  System designed and maintained by Edupriva  |  info.edupriva@gmail.com`,
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
