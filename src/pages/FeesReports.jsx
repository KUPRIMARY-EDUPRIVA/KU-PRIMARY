// src/pages/FeesReports.jsx
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { useSync } from '../context/SyncContext';
import { useFee } from '../context/FeeContext';
import { db } from '../firebase';
import { collection, query, where, getDocs, orderBy, limit, doc, getDoc } from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer,
    LineChart, Line, PieChart, Pie, Cell
} from 'recharts';
import {
    SCHOOL_LEVELS,
    LEVEL_CLASSES,
    LEVEL_DISPLAY_NAMES,
    getClassOptions,
    getLevelDisplayName
} from '../utils/constants';
import { downloadFeeReportPDF } from '../services/pdf';

export default function FeesReports() {
    const navigate = useNavigate();
    const { currentUser, userData } = useAuth();
    const { getLevelClasses } = useSchool();
    const { saveToIndexedDB, getFromIndexedDB } = useSync();
    const { 
        students, 
        feeBalances, 
        feeTransactions, 
        loading,
        getStudentBalance,
        refreshData
    } = useFee();

    // State
    const [reportData, setReportData] = useState([]);
    const [filteredData, setFilteredData] = useState([]);
    const [schoolData, setSchoolData] = useState(null);
    const [loadingReport, setLoadingReport] = useState(false);
    const [generatingPDF, setGeneratingPDF] = useState(false);
    const [showReportModal, setShowReportModal] = useState(false);
    const [reportHTML, setReportHTML] = useState('');
    const [activeTab, setActiveTab] = useState('overview');

    // Filter states
    const [selectedLevel, setSelectedLevel] = useState('');
    const [selectedClass, setSelectedClass] = useState('');
    const [selectedTerm, setSelectedTerm] = useState('all');
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
    const [paymentMethod, setPaymentMethod] = useState('all');
    const [dateRange, setDateRange] = useState({
        start: '',
        end: ''
    });
    const [statusFilter, setStatusFilter] = useState('all');

    // Stats
    const [stats, setStats] = useState({
        totalStudents: 0,
        totalCollected: 0,
        totalDue: 0,
        outstanding: 0,
        fullyPaid: 0,
        partialPaid: 0,
        pending: 0,
        collectionRate: 0
    });

    const [chartData, setChartData] = useState({
        dailyCollections: [],
        statusDistribution: [],
        debtDistribution: []
    });

    // Report type
    const [reportType, setReportType] = useState('summary');

    const reportRef = useRef(null);

    // Load school data
    useEffect(() => {
        if (userData?.schoolId) {
            loadSchoolData();
        }
    }, [userData]);

    // Generate report when filters change
    useEffect(() => {
        if (students.length > 0 && feeBalances) {
            generateReport();
        }
    }, [students, feeBalances, selectedLevel, selectedClass, selectedTerm, selectedYear, paymentMethod, statusFilter, dateRange]);

    const loadSchoolData = async () => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) return;

            const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
            if (schoolDoc.exists()) {
                setSchoolData(schoolDoc.data());
            }
        } catch (error) {
            console.error('Error loading school data:', error);
        }
    };

    const generateReport = () => {
        setLoadingReport(true);

        try {
            // Get all students with fee balances
            let reportItems = students.map(student => {
                const balance = getStudentBalance(student.id);
                const transactions = feeTransactions.filter(t => t.studentId === student.id);
                
                // Filter by payment method
                let filteredTransactions = transactions;
                if (paymentMethod !== 'all') {
                    filteredTransactions = transactions.filter(t => t.paymentMethod === paymentMethod);
                }

                // Filter by date range
                if (dateRange.start) {
                    filteredTransactions = filteredTransactions.filter(t => 
                        t.paymentDate && t.paymentDate >= dateRange.start
                    );
                }
                if (dateRange.end) {
                    filteredTransactions = filteredTransactions.filter(t => 
                        t.paymentDate && t.paymentDate <= dateRange.end
                    );
                }

                // Filter by term
                if (selectedTerm !== 'all') {
                    filteredTransactions = filteredTransactions.filter(t => t.term === selectedTerm);
                }

                // Filter by year
                if (selectedYear) {
                    filteredTransactions = filteredTransactions.filter(t => t.year === parseInt(selectedYear));
                }

                const totalPaid = filteredTransactions
                    .filter(t => t.type === 'payment' && (t.status === 'completed' || t.status === 'success'))
                    .reduce((sum, t) => sum + (t.amount || 0), 0);

                const totalDue = Number(balance?.totalInvoiced ?? balance?.totalDue ?? 0);
                const currentBalance = balance?.balance !== undefined ? Number(balance.balance) : (totalDue - totalPaid);

                return {
                    ...student,
                    balance: balance || { totalDue: 0, totalPaid: 0, balance: 0, status: 'pending' },
                    totalPaid: totalPaid,
                    totalDue: totalDue,
                    currentBalance: currentBalance,
                    transactionCount: filteredTransactions.length,
                    status: currentBalance <= 0 ? 'paid' : 
                            (currentBalance < totalDue * 0.5 ? 'partial' : 'pending'),
                    transactions: filteredTransactions
                };
            });

            // Apply filters
            let filtered = reportItems;

            // Filter by level
            if (selectedLevel) {
                filtered = filtered.filter(item => item.level === selectedLevel);
            }

            // Filter by class
            if (selectedClass) {
                filtered = filtered.filter(item => item.class === selectedClass);
            }

            // Filter by status
            if (statusFilter !== 'all') {
                filtered = filtered.filter(item => item.status === statusFilter);
            }

            // Sort by name
            filtered.sort((a, b) => {
                const nameA = `${a.firstName || ''} ${a.lastName || ''}`.toLowerCase();
                const nameB = `${b.firstName || ''} ${b.lastName || ''}`.toLowerCase();
                return nameA.localeCompare(nameB);
            });

            setFilteredData(filtered);

            // Calculate stats
            const totalStudents = filtered.length;
            const totalCollected = filtered.reduce((sum, item) => sum + item.totalPaid, 0);
            const totalDue = filtered.reduce((sum, item) => sum + item.totalDue, 0);
            const outstanding = filtered.reduce((sum, item) => sum + (item.currentBalance > 0 ? item.currentBalance : 0), 0);
            const fullyPaid = filtered.filter(item => item.status === 'paid').length;
            const partialPaid = filtered.filter(item => item.status === 'partial').length;
            const pending = filtered.filter(item => item.status === 'pending').length;
            const collectionRate = totalDue > 0 ? (totalCollected / totalDue) * 100 : 0;

            setStats({
                totalStudents,
                totalCollected,
                totalDue,
                outstanding,
                fullyPaid,
                partialPaid,
                pending,
                collectionRate
            });

            // Generate Chart Data
            // 1. Daily Collections
            const dailyMap = {};
            filtered.forEach(student => {
                student.transactions.forEach(t => {
                    if (t.type === 'payment' && (t.status === 'completed' || t.status === 'success') && t.paymentDate) {
                        const dateObj = new Date(t.paymentDate);
                        if (!isNaN(dateObj.getTime())) {
                            const dateStr = dateObj.toISOString().split('T')[0];
                            dailyMap[dateStr] = (dailyMap[dateStr] || 0) + (t.amount || 0);
                        }
                    }
                });
            });
            const dailyCollections = Object.keys(dailyMap).sort().slice(-14).map(date => ({
                date: date.substring(5), // MM-DD
                amount: dailyMap[date]
            })); // Last 14 days of collections

            // 2. Status Distribution (Pie Chart)
            const statusDistribution = [
                { name: 'Fully Paid', value: fullyPaid, color: '#27ae60' },
                { name: 'Partial', value: partialPaid, color: '#f39c12' },
                { name: 'Pending', value: pending, color: '#e74c3c' }
            ].filter(d => d.value > 0);

            // 3. Debt Distribution (Bar Chart)
            const debtBuckets = { '0': 0, '1-5k': 0, '5k-10k': 0, '10k-20k': 0, '20k+': 0 };
            filtered.forEach(item => {
                const bal = item.currentBalance;
                if (bal <= 0) debtBuckets['0']++;
                else if (bal <= 5000) debtBuckets['1-5k']++;
                else if (bal <= 10000) debtBuckets['5k-10k']++;
                else if (bal <= 20000) debtBuckets['10k-20k']++;
                else debtBuckets['20k+']++;
            });
            const debtDistribution = [
                { name: '0', count: debtBuckets['0'] },
                { name: '1k-5k', count: debtBuckets['1-5k'] },
                { name: '5k-10k', count: debtBuckets['5k-10k'] },
                { name: '10k-20k', count: debtBuckets['10k-20k'] },
                { name: '20k+', count: debtBuckets['20k+'] }
            ];

            setChartData({
                dailyCollections,
                statusDistribution,
                debtDistribution
            });

            setReportData(filtered);

        } catch (error) {
            console.error('Error generating report:', error);
            showNotification('Failed to generate report', 'error');
        } finally {
            setLoadingReport(false);
        }
    };

    const getUniqueClasses = () => {
        const classes = new Set();
        if (selectedLevel) {
            const list = getLevelClasses ? getLevelClasses(selectedLevel) : (LEVEL_CLASSES[selectedLevel] || []);
            list.forEach(c => classes.add(c));
        } else {
            const levels = ['pre-primary', 'lower-primary', 'upper-primary', 'junior-school', 'senior-school'];
            levels.forEach(l => {
                const list = getLevelClasses ? getLevelClasses(l) : (LEVEL_CLASSES[l] || []);
                list.forEach(c => classes.add(c));
            });
        }
        students.forEach(s => {
            if (s.class && (!selectedLevel || s.level === selectedLevel)) {
                classes.add(s.class);
            }
        });
        return [...classes].sort();
    };

    const getUniqueLevels = () => {
        const levels = new Set();
        SCHOOL_LEVELS.forEach(lvl => levels.add(lvl.value));
        students.forEach(s => {
            if (s.level) levels.add(s.level);
        });
        return [...levels];
    };

    const getStatusColor = (status) => {
        switch (status) {
            case 'paid': return '#27ae60';
            case 'partial': return '#f39c12';
            case 'pending': return '#e74c3c';
            default: return '#95a5a6';
        }
    };

    const getStatusLabel = (status) => {
        switch (status) {
            case 'paid': return '✅ Fully Paid';
            case 'partial': return '⚠️ Partially Paid';
            case 'pending': return '❌ Pending';
            default: return 'Unknown';
        }
    };

    const formatCurrency = (amount) => {
        return `KES ${(amount || 0).toLocaleString()}`;
    };

    const formatDate = (date) => {
        if (!date) return 'N/A';
        if (date.toDate) date = date.toDate();
        return new Date(date).toLocaleDateString('en-KE', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    };

    const handleExportPDF = async () => {
        if (filteredData.length === 0) {
            showNotification('No data to export', 'warning');
            return;
        }

        setGeneratingPDF(true);

        try {
            const html = generateReportHTML();
            setReportHTML(html);
            setShowReportModal(true);
        } catch (error) {
            console.error('Error generating PDF:', error);
            showNotification('Failed to generate PDF', 'error');
        } finally {
            setGeneratingPDF(false);
        }
    };

    const generateReportHTML = () => {
        const schoolName = schoolData?.name || 'My School';
        const schoolLogo = schoolData?.logoUrl || 'https://ui-avatars.com/api/?name=School&background=1a237e&color=fff&size=120';
        const currentDate = new Date().toLocaleDateString('en-KE', {
            day: '2-digit',
            month: 'long',
            year: 'numeric'
        });
        const currentTime = new Date().toLocaleTimeString('en-KE', {
            hour: '2-digit',
            minute: '2-digit'
        });

        const levelDisplay = selectedLevel ? LEVEL_DISPLAY_NAMES[selectedLevel] || selectedLevel : 'All';
        const classDisplay = selectedClass || 'All';
        const termDisplay = selectedTerm === 'all' ? 'All Terms' : selectedTerm;

        return `
            <div id="report-content" style="
                padding: 40px;
                background: white;
                font-family: 'Poppins', Arial, sans-serif;
                max-width: 1200px;
                margin: 0 auto;
            ">
                <!-- Header -->
                <div style="
                    text-align: center;
                    border-bottom: 3px double #1a237e;
                    padding-bottom: 20px;
                    margin-bottom: 30px;
                ">
                    <img src="${schoolLogo}" alt="School Logo" style="
                        max-height: 80px;
                        margin-bottom: 10px;
                    " />
                    <h1 style="
                        color: #1a237e;
                        font-size: 28px;
                        letter-spacing: 2px;
                        margin: 5px 0;
                    ">${schoolName}</h1>
                    <p style="
                        color: #666;
                        font-size: 14px;
                        margin: 0;
                    ">Fee Management Report</p>
                    <div style="
                        display: flex;
                        justify-content: center;
                        gap: 20px;
                        margin-top: 10px;
                        font-size: 13px;
                        color: #666;
                        flex-wrap: wrap;
                    ">
                        <span><strong>Level:</strong> ${levelDisplay}</span>
                        <span><strong>Class:</strong> ${classDisplay}</span>
                        <span><strong>Term:</strong> ${termDisplay}</span>
                        <span><strong>Year:</strong> ${selectedYear}</span>
                        <span><strong>Generated:</strong> ${currentDate} at ${currentTime}</span>
                    </div>
                </div>

                <!-- Stats Summary -->
                <div style="
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 15px;
                    margin-bottom: 30px;
                ">
                    <div style="
                        background: #f8f9fa;
                        padding: 15px;
                        border-radius: 8px;
                        text-align: center;
                    ">
                        <div style="font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Total Students</div>
                        <div style="font-size: 24px; font-weight: 700; color: #1a237e;">${stats.totalStudents}</div>
                    </div>
                    <div style="
                        background: #f8f9fa;
                        padding: 15px;
                        border-radius: 8px;
                        text-align: center;
                    ">
                        <div style="font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Total Collected</div>
                        <div style="font-size: 24px; font-weight: 700; color: #27ae60;">${formatCurrency(stats.totalCollected)}</div>
                    </div>
                    <div style="
                        background: #f8f9fa;
                        padding: 15px;
                        border-radius: 8px;
                        text-align: center;
                    ">
                        <div style="font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Total Due</div>
                        <div style="font-size: 24px; font-weight: 700; color: #1a237e;">${formatCurrency(stats.totalDue)}</div>
                    </div>
                    <div style="
                        background: #f8f9fa;
                        padding: 15px;
                        border-radius: 8px;
                        text-align: center;
                    ">
                        <div style="font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Outstanding</div>
                        <div style="font-size: 24px; font-weight: 700; color: #e74c3c;">${formatCurrency(stats.outstanding)}</div>
                    </div>
                    <div style="
                        background: #f8f9fa;
                        padding: 15px;
                        border-radius: 8px;
                        text-align: center;
                    ">
                        <div style="font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Collection Rate</div>
                        <div style="font-size: 24px; font-weight: 700; color: #3498db;">${stats.collectionRate.toFixed(1)}%</div>
                    </div>
                </div>

                <!-- Status Breakdown -->
                <div style="
                    display: flex;
                    gap: 20px;
                    flex-wrap: wrap;
                    margin-bottom: 30px;
                    padding: 15px;
                    background: #f8f9fa;
                    border-radius: 8px;
                ">
                    <div>
                        <span style="font-weight: 600; color: #27ae60;">✅ Fully Paid:</span>
                        <span style="font-weight: 700;">${stats.fullyPaid} (${stats.totalStudents > 0 ? ((stats.fullyPaid / stats.totalStudents) * 100).toFixed(1) : 0}%)</span>
                    </div>
                    <div>
                        <span style="font-weight: 600; color: #f39c12;">⚠️ Partial:</span>
                        <span style="font-weight: 700;">${stats.partialPaid} (${stats.totalStudents > 0 ? ((stats.partialPaid / stats.totalStudents) * 100).toFixed(1) : 0}%)</span>
                    </div>
                    <div>
                        <span style="font-weight: 600; color: #e74c3c;">❌ Pending:</span>
                        <span style="font-weight: 700;">${stats.pending} (${stats.totalStudents > 0 ? ((stats.pending / stats.totalStudents) * 100).toFixed(1) : 0}%)</span>
                    </div>
                </div>

                <!-- Detailed Table -->
                <div style="overflow-x: auto;">
                    <table style="
                        width: 100%;
                        border-collapse: collapse;
                        font-size: 13px;
                    ">
                        <thead>
                            <tr style="
                                background: #1a237e;
                                color: white;
                            ">
                                <th style="padding: 10px 12px; text-align: left;">#</th>
                                <th style="padding: 10px 12px; text-align: left;">Student Name</th>
                                <th style="padding: 10px 12px; text-align: left;">Admission No</th>
                                <th style="padding: 10px 12px; text-align: left;">Class</th>
                                <th style="padding: 10px 12px; text-align: right;">Total Due</th>
                                <th style="padding: 10px 12px; text-align: right;">Paid</th>
                                <th style="padding: 10px 12px; text-align: right;">Balance</th>
                                <th style="padding: 10px 12px; text-align: center;">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${filteredData.map((item, index) => `
                                <tr style="border-bottom: 1px solid #e0e6ed;">
                                    <td style="padding: 8px 12px;">${index + 1}</td>
                                    <td style="padding: 8px 12px; font-weight: 500;">${item.firstName || ''} ${item.lastName || ''}</td>
                                    <td style="padding: 8px 12px;">${item.admissionNumber || item.studentId || 'N/A'}</td>
                                    <td style="padding: 8px 12px;">${item.class || 'N/A'}</td>
                                    <td style="padding: 8px 12px; text-align: right;">${formatCurrency(item.totalDue)}</td>
                                    <td style="padding: 8px 12px; text-align: right; color: #27ae60;">${formatCurrency(item.totalPaid)}</td>
                                    <td style="padding: 8px 12px; text-align: right; font-weight: 600; color: ${item.currentBalance > 0 ? '#e74c3c' : '#27ae60'};">${formatCurrency(item.currentBalance)}</td>
                                    <td style="padding: 8px 12px; text-align: center;">
                                        <span style="
                                            padding: 3px 10px;
                                            border-radius: 12px;
                                            font-size: 11px;
                                            font-weight: 600;
                                            background: ${getStatusColor(item.status)}20;
                                            color: ${getStatusColor(item.status)};
                                        ">
                                            ${getStatusLabel(item.status)}
                                        </span>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                        <tfoot>
                            <tr style="
                                background: #f8f9fa;
                                font-weight: 700;
                            ">
                                <td colspan="4" style="padding: 10px 12px; text-align: right;">TOTALS</td>
                                <td style="padding: 10px 12px; text-align: right;">${formatCurrency(stats.totalDue)}</td>
                                <td style="padding: 10px 12px; text-align: right;">${formatCurrency(stats.totalCollected)}</td>
                                <td style="padding: 10px 12px; text-align: right;">${formatCurrency(stats.outstanding)}</td>
                                <td style="padding: 10px 12px; text-align: center;"></td>
                            </tr>
                        </tfoot>
                    </table>
                </div>

                <!-- Footer -->
                <div style="
                    margin-top: 30px;
                    padding-top: 20px;
                    border-top: 1px solid #e0e6ed;
                    display: flex;
                    justify-content: space-between;
                    font-size: 12px;
                    color: #666;
                    flex-wrap: wrap;
                    gap: 10px;
                ">
                    <span><i class="fas fa-print"></i> Generated by: ${userData?.fullName || userData?.firstName || 'System'}</span>
                    <span><i class="fas fa-calendar-alt"></i> ${currentDate}</span>
                    <span><i class="fas fa-clock"></i> ${currentTime}</span>
                </div>
            </div>
        `;
    };

    const handleDownloadPDF = async () => {
        setGeneratingPDF(true);
        try {
            const result = await downloadFeeReportPDF({
                summary: {
                    totalBilled: stats?.totalDue || 0,
                    totalCollected: stats?.totalCollected || 0,
                    totalBalance: stats?.outstanding || 0
                },
                records: (filteredData || []).map(item => ({
                    admissionNumber: item.admissionNumber || item.studentId,
                    studentName: `${item.firstName || ''} ${item.lastName || ''}`.trim(),
                    className: item.class || 'N/A',
                    billed: item.totalDue || 0,
                    paid: item.totalPaid || 0,
                    balance: item.currentBalance || 0,
                    status: item.status || 'Active'
                }))
            }, userData);
            showNotification(`PDF saved${result?.uri ? ' to Downloads/EduPriva' : ''}${result?.filename ? ` as ${result.filename}` : ''}.`, 'success');
        } catch (error) {
            console.error('Fee report PDF export failed:', error);
            showNotification(`PDF export failed: ${error.message || 'Unable to save the report.'}`, 'error');
        } finally {
            setGeneratingPDF(false);
        }
    };

    const showNotification = (message, type = 'info') => {
        const colors = {
            success: '#27ae60',
            error: '#e74c3c',
            warning: '#f39c12',
            info: '#3498db'
        };
        const iconMap = {
            success: 'check-circle',
            error: 'exclamation-circle',
            warning: 'exclamation-triangle',
            info: 'info-circle'
        };

        const notificationEl = document.createElement('div');
        notificationEl.className = 'custom-notification';
        notificationEl.style.backgroundColor = colors[type] || colors.info;
        notificationEl.innerHTML = `
            <i class="fas fa-${iconMap[type] || 'info-circle'}"></i>
            <span>${message}</span>
        `;
        document.body.appendChild(notificationEl);

        setTimeout(() => {
            notificationEl.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => {
                if (notificationEl.parentNode) {
                    notificationEl.parentNode.removeChild(notificationEl);
                }
            }, 300);
        }, 4000);
    };

    if (loading) {
        return <LoadingSpinner fullScreen text="Loading fee data..." />;
    }

    return (
        <Layout title="Fee Reports">
            <style>{`
                .reports-container {
                    padding: 0;
                }

                .report-header {
                    margin-bottom: 30px;
                }

                .report-header h1 {
                    font-size: 24px;
                    color: var(--secondary);
                    margin-bottom: 5px;
                }

                .report-header p {
                    color: var(--gray);
                    font-size: 14px;
                }

                .filters-section {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                    margin-bottom: 25px;
                }

                .filters-section .filter-row {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 15px;
                    align-items: center;
                }

                .filters-section .filter-group {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    flex: 1;
                    min-width: 150px;
                }

                .filters-section .filter-group label {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--secondary);
                }

                .filters-section .filter-group input,
                .filters-section .filter-group select {
                    padding: 8px 12px;
                    border: 2px solid var(--border);
                    border-radius: 8px;
                    font-size: 13px;
                    transition: all 0.3s;
                    background: white;
                    color: var(--secondary);
                }

                .filters-section .filter-group input:focus,
                .filters-section .filter-group select:focus {
                    outline: none;
                    border-color: var(--primary);
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

                .btn-danger {
                    background: var(--danger);
                    color: white;
                }

                .btn-danger:hover {
                    opacity: 0.9;
                    transform: translateY(-2px);
                }

                .btn-sm {
                    padding: 6px 12px;
                    font-size: 12px;
                }

                .stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }

                .stat-card {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                    transition: all 0.3s;
                }

                .stat-card:hover {
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-lg);
                }

                .stat-card .stat-label {
                    font-size: 13px;
                    color: var(--gray);
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .stat-card .stat-value {
                    font-size: 28px;
                    font-weight: 700;
                    color: var(--secondary);
                    margin-top: 5px;
                }

                .stat-card .stat-sub {
                    font-size: 12px;
                    color: var(--gray);
                    margin-top: 5px;
                }

                .stat-card .stat-icon {
                    float: right;
                    font-size: 28px;
                    opacity: 0.2;
                    color: var(--primary);
                }

                .table-container {
                    background: white;
                    border-radius: 12px;
                    box-shadow: var(--shadow);
                    overflow: hidden;
                }

                .table-wrapper {
                    overflow-x: auto;
                }

                table {
                    width: 100%;
                    border-collapse: collapse;
                }

                thead {
                    background: var(--primary);
                    color: white;
                }

                th {
                    padding: 12px 16px;
                    text-align: left;
                    font-size: 12px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                td {
                    padding: 12px 16px;
                    border-bottom: 1px solid var(--border);
                    font-size: 13px;
                }

                tr:hover {
                    background: var(--light);
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
                    max-width: 1100px;
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
                    border-bottom: 2px solid var(--border);
                    padding-bottom: 15px;
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

                .modal-footer {
                    display: flex;
                    gap: 10px;
                    justify-content: flex-end;
                    margin-top: 25px;
                    padding-top: 20px;
                    border-top: 1px solid var(--border);
                    flex-wrap: wrap;
                }

                .empty-state {
                    text-align: center;
                    padding: 60px 20px;
                    color: var(--gray);
                }

                .empty-state i {
                    font-size: 64px;
                    color: var(--border);
                    margin-bottom: 20px;
                }

                @media (max-width: 768px) {
                    .filters-section .filter-row {
                        flex-direction: column;
                        align-items: stretch;
                    }

                    .filters-section .filter-group {
                        min-width: 100%;
                    }

                    .stats-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }

                    .modal {
                        padding: 20px;
                    }
                }

                @media (max-width: 480px) {
                    .stats-grid {
                        grid-template-columns: 1fr;
                    }
                }

                @keyframes slideUp {
                    from { transform: translateY(20px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
            `}</style>

            <div className="reports-container">
                {/* Header */}
                <div className="report-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h1><i className="fas fa-file-invoice"></i> Fee Reports</h1>
                        <p>Generate and export detailed fee reports with filters</p>
                    </div>
                    <div style={{ display: 'flex', gap: '10px', background: '#f1f5f9', padding: '5px', borderRadius: '12px' }}>
                        <button 
                            className={`btn ${activeTab === 'overview' ? 'btn-primary' : ''}`}
                            onClick={() => setActiveTab('overview')}
                            style={{ background: activeTab === 'overview' ? 'var(--primary)' : 'transparent', color: activeTab === 'overview' ? 'white' : 'var(--secondary)', boxShadow: 'none' }}
                        >
                            <i className="fas fa-chart-pie"></i> Overview
                        </button>
                        <button 
                            className={`btn ${activeTab === 'table' ? 'btn-primary' : ''}`}
                            onClick={() => setActiveTab('table')}
                            style={{ background: activeTab === 'table' ? 'var(--primary)' : 'transparent', color: activeTab === 'table' ? 'white' : 'var(--secondary)', boxShadow: 'none' }}
                        >
                            <i className="fas fa-table"></i> Detailed List
                        </button>
                    </div>
                </div>

                {/* Filters */}
                <div className="filters-section">
                    <div className="filter-row">
                        <div className="filter-group">
                            <label>Level</label>
                            <select
                                value={selectedLevel}
                                onChange={(e) => setSelectedLevel(e.target.value)}
                            >
                                <option value="">All Levels</option>
                                {getUniqueLevels().map(level => (
                                    <option key={level} value={level}>{LEVEL_DISPLAY_NAMES[level] || level}</option>
                                ))}
                            </select>
                        </div>

                        <div className="filter-group">
                            <label>Class</label>
                            <select
                                value={selectedClass}
                                onChange={(e) => setSelectedClass(e.target.value)}
                            >
                                <option value="">All Classes</option>
                                {getUniqueClasses().map(cls => (
                                    <option key={cls} value={cls}>{cls}</option>
                                ))}
                            </select>
                        </div>

                        <div className="filter-group">
                            <label>Term</label>
                            <select
                                value={selectedTerm}
                                onChange={(e) => setSelectedTerm(e.target.value)}
                            >
                                <option value="all">All Terms</option>
                                <option value="Term 1">Term 1</option>
                                <option value="Term 2">Term 2</option>
                                <option value="Term 3">Term 3</option>
                            </select>
                        </div>

                        <div className="filter-group">
                            <label>Year</label>
                           <select
    value={selectedYear}
    onChange={(e) => setSelectedYear(parseInt(e.target.value))}
>
    {Array.from(
        new Set([new Date().getFullYear(), 2025, 2024, 2023, 2022, 2021, 2020])
    ).map((year) => (
        <option key={year} value={year}>{year}</option>
    ))}
</select>
                        </div>
                    </div>

                    <div className="filter-row" style={{ marginTop: '15px' }}>
                        <div className="filter-group">
                            <label>Payment Method</label>
                            <select
                                value={paymentMethod}
                                onChange={(e) => setPaymentMethod(e.target.value)}
                            >
                                <option value="all">All Methods</option>
                                <option value="cash">Cash</option>
                                <option value="bank">Bank Transfer</option>
                                <option value="mpesa">M-Pesa</option>
                                <option value="cheque">Cheque</option>
                            </select>
                        </div>

                        <div className="filter-group">
                            <label>Status</label>
                            <select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value)}
                            >
                                <option value="all">All Status</option>
                                <option value="paid">Fully Paid</option>
                                <option value="partial">Partially Paid</option>
                                <option value="pending">Pending</option>
                            </select>
                        </div>

                        <div className="filter-group">
                            <label>Date From</label>
                            <input
                                type="date"
                                value={dateRange.start}
                                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                            />
                        </div>

                        <div className="filter-group">
                            <label>Date To</label>
                            <input
                                type="date"
                                value={dateRange.end}
                                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                            />
                        </div>

                        <div className="filter-group" style={{ flexDirection: 'row', alignItems: 'flex-end', gap: '8px', flex: '0 1 auto' }}>
                            <button className="btn btn-primary" onClick={() => generateReport()}>
                                <i className="fas fa-sync"></i> Refresh
                            </button>
                            <button className="btn btn-success" onClick={handleExportPDF} disabled={generatingPDF || filteredData.length === 0}>
                                <i className="fas fa-file-pdf"></i> {generatingPDF ? 'Generating...' : 'Export PDF'}
                            </button>
                            <button className="btn btn-outline" onClick={() => {
                                setSelectedLevel('');
                                setSelectedClass('');
                                setSelectedTerm('all');
                                setSelectedYear(new Date().getFullYear());
                                setPaymentMethod('all');
                                setStatusFilter('all');
                                setDateRange({ start: '', end: '' });
                                generateReport();
                            }}>
                                <i className="fas fa-undo"></i> Reset
                            </button>
                        </div>
                    </div>
                </div>

                {/* Stats */}
                <div className="stats-grid">
                    <div className="stat-card">
                        <div className="stat-label">Total Students</div>
                        <div className="stat-value">{stats.totalStudents}</div>
                        <div className="stat-icon"><i className="fas fa-users"></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Total Collected</div>
                        <div className="stat-value">{formatCurrency(stats.totalCollected)}</div>
                        <div className="stat-icon"><i className="fas fa-check-circle" style={{ color: '#27ae60' }}></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Total Due</div>
                        <div className="stat-value">{formatCurrency(stats.totalDue)}</div>
                        <div className="stat-icon"><i className="fas fa-file-invoice"></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Outstanding Balance</div>
                        <div className="stat-value" style={{ color: stats.outstanding > 0 ? 'var(--danger)' : 'var(--success)' }}>
                            {formatCurrency(stats.outstanding)}
                        </div>
                        <div className="stat-icon"><i className="fas fa-exclamation-triangle" style={{ color: stats.outstanding > 0 ? 'var(--danger)' : 'var(--success)' }}></i></div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Collection Rate</div>
                        <div className="stat-value">{stats.collectionRate.toFixed(1)}%</div>
                        <div className="stat-icon"><i className="fas fa-percentage"></i></div>
                        <div className="stat-sub">
                            {stats.fullyPaid} fully paid, {stats.partialPaid} partial, {stats.pending} pending
                        </div>
                    </div>
                </div>

                {activeTab === 'overview' ? (
                    <div className="charts-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '30px' }}>
                        {/* Daily Collections Chart */}
                        <div className="chart-card" style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: 'var(--shadow)' }}>
                            <h3 style={{ fontSize: '16px', marginBottom: '20px', color: 'var(--secondary)' }}>Daily Fee Collections (Last 14 Days)</h3>
                            <div style={{ height: '300px' }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={chartData.dailyCollections}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                        <XAxis dataKey="date" />
                                        <YAxis tickFormatter={(val) => `KES ${(val / 1000)}k`} />
                                        <RechartsTooltip formatter={(val) => formatCurrency(val)} />
                                        <Line type="monotone" dataKey="amount" stroke="#4f46e5" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 8 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </div>

                        {/* Status Distribution Pie Chart */}
                        <div className="chart-card" style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: 'var(--shadow)' }}>
                            <h3 style={{ fontSize: '16px', marginBottom: '20px', color: 'var(--secondary)' }}>Payment Status Distribution</h3>
                            <div style={{ height: '300px' }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie
                                            data={chartData.statusDistribution}
                                            cx="50%"
                                            cy="50%"
                                            innerRadius={60}
                                            outerRadius={100}
                                            paddingAngle={5}
                                            dataKey="value"
                                        >
                                            {chartData.statusDistribution.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={entry.color} />
                                            ))}
                                        </Pie>
                                        <RechartsTooltip />
                                        <Legend verticalAlign="bottom" height={36}/>
                                    </PieChart>
                                </ResponsiveContainer>
                            </div>
                        </div>

                        {/* Debt Distribution Bar Chart */}
                        <div className="chart-card" style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: 'var(--shadow)', gridColumn: '1 / -1' }}>
                            <h3 style={{ fontSize: '16px', marginBottom: '20px', color: 'var(--secondary)' }}>Student Debt Distribution (KES)</h3>
                            <div style={{ height: '300px' }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={chartData.debtDistribution}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                        <XAxis dataKey="name" />
                                        <YAxis />
                                        <RechartsTooltip />
                                        <Bar dataKey="count" fill="#e74c3c" radius={[4, 4, 0, 0]} />
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="table-container">
                    <div className="table-wrapper">
                        <table>
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Student Name</th>
                                    <th>Admission No</th>
                                    <th>Class</th>
                                    <th>Total Due</th>
                                    <th>Paid</th>
                                    <th>Balance</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loadingReport ? (
                                    <tr>
                                        <td colSpan="8">
                                            <div className="empty-state">
                                                <i className="fas fa-spinner fa-spin"></i>
                                                <p>Generating report...</p>
                                            </div>
                                        </td>
                                    </tr>
                                ) : filteredData.length === 0 ? (
                                    <tr>
                                        <td colSpan="8">
                                            <div className="empty-state">
                                                <i className="fas fa-file-invoice"></i>
                                                <p>No data found matching the filters</p>
                                            </div>
                                        </td>
                                    </tr>
                                ) : (
                                    filteredData.map((item, index) => (
                                        <tr key={item.id}>
                                            <td>{index + 1}</td>
                                            <td>
                                                <div style={{ fontWeight: '500' }}>
                                                    {item.firstName || ''} {item.lastName || ''}
                                                </div>
                                            </td>
                                            <td>{item.admissionNumber || item.studentId || 'N/A'}</td>
                                            <td>{item.class || 'N/A'}</td>
                                            <td style={{ fontWeight: '500' }}>{formatCurrency(item.totalDue)}</td>
                                            <td style={{ color: '#27ae60', fontWeight: '500' }}>{formatCurrency(item.totalPaid)}</td>
                                            <td style={{ 
                                                fontWeight: '700',
                                                color: item.currentBalance > 0 ? 'var(--danger)' : 'var(--success)'
                                            }}>
                                                {formatCurrency(item.currentBalance)}
                                            </td>
                                            <td>
                                                <span style={{
                                                    padding: '3px 12px',
                                                    borderRadius: '20px',
                                                    fontSize: '12px',
                                                    fontWeight: '600',
                                                    background: getStatusColor(item.status) + '20',
                                                    color: getStatusColor(item.status)
                                                }}>
                                                    {getStatusLabel(item.status)}
                                                </span>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                            {filteredData.length > 0 && (
                                <tfoot>
                                    <tr style={{ background: 'var(--light)', fontWeight: '700' }}>
                                        <td colSpan="4" style={{ textAlign: 'right', padding: '12px 16px' }}>TOTALS</td>
                                        <td style={{ padding: '12px 16px' }}>{formatCurrency(stats.totalDue)}</td>
                                        <td style={{ padding: '12px 16px', color: '#27ae60' }}>{formatCurrency(stats.totalCollected)}</td>
                                        <td style={{ padding: '12px 16px', color: stats.outstanding > 0 ? 'var(--danger)' : 'var(--success)' }}>
                                            {formatCurrency(stats.outstanding)}
                                        </td>
                                        <td style={{ padding: '12px 16px' }}></td>
                                    </tr>
                                </tfoot>
                            )}
                        </table>
                    </div>
                </div>
                )}
            </div>

            {/* Report Modal */}
            {showReportModal && (
                <div className="modal-overlay active" onClick={(e) => {
                    if (e.target === e.currentTarget) setShowReportModal(false);
                }}>
                    <div className="modal">
                        <div className="modal-header">
                            <h2><i className="fas fa-file-pdf"></i> Fee Report</h2>
                            <button className="modal-close" onClick={() => setShowReportModal(false)}>
                                <i className="fas fa-times"></i>
                            </button>
                        </div>
                        <div dangerouslySetInnerHTML={{ __html: reportHTML }} />
                        <div className="modal-footer">
                            <button className="btn btn-outline" onClick={() => setShowReportModal(false)}>
                                Close
                            </button>
                            <button className="btn btn-success" onClick={handleDownloadPDF} disabled={generatingPDF}>
                                <i className={`fas ${generatingPDF ? 'fa-spinner fa-spin' : 'fa-download'}`}></i> {generatingPDF ? 'Saving PDF…' : 'Download PDF'}
                            </button>
                            <button className="btn btn-primary" onClick={() => window.print()}>
                                <i className="fas fa-print"></i> Print
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
