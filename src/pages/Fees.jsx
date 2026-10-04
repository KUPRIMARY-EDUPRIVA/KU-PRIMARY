// src/pages/Fees.jsx
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { useSync } from '../context/SyncContext';
import { useFee } from '../context/FeeContext';
import { db } from '../firebase';
import { doc, updateDoc } from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import ReceiptModal from '../components/Fees/ReceiptModal';
import StudentPicker from '../components/Fees/StudentPicker';
import * as XLSX from 'xlsx';
import { parse as parseCSV } from 'csv-parse/browser/esm';
import {
    SCHOOL_LEVELS, LEVEL_CLASSES, LEVEL_DISPLAY_NAMES,
    getClassOptions, getLevelDisplayName
} from '../utils/constants';
import {
    requireSchoolId, getSchoolData, getFeeStructure, getFeeStructures,
    DEFAULT_PAGE_SIZE, getStudentByAdmission
} from '../services/feeService';
import { downloadReceiptPDF } from '../services/pdf';
import { AuditLogService } from '../services/auditService';

// ---------- Constants ----------
const MAX_IMPORT_SIZE = 5 * 1024 * 1024;
const OVERDUE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const LEVEL_ORDER = ['pre-primary', 'lower-primary', 'upper-primary', 'junior-school', 'senior-school'];

// Roster paging guards
const ROSTER_PAGE_SIZE = 500;
const ROSTER_MAX_PAGES = 200;
const ROSTER_CACHE_TTL_MS = 60 * 1000; // 60s — bulk ops reuse within a minute

const generateStatementHash = (data) => {
    const content = JSON.stringify(data.slice(0, 10));
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    const timestamp = new Date().toISOString().split('T')[0];
    return `stmt_${Math.abs(hash)}_${timestamp}`;
};

const escapeCsv = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------- Static style helpers (pure — safe to hoist) ----------
const smallBtn = (bg) => ({
    padding: '4px 12px', fontSize: '11px', background: bg, color: 'white',
    border: 'none', borderRadius: '6px', cursor: 'pointer'
});

const pageBtnStyle = (disabled) => ({
    padding: '8px 14px', border: '1px solid var(--border)', borderRadius: '6px',
    background: 'white', color: 'var(--secondary)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: '500', opacity: disabled ? 0.5 : 1
});

