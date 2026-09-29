// src/pages/StudentFeeDetail.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFee } from '../context/FeeContext';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { downloadStudentInvoicePDF, saveGeneratedPdf } from '../services/pdf';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

export default function StudentFeeDetail() {
    const { studentId } = useParams();
    const navigate = useNavigate();
    const { userData, schoolData } = useAuth();
    const { 
        students, 
        feeTransactions, 
        invoices,
        getStudentBalance,
        getStudentInvoices,
        getInvoiceStats,
        voidTransaction,
        cancelInvoice
    } = useFee();
    
    const [student, setStudent] = useState(null);
    const [transactions, setTransactions] = useState([]);
    const [studentInvoices, setStudentInvoices] = useState([]);
    const [balance, setBalance] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('transactions');
    const [showInvoiceModal, setShowInvoiceModal] = useState(false);
    const [selectedInvoice, setSelectedInvoice] = useState(null);
    const [isGeneratingPDF, setIsGeneratingPDF] = useState(false);
    
    const reportRef = useRef(null);

    // Get school details from userData or schoolData
    const schoolLogo = schoolData?.logoUrl || userData?.logoUrl || schoolData?.schoolLogo || userData?.schoolLogo || '';
    const schoolName = schoolData?.name || userData?.schoolName || schoolData?.schoolName || 'EDUPRIVA';
    const schoolMotto = schoolData?.motto || userData?.schoolMotto || schoolData?.schoolMotto || 'Powering Modern Education';
    const schoolAddress = schoolData?.address || userData?.schoolAddress || schoolData?.schoolAddress || '';
    const schoolPhone = schoolData?.phone || userData?.schoolPhone || schoolData?.schoolPhone || '';
    const schoolEmail = schoolData?.email || userData?.schoolEmail || schoolData?.schoolEmail || '';

    useEffect(() => {
        if (students.length > 0 && studentId) {
            const foundStudent = students.find(s => s.id === studentId);
            if (foundStudent) {
                setStudent(foundStudent);
                const studentBalance = getStudentBalance(studentId);
                setBalance(studentBalance);
                
                const studentTransactions = feeTransactions.filter(t => t.studentId === studentId);
                setTransactions(studentTransactions);
                
                const studentInvoicesList = getStudentInvoices(studentId, { includeCancelled: true });
                setStudentInvoices(studentInvoicesList);
            }
            setLoading(false);
        }
    }, [students, studentId, feeTransactions, invoices]);

    // Get invoice stats for this student
    const getStudentInvoiceStats = () => {
        const total = studentInvoices.length;
        const paid = studentInvoices.filter(inv => inv.status === 'paid').length;
        const overdue = studentInvoices.filter(inv => inv.status === 'overdue').length;
        const pending = studentInvoices.filter(inv => inv.status === 'pending' || inv.status === 'partial').length;
        
        const totalAmount = studentInvoices.reduce((sum, inv) => sum + (inv.total || 0), 0);
        const paidAmount = studentInvoices.reduce((sum, inv) => sum + (inv.paidAmount || 0), 0);
        const outstandingAmount = totalAmount - paidAmount;

        return { total, paid, overdue, pending, totalAmount, paidAmount, outstandingAmount };
    };

    // View invoice details
    const viewInvoiceDetails = (invoice) => {
        setSelectedInvoice(invoice);
        setShowInvoiceModal(true);
    };

    // Generate PDF report neatly with jsPDF and autoTable, combining invoices and transactions sorted chronologically (oldest downwards)
    const generatePDF = async () => {
        setIsGeneratingPDF(true);
        try {
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();

            // Load logo as data URL to avoid CORS/taint issues
            const logoUrl = schoolLogo || `https://ui-avatars.com/api/?name=${encodeURIComponent(schoolName)}&background=1a237e&color=fff&size=120`;
            let logoDataUrl = null;
            if (logoUrl) {
                try {
                    logoDataUrl = await new Promise((resolve) => {
                        const img = new Image();
                        img.crossOrigin = 'Anonymous';
                        img.onload = () => {
                            const canvas = document.createElement('canvas');
                            canvas.width = img.width;
                            canvas.height = img.height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0);
                            resolve(canvas.toDataURL('image/png'));
                        };
                        img.onerror = () => resolve(null);
                        img.src = logoUrl;
                    });
                } catch (e) {
                    console.error('Error loading logo for PDF:', e);
                }
            }

            let startY = 15;

            // School Logo & Header
            if (logoDataUrl) {
                pdf.addImage(logoDataUrl, 'PNG', pageWidth / 2 - 12, startY, 24, 24);
                startY += 28;
            }

            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(20);
            pdf.setTextColor(26, 35, 126); // Deep Navy #1a237e
            pdf.text(schoolName, pageWidth / 2, startY, { align: 'center' });
            startY += 6;

            if (schoolMotto) {
                pdf.setFont('helvetica', 'italic');
                pdf.setFontSize(10);
                pdf.setTextColor(85, 85, 85);
                pdf.text(schoolMotto, pageWidth / 2, startY, { align: 'center' });
                startY += 5;
            }

            let contactStr = '';
            if (schoolAddress) contactStr += schoolAddress;
            if (schoolPhone) contactStr += (contactStr ? ' | ' : '') + `Tel: ${schoolPhone}`;
            if (schoolEmail) contactStr += (contactStr ? ' | ' : '') + `Email: ${schoolEmail}`;
            if (contactStr) {
                pdf.setFont('helvetica', 'normal');
                pdf.setFontSize(9);
                pdf.setTextColor(100, 100, 100);
                pdf.text(contactStr, pageWidth / 2, startY, { align: 'center' });
                startY += 8;
            }

            // Divider line
            pdf.setLineWidth(0.8);
            pdf.setDrawColor(26, 35, 126);
            pdf.line(14, startY, pageWidth - 14, startY);
            startY += 8;

            // Document Title
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(14);
            pdf.setTextColor(26, 35, 126);
            pdf.text('STUDENT FEE STATEMENT', pageWidth / 2, startY, { align: 'center' });
            startY += 10;

            // Student Information Box
            pdf.setFillColor(248, 250, 252);
            pdf.setLineWidth(0.2);
            pdf.setDrawColor(226, 232, 240);
            pdf.roundedRect(14, startY, pageWidth - 28, 22, 3, 3, 'FD');

            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(10);
            pdf.setTextColor(15, 23, 42);
            pdf.text(`Student Name: ${student?.firstName || ''} ${student?.lastName || ''}`, 18, startY + 7);
            pdf.text(`Admission No: ${student?.admissionNumber || student?.studentId || student?.admNo || 'N/A'}`, 120, startY + 7);

            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(9);
            pdf.text(`Class: ${student?.class || student?.className || student?.classGrade || 'N/A'}`, 18, startY + 15);
            pdf.text(`Current Balance: KES ${balance?.balance?.toLocaleString() || '0'}`, 120, startY + 15);
            startY += 28;

            // Combine Invoices and Transactions arranged using createdAt, from oldest downwards
            const invoiceEntries = studentInvoices.map(inv => ({
                date: inv.createdAt || inv.date || new Date().toISOString(),
                timestamp: new Date(inv.createdAt || inv.date || Date.now()).getTime(),
                description: `Invoice #${inv.invoiceNumber} - ${inv.term || 'Fee Charge'}`,
                debit: inv.total || 0,
                credit: 0
            }));

            const paymentEntries = transactions.map(txn => ({
                date: txn.createdAt || txn.paymentDate || new Date().toISOString(),
                timestamp: new Date(txn.createdAt || txn.paymentDate || Date.now()).getTime(),
                description: `Payment via ${txn.paymentMethod || 'Cash'} (Ref: ${txn.receiptNumber || txn.reference || 'N/A'})`,
                debit: 0,
                credit: txn.amount || 0
            }));

            const allEntries = [...invoiceEntries, ...paymentEntries].sort((a, b) => a.timestamp - b.timestamp);

            let runningBalance = 0;
            const tableRows = allEntries.map(entry => {
                runningBalance += (entry.debit - entry.credit);
                return [
                    new Date(entry.date).toLocaleDateString(),
                    entry.description,
                    entry.debit > 0 ? `KES ${entry.debit.toLocaleString()}` : '-',
                    entry.credit > 0 ? `KES ${entry.credit.toLocaleString()}` : '-',
                    `KES ${runningBalance.toLocaleString()}`
                ];
            });

            if (tableRows.length === 0) {
                tableRows.push(['-', 'No fee transactions or invoices recorded', '-', '-', 'KES 0']);
            }

            autoTable(pdf, {
                startY: startY,
                head: [['Date', 'Description', 'Charge (Debit)', 'Payment (Credit)', 'Balance']],
                body: tableRows,
                theme: 'grid',
                headStyles: { fillColor: [26, 35, 126], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
                bodyStyles: { fontSize: 8.5, textColor: [15, 23, 42] },
                alternateRowStyles: { fillColor: [248, 250, 252] },
                columnStyles: {
                    0: { cellWidth: 25 },
                    1: { cellWidth: 72 },
                    2: { cellWidth: 30, halign: 'right' },
                    3: { cellWidth: 30, halign: 'right' },
                    4: { cellWidth: 25, halign: 'right' }
                },
                margin: { left: 14, right: 14 }
            });

            // Footer below a solid line (one line, no dotted boxes)
            const finalY = pdf.lastAutoTable ? pdf.lastAutoTable.finalY + 15 : startY + 40;
            const footerY = Math.max(finalY, pageHeight - 15);

            pdf.setLineWidth(0.5);
            pdf.setDrawColor(203, 213, 225);
            pdf.line(14, footerY - 5, pageWidth - 14, footerY - 5);

            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(8.5);
            pdf.setTextColor(100, 116, 139);
            pdf.text(
                `Official Fee Statement • ${schoolName} ${schoolPhone ? `• Tel: ${schoolPhone}` : ''} • Generated on: ${new Date().toLocaleDateString()}`,
                pageWidth / 2,
                footerY,
                { align: 'center' }
            );

            await saveGeneratedPdf(
                pdf,
                `Fee_Statement_${student?.firstName || ''}_${student?.lastName || ''}_${new Date().toISOString().slice(0,10)}.pdf`
            );

        } catch (error) {
            console.error('Error generating PDF:', error);
            alert('Failed to generate PDF. Please try again.');
        } finally {
            setIsGeneratingPDF(false);
        }
    };

    const handleVoidTransaction = async (txn) => {
        if (!window.confirm(`Are you sure you want to reverse this payment of KES ${txn.amount?.toLocaleString()}? This action cannot be undone.`)) return;
        const reason = window.prompt("Enter reason for reversal:");
        if (!reason) {
            alert('A reason is required to reverse a transaction.');
            return;
        }
        
        try {
            const res = await voidTransaction(txn.id, reason);
            if (res.success) {
                alert('Transaction successfully reversed.');
            } else {
                alert(`Failed to reverse transaction: ${res.error}`);
            }
        } catch (error) {
            alert(`Error reversing transaction: ${error.message}`);
        }
    };

    const handleCancelInvoice = async (invoice) => {
        if (invoice.paidAmount > 0) {
            alert('Cannot cancel an invoice with payments applied. Please reverse the payments first.');
            return;
        }
        if (!window.confirm(`Are you sure you want to cancel this invoice for KES ${invoice.total?.toLocaleString()}?`)) return;
        const reason = window.prompt("Enter reason for cancellation:");
        if (!reason) {
            alert('A reason is required to cancel an invoice.');
            return;
        }

        try {
            const res = await cancelInvoice(invoice.id, reason);
            if (res.success) {
                alert('Invoice successfully cancelled.');
            } else {
                alert(`Failed to cancel invoice: ${res.error}`);
            }
        } catch (error) {
            alert(`Error cancelling invoice: ${error.message}`);
        }
    };

    // Generate invoice PDF
    const generateInvoicePDF = async (invoice) => {
        setIsGeneratingPDF(true);
        try {
            await downloadStudentInvoicePDF(invoice, schoolData || userData);
        } catch (error) {
            console.error('Error generating invoice PDF:', error);
            alert('Failed to generate invoice PDF. Please try again.');
        } finally {
            setIsGeneratingPDF(false);
        }
    };

    // Generate invoice HTML for PDF with dynamic school data
    const generateInvoiceHTML = (invoice) => {
        return `
            <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
                <!-- Header with dynamic school name -->
                <div style="text-align: center; border-bottom: 3px double #1a237e; padding-bottom: 15px; margin-bottom: 20px;">
                    <h1 style="color: #1a237e; font-size: 28px; margin: 0;">${schoolName}</h1>
                    <p style="color: #666; font-style: italic; margin: 5px 0;">${schoolMotto}</p>
                    ${schoolAddress ? `<p style="color: #666; font-size: 12px; margin: 2px 0;">${schoolAddress}</p>` : ''}
                    ${schoolPhone || schoolEmail ? `
                        <p style="color: #666; font-size: 12px; margin: 2px 0;">
                            ${schoolPhone ? `Tel: ${schoolPhone}` : ''} ${schoolPhone && schoolEmail ? '|' : ''} ${schoolEmail ? `Email: ${schoolEmail}` : ''}
                        </p>
                    ` : ''}
                    <h2 style="margin: 10px 0 5px;">INVOICE</h2>
                    <p style="margin: 5px 0; font-size: 14px;"><strong>Invoice Number:</strong> ${invoice.invoiceNumber}</p>
                    <p style="margin: 5px 0; font-size: 14px;"><strong>Date:</strong> ${new Date(invoice.createdAt).toLocaleDateString()}</p>
                    <p style="margin: 5px 0; font-size: 14px;"><strong>Due Date:</strong> ${new Date(invoice.dueDate).toLocaleDateString()}</p>
                </div>

                <!-- Bill To Section -->
                <div style="margin-bottom: 20px; padding: 15px; background: #f5f5f5; border-radius: 8px;">
                    <h3 style="margin: 0 0 10px; font-size: 16px;">Bill To:</h3>
                    <p style="margin: 3px 0; font-size: 14px;"><strong>Student:</strong> ${invoice.studentName}</p>
                    <p style="margin: 3px 0; font-size: 14px;"><strong>Class:</strong> ${invoice.studentClass || 'N/A'}</p>
                    <p style="margin: 3px 0; font-size: 14px;"><strong>Admission No:</strong> ${invoice.admissionNumber || 'N/A'}</p>
                    <p style="margin: 3px 0; font-size: 14px;"><strong>Term:</strong> ${invoice.term}</p>
                </div>

                <!-- Invoice Items Table -->
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                    <thead>
                        <tr style="background: #1a237e; color: white;">
                            <th style="padding: 10px 12px; text-align: left; font-size: 13px;">Description</th>
                            <th style="padding: 10px 12px; text-align: right; font-size: 13px;">Amount (KES)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${invoice.items.map((item, index) => `
                            <tr style="border-bottom: 1px solid #ddd;">
                                <td style="padding: 8px 12px; font-size: 13px;">${item.description}</td>
                                <td style="padding: 8px 12px; text-align: right; font-size: 13px;">${item.amount.toLocaleString()}</td>
                            </tr>
                        `).join('')}
                        <tr style="border-top: 2px solid #333;">
                            <td style="padding: 8px 12px; font-size: 14px; font-weight: 700;">Subtotal</td>
                            <td style="padding: 8px 12px; text-align: right; font-size: 14px; font-weight: 700;">${invoice.subtotal.toLocaleString()}</td>
                        </tr>
                        ${invoice.tax > 0 ? `
                            <tr>
                                <td style="padding: 8px 12px; font-size: 13px;">Tax</td>
                                <td style="padding: 8px 12px; text-align: right; font-size: 13px;">${invoice.tax.toLocaleString()}</td>
                            </tr>
                        ` : ''}
                        ${invoice.discount > 0 ? `
                            <tr>
                                <td style="padding: 8px 12px; font-size: 13px;">Discount</td>
                                <td style="padding: 8px 12px; text-align: right; font-size: 13px;">-${invoice.discount.toLocaleString()}</td>
                            </tr>
                        ` : ''}
                        <tr style="background: #1a237e; color: white;">
                            <td style="padding: 10px 12px; font-size: 16px; font-weight: 700;">TOTAL</td>
                            <td style="padding: 10px 12px; text-align: right; font-size: 16px; font-weight: 700;">${invoice.total.toLocaleString()}</td>
                        </tr>
                        <tr style="background: #e8f5e9;">
                            <td style="padding: 8px 12px; font-size: 13px; font-weight: 600; color: #2e7d32;">Amount Paid</td>
                            <td style="padding: 8px 12px; text-align: right; font-size: 13px; font-weight: 600; color: #2e7d32;">${(invoice.paidAmount || 0).toLocaleString()}</td>
                        </tr>
                        <tr style="background: ${invoice.remainingBalance > 0 ? '#ffebee' : '#e8f5e9'};">
                            <td style="padding: 8px 12px; font-size: 14px; font-weight: 700; color: ${invoice.remainingBalance > 0 ? '#c62828' : '#2e7d32'};">Balance Due</td>
                            <td style="padding: 8px 12px; text-align: right; font-size: 14px; font-weight: 700; color: ${invoice.remainingBalance > 0 ? '#c62828' : '#2e7d32'};">${invoice.remainingBalance.toLocaleString()}</td>
                        </tr>
                    </tbody>
                </table>

                ${invoice.notes ? `
                    <div style="margin-bottom: 20px; padding: 10px; background: #fff3e0; border-left: 4px solid #ff9800; border-radius: 4px;">
                        <p style="margin: 0; font-size: 13px;"><strong>Notes:</strong> ${invoice.notes}</p>
                    </div>
                ` : ''}

                <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #ddd; display: flex; justify-content: space-between; font-size: 12px; color: #666;">
                    <span>Status: <strong style="text-transform: uppercase; color: ${invoice.status === 'paid' ? '#2e7d32' : invoice.status === 'overdue' ? '#c62828' : '#e65100'};">${invoice.status}</strong></span>
                    <span>Generated on: ${new Date().toLocaleString()}</span>
                </div>

                <!-- Signature and Stamp Section (Part of Document) -->
                <div style="margin-top: 40px; padding: 20px; border-top: 2px solid #333;">
                    <div style="display: flex; justify-content: space-around; flex-wrap: wrap; gap: 20px;">
                        <div style="text-align: center; min-width: 150px;">
                            <div style="border-bottom: 2px solid #333; width: 180px; height: 40px; margin: 0 auto;"></div>
                            <p style="margin: 5px 0 0; font-size: 12px; color: #666; font-weight: 600;">Signature</p>
                            <p style="margin: 2px 0 0; font-size: 10px; color: #999;">Authorized Signatory</p>
                        </div>
                        <div style="text-align: center; min-width: 150px;">
                            <div style="border-bottom: 2px solid #333; width: 180px; height: 40px; margin: 0 auto;"></div>
                            <p style="margin: 5px 0 0; font-size: 12px; color: #666; font-weight: 600;">Date</p>
                            <p style="margin: 2px 0 0; font-size: 10px; color: #999;">${new Date().toLocaleDateString()}</p>
                        </div>
                        <div style="text-align: center; min-width: 150px;">
                            <div style="border: 2px solid #333; width: 80px; height: 80px; margin: 0 auto; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #666; font-weight: 700; text-align: center; line-height: 1.3;">
                                SCHOOL<br/>STAMP
                            </div>
                            <p style="margin: 5px 0 0; font-size: 12px; color: #666; font-weight: 600;">School Stamp</p>
                            <p style="margin: 2px 0 0; font-size: 10px; color: #999;">Official Seal</p>
                        </div>
                    </div>
                </div>

                <!-- Footer with Disclaimer -->
                <div style="margin-top: 20px; padding: 15px; background: #fff3e0; border-radius: 8px; text-align: center; border: 2px dashed #ff9800;">
                    <p style="margin: 0; font-size: 12px; color: #e65100; font-weight: 600;">
                        <i class="fas fa-file-invoice"></i> 
                        Official Fee Statement
                    </p>
                    <p style="margin: 5px 0 0; font-size: 10px; color: #999;">
                        ${schoolName} | ${schoolAddress || ''} | ${schoolPhone || ''}
                    </p>
                </div>
            </div>
        `;
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading student fee details..." />;
    }

    if (!student) {
        return (
            <Layout title="Student Fee Details">
                <div style={{ textAlign: 'center', padding: '60px 20px' }}>
                    <i className="fas fa-user-graduate" style={{ fontSize: '64px', color: '#e0e6ed', marginBottom: '20px' }}></i>
                    <h3 style={{ fontSize: '20px', color: '#2c3e50', marginBottom: '10px' }}>Student Not Found</h3>
                    <p style={{ color: '#95a5a6', maxWidth: '400px', margin: '0 auto' }}>The student you're looking for could not be found.</p>
                    <button className="btn btn-primary" onClick={() => navigate('/fees')} style={{ marginTop: '20px' }}>
                        <i className="fas fa-arrow-left"></i> Back to Fees
                    </button>
                </div>
            </Layout>
        );
    }

    const invoiceStats = getStudentInvoiceStats();

    return (
        <Layout title={`Fee Details - ${student.firstName || ''} ${student.lastName || ''}`}>
            <style>{`
                .tab-button {
                    padding: 10px 20px;
                    border: none;
                    border-radius: 8px 8px 0 0;
                    cursor: pointer;
                    font-weight: 600;
                    transition: all 0.3s;
                    background: transparent;
                    color: var(--gray);
                    font-size: 14px;
                }
                .tab-button.active {
                    background: white;
                    color: var(--primary);
                    box-shadow: 0 -2px 10px rgba(0,0,0,0.05);
                }
                .tab-button:hover:not(.active) {
                    color: var(--secondary);
                }
                .status-badge {
                    padding: 3px 12px;
                    border-radius: 20px;
                    font-size: 11px;
                    font-weight: 600;
                }
                .status-badge.paid {
                    background: #d4edda;
                    color: #155724;
                }
                .status-badge.pending {
                    background: #fff3cd;
                    color: #856404;
                }
                .status-badge.overdue {
                    background: #f8d7da;
                    color: #721c24;
                }
                .status-badge.partial {
                    background: #d1ecf1;
                    color: #0c5460;
                }
                .status-badge.draft {
                    background: #e2e3e5;
                    color: #383d41;
                }
                .btn {
                    padding: 8px 16px;
                    border: none;
                    border-radius: 8px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s;
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 13px;
                }
                .btn-primary {
                    background: var(--primary);
                    color: white;
                }
                .btn-primary:hover {
                    background: var(--primary-dark);
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-lg);
                }
                .btn-success {
                    background: var(--success);
                    color: white;
                }
                .btn-success:hover {
                    opacity: 0.9;
                    transform: translateY(-2px);
                }
                .btn-outline {
                    background: transparent;
                    border: 2px solid var(--border);
                    color: var(--secondary);
                }
                .btn-outline:hover {
                    border-color: var(--primary);
                    color: var(--primary);
                }
                .modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.5);
                    z-index: 1000;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                    backdrop-filter: blur(4px);
                }
                .modal-overlay.active {
                    display: flex;
                }
                .modal {
                    background: white;
                    border-radius: 16px;
                    max-width: 700px;
                    width: 100%;
                    max-height: 90vh;
                    overflow-y: auto;
                    padding: 30px;
                    animation: slideUp 0.3s ease;
                }
                .modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 25px;
                }
                .modal-header h2 {
                    font-size: 22px;
                    color: var(--secondary);
                }
                .modal-close {
                    width: 40px;
                    height: 40px;
                    border: none;
                    border-radius: 50%;
                    background: var(--light);
                    cursor: pointer;
                    font-size: 18px;
                    transition: all 0.3s;
                }
                .modal-close:hover {
                    background: var(--border);
                }
                .invoice-detail-item {
                    display: flex;
                    justify-content: space-between;
                    padding: 8px 0;
                    border-bottom: 1px solid var(--border);
                }
                .invoice-detail-item .label {
                    font-weight: 500;
                    color: var(--gray);
                }
                .invoice-detail-item .value {
                    font-weight: 600;
                    color: var(--secondary);
                }
                @keyframes slideUp {
                    from { transform: translateY(30px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
                @media print {
                    .no-print { display: none !important; }
                    .modal-overlay { position: static !important; background: white !important; }
                    .modal { box-shadow: none !important; max-height: none !important; }
                    .modal-footer { display: none !important; }
                }
                @media (max-width: 768px) {
                    .tab-button {
                        font-size: 12px;
                        padding: 8px 12px;
                    }
                }
            `}</style>

            <div style={{ padding: '20px 0' }}>
                <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
                    <button className="btn btn-outline" onClick={() => navigate('/fees')}>
                        <i className="fas fa-arrow-left"></i> Back to Fees
                    </button>
                    <button className="btn btn-primary" onClick={generatePDF} disabled={isGeneratingPDF}>
                        <i className="fas fa-file-pdf"></i> {isGeneratingPDF ? 'Generating...' : 'Export to PDF'}
                    </button>
                </div>

                {/* Report Content for PDF */}
                <div ref={reportRef} style={{ background: '#ffffff', padding: '20px' }}>
                    {/* School Header with Logo */}
                    <div style={{ textAlign: 'center', borderBottom: '3px double #1a237e', paddingBottom: '15px', marginBottom: '25px' }}>
                        {schoolLogo ? (
                            <img src={schoolLogo} alt="School Logo" style={{ maxHeight: '70px', marginBottom: '10px', objectFit: 'contain' }} />
                        ) : (
                            <img src="https://ui-avatars.com/api/?name=School&background=1a237e&color=fff&size=120" alt="School Logo" style={{ maxHeight: '70px', marginBottom: '10px', borderRadius: '50%' }} />
                        )}
                        <h1 style={{ color: '#1a237e', fontSize: '26px', margin: '0 0 5px 0', fontWeight: '700' }}>{schoolName}</h1>
                        <p style={{ color: '#555', fontStyle: 'italic', margin: '0 0 5px 0', fontSize: '13px' }}>{schoolMotto}</p>
                        {schoolAddress && <p style={{ color: '#666', fontSize: '12px', margin: '2px 0' }}>{schoolAddress}</p>}
                        {(schoolPhone || schoolEmail) && (
                            <p style={{ color: '#666', fontSize: '12px', margin: '2px 0' }}>
                                {schoolPhone ? `Tel: ${schoolPhone}` : ''} {schoolPhone && schoolEmail ? '|' : ''} {schoolEmail ? `Email: ${schoolEmail}` : ''}
                            </p>
                        )}
                        <h2 style={{ color: '#1a237e', fontSize: '18px', margin: '15px 0 5px 0', textTransform: 'uppercase', letterSpacing: '1px' }}>Student Fee Statement</h2>
                    </div>

                    {/* Student Info Card */}
                    <div style={{
                        background: 'white',
                        borderRadius: '12px',
                        padding: '25px',
                        boxShadow: 'var(--shadow)',
                        marginBottom: '25px'
                    }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
                            <div>
                                <div style={{ fontSize: '12px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>Student</div>
                                <div style={{ fontSize: '18px', fontWeight: '600', color: 'var(--secondary)' }}>
                                    {student.firstName || ''} {student.lastName || ''}
                                </div>
                                <div style={{ fontSize: '13px', color: 'var(--gray)' }}>
                                    Adm: {student.admissionNumber || student.studentId || student.admNo || 'N/A'}
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: '12px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>Class</div>
                                <div style={{ fontSize: '18px', fontWeight: '600', color: 'var(--secondary)' }}>{student.class || student.className || student.classGrade || 'N/A'}</div>
                                <div style={{ fontSize: '13px', color: 'var(--gray)' }}>{student.level || 'N/A'}</div>
                            </div>
                            <div>
                                <div style={{ fontSize: '12px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>Total Invoiced</div>
                                <div style={{ fontSize: '18px', fontWeight: '600', color: 'var(--secondary)' }}>
                                    KES {balance?.totalInvoiced?.toLocaleString() || '0'}
                                </div>
                                <div style={{ fontSize: '13px', color: 'var(--gray)' }}>
                                    Invoices: {invoiceStats.total}
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: '12px', color: 'var(--gray)', textTransform: 'uppercase', fontWeight: '500' }}>Balance</div>
                                <div style={{ 
                                    fontSize: '18px', 
                                    fontWeight: '600', 
                                    color: balance?.balance > 0 ? 'var(--danger)' : 'var(--success)'
                                }}>
                                    KES {balance?.balance?.toLocaleString() || '0'}
                                </div>
                                <div style={{ fontSize: '13px', color: 'var(--gray)' }}>
                                    Status: {balance?.status === 'paid' ? '✅ Fully Paid' : 
                                            balance?.status === 'partial' ? '⚠️ Partial' : 
                                            balance?.status === 'no_invoice' ? 'No Invoices' : '❌ Pending'}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Invoice Stats Summary */}
                    {invoiceStats.total > 0 && (
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
                            gap: '10px',
                            marginBottom: '25px',
                            padding: '15px',
                            background: 'white',
                            borderRadius: '12px',
                            boxShadow: 'var(--shadow)'
                        }}>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '10px', color: 'var(--gray)', textTransform: 'uppercase' }}>Total</div>
                                <div style={{ fontSize: '18px', fontWeight: '700' }}>{invoiceStats.total}</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '10px', color: 'var(--gray)', textTransform: 'uppercase' }}>Paid</div>
                                <div style={{ fontSize: '18px', fontWeight: '700', color: 'var(--success)' }}>{invoiceStats.paid}</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '10px', color: 'var(--gray)', textTransform: 'uppercase' }}>Pending</div>
                                <div style={{ fontSize: '18px', fontWeight: '700', color: 'var(--warning)' }}>{invoiceStats.pending}</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '10px', color: 'var(--gray)', textTransform: 'uppercase' }}>Overdue</div>
                                <div style={{ fontSize: '18px', fontWeight: '700', color: 'var(--danger)' }}>{invoiceStats.overdue}</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '10px', color: 'var(--gray)', textTransform: 'uppercase' }}>Outstanding</div>
                                <div style={{ fontSize: '18px', fontWeight: '700', color: 'var(--danger)' }}>
                                    KES {invoiceStats.outstandingAmount.toLocaleString()}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Tabs */}
                    <div style={{ display: 'flex', gap: '0', borderBottom: '2px solid var(--border)', marginBottom: '25px' }}>
                        <button 
                            className={`tab-button ${activeTab === 'transactions' ? 'active' : ''}`}
                            onClick={() => setActiveTab('transactions')}
                        >
                            <i className="fas fa-history"></i> Transactions
                        </button>
                        <button 
                            className={`tab-button ${activeTab === 'invoices' ? 'active' : ''}`}
                            onClick={() => setActiveTab('invoices')}
                        >
                            <i className="fas fa-file-invoice"></i> Invoices ({studentInvoices.length})
                        </button>
                    </div>

                    {/* Transactions Tab */}
                    {activeTab === 'transactions' && (
                        <div style={{
                            background: 'white',
                            borderRadius: '12px',
                            boxShadow: 'var(--shadow)',
                            overflow: 'hidden'
                        }}>
                            <div style={{ padding: '20px', borderBottom: '1px solid var(--border)' }}>
                                <h3 style={{ fontSize: '18px', color: 'var(--secondary)' }}>Transaction History</h3>
                            </div>
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ background: 'var(--light)' }}>
                                            <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Date</th>
                                            <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Description</th>
                                            <th style={{ padding: '12px 20px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Amount</th>
                                            <th style={{ padding: '12px 20px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Method</th>
                                            <th style={{ padding: '12px 20px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Status</th>
                                            <th style={{ padding: '12px 20px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {transactions.length === 0 ? (
                                            <tr>
                                                <td colSpan="6" style={{ textAlign: 'center', padding: '40px', color: 'var(--gray)' }}>
                                                    <i className="fas fa-info-circle" style={{ fontSize: '24px', display: 'block', marginBottom: '10px' }}></i>
                                                    No transactions found
                                                </td>
                                            </tr>
                                        ) : (
                                            transactions.map(t => (
                                                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)', opacity: t.voided ? 0.6 : 1, textDecoration: t.voided ? 'line-through' : 'none' }}>
                                                    <td style={{ padding: '12px 20px' }}>
                                                        {t.paymentDate ? new Date(t.paymentDate).toLocaleDateString() : 'N/A'}
                                                    </td>
                                                    <td style={{ padding: '12px 20px' }}>
                                                        {t.description || 'N/A'}
                                                        {t.invoiceNumber && (
                                                            <div style={{ fontSize: '11px', color: 'var(--gray)' }}>
                                                                Invoice: {t.invoiceNumber}
                                                            </div>
                                                        )}
                                                        {t.voided && (
                                                            <div style={{ fontSize: '11px', color: 'var(--danger)', fontWeight: 'bold' }}>
                                                                VOIDED: {t.voidReason}
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '12px 20px', textAlign: 'right', fontWeight: '600' }}>
                                                        KES {t.amount?.toLocaleString() || '0'}
                                                    </td>
                                                    <td style={{ padding: '12px 20px', textAlign: 'center' }}>
                                                        <span style={{
                                                            padding: '2px 10px',
                                                            borderRadius: '12px',
                                                            fontSize: '11px',
                                                            background: t.paymentMethod === 'mpesa' ? '#d1ecf1' : 
                                                                       t.paymentMethod === 'cash' ? '#d4edda' : '#fff3cd',
                                                            color: t.paymentMethod === 'mpesa' ? '#0c5460' : 
                                                                   t.paymentMethod === 'cash' ? '#155724' : '#856404'
                                                        }}>
                                                            {t.paymentMethod || 'N/A'}
                                                        </span>
                                                    </td>
                                                    <td style={{ padding: '12px 20px', textAlign: 'center' }}>
                                                        <span style={{
    padding: '2px 10px',
    borderRadius: '12px',
    fontSize: '11px',
    background: t.voided ? '#f8d7da' : t.status === 'completed' ? '#d4edda' :
                t.status === 'pending' ? '#fff3cd' : '#f8d7da',
    color: t.voided ? '#721c24' : t.status === 'completed' ? '#155724' :
            t.status === 'pending' ? '#856404' : '#721c24'
}}>
    {t.voided ? 'VOIDED' : t.status || 'N/A'}
</span>
</td>
<td style={{ padding: '12px 20px', textAlign: 'center' }}>
    {!t.voided && t.type === 'payment' && (
        <button 
            onClick={() => handleVoidTransaction(t)}
            style={{ background: 'none', border: '1px solid var(--danger)', color: 'var(--danger)', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
        >
            Reverse
        </button>
    )}
</td>
</tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Invoices Tab */}
                    {activeTab === 'invoices' && (
                        <div style={{
                            background: 'white',
                            borderRadius: '12px',
                            boxShadow: 'var(--shadow)',
                            overflow: 'hidden'
                        }}>
                            <div style={{ padding: '20px', borderBottom: '1px solid var(--border)' }}>
                                <h3 style={{ fontSize: '18px', color: 'var(--secondary)' }}>Invoices</h3>
                            </div>
                            <div style={{ overflowX: 'auto' }}>
                                {studentInvoices.length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '40px', color: 'var(--gray)' }}>
                                        <i className="fas fa-file-invoice" style={{ fontSize: '48px', display: 'block', marginBottom: '15px', color: 'var(--border)' }}></i>
                                        No invoices found for this student
                                    </div>
                                ) : (
                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                        <thead>
                                            <tr style={{ background: 'var(--light)' }}>
                                                <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Invoice #</th>
                                                <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Date</th>
                                                <th style={{ padding: '12px 20px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Due Date</th>
                                                <th style={{ padding: '12px 20px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Total</th>
                                                <th style={{ padding: '12px 20px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Paid</th>
                                                <th style={{ padding: '12px 20px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Balance</th>
                                                <th style={{ padding: '12px 20px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Status</th>
                                                <th style={{ padding: '12px 20px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--gray)' }}>Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {studentInvoices.map(invoice => (
                                                <tr key={invoice.id} style={{ borderBottom: '1px solid var(--border)', opacity: invoice.status === 'cancelled' ? 0.6 : 1, textDecoration: invoice.status === 'cancelled' ? 'line-through' : 'none' }}>
                                                    <td style={{ padding: '12px 20px', fontWeight: '600' }}>
                                                        {invoice.invoiceNumber}
                                                    </td>
                                                    <td style={{ padding: '12px 20px' }}>
                                                        {new Date(invoice.createdAt).toLocaleDateString()}
                                                    </td>
                                                    <td style={{ padding: '12px 20px' }}>
                                                        {new Date(invoice.dueDate).toLocaleDateString()}
                                                        {new Date(invoice.dueDate) < new Date() && invoice.status !== 'paid' && (
                                                            <span style={{ color: 'var(--danger)', marginLeft: '5px', fontSize: '11px' }}>
                                                                <i className="fas fa-exclamation-circle"></i> Overdue
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '12px 20px', textAlign: 'right', fontWeight: '600' }}>
                                                        KES {invoice.total.toLocaleString()}
                                                    </td>
                                                    <td style={{ padding: '12px 20px', textAlign: 'right', color: 'var(--success)' }}>
                                                        KES {(invoice.paidAmount || 0).toLocaleString()}
                                                    </td>
                                                    <td style={{ padding: '12px 20px', textAlign: 'right', fontWeight: '600', color: invoice.remainingBalance > 0 ? 'var(--danger)' : 'var(--success)' }}>
                                                        KES {invoice.remainingBalance.toLocaleString()}
                                                    </td>
                                                    <td style={{ padding: '12px 20px', textAlign: 'center' }}>
                                                        <span className={`status-badge ${invoice.status}`}>
                                                            {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
                                                        </span>
                                                    </td>
                                                    <td style={{ padding: '12px 20px', textAlign: 'center' }}>
                                                        <div style={{ display: 'flex', gap: '5px', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                            <button 
                                                                className="btn btn-primary"
                                                                style={{ padding: '4px 10px', fontSize: '11px' }}
                                                                onClick={() => viewInvoiceDetails(invoice)}
                                                            >
                                                                <i className="fas fa-eye"></i> View
                                                            </button>
                                                            <button 
                                                                className="btn btn-success"
                                                                style={{ padding: '4px 10px', fontSize: '11px' }}
                                                                onClick={() => generateInvoicePDF(invoice)}
                                                                disabled={isGeneratingPDF}
                                                            >
                                                                <i className="fas fa-file-pdf"></i> PDF
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Signature and Stamp Section (Part of Document) */}
                    <div style={{
                        marginTop: '40px',
                        padding: '25px',
                        background: 'white',
                        borderRadius: '12px',
                        boxShadow: 'var(--shadow)',
                        borderTop: '3px solid var(--primary)'
                    }}>
                        <div style={{ 
                            display: 'flex', 
                            justifyContent: 'space-around', 
                            flexWrap: 'wrap', 
                            gap: '30px',
                            alignItems: 'flex-end'
                        }}>
                            <div style={{ textAlign: 'center', minWidth: '150px' }}>
                                <div style={{ borderBottom: '2px solid #333', width: '200px', height: '45px', margin: '0 auto' }}></div>
                                <p style={{ margin: '8px 0 0', fontSize: '13px', color: '#333', fontWeight: '600' }}>Signature</p>
                                <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#999' }}>Authorized Signatory</p>
                            </div>
                            <div style={{ textAlign: 'center', minWidth: '150px' }}>
                                <div style={{ borderBottom: '2px solid #333', width: '200px', height: '45px', margin: '0 auto' }}>
                                    <p style={{ margin: '25px 0 0', fontSize: '13px', color: '#333', fontWeight: '500' }}>
                                        {new Date().toLocaleDateString()}
                                    </p>
                                </div>
                                <p style={{ margin: '8px 0 0', fontSize: '13px', color: '#333', fontWeight: '600' }}>Date</p>
                                <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#999' }}>Date of Signing</p>
                            </div>
                            <div style={{ textAlign: 'center', minWidth: '150px' }}>
                                <div style={{ 
                                    border: '2px solid #333', 
                                    width: '90px', 
                                    height: '90px', 
                                    margin: '0 auto', 
                                    borderRadius: '4px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '12px',
                                    color: '#555',
                                    fontWeight: '700',
                                    textAlign: 'center',
                                    lineHeight: '1.4',
                                    background: '#fafafa'
                                }}>
                                    SCHOOL<br/>STAMP
                                </div>
                                <p style={{ margin: '8px 0 0', fontSize: '13px', color: '#333', fontWeight: '600' }}>School Stamp</p>
                                <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#999' }}>Official Seal</p>
                            </div>
                        </div>
                    </div>

                    {/* Normal One-Line Footer below a solid line */}
                    <div style={{
                        marginTop: '30px',
                        paddingTop: '15px',
                        borderTop: '1px solid #cbd5e1',
                        textAlign: 'center',
                        fontSize: '12px',
                        color: '#475569'
                    }}>
                        Official Fee Statement &bull; {schoolName} {schoolPhone ? `&bull; Tel: ${schoolPhone}` : ''} &bull; Generated on: {new Date().toLocaleDateString()}
                    </div>
                </div>

                {/* Invoice Details Modal */}
                {showInvoiceModal && selectedInvoice && (
                    <div className="modal-overlay active" onClick={(e) => {
                        if (e.target === e.currentTarget) setShowInvoiceModal(false);
                    }}>
                        <div className="modal">
                            <div className="modal-header">
                                <h2>Invoice Details</h2>
                                <button className="modal-close" onClick={() => setShowInvoiceModal(false)}>
                                    <i className="fas fa-times"></i>
                                </button>
                            </div>
                            
                            <div style={{ marginBottom: '20px' }}>
                                <div className="invoice-detail-item">
                                    <span className="label">Invoice Number</span>
                                    <span className="value">{selectedInvoice.invoiceNumber}</span>
                                </div>
                                <div className="invoice-detail-item">
                                    <span className="label">Date</span>
                                    <span className="value">{new Date(selectedInvoice.createdAt).toLocaleDateString()}</span>
                                </div>
                                <div className="invoice-detail-item">
                                    <span className="label">Due Date</span>
                                    <span className="value">
                                        {new Date(selectedInvoice.dueDate).toLocaleDateString()}
                                        {new Date(selectedInvoice.dueDate) < new Date() && selectedInvoice.status !== 'paid' && (
                                            <span style={{ color: 'var(--danger)', marginLeft: '10px' }}>
                                                (Overdue)
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <div className="invoice-detail-item">
                                    <span className="label">Status</span>
                                    <span className="value">
                                        <span className={`status-badge ${selectedInvoice.status}`}>
                                            {selectedInvoice.status.charAt(0).toUpperCase() + selectedInvoice.status.slice(1)}
                                        </span>
                                    </span>
                                </div>
                                <div className="invoice-detail-item">
                                    <span className="label">Term</span>
                                    <span className="value">{selectedInvoice.term}</span>
                                </div>
                            </div>

                            <h3 style={{ fontSize: '16px', marginBottom: '10px' }}>Items</h3>
                            <div style={{ marginBottom: '15px' }}>
                                {selectedInvoice.items && selectedInvoice.items.map((item, index) => (
                                    <div key={index} className="invoice-detail-item">
                                        <span className="label">{item.description}</span>
                                        <span className="value">KES {item.amount.toLocaleString()}</span>
                                    </div>
                                ))}
                                <div className="invoice-detail-item" style={{ fontWeight: '700', borderTop: '2px solid var(--border)' }}>
                                    <span className="label">Subtotal</span>
                                    <span className="value">KES {selectedInvoice.subtotal.toLocaleString()}</span>
                                </div>
                                {selectedInvoice.tax > 0 && (
                                    <div className="invoice-detail-item">
                                        <span className="label">Tax</span>
                                        <span className="value">KES {selectedInvoice.tax.toLocaleString()}</span>
                                    </div>
                                )}
                                {selectedInvoice.discount > 0 && (
                                    <div className="invoice-detail-item">
                                        <span className="label">Discount</span>
                                        <span className="value">-KES {selectedInvoice.discount.toLocaleString()}</span>
                                    </div>
                                )}
                                <div className="invoice-detail-item" style={{ fontWeight: '700', fontSize: '16px', color: 'var(--primary)' }}>
                                    <span className="label">Total</span>
                                    <span className="value">KES {selectedInvoice.total.toLocaleString()}</span>
                                </div>
                                <div className="invoice-detail-item">
                                    <span className="label">Paid</span>
                                    <span className="value" style={{ color: 'var(--success)' }}>KES {(selectedInvoice.paidAmount || 0).toLocaleString()}</span>
                                </div>
                                <div className="invoice-detail-item" style={{ fontWeight: '700', fontSize: '16px' }}>
                                    <span className="label">Remaining Balance</span>
                                    <span className="value" style={{ color: selectedInvoice.remainingBalance > 0 ? 'var(--danger)' : 'var(--success)' }}>
                                        KES {selectedInvoice.remainingBalance.toLocaleString()}
                                    </span>
                                </div>
                            </div>

                            {selectedInvoice.notes && (
                                <div style={{ marginBottom: '15px', padding: '10px', background: 'var(--light)', borderRadius: '8px' }}>
                                    <strong>Notes:</strong> {selectedInvoice.notes}
                                </div>
                            )}

                            <div className="modal-footer" style={{ 
                                display: 'flex', 
                                gap: '10px', 
                                justifyContent: 'flex-end', 
                                marginTop: '25px', 
                                paddingTop: '20px', 
                                borderTop: '1px solid var(--border)',
                                flexWrap: 'wrap'
                            }}>
                                <button 
                                    className="btn btn-success"
                                    onClick={() => {
                                        setShowInvoiceModal(false);
                                        generateInvoicePDF(selectedInvoice);
                                    }}
                                    disabled={isGeneratingPDF}
                                >
                                    <i className="fas fa-file-pdf"></i> Download PDF
                                </button>
                                <button 
                                    className="btn btn-outline"
                                    onClick={() => setShowInvoiceModal(false)}
                                >
                                    Close
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </Layout>
    );
}
