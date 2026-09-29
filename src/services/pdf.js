// src/services/pdf.js
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Capacitor, registerPlugin } from '@capacitor/core';

const DeviceSecurity = registerPlugin('DeviceSecurity');

// Common PDF configuration
const PDF_COLORS = {
    primary: [26, 35, 126], // #1a237e
    text: [44, 62, 80],
    border: [203, 213, 225],
    accent: [248, 250, 252]
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

async function addSchoolHeader(doc, school, title, pageNumber, totalPages) {
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageWidth = doc.internal.pageSize.getWidth();
    // Logo
    if (school?.schoolLogo) {
        try {
            doc.addImage(school.schoolLogo, 'PNG', 10, 10, 20, 20);
        } catch (e) {
            console.error('Error adding logo:', e);
        }
    }

    // Header info
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

    // Footer
    doc.setDrawColor(...PDF_COLORS.border);
    doc.line(10, pageHeight - 12, pageWidth - 10, pageHeight - 12);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Page ${pageNumber} of ${totalPages}`, pageWidth - 10, pageHeight - 7, { align: 'right' });
    doc.text(`Generated on ${new Date().toLocaleDateString()}`, 10, pageHeight - 7);
}

export async function downloadStudentReportCardPDF({ students, meta, subjects, term }) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const studentList = Array.isArray(students) ? students : [];
    if (!studentList.length) throw new Error('There are no student report cards to export.');
    const subjectList = Array.isArray(subjects) ? subjects : [];
    const totalPages = studentList.length;

    for (let index = 0; index < studentList.length; index++) {
        const student = studentList[index];
        if (index > 0) doc.addPage();

        await addSchoolHeader(doc, meta, 'ACADEMIC PROGRESS REPORT', index + 1, totalPages);

        // Student Info
        doc.setFontSize(10);
        doc.setTextColor(...PDF_COLORS.text);
        doc.rect(10, 35, 190, 20); // Border
        
        doc.text(`Name: ${[student.firstName, student.lastName].filter(Boolean).join(' ') || 'Student'}`, 15, 42);
        doc.text(`Adm No: ${student.admissionNumber || student.studentId || 'N/A'}`, 15, 48);
        doc.text(`Class: ${student.class || meta?.cls || '—'}`, 100, 42);
        doc.text(`Term: ${term}`, 100, 48);

        // Subjects Table
        const tableData = subjectList.map(subject => [
            subject,
            (Array.isArray(student.scores?.[subject])
                ? student.scores[subject][student.scores[subject].length - 1]
                : student.scores?.[subject]) ?? '-',
            student.averages?.[subject] != null ? `${student.averages[subject]}%` : '-',
            '-', // Rank
            '-', // Grade
            '-'  // Points
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

    // Build school information in the format expected by the header
    const school = {
        schoolName: meta?.schoolName || 'TOPLINK EDU',
        schoolAddress: meta?.schoolAddress || '',
        schoolPhone: meta?.schoolPhone || '',
        schoolLogo: meta?.schoolLogo || ''
    };

    await addSchoolHeader(
        doc,
        school,
        'ACADEMIC PROGRESS REPORT',
        1,
        1
    );

    // Student information
    doc.setFontSize(10);
    doc.setTextColor(...PDF_COLORS.text);

    doc.rect(10, 35, 190, 24);

    doc.setFont('helvetica', 'bold');
    doc.text(
        `Name: ${student?.firstName || ''} ${student?.lastName || ''}`.trim(),
        15,
        42
    );

    doc.setFont('helvetica', 'normal');

    doc.text(
        `Adm No: ${student?.admissionNumber || student?.studentId || 'N/A'}`,
        15,
        49
    );

    doc.text(
        `Class: ${meta?.cls || 'N/A'}`,
        105,
        42
    );

    doc.text(
        `Level: ${meta?.level || 'N/A'}`,
        105,
        49
    );

    doc.text(
        `Term: ${meta?.term || 'N/A'}`,
        15,
        56
    );

    doc.text(
        `Assessment: ${meta?.assessmentType || 'N/A'}`,
        105,
        56
    );

    // Normalize scores
    const studentScores = Array.isArray(scores) ? scores : [];

    // Create subject rows
    const tableData = subjects.map(subject => {
        const subjectEntries = studentScores.filter(
            score => score?.subject === subject
        );

        const latest = subjectEntries.length
            ? subjectEntries[subjectEntries.length - 1]
            : null;

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
        bodyStyles: {
            fontSize: 9,
            halign: 'center'
        },
        columnStyles: {
            0: {
                halign: 'left'
            }
        },
        margin: {
            left: 10,
            right: 10
        }
    });

    const finalY = doc.lastAutoTable?.finalY || 65;

    // Overall average
    const numericScores = studentScores
        .map(s => Number(s?.score))
        .filter(score => Number.isFinite(score));

    const average = numericScores.length
        ? Math.round(
            numericScores.reduce((sum, score) => sum + score, 0) /
            numericScores.length
        )
        : null;

    const summaryY = Math.min(finalY + 12, 265);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...PDF_COLORS.primary);

    doc.text(
        `Overall Average: ${average !== null ? `${average}%` : 'N/A'}`,
        15,
        summaryY
    );

    if (average !== null) {
        doc.text(
            `Overall Grade: ${getGradeFromScore(average)}`,
            105,
            summaryY
        );
    }

    doc.setFont('helvetica', 'normal');

    const studentName =
        `${student?.firstName || ''}_${student?.lastName || ''}`
            .trim()
            .replace(/\s+/g, '_');

    const safeName = studentName || 'Student';

    return saveGeneratedPdf(doc,
        `Student_Report_${safeName}_${meta?.term || 'Term'}.pdf`
    );
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
    await addSchoolHeader(doc, meta, 'Student Ranking', 1, 1);
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
    await addSchoolHeader(doc, school, 'Official Fee Receipt', 1, 1);
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
    await addSchoolHeader(doc, meta, 'Teacher Assessment Record', 1, 1);
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
    await addSchoolHeader(doc, meta, 'Teacher Assessment Records', 1, 1);
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
    await addSchoolHeader(doc, school, 'Official Academic Transcript', 1, 1);
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
    await addSchoolHeader(doc, school, title || 'Timetable', 1, 1);
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
    await addSchoolHeader(doc, school, 'Student Fee Invoice', 1, 1);
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
