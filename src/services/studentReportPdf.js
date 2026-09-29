import { jsPDF } from 'jspdf';
import 'jspdf-autotable';
import { saveGeneratedPdf } from './pdf';

// Consistent Branding Colors
const COLORS = {
    primary: [26, 35, 126], // #1a237e
    text: [44, 62, 80],
    border: [203, 213, 225],
    background: [248, 250, 252],
    white: [255, 255, 255]
};

async function addBranding(doc, meta) {
    // Header
    doc.setFillColor(...COLORS.primary);
    doc.rect(0, 0, 210, 35, 'F');
    
    doc.setTextColor(...COLORS.white);
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text(meta.schoolName.toUpperCase(), 105, 12, { align: 'center' });
    
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`${meta.schoolAddress} | ${meta.schoolPhone} | ${meta.schoolEmail}`, 105, 20, { align: 'center' });
    
    doc.setFontSize(12);
    doc.text('ACADEMIC PROGRESS REPORT', 105, 30, { align: 'center' });

    // Logo (simplified placeholder)
    if (meta.schoolLogo) {
        try {
            doc.addImage(meta.schoolLogo, 'PNG', 10, 5, 25, 25);
        } catch (e) {
            console.error('Error adding logo:', e);
        }
    }
}

export async function exportIndividualStudentReport(student, subjects, term, meta, getCBCGrade) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    
    await addBranding(doc, meta);

    // Student Info
    doc.setFontSize(10);
    doc.setTextColor(...COLORS.text);
    
    const infoY = 40;
    doc.rect(10, infoY, 190, 25);
    doc.text(`NAME: ${student.firstName} ${student.lastName}`, 15, infoY + 6);
    doc.text(`ADM No: ${student.admissionNumber || student.studentId || 'N/A'}`, 15, infoY + 12);
    doc.text(`CLASS: ${student.class || meta.cls}`, 15, infoY + 18);
    
    doc.text(`TERM: ${term}`, 100, infoY + 6);
    doc.text(`YEAR: ${meta.year}`, 100, infoY + 12);
    doc.text(`LEVEL: ${meta.levelDisplay}`, 100, infoY + 18);

    // Subjects Table
    const tableData = subjects.map(subject => {
        const avg = student.averages[subject];
        const g = getCBCGrade(avg ?? 0);
        const lastScore = (student.scores[subject] || [])[student.scores[subject].length - 1] ?? avg ?? '-';
        return [
            subject,
            lastScore,
            avg != null ? `${avg}%` : '-',
            avg != null ? `${Math.max(1, 35 - Math.round(avg / 3))}/120` : '-',
            avg != null ? g.code : '-',
            avg != null ? g.points.toFixed(0) : '-',
            avg >= 40 ? 'Satisfactory' : 'Work Hard',
            'Subj Teacher'
        ];
    });

    doc.autoTable({
        startY: 70,
        head: [['Subject', 'ETRM', 'AVR%', 'S/Rnk', 'GRD', 'PTS', 'Remarks', 'Subj Teacher']],
        body: tableData,
        theme: 'grid',
        headStyles: { fillColor: COLORS.primary, fontSize: 9, halign: 'center' },
        bodyStyles: { fontSize: 8, halign: 'center' },
        columnStyles: { 0: { halign: 'left' }, 7: { halign: 'left' } }
    });

    // Summary Metrics
    const summaryY = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(10);
    doc.text('Summary Metrics', 10, summaryY);
    doc.rect(10, summaryY + 2, 190, 20);
    
    doc.setFontSize(9);
    doc.text(`Rank: ${student.rank || 'N/A'} | Class Rank: ${student.classRank || 'N/A'} | Mean Grade: ${getCBCGrade(student.overallAverage || 0).code}`, 15, summaryY + 10);

    // Footer
    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text(`Generated on ${new Date().toLocaleDateString()}`, 10, 290);
    
    return saveGeneratedPdf(
        doc,
        `ReportCard_${student.firstName || ''}_${student.lastName || ''}.pdf`
    );
}