export default function Fees() {
    const navigate = useNavigate();
    const { currentUser, userData, userRole } = useAuth();
    const { getLevelClasses, schoolData: schoolCtxData } = useSchool();
    const { isOnline, saveToIndexedDB, getFromIndexedDB } = useSync();
    const {
        feeBalances, feeTransactions, loading,
        addFeeTransaction, getStudentBalance, refreshData, createBulkInvoices,
        sendInvoiceReminder, checkOverdueInvoices, getStudentInvoices,
        getInvoiceStats, reconcileBalance, feeStructures, scope,
        studentsPage, balancesPage,
        fetchStudentsPage, fetchStudentsCount,
        fetchBalancesPage, fetchBalancesCount,
        setStudentsQuery, setBalancesQuery,
        goToNextPage, goToPrevPage, setPageSize
    } = useFee();

    const students = studentsPage.items;
    const paginatedBalances = balancesPage.items;

    // ---- UI state ----
    const [showFeeModal, setShowFeeModal] = useState(false);
    const [showStatementModal, setShowStatementModal] = useState(false);
    const [showReconcileModal, setShowReconcileModal] = useState(false);
    const [showInvoiceModal, setShowInvoiceModal] = useState(false);
    const [showMpesaModal, setShowMpesaModal] = useState(false);
    const [showBulkFeeModal, setShowBulkFeeModal] = useState(false);
    const [showInvoiceDetailsModal, setShowInvoiceDetailsModal] = useState(false);
    const [showReceiptModal, setShowReceiptModal] = useState(false);

    const [isProcessing, setIsProcessing] = useState(false);
    const [selectedBank, setSelectedBank] = useState('');
    const [statementFile, setStatementFile] = useState(null);
    const [statementData, setStatementData] = useState([]);
    const [matchedTransactions, setMatchedTransactions] = useState([]);
    const [unmatchedTransactions, setUnmatchedTransactions] = useState([]);
    const [reconcileResults, setReconcileResults] = useState(null);
    const [statementHash, setStatementHash] = useState('');
    const [uploadedStatements, setUploadedStatements] = useState([]);

    // ---- Filter state (server-side) ----
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedLevel, setSelectedLevel] = useState('');
    const [selectedClass, setSelectedClass] = useState('');
    const [searchByAdmission, setSearchByAdmission] = useState('');
    const [searchType, setSearchType] = useState('name');

    // ---- School highest level (for filtering level dropdowns) ----
    const [schoolHighestLevel, setSchoolHighestLevel] = useState('senior-school');

    // ---- Selected entities ----
    const [selectedInvoice, setSelectedInvoice] = useState(null);
    const [receiptData, setReceiptData] = useState(null);
    const [schoolData, setSchoolData] = useState({
        schoolName: '', schoolLogo: '', schoolAddress: '', schoolPhone: '', schoolEmail: ''
    });

    // ---- Forms ----
    const [feeForm, setFeeForm] = useState({
        student: null,
        studentId: '', studentAdmission: '', amount: '', description: '',
        paymentMethod: 'cash', paymentDate: new Date().toISOString().split('T')[0],
        reference: '', class: '', level: '', term: 'Term 1', year: new Date().getFullYear()
    });

    const [invoiceForm, setInvoiceForm] = useState({
        studentIds: [], items: [{ description: '', amount: '' }],
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        term: 'Term 1', year: new Date().getFullYear(),
        invoiceAll: false, invoiceLevel: '', invoiceClass: '',
        notes: '', tax: 0, discount: 0
    });

    const [bulkFeeForm, setBulkFeeForm] = useState({
        level: '', class: '', amount: '', description: '',
        term: 'Term 1', year: new Date().getFullYear()
    });

    const [mpesaForm, setMpesaForm] = useState({
        student: null,
        studentId: '', studentAdmission: '', phoneNumber: '', amount: '', description: ''
    });

    const fileInputRef = useRef(null);

    // ---- Full-roster cache (for bulk ops that need all students, not just current page) ----
    const allStudentsCacheRef = useRef({ data: null, at: 0, key: '' });
    const [loadingAllStudents, setLoadingAllStudents] = useState(false);

    // ---- Notifications ----
    const showNotification = useCallback((message, type = 'info') => {
        const colors = { success: '#27ae60', error: '#e74c3c', warning: '#f39c12', info: '#3498db' };
        const n = document.createElement('div');
        n.style.cssText = `position:fixed;top:20px;right:20px;background:${colors[type] || colors.info};color:#fff;padding:14px 18px;border-radius:8px;box-shadow:0 5px 15px rgba(0,0,0,.2);z-index:10000;max-width:400px;font-size:14px;`;
        n.textContent = message;
        document.body.appendChild(n);
        setTimeout(() => n.remove(), 3500);
    }, []);

    /* =========================================================
       Full-roster loader (walks pages)
       ========================================================= */

    const rosterCacheKey = `${selectedLevel || '*'}|${selectedClass || '*'}`;

    const ensureAllStudents = useCallback(async () => {
        const now = Date.now();
        const cached = allStudentsCacheRef.current;
        if (
            cached.data
            && cached.key === rosterCacheKey
            && (now - cached.at) < ROSTER_CACHE_TTL_MS
        ) {
            return cached.data;
        }

        setLoadingAllStudents(true);
        try {
            const schoolId = requireSchoolId(userData);
            const acc = [];
            for (let page = 0; page < ROSTER_MAX_PAGES; page++) {
                // Accept both `{ items, total }` and plain array returns.
                const res = await fetchStudentsPage({
                    schoolId,
                    level: selectedLevel,
                    cls: selectedClass,
                    sortField: 'firstName',
                    sortDirection: 'asc',
                    pageIndex: page,
                    pageSize: ROSTER_PAGE_SIZE
                });
                const rows = Array.isArray(res) ? res : (res?.items || []);
                if (!rows.length) break;
                acc.push(...rows);
                if (rows.length < ROSTER_PAGE_SIZE) break;
            }
            allStudentsCacheRef.current = { data: acc, at: Date.now(), key: rosterCacheKey };
            return acc;
        } finally {
            setLoadingAllStudents(false);
        }
    }, [userData, selectedLevel, selectedClass, fetchStudentsPage, rosterCacheKey]);

    const invalidateRosterCache = () => {
        allStudentsCacheRef.current = { data: null, at: 0, key: '' };
    };

    /* =========================================================
       Bootstrap
       ========================================================= */

    useEffect(() => {
        (async () => {
            try {
                const schoolId = requireSchoolId(userData);
                const data = await getSchoolData(schoolId);
                if (data) {
                    setSchoolData({
                        schoolName: data.schoolName || data.name || 'School Name',
                        schoolLogo: data.logoUrl || '',
                        schoolAddress: data.address || '',
                        schoolPhone: data.phone || '',
                        schoolEmail: data.email || ''
                    });
                    if (data.highestLevel) setSchoolHighestLevel(data.highestLevel);
                }
            } catch (e) { console.warn('school data:', e.message); }
        })();

        (async () => {
            try {
                const cached = await getFromIndexedDB('uploaded_statements');
                if (cached) setUploadedStatements(cached);
            } catch (e) { console.warn('uploaded statements:', e); }
        })();
    }, [userData, getFromIndexedDB]);

    // Prefer context school data if present (avoids an extra fetch)
    useEffect(() => {
        if (schoolCtxData?.highestLevel) setSchoolHighestLevel(schoolCtxData.highestLevel);
    }, [schoolCtxData]);

    // Overdue-check interval — guarded via ref so it isn't torn down each render
    const overdueRef = useRef(checkOverdueInvoices);
    useEffect(() => { overdueRef.current = checkOverdueInvoices; }, [checkOverdueInvoices]);
    useEffect(() => {
        const interval = setInterval(() => {
            if (isOnline) overdueRef.current?.();
        }, OVERDUE_CHECK_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [isOnline]);

    // ---- Server-side filter: level/class change ----
    useEffect(() => {
        setStudentsQuery({
            level: selectedLevel,
            cls: selectedClass,
            sortField: 'firstName',
            sortDirection: 'asc'
        });
        setBalancesQuery({
            level: selectedLevel,
            cls: selectedClass,
            term: scope.term,
            year: scope.year
        });
        // The roster cache is scoped by level/class — drop it when they change.
        allStudentsCacheRef.current = { data: null, at: 0, key: '' };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedLevel, selectedClass]);

    // ---- Filter students for rendering (client-side on current page) ----
    const displayedStudents = useMemo(() => {
        const term = searchTerm.toLowerCase().trim();
        const admission = searchByAdmission.toLowerCase().trim();
        const hasLocalFilter = !!(term || admission);
        if (!hasLocalFilter) return students;
        return students.filter(student => {
            const name = `${student.firstName || ''} ${student.lastName || ''}`.toLowerCase();
            const studentAdmission = (student.admissionNumber || student.studentId || '').toLowerCase();
            if (searchType === 'admission' && admission) return studentAdmission.includes(admission);
            const matchSearch = !term || name.includes(term) ||
                studentAdmission.includes(term) ||
                (student.email || '').toLowerCase().includes(term);
            return matchSearch;
        });
    }, [students, searchTerm, searchByAdmission, searchType]);

    // ---- Unique option helpers ----
    const schoolLevels = useMemo(() => {
        const idx = LEVEL_ORDER.indexOf(schoolHighestLevel);
        return idx === -1 ? [...LEVEL_ORDER] : LEVEL_ORDER.slice(0, idx + 1);
    }, [schoolHighestLevel]);

    const uniqueLevels = useMemo(() => {
        const allowed = new Set(schoolLevels);
        // Preserve order from LEVEL_ORDER for stability
        const ordered = LEVEL_ORDER.filter(l => allowed.has(l));
        // Any levels seen on students but not in order — append
        const extras = new Set();
        students.forEach(s => {
            if (s.level && allowed.has(s.level) && !ordered.includes(s.level)) extras.add(s.level);
        });
        return [...ordered, ...extras];
    }, [students, schoolLevels]);

    const getClassesForLevel = useCallback((lvl) => {
        if (lvl) return getLevelClasses ? getLevelClasses(lvl) : (LEVEL_CLASSES[lvl] || []);
        const all = [];
        LEVEL_ORDER.forEach(l => {
            const cls = getLevelClasses ? getLevelClasses(l) : (LEVEL_CLASSES[l] || []);
            all.push(...cls);
        });
        return all;
    }, [getLevelClasses]);

    const uniqueClasses = useMemo(() => {
        const set = new Set(getClassesForLevel(selectedLevel));
        students.forEach(s => {
            if (s.class && (!selectedLevel || s.level === selectedLevel)) set.add(s.class);
        });
        return [...set].sort();
    }, [students, selectedLevel, getClassesForLevel]);

    const invoiceClasses = useMemo(() => {
        const set = new Set(getClassesForLevel(invoiceForm.invoiceLevel));
        students.forEach(s => {
            if (s.class && (!invoiceForm.invoiceLevel || s.level === invoiceForm.invoiceLevel)) set.add(s.class);
        });
        return [...set].sort();
    }, [students, invoiceForm.invoiceLevel, getClassesForLevel]);

    const bulkClasses = useMemo(() => {
        const set = new Set(getClassesForLevel(bulkFeeForm.level));
        students.forEach(s => {
            if (s.class && (!bulkFeeForm.level || s.level === bulkFeeForm.level)) set.add(s.class);
        });
        return [...set].sort();
    }, [students, bulkFeeForm.level, getClassesForLevel]);

    /* =========================================================
       Receipt helpers
       ========================================================= */

    const generateReceiptNumber = useCallback(() => {
        const prefix = 'RCP';
        const d = new Date();
        const year = d.getFullYear().toString().slice(-2);
        const month = (d.getMonth() + 1).toString().padStart(2, '0');
        const day = d.getDate().toString().padStart(2, '0');
        const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        return `${prefix}-${year}${month}${day}-${random}`;
    }, []);

    const generateReceipt = useCallback(async (transaction) => {
        try {
            const student = transaction._student
                || students.find(s => s.id === transaction.studentId);
            if (!student) { console.error('Student not found for receipt'); return; }
            const balance = getStudentBalance(transaction.studentId);
            const studentInvoices = (getStudentInvoices(transaction.studentId) || [])
                .filter(inv => inv.status !== 'paid' || inv.paidAmount > 0);

            const receipt = {
                receiptNumber: transaction.receiptNumber || generateReceiptNumber(),
                studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim() || 'Student',
                admissionNumber: student.admissionNumber || student.studentId || 'N/A',
                studentClass: student.class || 'N/A',
                amount: transaction.amount || 0,
                paymentMethod: transaction.paymentMethod || 'cash',
                paymentDate: transaction.paymentDate || new Date().toISOString(),
                description: transaction.description || 'Fee Payment',
                reference: transaction.reference || 'N/A',
                term: transaction.term || 'Term 1',
                year: transaction.year || new Date().getFullYear(),
                balance: balance?.balance || 0,
                totalPaid: balance?.totalPaid || 0,
                invoices: studentInvoices.map(inv => ({
                    invoiceNumber: inv.invoiceNumber, amount: inv.amount || 0
                }))
            };

            setReceiptData(receipt);
            setShowReceiptModal(true);

            if (isOnline && transaction.id) {
                try {
                    await updateDoc(doc(db, 'fee_transactions', transaction.id), {
                        receiptNumber: receipt.receiptNumber,
                        receiptGeneratedAt: new Date().toISOString()
                    });
                } catch (error) { console.error('Error saving receipt number:', error); }
            }
        } catch (error) {
            console.error('Error generating receipt:', error);
            showNotification('Failed to generate receipt', 'error');
        }
    }, [students, getStudentBalance, getStudentInvoices, isOnline, showNotification, generateReceiptNumber]);

    /* =========================================================
       Form handlers
       ========================================================= */

    const handleFeeFormChange = (e) => {
        const { name, value } = e.target;
        setFeeForm(prev => ({ ...prev, [name]: value }));
    };

    const handleInvoiceFormChange = (e) => {
        const { name, value } = e.target;
        setInvoiceForm(prev => ({ ...prev, [name]: value }));
    };

    const handleInvoiceItemChange = (index, field, value) => {
        setInvoiceForm(prev => {
            const newItems = [...prev.items];
            newItems[index] = { ...newItems[index], [field]: value };
            return { ...prev, items: newItems };
        });
    };

    const addInvoiceItem = () => {
        setInvoiceForm(prev => ({ ...prev, items: [...prev.items, { description: '', amount: '' }] }));
    };

    const removeInvoiceItem = (index) => {
        if (invoiceForm.items.length <= 1) return;
        setInvoiceForm(prev => ({ ...prev, items: prev.items.filter((_, i) => i !== index) }));
    };

    const calculateInvoiceTotal = () => {
        const subtotal = invoiceForm.items.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
        const tax = parseFloat(invoiceForm.tax) || 0;
        const discount = parseFloat(invoiceForm.discount) || 0;
        return subtotal + tax - discount;
    };

    const handleBulkFeeFormChange = (e) => {
        const { name, value } = e.target;
        setBulkFeeForm(prev => ({ ...prev, [name]: value }));
    };

    const handleMpesaFormChange = (e) => {
        const { name, value } = e.target;
        setMpesaForm(prev => ({ ...prev, [name]: value }));
    };

    /* =========================================================
       Student reconstruction + modal openers
       ========================================================= */

    const studentFromBalance = (balance) => {
        if (!balance) return null;
        const fullName = (balance.studentName || '').trim();
        const [firstName, ...rest] = fullName.split(/\s+/);
        return {
            id: balance.studentId,
            firstName: firstName || '',
            lastName: rest.join(' ') || '',
            admissionNumber: balance.admissionNumber || '',
            class: balance.studentClass || '',
            level: balance.level || ''
        };
    };

    const openFeeModal = (studentId = null, balanceHint = null) => {
        if (balanceHint) {
            const student = studentFromBalance(balanceHint);
            setFeeForm(prev => ({
                ...prev,
                student,
                studentId: student?.id || '',
                studentAdmission: student?.admissionNumber || '',
                class: student?.class || '',
                level: student?.level || ''
            }));
        } else if (studentId) {
            const local = students.find(s => s.id === studentId);
            if (local) {
                setFeeForm(prev => ({
                    ...prev,
                    student: local,
                    studentId: local.id,
                    studentAdmission: local.admissionNumber || local.studentId || '',
                    class: local.class || '',
                    level: local.level || ''
                }));
            } else {
                (async () => {
                    try {
                        const schoolId = requireSchoolId(userData);
                        const fetched = await getStudentByAdmission(schoolId, studentId);
                        if (fetched) {
                            setFeeForm(prev => ({
                                ...prev,
                                student: fetched,
                                studentId: fetched.id,
                                studentAdmission: fetched.admissionNumber || fetched.studentId || '',
                                class: fetched.class || '',
                                level: fetched.level || ''
                            }));
                        } else {
                            setFeeForm(prev => ({
                                ...prev, student: null, studentId: '',
                                studentAdmission: '', class: '', level: ''
                            }));
                        }
                    } catch { /* ignore */ }
                })();
            }
        } else {
            setFeeForm(prev => ({ ...prev, student: null, studentId: '', studentAdmission: '', class: '', level: '' }));
        }
        setShowFeeModal(true);
    };

    const openMpesaModal = (studentId = null, balanceHint = null) => {
        if (balanceHint) {
            const student = studentFromBalance(balanceHint);
            setMpesaForm(prev => ({
                ...prev,
                student,
                studentId: student?.id || '',
                studentAdmission: student?.admissionNumber || ''
            }));
        } else if (studentId) {
            const local = students.find(s => s.id === studentId);
            if (local) {
                setMpesaForm(prev => ({
                    ...prev,
                    student: local,
                    studentId: local.id,
                    studentAdmission: local.admissionNumber || local.studentId || ''
                }));
            } else {
                setMpesaForm(prev => ({ ...prev, student: null, studentId: '', studentAdmission: '' }));
            }
        } else {
            setMpesaForm(prev => ({ ...prev, student: null, studentId: '', studentAdmission: '' }));
        }
        setShowMpesaModal(true);
    };

    /* =========================================================
       Fee submit
       ========================================================= */

    const handleFeeSubmit = async (e) => {
        e.preventDefault();
        setIsProcessing(true);
        try {
            const student = feeForm.student;
            if (!student) {
                showNotification('Please search and select a student', 'warning');
                return;
            }

            const amountNum = parseFloat(feeForm.amount);
            if (!Number.isFinite(amountNum) || amountNum <= 0) {
                showNotification('Amount must be greater than zero.', 'warning');
                return;
            }

            // Warn if payment exceeds outstanding balance
            const stBal = feeBalances[student.id];
            if (stBal && stBal.balance > 0 && amountNum > stBal.balance) {
                const ok = window.confirm(
                    `Payment (KES ${amountNum.toLocaleString()}) exceeds outstanding balance ` +
                    `(KES ${stBal.balance.toLocaleString()}). Record anyway?`
                );
                if (!ok) return;
            }

            const receiptNumber = generateReceiptNumber();
            const transaction = {
                studentId: student.id,
                studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                admissionNumber: student.admissionNumber || student.studentId || '',
                amount: amountNum,
                description: feeForm.description || 'Fee payment',
                paymentMethod: feeForm.paymentMethod,
                paymentDate: feeForm.paymentDate,
                reference: feeForm.reference || `PAY-${Date.now()}`,
                class: student.class, level: student.level,
                term: feeForm.term, year: parseInt(feeForm.year, 10),
                type: 'payment', status: 'completed',
                recordedBy: currentUser?.uid,
                recordedByName: userData?.fullName || userData?.firstName || 'System',
                receiptNumber,
                _student: student
            };

            const result = await addFeeTransaction(transaction);
            if (result.success) {
                await AuditLogService.logAction(
                    userData?.schoolId,
                    { uid: currentUser?.uid, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
                    'FEE_PAYMENT',
                    { entityId: transaction.reference, studentId: student.id, amount: transaction.amount, method: transaction.paymentMethod }
                );
                showNotification('Fee payment recorded', 'success');
                setShowFeeModal(false);
                resetFeeForm();
                invalidateRosterCache();
                refreshData();
                await generateReceipt({ ...transaction, id: result.id });
            } else {
                showNotification('Failed to record payment: ' + result.error, 'error');
            }
        } catch (error) {
            console.error('Error recording fee:', error);
            showNotification('Failed to record payment', 'error');
        } finally { setIsProcessing(false); }
    };

    const resetFeeForm = () => {
        setFeeForm({
            student: null, studentId: '', studentAdmission: '', amount: '', description: '',
            paymentMethod: 'cash', paymentDate: new Date().toISOString().split('T')[0],
            reference: '', class: '', level: '', term: 'Term 1', year: new Date().getFullYear()
        });
    };

    /* =========================================================
       Invoice submit
       ========================================================= */

    const handleInvoiceSubmit = async (e) => {
        e.preventDefault();
        setIsProcessing(true);
        try {
            let selectedStudents = [];

            if (invoiceForm.invoiceAll) {
                selectedStudents = await ensureAllStudents();
            } else if (invoiceForm.invoiceLevel) {
                const roster = await ensureAllStudents();
                selectedStudents = roster.filter(s => s.level === invoiceForm.invoiceLevel);
            } else if (invoiceForm.invoiceClass) {
                const roster = await ensureAllStudents();
                selectedStudents = roster.filter(s => s.class === invoiceForm.invoiceClass);
            } else {
                // Explicit selection — resolve any IDs not on the current page.
                const onPage = new Map(students.map(s => [s.id, s]));
                const missing = invoiceForm.studentIds.some(id => !onPage.has(id));
                if (missing) {
                    const roster = await ensureAllStudents();
                    roster.forEach(s => {
                        if (invoiceForm.studentIds.includes(s.id)) onPage.set(s.id, s);
                    });
                }
                selectedStudents = invoiceForm.studentIds.map(id => onPage.get(id)).filter(Boolean);
            }

            if (selectedStudents.length === 0) {
                showNotification('No students found matching the criteria', 'warning');
                return;
            }

            const invoiceItems = invoiceForm.items
                .filter(item => item.description && item.amount)
                .map(item => ({ description: item.description, amount: parseFloat(item.amount) }));

            if (invoiceItems.length === 0) {
                showNotification('Please add at least one invoice item', 'warning');
                return;
            }

            const entries = selectedStudents.map((student, idx) => {
                const subtotal = invoiceItems.reduce((a, i) => a + i.amount, 0);
                const tax = parseFloat(invoiceForm.tax) || 0;
                const discount = parseFloat(invoiceForm.discount) || 0;
                return {
                    studentId: student.id,
                    studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                    studentClass: student.class || '',
                    studentLevel: student.level || '',
                    admissionNumber: student.admissionNumber || student.studentId || '',
                    items: invoiceItems, subtotal, tax, discount,
                    total: subtotal + tax - discount,
                    term: invoiceForm.term,
                    academicYear: invoiceForm.year.toString(),
                    dueDate: invoiceForm.dueDate,
                    notes: invoiceForm.notes,
                    suffix: `${Date.now()}_${idx}`
                };
            });

            const totalBilled = entries.reduce((sum, e) => sum + e.total, 0);

            const result = await createBulkInvoices(entries, {
                term: invoiceForm.term, year: invoiceForm.year,
                createdBy: currentUser?.uid,
                createdByName: userData?.fullName || userData?.firstName || 'System'
            });

            await AuditLogService.logAction(
                userData?.schoolId,
                { uid: currentUser?.uid, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
                'INVOICES_CREATED',
                {
                    count: result.count,
                    term: invoiceForm.term,
                    year: invoiceForm.year,
                    totalBilled,
                    scope: invoiceForm.invoiceAll ? 'all'
                        : invoiceForm.invoiceLevel ? `level:${invoiceForm.invoiceLevel}`
                        : invoiceForm.invoiceClass ? `class:${invoiceForm.invoiceClass}`
                        : 'selected'
                }
            );

            showNotification(`Invoices created for ${result.count} of ${selectedStudents.length} students`, 'success');
            setShowInvoiceModal(false);
            resetInvoiceForm();
            invalidateRosterCache();
            refreshData();
        } catch (error) {
            console.error('Error creating invoices:', error);
            showNotification('Failed to create invoices: ' + error.message, 'error');
        } finally { setIsProcessing(false); }
    };

    const resetInvoiceForm = () => {
        setInvoiceForm({
            studentIds: [], items: [{ description: '', amount: '' }],
            dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            term: 'Term 1', year: new Date().getFullYear(),
            invoiceAll: false, invoiceLevel: '', invoiceClass: '',
            notes: '', tax: 0, discount: 0
        });
    };

    const handleLoadFeeStructureIntoInvoice = async () => {
        try {
            const schoolId = requireSchoolId(userData);
            const target = invoiceForm.invoiceClass || invoiceForm.invoiceLevel || 'lower-primary';
            const struct = await getFeeStructure(schoolId, target, invoiceForm.year, invoiceForm.term);
            if (struct?.items?.length) {
                setInvoiceForm(prev => ({
                    ...prev,
                    items: struct.items.map(i => ({ description: i.description, amount: String(i.amount) }))
                }));
                showNotification(`Loaded ${struct.items.length} items from fee schedule (${struct.name || target})!`, 'success');
            } else {
                showNotification(`No fee schedule found for "${target}" in ${invoiceForm.term} ${invoiceForm.year}.`, 'warning');
            }
        } catch (err) {
            showNotification('Error loading fee structure: ' + err.message, 'error');
        }
    };

    /* =========================================================
       Bulk fee entry
       ========================================================= */

    const handleBulkFeeSubmit = async (e) => {
        e.preventDefault();
        setIsProcessing(true);
        try {
            const amountNum = parseFloat(bulkFeeForm.amount);
            if (!Number.isFinite(amountNum) || amountNum <= 0) {
                showNotification('Amount must be greater than zero.', 'warning');
                return;
            }

            const roster = await ensureAllStudents();
            const targetStudents = roster.filter(s => {
                const matchLevel = !bulkFeeForm.level || s.level === bulkFeeForm.level;
                const matchClass = !bulkFeeForm.class || s.class === bulkFeeForm.class;
                return matchLevel && matchClass;
            });

            if (targetStudents.length === 0) {
                showNotification('No students found matching the criteria', 'warning');
                return;
            }

            const CHUNK = 100;
            let successCount = 0;
            const batchRef = `BULK-${Date.now()}`;

            for (let i = 0; i < targetStudents.length; i += CHUNK) {
                const chunk = targetStudents.slice(i, i + CHUNK);
                const results = await Promise.all(chunk.map(student =>
                    addFeeTransaction({
                        studentId: student.id,
                        studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                        admissionNumber: student.admissionNumber || student.studentId || '',
                        amount: amountNum,
                        description: bulkFeeForm.description || 'Bulk fee payment',
                        paymentMethod: 'bulk',
                        paymentDate: new Date().toISOString().split('T')[0],
                        reference: `${batchRef}-${i}`,
                        class: student.class, level: student.level,
                        term: bulkFeeForm.term, year: parseInt(bulkFeeForm.year, 10),
                        type: 'payment', status: 'completed',
                        recordedBy: currentUser?.uid,
                        recordedByName: userData?.fullName || userData?.firstName || 'System'
                    })
                ));
                successCount += results.filter(r => r.success).length;
            }

            await AuditLogService.logAction(
                userData?.schoolId,
                { uid: currentUser?.uid, fullName: userData?.fullName, email: currentUser?.email, role: userRole },
                'BULK_FEE_PAYMENT',
                {
                    count: successCount,
                    amount: amountNum,
                    level: bulkFeeForm.level || '*',
                    cls: bulkFeeForm.class || '*',
                    term: bulkFeeForm.term
                }
            );

            showNotification(`Bulk fees recorded for ${successCount} of ${targetStudents.length} students`, 'success');
            setShowBulkFeeModal(false);
            setBulkFeeForm({ level: '', class: '', amount: '', description: '', term: 'Term 1', year: new Date().getFullYear() });
            invalidateRosterCache();
            refreshData();
        } catch (error) {
            console.error('Error recording bulk fees:', error);
            showNotification('Failed to record bulk fees', 'error');
        } finally { setIsProcessing(false); }
    };

    /* =========================================================
       M-Pesa submit
       ========================================================= */

    const handleMpesaPayment = async (e) => {
        e.preventDefault();
        setIsProcessing(true);
        try {
            const student = mpesaForm.student;
            if (!student) {
                showNotification('Please search and select a student', 'warning');
                return;
            }

            const amountNum = parseFloat(mpesaForm.amount);
            if (!Number.isFinite(amountNum) || amountNum <= 0) {
                showNotification('Amount must be greater than zero.', 'warning');
                return;
            }

            let phone = mpesaForm.phoneNumber.replace(/\D/g, '');
            if (phone.startsWith('0')) phone = '254' + phone.substring(1);
            else if (!phone.startsWith('254')) phone = '254' + phone;

            let token = '';
            try {
                if (currentUser?.getIdToken) token = await currentUser.getIdToken();
            } catch { /* ignore */ }

            const response = await fetch('/api/mpesa-stk-push', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify({
                    phoneNumber: phone,
                    amount: amountNum,
                    studentId: student.id,
                    studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                    admissionNumber: student.admissionNumber || student.studentId || '',
                    description: mpesaForm.description || 'School fees payment',
                    schoolId: userData?.schoolId,
                    schoolName: userData?.schoolName || ''
                })
            });

            const result = await response.json();
            if (result.success) {
                await addFeeTransaction({
                    studentId: student.id,
                    studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                    admissionNumber: student.admissionNumber || student.studentId || '',
                    amount: amountNum,
                    description: mpesaForm.description || 'M-Pesa payment',
                    paymentMethod: 'mpesa',
                    paymentDate: new Date().toISOString().split('T')[0],
                    reference: result.CheckoutRequestID || `MPESA-${Date.now()}`,
                    class: student.class, level: student.level,
                    term: feeForm.term || 'Term 1',
                    year: parseInt(feeForm.year || new Date().getFullYear(), 10),
                    type: 'payment', status: 'pending',
                    recordedBy: currentUser?.uid,
                    recordedByName: userData?.fullName || userData?.firstName || 'System',
                    mpesaResult: result
                });
                showNotification('M-Pesa STK push sent! Check the phone to complete payment.', 'success');
                setShowMpesaModal(false);
                setMpesaForm({ student: null, studentId: '', studentAdmission: '', phoneNumber: '', amount: '', description: '' });
                invalidateRosterCache();
            } else {
                showNotification('Failed to send M-Pesa STK push: ' + (result.message || 'unknown error'), 'error');
            }
        } catch (error) {
            console.error('Error processing M-Pesa payment:', error);
            showNotification('Failed to process M-Pesa payment', 'error');
        } finally { setIsProcessing(false); }
    };

    /* =========================================================
       Bank statement import
       ========================================================= */

    const handleFileImport = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > MAX_IMPORT_SIZE) {
            showNotification('File too large (max 5 MB)', 'error');
            e.target.value = ''; return;
        }

        setStatementFile(file);
        setStatementData([]);
        setMatchedTransactions([]);
        setUnmatchedTransactions([]);
        setReconcileResults(null);

        try {
            const fileType = file.name.split('.').pop().toLowerCase();
            let data = [];

            if (fileType === 'csv') {
                const text = await file.text();
                const parser = parseCSV({ columns: true, skip_empty_lines: true });
                const records = [];
                await new Promise((resolve, reject) => {
                    parser.on('readable', () => {
                        let record;
                        while ((record = parser.read()) !== null) records.push(record);
                    });
                    parser.on('error', reject);
                    parser.write(text); parser.end(); resolve();
                });
                data = records;
            } else if (fileType === 'xlsx' || fileType === 'xls') {
                const arrayBuffer = await file.arrayBuffer();
                const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                data = XLSX.utils.sheet_to_json(firstSheet);
            } else if (fileType === 'pdf') {
                const pdfjsLib = await import('pdfjs-dist');
                pdfjsLib.GlobalWorkerOptions.workerSrc = '//unpkg.com/pdfjs-dist@' + pdfjsLib.version + '/build/pdf.worker.min.mjs';
                const arrayBuffer = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                let fullText = '';
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const textContent = await page.getTextContent();
                    const yMap = {};
                    textContent.items.forEach(item => {
                        const y = Math.round(item.transform[5]);
                        if (!yMap[y]) yMap[y] = [];
                        yMap[y].push(item);
                    });
                    const sortedY = Object.keys(yMap).sort((a, b) => parseFloat(b) - parseFloat(a));
                    for (const y of sortedY) {
                        const lineItems = yMap[y].sort((a, b) => a.transform[4] - b.transform[4]);
                        const lineText = lineItems.map(item => item.str).join(' ').trim();
                        if (lineText) fullText += lineText + '\n';
                    }
                }
                const lines = fullText.split('\n');
                data = lines.map(line => {
                    const moneyMatch = line.match(/(?:KES|Ksh|Kshs|\$)\s*([\d,]+(?:\.\d{2})?)/i);
                    let amount = 0;
                    if (moneyMatch && moneyMatch[1]) amount = parseFloat(moneyMatch[1].replace(/,/g, ''));
                    else {
                        const numMatches = line.match(/\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b|\b\d+(?:\.\d{2})?\b/g);
                        if (numMatches) {
                            const numbers = numMatches.map(n => parseFloat(n.replace(/,/g, ''))).filter(n => n > 0 && n < 1000000);
                            if (numbers.length > 0) amount = numbers[numbers.length > 1 ? numbers.length - 2 : 0];
                        }
                    }
                    return { RawText: line, Amount: amount };
                }).filter(r => r.RawText.trim() !== '');
            } else {
                showNotification('Unsupported file format. Use CSV, Excel, or PDF.', 'error');
                return;
            }

            const hash = generateStatementHash(data);
            if (uploadedStatements.some(s => s.hash === hash)) {
                showNotification('This statement has already been uploaded', 'warning');
                setStatementFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
                return;
            }

            setStatementData(data);
            setStatementHash(hash);

            const headers = Object.keys(data[0] || {});
            let detectedBank = 'unknown';
            if (headers.some(h => h.toLowerCase().includes('mpesa'))) detectedBank = 'mpesa';
            else if (headers.some(h => h.toLowerCase().includes('transaction'))) detectedBank = 'bank';
            setSelectedBank(detectedBank);
            setShowReconcileModal(true);
        } catch (error) {
            console.error('Error importing file:', error);
            showNotification('Failed to import file: ' + error.message, 'error');
        }
    };

    /* =========================================================
       Reconciliation
       ========================================================= */

    const performReconciliation = async () => {
        setIsProcessing(true);
        setShowReconcileModal(false);
        try {
            const matched = [];
            const unmatched = [];
            const studentMap = {};

            // Walk the FULL roster — critical: bank statements include students
            // who may not be on the current page.
            const roster = await ensureAllStudents();

            roster.forEach(s => {
                const name = `${s.firstName || ''} ${s.lastName || ''}`.trim().toLowerCase();
                const admission = (s.admissionNumber || s.studentId || '').toLowerCase();
                if (name) studentMap[name] = s;
                if (admission) studentMap[admission] = s;
                const noSpaceName = name.replace(/\s/g, '');
                if (noSpaceName) studentMap[noSpaceName] = s;
                // Index individual name tokens ≥3 chars
                name.split(/\s+/).forEach(tok => {
                    if (tok.length >= 3 && !studentMap[tok]) studentMap[tok] = s;
                });
            });

            for (const transaction of statementData) {
                let matchedStudent = null;
                let matchScore = 0;
                const transactionText = Object.values(transaction).join(' ').toLowerCase();
                for (const [key, student] of Object.entries(studentMap)) {
                    if (typeof key === 'string' && key && transactionText.includes(key)) {
                        if (key.length > matchScore) {
                            matchedStudent = student;
                            matchScore = key.length;
                        }
                    }
                }
                const amount = parseFloat(transaction.Amount || transaction.amount || transaction.AMOUNT || 0);
                if (amount > 0 && matchedStudent) {
                    const balance = getStudentBalance(matchedStudent.id);
                    if (balance && balance.balance >= amount) matchScore += 10;
                }
                if (matchedStudent && matchScore > 5) {
                    matched.push({
                        transaction, student: matchedStudent, amount, confidence: matchScore,
                        admissionNumber: matchedStudent.admissionNumber || matchedStudent.studentId
                    });
                } else unmatched.push(transaction);
            }

            setMatchedTransactions(matched);
            setUnmatchedTransactions(unmatched);
            setReconcileResults({
                total: statementData.length, matched: matched.length, unmatched: unmatched.length,
                totalAmount: statementData.reduce((sum, t) => sum + (parseFloat(t.Amount || t.amount || t.AMOUNT || 0) || 0), 0)
            });
            setShowStatementModal(true);
        } catch (error) {
            console.error('Error during reconciliation:', error);
            showNotification('Failed to reconcile transactions', 'error');
        } finally { setIsProcessing(false); }
    };

    const recordReconciledTransactions = async () => {
        setIsProcessing(true);
        try {
            const reconciliationId = `REC-${Date.now().toString().slice(0, 8)}`;
            const CHUNK = 50;
            let successCount = 0;

            for (let i = 0; i < matchedTransactions.length; i += CHUNK) {
                const chunk = matchedTransactions.slice(i, i + CHUNK);
                const results = await Promise.all(chunk.map(({ student, transaction, amount }) =>
                    addFeeTransaction({
                        studentId: student.id,
                        studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                        admissionNumber: student.admissionNumber || student.studentId || '',
                        amount,
                        description: transaction.Description || transaction.description || 'Bank statement reconciliation',
                        paymentMethod: selectedBank === 'mpesa' ? 'mpesa' : 'bank',
                        paymentDate: transaction.Date || transaction.date || new Date().toISOString().split('T')[0],
                        reference: transaction.Reference || transaction.reference || `REC-${Date.now()}`,
                        class: student.class, level: student.level,
                        term: scope.term || 'Term 1',
                        year: scope.year || new Date().getFullYear(),
                        type: 'payment', status: 'completed',
                        recordedBy: currentUser?.uid,
                        recordedByName: userData?.fullName || userData?.firstName || 'System',
                        reconciled: true, reconciliationId,
                        receiptNumber: generateReceiptNumber()
                    })
                ));
                successCount += results.filter(r => r.success).length;
            }

            if (statementHash) {
                const updated = [...uploadedStatements, {
                    hash: statementHash,
                    fileName: statementFile?.name || 'Unknown',
                    uploadedAt: new Date().toISOString(),
                    recordCount: statementData.length,
                    matchedCount: matchedTransactions.length
                }];
                setUploadedStatements(updated);
                await saveToIndexedDB('uploaded_statements', updated);
            }

            showNotification(`Recorded ${successCount} of ${matchedTransactions.length} payments`, 'success');
            setShowStatementModal(false);
            setStatementData([]);
            setMatchedTransactions([]);
            setUnmatchedTransactions([]);
            setReconcileResults(null);
            setStatementFile(null);
            invalidateRosterCache();
            refreshData();
            if (fileInputRef.current) fileInputRef.current.value = '';
        } catch (error) {
            console.error('Error recording reconciled transactions:', error);
            showNotification('Failed to record transactions', 'error');
        } finally { setIsProcessing(false); }
    };

    /* =========================================================
       Invoice details + reminders
       ========================================================= */

    const viewInvoiceDetails = (invoice) => {
        setSelectedInvoice(invoice);
        setShowInvoiceDetailsModal(true);
    };

    const handleSendReminder = async (invoice) => {
        if (!window.confirm(`Send reminder for invoice ${invoice.invoiceNumber} to ${invoice.studentName}?`)) return;
        try {
            const result = await sendInvoiceReminder(invoice.id);
            if (result.success) { showNotification('Reminder sent', 'success'); refreshData(); }
            else showNotification('Failed to send reminder: ' + result.error, 'error');
        } catch (error) {
            console.error('Error sending reminder:', error);
            showNotification('Failed to send reminder', 'error');
        }
    };

    /* =========================================================
       Defaulters export (full roster)
       ========================================================= */

    const handleExportDefaulters = async () => {
        try {
            const roster = await ensureAllStudents();
            const defaulters = roster.map(s => {
                const balance = getStudentBalance(s.id) || { balance: 0 };
                return {
                    Name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
                    Admission: s.admissionNumber || 'N/A',
                    Class: s.class || 'N/A',
                    Balance: balance.balance,
                    ParentPhone: s.parentPhone || 'N/A',
                    ParentEmail: s.parentEmail || 'N/A'
                };
            }).filter(s => s.Balance > 0);

            if (defaulters.length === 0) {
                showNotification('No defaulters found.', 'info');
                return;
            }

            const headers = ['Name', 'Admission', 'Class', 'Balance', 'ParentPhone', 'ParentEmail'];
            const csvContent = '\uFEFF' + headers.join(',') + '\n' +
                defaulters.map(row => headers.map(f => escapeCsv(row[f])).join(',')).join('\n');

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `Defaulters_${scope.term || 'Term1'}_${scope.year || new Date().getFullYear()}.csv`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            showNotification(`Exported ${defaulters.length} defaulters`, 'success');
        } catch (err) {
            console.error('Defaulters export failed:', err);
            showNotification('Export failed: ' + err.message, 'error');
        }
    };

    /* =========================================================
       Bulk reminders (full roster)
       ========================================================= */

    const handleSendBulkReminders = async () => {
        if (!window.confirm('This will send reminders for all unpaid invoices to parents. Proceed?')) return;
        setIsProcessing(true);
        let sentCount = 0;
        try {
            const roster = await ensureAllStudents();
            const allUnpaid = [];
            roster.forEach(s => {
                const invoices = getStudentInvoices(s.id) || [];
                invoices.forEach(inv => {
                    if (['pending', 'partial', 'overdue'].includes(inv.status)) allUnpaid.push(inv.id);
                });
            });
            if (allUnpaid.length === 0) {
                showNotification('No unpaid invoices found.', 'info');
                return;
            }
            for (const invId of allUnpaid) {
                await sendInvoiceReminder(invId);
                sentCount++;
            }
            showNotification(`Successfully sent ${sentCount} reminders.`, 'success');
        } catch (error) {
            showNotification(`Error sending reminders: ${error.message}`, 'error');
        } finally { setIsProcessing(false); }
    };

    /* =========================================================
       Receipt handlers
       ========================================================= */

    const handleGenerateReceipt = async (studentId) => {
        const studentTransactions = feeTransactions
            .filter(t => t.studentId === studentId && t.type === 'payment')
            .sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));
        if (studentTransactions.length > 0) {
            const student = students.find(s => s.id === studentId);
            await generateReceipt({ ...studentTransactions[0], _student: student });
        } else {
            showNotification('No transactions found for this student', 'warning');
        }
    };

    const handleDownloadReceiptPDF = useCallback(async () => {
        if (!receiptData) return;
        try {
            const result = await downloadReceiptPDF(receiptData, schoolData);
            showNotification(
                `Receipt saved${result?.uri ? ' to Downloads/EduPriva' : ''}${result?.filename ? ` as ${result.filename}` : ''}.`,
                'success'
            );
        } catch (e) {
            console.error(e);
            showNotification('PDF generation failed', 'error');
        }
    }, [receiptData, schoolData, showNotification]);

    /* =========================================================
       Derived stats
       ========================================================= */

    const invoiceStats = useMemo(() => {
        try { return getInvoiceStats(); } catch { return null; }
    }, [getInvoiceStats]);

    const totalCollected = useMemo(() =>
        feeTransactions
            .filter(t => t.type === 'payment' && ['completed', 'success', 'paid'].includes(t.status))
            .reduce((sum, t) => sum + (t.amount || 0), 0),
        [feeTransactions]);

    const outstandingBalance = useMemo(() =>
        Object.values(feeBalances).reduce((sum, b) => sum + (b.balance > 0 ? b.balance : 0), 0),
        [feeBalances]);

    const fullyPaid = useMemo(() =>
        Object.values(feeBalances).filter(b => b.status === 'paid').length, [feeBalances]);

    const partialPaid = useMemo(() =>
        Object.values(feeBalances).filter(b => b.status === 'partial').length, [feeBalances]);

    // Memoized balance enrichment — avoids calling getStudentInvoices in the render loop.
    const enrichedBalances = useMemo(() => {
        return paginatedBalances.map(studentBalance => {
            const enriched = {
                ...studentBalance,
                studentName: studentBalance.studentName || 'Unnamed Student',
                studentClass: studentBalance.studentClass || 'N/A',
                admissionNumber: studentBalance.admissionNumber || 'N/A',
                totalInvoiced: studentBalance.totalInvoiced || 0,
                totalPaid: studentBalance.totalPaid || 0,
                totalDiscount: studentBalance.totalDiscount || 0,
                totalWaived: studentBalance.totalWaived || 0,
                balance: studentBalance.balance || 0,
                status: studentBalance.status || 'no_invoice'
            };
            const studentInvoices = getStudentInvoices(enriched.studentId) || [];
            if (studentInvoices.length > 0) {
                enriched.invoiceSummary = {
                    total: studentInvoices.length,
                    unpaid: studentInvoices.filter(i => ['pending', 'overdue', 'partial'].includes(i.status)).length,
                    overdue: studentInvoices.filter(i => i.status === 'overdue').length
                };
            }
            return enriched;
        });
    }, [paginatedBalances, getStudentInvoices]);

    /* =========================================================
       Render helpers
       ========================================================= */

    const renderBalanceCard = (balance) => {
        const statusColor = balance.status === 'paid' ? '#27ae60' :
            balance.status === 'partial' ? '#f39c12' :
            balance.status === 'no_invoice' ? '#95a5a6' : '#e74c3c';
        const statusLabel = balance.status === 'paid' ? 'Paid' :
            balance.status === 'partial' ? 'Partial' :
            balance.status === 'no_invoice' ? 'No Invoice' : 'Pending';

        return (
            <div className="balance-card" key={balance.studentId} style={{
                background: 'white', borderRadius: '12px', padding: '15px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                borderLeft: `4px solid ${statusColor}`, marginBottom: '10px', transition: 'all 0.3s'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <div style={{ fontWeight: '600', color: 'var(--secondary)' }}>
                            {balance.studentName}
                            <span style={{ fontSize: '11px', color: 'var(--gray)', marginLeft: '8px' }}>
                                ({balance.studentClass || 'N/A'})
                            </span>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                            Adm: {balance.admissionNumber || 'N/A'} • Invoiced: KES {(balance.totalInvoiced || 0).toLocaleString()} • Paid: KES {(balance.totalPaid || 0).toLocaleString()}
                        </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: '700', fontSize: '18px', color: (balance.balance || 0) > 0 ? 'var(--danger)' : 'var(--success)' }}>
                            KES {(balance.balance || 0).toLocaleString()}
                        </div>
                        <span style={{
                            fontSize: '11px', padding: '2px 10px', borderRadius: '12px',
                            background: statusColor + '20', color: statusColor, fontWeight: '600'
                        }}>
                            {statusLabel}
                        </span>
                    </div>
                </div>
                <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-sm btn-primary" onClick={() => openFeeModal(balance.studentId, balance)} style={smallBtn('var(--primary)')}>
                        <i className="fas fa-plus"></i> Pay
                    </button>
                    <button type="button" className="btn btn-sm btn-success" onClick={() => openMpesaModal(balance.studentId, balance)} style={smallBtn('#25D366')}>
                        <i className="fas fa-mobile-alt"></i> M-Pesa
                    </button>
                    <button type="button" className="btn btn-sm btn-info" onClick={() => navigate(`/student-fees/${balance.studentId}`)} style={smallBtn('var(--info)')}>
                        <i className="fas fa-history"></i> History
                    </button>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => handleGenerateReceipt(balance.studentId)} style={smallBtn('#6c757d')}>
                        <i className="fas fa-receipt"></i> Receipt
                    </button>
                    <button type="button" className="btn btn-sm btn-outline" title="Reconcile Student Balance"
                        onClick={async () => {
                            try {
                                await reconcileBalance(balance.studentId, scope.term, scope.year);
                                showNotification(`Reconciled balance for ${balance.studentName}`, 'success');
                            } catch (err) {
                                showNotification(`Reconciliation failed: ${err.message}`, 'error');
                            }
                        }} style={smallBtn('#4b5563')}>
                        <i className="fas fa-sync-alt"></i> Reconcile
                    </button>
                </div>
            </div>
        );
    };

    const renderPagination = () => {
        const totalPages = balancesPage.total !== null
            ? Math.ceil(balancesPage.total / balancesPage.pageSize)
            : null;
        const start = balancesPage.pageIndex * balancesPage.pageSize + 1;
        const end = start + paginatedBalances.length - 1;
        const showing = paginatedBalances.length;

        return (
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '15px 20px', background: 'white', borderTop: '1px solid var(--border)',
                flexWrap: 'wrap', gap: '10px', borderRadius: '0 0 12px 12px'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: '14px', color: 'var(--gray)' }}>
                        {showing === 0
                            ? 'No records'
                            : `Page ${balancesPage.pageIndex + 1}${totalPages ? ` of ${totalPages}` : ''} — showing ${start}-${end}${balancesPage.total !== null ? ` of ${balancesPage.total}` : ''}`}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <label style={{ fontSize: '13px', color: 'var(--gray)' }}>Rows per page:</label>
                        <select value={balancesPage.pageSize}
                            onChange={(e) => setPageSize('balances', parseInt(e.target.value, 10))}
                            style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border)', fontSize: '13px' }}>
                            {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '5px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        style={pageBtnStyle(balancesPage.pageIndex === 0 || balancesPage.loading)}
                        onClick={() => goToPrevPage('balances')}
                        disabled={balancesPage.pageIndex === 0 || balancesPage.loading}
                    >
                        <i className="fas fa-chevron-left"></i> Prev
                    </button>
                    <button
                        type="button"
                        style={pageBtnStyle(!balancesPage.hasMore || balancesPage.loading)}
                        onClick={() => goToNextPage('balances')}
                        disabled={!balancesPage.hasMore || balancesPage.loading}
                    >
                        Next <i className="fas fa-chevron-right"></i>
                    </button>
                </div>
            </div>
        );
    };

    if (loading && studentsPage.items.length === 0) return <LoadingSpinner fullScreen text="Loading fee data..." />;

    return (
        <Layout title="Fee Management">
            <style>{feesStyles}</style>

            <div className="fees-container">
                {/* Invoice Stats Summary */}
                {invoiceStats && invoiceStats.total > 0 && (
                    <div style={{
                        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                        gap: '10px', marginBottom: '20px', padding: '15px',
                        background: 'white', borderRadius: '12px', boxShadow: 'var(--shadow)'
                    }}>
                        <StatBox label="Total Invoices" value={invoiceStats.total} />
                        <StatBox label="Paid" value={invoiceStats.paid} color="var(--success)" />
                        <StatBox label="Pending" value={invoiceStats.pending} color="var(--warning)" />
                        <StatBox label="Overdue" value={invoiceStats.overdue} color="var(--danger)" />
                        <StatBox label="Outstanding" value={`KES ${(invoiceStats.outstandingAmount || 0).toLocaleString()}`} color="var(--danger)" />
                    </div>
                )}

                {/* Stats */}
                <div className="fee-stats-grid">
                    <div className="fee-stat-card">
                        <div className="stat-label">Total Students</div>
                        <div className="stat-value">{studentsPage.total ?? students.length}</div>
                    </div>
                    <div className="fee-stat-card">
                        <div className="stat-label">Total Collected</div>
                        <div className="stat-value">KES {totalCollected.toLocaleString()}</div>
                    </div>
                    <div className="fee-stat-card">
                        <div className="stat-label">Outstanding Balance</div>
                        <div className="stat-value" style={{ color: 'var(--danger)' }}>KES {outstandingBalance.toLocaleString()}</div>
                    </div>
                    <div className="fee-stat-card">
                        <div className="stat-label">Fully Paid</div>
                        <div className="stat-value" style={{ color: 'var(--success)' }}>{fullyPaid}</div>
                        <div className="stat-sub">{partialPaid} partial</div>
                    </div>
                </div>

                {/* Action Buttons */}
                <div className="fee-actions">
                    <button type="button" className="btn btn-primary" onClick={() => openFeeModal()}><i className="fas fa-plus"></i> Record Payment</button>
                    <button type="button" className="btn btn-success" onClick={() => setShowInvoiceModal(true)}><i className="fas fa-file-invoice"></i> Create Invoice</button>
                    <button type="button" className="btn btn-info" onClick={() => navigate('/fee-structure')} style={{ background: '#4f46e5', color: '#fff' }}><i className="fas fa-layer-group"></i> Fee Schedules</button>
                    <button type="button" className="btn btn-warning" onClick={() => setShowBulkFeeModal(true)}><i className="fas fa-users"></i> Bulk Fee Entry</button>
                    <button type="button" className="btn btn-whatsapp" onClick={() => setShowMpesaModal(true)}><i className="fas fa-mobile-alt"></i> M-Pesa STK Push</button>
                    <button type="button" className="btn btn-danger" onClick={() => setShowReconcileModal(true)}><i className="fas fa-credit-card"></i> Reconcile Statement</button>
                    <button type="button" className="btn btn-outline" onClick={() => navigate('/fee-reports')}><i className="fas fa-chart-bar"></i> Reports</button>
                    <button type="button" className="btn btn-outline" onClick={handleExportDefaulters} style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
                        <i className="fas fa-file-csv"></i> Export Defaulters
                    </button>
                    <button type="button" className="btn btn-outline" onClick={handleSendBulkReminders} disabled={isProcessing} style={{ borderColor: '#f39c12', color: '#f39c12' }}>
                        <i className="fas fa-bell"></i> {isProcessing ? 'Sending...' : 'Send All Reminders'}
                    </button>
                </div>

                {/* Filters */}
                <div className="filters-section">
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', width: '100%' }}>
                        <div className="search-toggle">
                            <button type="button" className={searchType === 'name' ? 'active' : ''} onClick={() => { setSearchType('name'); setSearchByAdmission(''); setSearchTerm(''); }}>
                                <i className="fas fa-user"></i> Name
                            </button>
                            <button type="button" className={searchType === 'admission' ? 'active' : ''} onClick={() => { setSearchType('admission'); setSearchTerm(''); }}>
                                <i className="fas fa-id-card"></i> Admission No
                            </button>
                        </div>
                    </div>

                    {searchType === 'name' ? (
                        <input type="text" className="search-input" placeholder="Search on current page by name, email, or ID..."
                            value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                    ) : (
                        <input type="text" className="search-input" placeholder="Search on current page by admission number..."
                            value={searchByAdmission} onChange={(e) => setSearchByAdmission(e.target.value)}
                            style={{ borderColor: 'var(--primary)' }} />
                    )}

                    <select className="filter-select" value={selectedLevel} onChange={(e) => setSelectedLevel(e.target.value)}>
                        <option value="">All Levels</option>
                        {uniqueLevels.map(level => (
                            <option key={level} value={level}>{LEVEL_DISPLAY_NAMES[level] || level}</option>
                        ))}
                    </select>
                    <select className="filter-select" value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
                        <option value="">All Classes</option>
                        {uniqueClasses.map(cls => <option key={cls} value={cls}>{cls}</option>)}
                    </select>
                    <button type="button" className="btn btn-outline" onClick={() => {
                        setSearchTerm(''); setSearchByAdmission('');
                        setSelectedLevel(''); setSelectedClass('');
                    }}><i className="fas fa-times"></i> Clear</button>
                </div>

                {loadingAllStudents && (
                    <div style={{ padding: '10px 16px', background: '#eef2ff', color: '#3730a3', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
                        <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }}></i>
                        Loading full roster for bulk operation…
                    </div>
                )}

                {/* Balance List */}
                {balancesPage.loading && paginatedBalances.length === 0 ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--gray)' }}>
                        <i className="fas fa-spinner fa-spin" style={{ fontSize: '32px' }}></i>
                        <div style={{ marginTop: '10px' }}>Loading page...</div>
                    </div>
                ) : (
                    <div className="balance-list">
                        {enrichedBalances.map(enriched => renderBalanceCard(enriched))}

                        {paginatedBalances.length === 0 && !balancesPage.loading && (
                            <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '60px 20px', color: 'var(--gray)' }}>
                                <i className="fas fa-search" style={{ fontSize: '64px', display: 'block', marginBottom: '20px', color: 'var(--border)' }}></i>
                                <h3 style={{ fontSize: '20px', color: 'var(--secondary)', marginBottom: '10px' }}>No Students Found</h3>
                                <p>No students found matching the filters</p>
                            </div>
                        )}
                    </div>
                )}

                {renderPagination()}

                {/* ===================== MODALS ===================== */}

                {/* Fee Modal */}
                {showFeeModal && (
                    <Modal onClose={() => setShowFeeModal(false)} title="Record Fee Payment">
                        <form onSubmit={handleFeeSubmit}>
                            <div className="form-group">
                                <label>Student <span className="required">*</span></label>
                                <StudentPicker
                                    schoolId={userData?.schoolId}
                                    value={feeForm.student}
                                    onChange={(student) => {
                                        setFeeForm(prev => ({
                                            ...prev,
                                            student,
                                            studentId: student?.id || '',
                                            studentAdmission: student?.admissionNumber || student?.studentId || '',
                                            class: student?.class || '',
                                            level: student?.level || ''
                                        }));
                                    }}
                                    autoFocus
                                />
                                <div style={{ fontSize: '12px', color: 'var(--gray)', marginTop: '5px' }}>
                                    Type at least 2 characters to search across all students (any page).
                                </div>
                            </div>

                            {feeForm.student && (() => {
                                const stBal = feeBalances[feeForm.student.id];
                                const totalOwed = stBal ? stBal.balance : 0;
                                return (
                                    <div style={{ marginBottom: '15px', padding: '12px', background: 'var(--light)', borderRadius: '8px' }}>
                                        <div style={{ fontSize: '13px' }}>
                                            <strong>Student:</strong> {feeForm.student.firstName} {feeForm.student.lastName}
                                            <br /><strong>Class:</strong> {feeForm.student.class || 'N/A'} | <strong>Level:</strong> {feeForm.student.level || 'N/A'}
                                            <br /><strong>Total Balance Owed:</strong> <span style={{ color: totalOwed > 0 ? 'var(--danger)' : 'var(--success)', fontWeight: '700' }}>KES {totalOwed.toLocaleString()}</span>
                                        </div>
                                    </div>
                                );
                            })()}

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Amount (KES) <span className="required">*</span></label>
                                    <input type="number" name="amount" value={feeForm.amount} onChange={handleFeeFormChange} min="1" step="1" required />
                                </div>
                                <div className="form-group">
                                    <label>Payment Method <span className="required">*</span></label>
                                    <select name="paymentMethod" value={feeForm.paymentMethod} onChange={handleFeeFormChange} required>
                                        <option value="cash">Cash</option>
                                        <option value="mpesa">M-Pesa</option>
                                        <option value="bank">Bank Transfer</option>
                                        <option value="cheque">Cheque</option>
                                        <option value="waiver">Fee Waiver / Bursary</option>
                                        <option value="discount">Fee Discount</option>
                                    </select>
                                </div>
                            </div>

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Payment Date</label>
                                    <input type="date" name="paymentDate" value={feeForm.paymentDate} onChange={handleFeeFormChange} />
                                </div>
                                <div className="form-group">
                                    <label>Reference</label>
                                    <input type="text" name="reference" value={feeForm.reference} onChange={handleFeeFormChange} placeholder="Optional" />
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Description</label>
                                <input type="text" name="description" value={feeForm.description} onChange={handleFeeFormChange} placeholder="Payment description" />
                            </div>

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Term</label>
                                    <select name="term" value={feeForm.term} onChange={handleFeeFormChange}>
                                        <option value="Term 1">Term 1</option>
                                        <option value="Term 2">Term 2</option>
                                        <option value="Term 3">Term 3</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>Year</label>
                                    <input type="number" name="year" value={feeForm.year} onChange={handleFeeFormChange} min="2020" max="2035" />
                                </div>
                            </div>

                            <div className="modal-footer">
                                <button type="button" className="btn btn-outline" onClick={() => setShowFeeModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={isProcessing}>
                                    {isProcessing ? 'Processing...' : 'Record Payment'}
                                </button>
                            </div>
                        </form>
                    </Modal>
                )}

                {/* Invoice Modal */}
                {showInvoiceModal && (
                    <Modal onClose={() => setShowInvoiceModal(false)} title="Create Invoice">
                        <form onSubmit={handleInvoiceSubmit}>
                            <div className="invoice-options">
                                <label><input type="radio" name="invoiceScope" checked={!invoiceForm.invoiceAll && !invoiceForm.invoiceLevel && !invoiceForm.invoiceClass}
                                    onChange={() => setInvoiceForm(prev => ({ ...prev, invoiceAll: false, invoiceLevel: '', invoiceClass: '', studentIds: [] }))} /> Selected Students</label>
                                <label><input type="radio" name="invoiceScope" checked={invoiceForm.invoiceAll}
                                    onChange={() => setInvoiceForm(prev => ({ ...prev, invoiceAll: true, invoiceLevel: '', invoiceClass: '', studentIds: [] }))} /> All Students</label>
                                <label><input type="radio" name="invoiceScope" checked={!!invoiceForm.invoiceLevel}
                                    onChange={() => setInvoiceForm(prev => ({ ...prev, invoiceAll: false, invoiceLevel: prev.invoiceLevel || schoolLevels[0] || 'pre-primary', invoiceClass: '', studentIds: [] }))} /> By Level</label>
                                <label><input type="radio" name="invoiceScope" checked={!!invoiceForm.invoiceClass}
                                    onChange={() => setInvoiceForm(prev => ({ ...prev, invoiceAll: false, invoiceLevel: '', invoiceClass: prev.invoiceClass || '', studentIds: [] }))} /> By Class</label>
                            </div>

                            {invoiceForm.invoiceLevel && (
                                <div className="form-group">
                                    <label>Select Level</label>
                                    <select value={invoiceForm.invoiceLevel} onChange={(e) => setInvoiceForm(prev => ({ ...prev, invoiceLevel: e.target.value }))}>
                                        {uniqueLevels.map(level => (
                                            <option key={level} value={level}>{LEVEL_DISPLAY_NAMES[level] || level}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            {invoiceForm.invoiceClass && (
                                <div className="form-group">
                                    <label>Select Class</label>
                                    <select value={invoiceForm.invoiceClass} onChange={(e) => setInvoiceForm(prev => ({ ...prev, invoiceClass: e.target.value }))}>
                                        <option value="">Select Class</option>
                                        {invoiceClasses.map(cls => <option key={cls} value={cls}>{cls}</option>)}
                                    </select>
                                </div>
                            )}

                            {!invoiceForm.invoiceAll && !invoiceForm.invoiceLevel && !invoiceForm.invoiceClass && (
                                <div className="form-group">
                                    <label>Select Students <span className="required">*</span></label>
                                    <div className="student-select-grid">
                                        {students.map(s => (
                                            <label key={s.id} className="student-select-item">
                                                <input type="checkbox" checked={invoiceForm.studentIds.includes(s.id)}
                                                    onChange={(e) => {
                                                        if (e.target.checked) setInvoiceForm(prev => ({ ...prev, studentIds: [...prev.studentIds, s.id] }));
                                                        else setInvoiceForm(prev => ({ ...prev, studentIds: prev.studentIds.filter(id => id !== s.id) }));
                                                    }} />
                                                {s.firstName || ''} {s.lastName || ''} - {s.admissionNumber || s.studentId || 'N/A'} ({s.class || 'N/A'})
                                            </label>
                                        ))}
                                    </div>
                                    <div style={{ fontSize: '12px', color: 'var(--gray)', marginTop: '5px' }}>
                                        Selected: {invoiceForm.studentIds.length} student(s) on this page.
                                    </div>
                                </div>
                            )}

                            <div className="form-group">
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                    <label style={{ margin: 0 }}>Invoice Items <span className="required">*</span></label>
                                    <button type="button" onClick={handleLoadFeeStructureIntoInvoice}
                                        style={{
                                            background: '#e0e7ff', color: '#3730a3', border: '1px solid #c7d2fe',
                                            borderRadius: '6px', padding: '4px 10px', fontSize: '12px',
                                            fontWeight: 600, cursor: 'pointer', display: 'inline-flex',
                                            alignItems: 'center', gap: '5px'
                                        }}>
                                        <i className="fas fa-magic"></i> Load from Fee Schedule
                                    </button>
                                </div>
                                <div className="invoice-items-container">
                                    {invoiceForm.items.map((item, index) => (
                                        <div key={index} className="invoice-item-row">
                                            <input type="text" placeholder="Description" value={item.description}
                                                onChange={(e) => handleInvoiceItemChange(index, 'description', e.target.value)} required />
                                            <input type="number" placeholder="Amount" value={item.amount}
                                                onChange={(e) => handleInvoiceItemChange(index, 'amount', e.target.value)} min="0" step="1" required />
                                            <button type="button" className="remove-btn" onClick={() => removeInvoiceItem(index)} disabled={invoiceForm.items.length <= 1}>
                                                <i className="fas fa-times"></i>
                                            </button>
                                        </div>
                                    ))}
                                    <button type="button" className="btn btn-outline" onClick={addInvoiceItem} style={{ padding: '6px 12px', fontSize: '12px', marginTop: '5px' }}>
                                        <i className="fas fa-plus"></i> Add Item
                                    </button>
                                </div>
                                <div style={{ fontSize: '13px', fontWeight: '600', marginTop: '10px' }}>
                                    Subtotal: KES {invoiceForm.items.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0).toLocaleString()}
                                    {Number(invoiceForm.tax) > 0 && ` | Tax: KES ${parseFloat(invoiceForm.tax).toLocaleString()}`}
                                    {Number(invoiceForm.discount) > 0 && ` | Discount: KES ${parseFloat(invoiceForm.discount).toLocaleString()}`}
                                    <span style={{ color: 'var(--primary)' }}> | Total: KES {calculateInvoiceTotal().toLocaleString()}</span>
                                </div>
                            </div>

                            <div className="form-row">
                                <div className="form-group"><label>Tax (KES)</label>
                                    <input type="number" name="tax" value={invoiceForm.tax} onChange={handleInvoiceFormChange} min="0" step="1" /></div>
                                <div className="form-group"><label>Discount (KES)</label>
                                    <input type="number" name="discount" value={invoiceForm.discount} onChange={handleInvoiceFormChange} min="0" step="1" /></div>
                            </div>

                            <div className="form-row">
                                <div className="form-group"><label>Due Date <span className="required">*</span></label>
                                    <input type="date" name="dueDate" value={invoiceForm.dueDate} onChange={handleInvoiceFormChange} required /></div>
                                <div className="form-group"><label>Term</label>
                                    <select name="term" value={invoiceForm.term} onChange={handleInvoiceFormChange}>
                                        <option value="Term 1">Term 1</option>
                                        <option value="Term 2">Term 2</option>
                                        <option value="Term 3">Term 3</option>
                                    </select></div>
                            </div>

                            <div className="form-group">
                                <label>Notes</label>
                                <textarea name="notes" value={invoiceForm.notes} onChange={handleInvoiceFormChange} rows="2" placeholder="Additional notes" />
                            </div>

                            <div className="modal-footer">
                                <button type="button" className="btn btn-outline" onClick={() => setShowInvoiceModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={isProcessing}>
                                    {isProcessing ? 'Creating...' : 'Create Invoice'}
                                </button>
                            </div>
                        </form>
                    </Modal>
                )}

                {/* Bulk Fee Modal */}
                {showBulkFeeModal && (
                    <Modal onClose={() => setShowBulkFeeModal(false)} title="Bulk Fee Entry">
                        <form onSubmit={handleBulkFeeSubmit}>
                            <div style={{ padding: 12, background: '#eef2ff', color: '#3730a3', borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
                                <i className="fas fa-info-circle" style={{ marginRight: 8 }}></i>
                                Bulk entry applies to the <strong>entire roster</strong> (all pages), filtered by level/class below.
                            </div>
                            <div className="form-row">
                                <div className="form-group"><label>Level</label>
                                    <select name="level" value={bulkFeeForm.level} onChange={handleBulkFeeFormChange}>
                                        <option value="">All Levels</option>
                                        {uniqueLevels.map(level => <option key={level} value={level}>{LEVEL_DISPLAY_NAMES[level] || level}</option>)}
                                    </select></div>
                                <div className="form-group"><label>Class</label>
                                    <select name="class" value={bulkFeeForm.class} onChange={handleBulkFeeFormChange}>
                                        <option value="">All Classes</option>
                                        {bulkClasses.map(cls => <option key={cls} value={cls}>{cls}</option>)}
                                    </select></div>
                            </div>
                            <div className="form-row">
                                <div className="form-group"><label>Amount (KES) <span className="required">*</span></label>
                                    <input type="number" name="amount" value={bulkFeeForm.amount} onChange={handleBulkFeeFormChange} min="1" step="1" required /></div>
                                <div className="form-group"><label>Term</label>
                                    <select name="term" value={bulkFeeForm.term} onChange={handleBulkFeeFormChange}>
                                        <option value="Term 1">Term 1</option>
                                        <option value="Term 2">Term 2</option>
                                        <option value="Term 3">Term 3</option>
                                    </select></div>
                            </div>
                            <div className="form-group">
                                <label>Description</label>
                                <input type="text" name="description" value={bulkFeeForm.description} onChange={handleBulkFeeFormChange} placeholder="Bulk fee description" />
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-outline" onClick={() => setShowBulkFeeModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={isProcessing}>
                                    {isProcessing ? 'Processing...' : 'Record Bulk Fees'}
                                </button>
                            </div>
                        </form>
                    </Modal>
                )}

                {/* M-Pesa Modal */}
                {showMpesaModal && (
                    <Modal onClose={() => setShowMpesaModal(false)} title={<><i className="fas fa-mobile-alt" style={{ color: '#25D366' }}></i> M-Pesa STK Push</>}>
                        <form onSubmit={handleMpesaPayment}>
                            <div className="form-group">
                                <label>Student <span className="required">*</span></label>
                                <StudentPicker
                                    schoolId={userData?.schoolId}
                                    value={mpesaForm.student}
                                    onChange={(student) => {
                                        setMpesaForm(prev => ({
                                            ...prev,
                                            student,
                                            studentId: student?.id || '',
                                            studentAdmission: student?.admissionNumber || student?.studentId || ''
                                        }));
                                    }}
                                    autoFocus
                                />
                                <div style={{ fontSize: '12px', color: 'var(--gray)', marginTop: '5px' }}>
                                    Type at least 2 characters to search across all students (any page).
                                </div>
                            </div>

                            <div className="form-group">
                                <label>Phone Number <span className="required">*</span></label>
                                <input type="tel" name="phoneNumber" value={mpesaForm.phoneNumber} onChange={handleMpesaFormChange} placeholder="e.g. 0712345678" required />
                                <div style={{ fontSize: '12px', color: 'var(--gray)', marginTop: '5px' }}>M-Pesa registered phone number</div>
                            </div>

                            <div className="form-row">
                                <div className="form-group"><label>Amount (KES) <span className="required">*</span></label>
                                    <input type="number" name="amount" value={mpesaForm.amount} onChange={handleMpesaFormChange} min="1" step="1" required /></div>
                                <div className="form-group"><label>Description</label>
                                    <input type="text" name="description" value={mpesaForm.description} onChange={handleMpesaFormChange} placeholder="Payment description" /></div>
                            </div>

                            <div className="modal-footer">
                                <button type="button" className="btn btn-outline" onClick={() => setShowMpesaModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-whatsapp" disabled={isProcessing} style={smallBtn('#25D366')}>
                                    {isProcessing ? 'Sending...' : <><i className="fas fa-paper-plane"></i> Send STK Push</>}
                                </button>
                            </div>
                        </form>
                    </Modal>
                )}

                {/* Reconcile Modal */}
                {showReconcileModal && (
                    <Modal onClose={() => setShowReconcileModal(false)} title={<><i className="fas fa-credit-card"></i> Reconcile Bank Statement</>}>
                        <div className="file-upload-area" onClick={() => fileInputRef.current?.click()}>
                            <i className="fas fa-cloud-upload-alt"></i>
                            <p><strong>Click to upload bank statement</strong></p>
                            <p>Supported: CSV, Excel, PDF</p>
                            <p className="file-types">Max 5 MB</p>
                            {uploadedStatements.length > 0 && (
                                <p style={{ fontSize: '11px', color: 'var(--gray)', marginTop: '10px' }}>
                                    Previously uploaded: {uploadedStatements.length} statements
                                </p>
                            )}
                        </div>
                        <input type="file" ref={fileInputRef} accept=".csv,.xlsx,.xls,.pdf" onChange={handleFileImport} style={{ display: 'none' }} />
                        {statementFile && (
                            <div style={{ marginTop: '15px', padding: '15px', background: 'var(--light)', borderRadius: '8px' }}>
                                <p><strong>File:</strong> {statementFile.name}</p>
                                <p style={{ fontSize: '13px', color: 'var(--gray)' }}>{statementFile.size} bytes</p>
                                <button type="button" className="btn btn-primary" onClick={performReconciliation} disabled={isProcessing} style={{ marginTop: '10px' }}>
                                    {isProcessing ? 'Processing...' : 'Reconcile Now'}
                                </button>
                            </div>
                        )}
                        <div className="modal-footer">
                            <button type="button" className="btn btn-outline" onClick={() => setShowReconcileModal(false)}>Cancel</button>
                        </div>
                    </Modal>
                )}

                {/* Statement Results Modal */}
                {showStatementModal && reconcileResults && (
                    <Modal onClose={() => setShowStatementModal(false)} title="Reconciliation Results">
                        <div className="reconciliation-summary">
                            <div className="stat"><span>Total Transactions</span><strong>{reconcileResults.total}</strong></div>
                            <div className="stat"><span>Matched</span><strong style={{ color: 'var(--success)' }}>{reconcileResults.matched}</strong></div>
                            <div className="stat"><span>Unmatched</span><strong style={{ color: 'var(--danger)' }}>{reconcileResults.unmatched}</strong></div>
                            <div className="stat"><span>Total Amount</span><strong>KES {reconcileResults.totalAmount.toLocaleString()}</strong></div>
                        </div>

                        {matchedTransactions.length > 0 && (
                            <div style={{ marginBottom: '20px' }}>
                                <h3 style={{ fontSize: '16px', marginBottom: '10px' }}>
                                    <i className="fas fa-check-circle" style={{ color: 'var(--success)' }}></i> Matched ({matchedTransactions.length})
                                </h3>
                                <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                                    {matchedTransactions.map((match, index) => (
                                        <div key={index} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                            <span>
                                                <strong>{match.student.firstName || ''} {match.student.lastName || ''}</strong>
                                                <div style={{ fontSize: '11px', color: 'var(--gray)' }}>Adm: {match.admissionNumber || 'N/A'}</div>
                                            </span>
                                            <span style={{ fontWeight: '600' }}>KES {match.amount.toLocaleString()}</span>
                                            <span style={{ fontSize: '11px', color: 'var(--gray)' }}>Conf: {Math.round(match.confidence)}%</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {unmatchedTransactions.length > 0 && (
                            <div style={{ marginBottom: '20px' }}>
                                <h3 style={{ fontSize: '16px', marginBottom: '10px' }}>
                                    <i className="fas fa-exclamation-triangle" style={{ color: 'var(--danger)' }}></i> Unmatched ({unmatchedTransactions.length})
                                </h3>
                                <div style={{ maxHeight: '150px', overflowY: 'auto', fontSize: '13px', color: 'var(--gray)' }}>
                                    {unmatchedTransactions.slice(0, 10).map((t, index) => (
                                        <div key={index} style={{ padding: '4px 12px', borderBottom: '1px solid var(--border)' }}>
                                            {Object.values(t).join(' | ')}
                                        </div>
                                    ))}
                                    {unmatchedTransactions.length > 10 && (
                                        <div style={{ padding: '4px 12px', color: 'var(--gray)', fontStyle: 'italic' }}>
                                            ... and {unmatchedTransactions.length - 10} more
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        <div className="modal-footer">
                            <button type="button" className="btn btn-outline" onClick={() => setShowStatementModal(false)}>Close</button>
                            {matchedTransactions.length > 0 && (
                                <button type="button" className="btn btn-success" onClick={recordReconciledTransactions} disabled={isProcessing}>
                                    {isProcessing ? 'Recording...' : `Record ${matchedTransactions.length} Payments`}
                                </button>
                            )}
                        </div>
                    </Modal>
                )}

                {/* Invoice Details Modal */}
                {showInvoiceDetailsModal && selectedInvoice && (
                    <Modal onClose={() => setShowInvoiceDetailsModal(false)} title="Invoice Details" maxWidth={600}>
                        <div style={{ marginBottom: '20px' }}>
                            <DetailRow label="Invoice Number" value={selectedInvoice.invoiceNumber} />
                            <DetailRow label="Student" value={selectedInvoice.studentName} />
                            <DetailRow label="Admission Number" value={selectedInvoice.admissionNumber || 'N/A'} />
                            <DetailRow label="Class" value={selectedInvoice.studentClass || 'N/A'} />
                            <DetailRow label="Term" value={selectedInvoice.term} />
                            <DetailRow label="Due Date" value={selectedInvoice.dueDate ? new Date(selectedInvoice.dueDate).toLocaleDateString() : 'N/A'} />
                            <DetailRow label="Status" value={
                                <span className={`status-badge ${selectedInvoice.status}`}>
                                    {String(selectedInvoice.status || '').charAt(0).toUpperCase() + String(selectedInvoice.status || '').slice(1)}
                                </span>
                            } />
                        </div>

                        <h3 style={{ fontSize: '16px', marginBottom: '10px' }}>Items</h3>
                        <div style={{ marginBottom: '15px' }}>
                            {selectedInvoice.items?.map((item, index) => (
                                <DetailRow key={index} label={item.description} value={`KES ${Number(item.amount || 0).toLocaleString()}`} />
                            ))}
                            <DetailRow label="Subtotal" value={`KES ${Number(selectedInvoice.subtotal || 0).toLocaleString()}`} bold />
                            {Number(selectedInvoice.tax) > 0 && <DetailRow label="Tax" value={`KES ${Number(selectedInvoice.tax).toLocaleString()}`} />}
                            {Number(selectedInvoice.discount) > 0 && <DetailRow label="Discount" value={`-KES ${Number(selectedInvoice.discount).toLocaleString()}`} />}
                            <DetailRow label="Total" value={`KES ${Number(selectedInvoice.total || 0).toLocaleString()}`} bold highlight />
                            <DetailRow label="Paid" value={`KES ${Number(selectedInvoice.paidAmount || 0).toLocaleString()}`} color="var(--success)" />
                            <DetailRow label="Remaining Balance" value={`KES ${Number(selectedInvoice.remainingBalance || 0).toLocaleString()}`} bold
                                color={(selectedInvoice.remainingBalance || 0) > 0 ? 'var(--danger)' : 'var(--success)'} />
                        </div>

                        {selectedInvoice.notes && (
                            <div style={{ marginBottom: '15px', padding: '10px', background: 'var(--light)', borderRadius: '8px' }}>
                                <strong>Notes:</strong> {selectedInvoice.notes}
                            </div>
                        )}

                        <div className="modal-footer">
                            {selectedInvoice.status !== 'paid' && (
                                <button type="button" className="btn btn-warning" onClick={() => handleSendReminder(selectedInvoice)}>
                                    <i className="fas fa-bell"></i> Send Reminder
                                </button>
                            )}
                            <button type="button" className="btn btn-outline" onClick={() => setShowInvoiceDetailsModal(false)}>Close</button>
                        </div>
                    </Modal>
                )}

                {/* Receipt Modal */}
                {showReceiptModal && receiptData && (
                    <ReceiptModal
                        receiptData={receiptData}
                        schoolData={schoolData}
                        onClose={() => { setShowReceiptModal(false); setReceiptData(null); }}
                        onDownloadPDF={handleDownloadReceiptPDF}
                    />
                )}
            </div>
        </Layout>
    );
}

// ---------- Helper subcomponents ----------
function Modal({ children, onClose, title, maxWidth = 700 }) {
    return (
        <div className="modal-overlay active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="modal" style={{ maxWidth }}>
                <div className="modal-header">
                    <h2>{title}</h2>
                    <button type="button" className="modal-close" onClick={onClose}><i className="fas fa-times"></i></button>
                </div>
                {children}
            </div>
        </div>
    );
}

function StatBox({ label, value, color }) {
    return (
        <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--gray)', textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: '20px', fontWeight: '700', color: color || 'var(--secondary)' }}>{value}</div>
        </div>
    );
}

function DetailRow({ label, value, bold, highlight, color }) {
    return (
        <div className="invoice-detail-item" style={{ fontWeight: bold ? '700' : 'normal' }}>
            <span className="label">{label}</span>
            <span className="value" style={{
                color: color || (highlight ? 'var(--primary)' : 'var(--secondary)'),
                fontSize: highlight ? '16px' : 'inherit'
            }}>{value}</span>
        </div>
    );
}

const feesStyles = `
    .fees-container { padding: 0; }
    .fee-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .fee-stat-card { background: white; border-radius: 12px; padding: 20px; box-shadow: var(--shadow); transition: all 0.3s; }
    .fee-stat-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); }
    .fee-stat-card .stat-label { font-size: 13px; color: var(--gray); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
    .fee-stat-card .stat-value { font-size: 28px; font-weight: 700; color: var(--secondary); margin-top: 5px; }
    .fee-stat-card .stat-sub { font-size: 12px; color: var(--gray); margin-top: 5px; }
    .search-toggle { display: flex; gap: 5px; padding: 4px; background: var(--light); border-radius: 8px; border: 1px solid var(--border); }
    .search-toggle button { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; transition: all 0.3s; background: transparent; color: var(--gray); }
    .search-toggle button.active { background: white; color: var(--primary); box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .search-toggle button:hover:not(.active) { color: var(--secondary); }
    .fee-actions { display: flex; gap: 10px; margin-bottom: 25px; flex-wrap: wrap; }
    .fee-actions .btn { padding: 10px 20px; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.3s; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
    .fee-actions .btn-primary { background: var(--primary); color: white; }
    .fee-actions .btn-primary:hover { background: var(--primary-dark); transform: translateY(-2px); box-shadow: var(--shadow-lg); }
    .fee-actions .btn-success { background: var(--success); color: white; }
    .fee-actions .btn-success:hover { opacity: 0.9; transform: translateY(-2px); }
    .fee-actions .btn-warning { background: var(--warning); color: white; }
    .fee-actions .btn-warning:hover { opacity: 0.9; transform: translateY(-2px); }
    .fee-actions .btn-danger { background: var(--danger); color: white; }
    .fee-actions .btn-danger:hover { opacity: 0.9; transform: translateY(-2px); }
    .fee-actions .btn-outline { background: transparent; border: 2px solid var(--border); color: var(--secondary); }
    .fee-actions .btn-outline:hover { border-color: var(--primary); color: var(--primary); }
    .fee-actions .btn-whatsapp { background: #25D366; color: white; }
    .fee-actions .btn-whatsapp:hover { background: #128C7E; transform: translateY(-2px); }
    .filters-section { background: white; border-radius: 12px; padding: 20px; box-shadow: var(--shadow); margin-bottom: 25px; display: flex; flex-wrap: wrap; gap: 15px; align-items: center; }
    .search-input { flex: 1; min-width: 200px; padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; transition: all 0.3s; background: white; color: var(--secondary); }
    .search-input:focus { outline: none; border-color: var(--primary); }
    .filter-select { padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; background: white; cursor: pointer; min-width: 150px; color: var(--secondary); }
    .filter-select:focus { outline: none; border-color: var(--primary); }
    .balance-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 15px; }
    .balance-card { transition: all 0.3s; }
    .balance-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); }
    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: none; align-items: center; justify-content: center; padding: 20px; }
    .modal-overlay.active { display: flex; }
    .modal { background: white; border-radius: 16px; max-width: 700px; width: 100%; max-height: 90vh; overflow-y: auto; padding: 30px; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
    .modal-header h2 { font-size: 22px; color: var(--secondary); }
    .modal-close { width: 40px; height: 40px; border: none; border-radius: 50%; background: var(--light); cursor: pointer; font-size: 18px; transition: all 0.3s; }
    .modal-close:hover { background: var(--border); }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; font-size: 14px; font-weight: 600; color: var(--secondary); margin-bottom: 5px; }
    .form-group label .required { color: var(--danger); }
    .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; transition: all 0.3s; background: white; color: var(--secondary); }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: var(--primary); }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
    .modal-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; padding-top: 20px; border-top: 1px solid var(--border); }
    .invoice-options { display: flex; gap: 15px; flex-wrap: wrap; margin-bottom: 15px; padding: 15px; background: var(--light); border-radius: 8px; }
    .invoice-options label { display: flex; align-items: center; gap: 5px; font-weight: 500; cursor: pointer; }
    .student-select-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; max-height: 300px; overflow-y: auto; padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
    .student-select-item { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: 6px; cursor: pointer; transition: all 0.3s; }
    .student-select-item:hover { background: var(--light); }
    .student-select-item input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
    .invoice-items-container { border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
    .invoice-item-row { display: grid; grid-template-columns: 1fr 100px 30px; gap: 10px; margin-bottom: 8px; align-items: center; }
    .invoice-item-row input { padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
    .invoice-item-row .remove-btn { background: none; border: none; color: var(--danger); cursor: pointer; font-size: 18px; padding: 4px; }
    .invoice-item-row .remove-btn:hover { color: #c0392b; }
    .reconciliation-summary { background: var(--light); border-radius: 12px; padding: 20px; margin: 15px 0; }
    .reconciliation-summary .stat { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .reconciliation-summary .stat:last-child { border-bottom: none; }
    .file-upload-area { border: 2px dashed var(--border); border-radius: 12px; padding: 40px; text-align: center; cursor: pointer; transition: all 0.3s; }
    .file-upload-area:hover { border-color: var(--primary); background: var(--light); }
    .file-upload-area i { font-size: 48px; color: var(--gray); margin-bottom: 15px; }
    .file-upload-area p { color: var(--gray); margin: 5px 0; }
    .file-upload-area .file-types { font-size: 12px; color: var(--gray); }
    .invoice-detail-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .invoice-detail-item .label { font-weight: 500; color: var(--gray); }
    .invoice-detail-item .value { font-weight: 600; color: var(--secondary); }
    .status-badge { padding: 3px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .status-badge.paid { background: #d4edda; color: #155724; }
    .status-badge.pending { background: #fff3cd; color: #856404; }
    .status-badge.overdue { background: #f8d7da; color: #721c24; }
    .status-badge.partial { background: #d1ecf1; color: #0c5460; }
    .status-badge.draft { background: #e2e3e5; color: #383d41; }
    @media (max-width: 768px) {
        .fee-stats-grid { grid-template-columns: repeat(2, 1fr); }
        .balance-list { grid-template-columns: 1fr; }
        .filters-section { flex-direction: column; align-items: stretch; }
        .search-input, .filter-select { width: 100%; }
        .fee-actions { flex-direction: column; }
        .fee-actions .btn { width: 100%; justify-content: center; }
        .modal { padding: 20px; }
        .search-toggle { width: 100%; }
        .search-toggle button { flex: 1; text-align: center; }
        .form-row { grid-template-columns: 1fr; }
        .invoice-item-row { grid-template-columns: 1fr 80px 30px; }
    }
    @media (max-width: 480px) {
        .fee-stats-grid { grid-template-columns: 1fr; }
        .invoice-item-row { grid-template-columns: 1fr 60px 30px; }
    }
`;
