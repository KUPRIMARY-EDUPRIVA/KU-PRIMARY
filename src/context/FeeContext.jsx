// src/context/FeeContext.jsx
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAuth } from './AuthContext';
import { useSync } from './SyncContext';
import {
    requireSchoolId, getStudents, getFeeTransactions, getInvoices, getBalancesForSchool,
    createInvoicesBatch, postTransaction, voidTransaction, getInvoiceSummary,
    isTermLocked, computeAging, getFeeStructures, upsertFeeStructure, deleteFeeStructure,
    reconcileStudentBalance, cancelInvoice,
    // Paginated APIs
    getStudentsPage, getBalancesPage, getInvoicesPage, getFeeTransactionsPage,
    getStudentsCount, getBalancesCount, getInvoicesCount,
    DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE
} from '../services/feeService';
import { setMemory } from '../services/cache';
import { fetchNetlifyFunction } from '../services/netlifyApi';

const FeeContext = createContext();
export function useFee() {
    const ctx = useContext(FeeContext);
    if (!ctx) throw new Error('useFee must be used within a FeeProvider');
    return ctx;
}

const generateInvoiceNumber = (schoolId, seq) => {
    const prefix = (schoolId || 'SCH').substring(0, 4).toUpperCase();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `${prefix}-INV-${stamp}-${String(seq % 10000).padStart(4, '0')}`;
};

// ============================================================
// Pagination state shape
// ============================================================
const createPaginationState = (pageSize = DEFAULT_PAGE_SIZE) => ({
    items: [],
    pageSize,
    cursor: null,        // cursor for next page
    cursorPrev: null,    // cursor for prev page
    hasMore: false,
    hasPrev: false,
    pageIndex: 0,        // 0-based
    total: null,         // total count (fetched separately)
    loading: false,
    error: null,
    direction: 'first'
});

export function FeeProvider({ children }) {
    const { userData, currentUser } = useAuth();
    const { isOnline, saveToIndexedDB, getFromIndexedDB } = useSync();

    // ---- Non-paginated state (kept for compatibility) ----
    const [students, setStudents] = useState([]);
    const [balances, setBalances] = useState({});
    const [feeTransactions, setFeeTransactions] = useState([]);
    const [invoices, setInvoices] = useState([]);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [scope, setScope] = useState({ term: 'Term 1', year: new Date().getFullYear(), level: '', cls: '' });
    const [termLocked, setTermLocked] = useState(false);
    const [feeStructures, setFeeStructures] = useState([]);

    // ---- Paginated state ----
    const [studentsPage, setStudentsPage] = useState(() => createPaginationState());
    const [balancesPage, setBalancesPage] = useState(() => createPaginationState());
    const [invoicesPage, setInvoicesPage] = useState(() => createPaginationState());
    const [transactionsPage, setTransactionsPage] = useState(() => createPaginationState());

    // Refs to hold latest query params (avoid stale closures)
    const studentsQueryRef = useRef({ level: '', cls: '', sortField: 'firstName', sortDirection: 'asc' });
    const balancesQueryRef = useRef({ term: '', year: '', level: '', cls: '', status: '', sortField: 'studentName', sortDirection: 'asc' });
    const invoicesQueryRef = useRef({ term: '', year: '', status: '', studentId: '', sortDirection: 'desc' });
    const transactionsQueryRef = useRef({ term: '', year: '', studentId: '', type: '', sortDirection: 'desc' });

    // ============================================================
    // PAGINATED FETCHERS
    // ============================================================

    const fetchStudentsPage = useCallback(async (opts = {}) => {
        let schoolId;
        try { schoolId = requireSchoolId(userData); }
        catch (e) { return; }

        const direction = opts.direction || 'first';
        const queryParams = { ...studentsQueryRef.current, ...opts, direction };

        setStudentsPage(prev => ({
            ...prev,
            loading: true,
            error: null,
            // reset cursor if starting fresh
            cursor: direction === 'first' ? null : prev.cursor,
            cursorPrev: direction === 'first' ? null : prev.cursorPrev,
            pageIndex: direction === 'first' ? 0 : (opts.pageIndex ?? prev.pageIndex)
        }));

        try {
            const res = await getStudentsPage(schoolId, {
                pageSize: studentsPage.pageSize,
                cursor: direction === 'prev' ? studentsPage.cursorPrev : studentsPage.cursor,
                direction,
                level: queryParams.level,
                cls: queryParams.cls,
                sortField: queryParams.sortField || 'firstName',
                sortDirection: queryParams.sortDirection || 'asc'
            });

            setStudentsPage(prev => ({
                ...prev,
                items: res.items,
                cursor: res.cursor,
                cursorPrev: res.cursorPrev,
                hasMore: res.hasMore,
                hasPrev: direction !== 'first' ? true : false,
                loading: false,
                pageIndex: direction === 'next' ? prev.pageIndex + 1
                    : direction === 'prev' ? Math.max(0, prev.pageIndex - 1)
                    : 0
            }));
        } catch (err) {
            console.error('fetchStudentsPage failed:', err);
            setStudentsPage(prev => ({ ...prev, loading: false, error: err.message }));
        }
    }, [userData, studentsPage.pageSize, studentsPage.cursor, studentsPage.cursorPrev]);

    const fetchStudentsCount = useCallback(async () => {
        let schoolId;
        try { schoolId = requireSchoolId(userData); } catch { return; }
        const count = await getStudentsCount(schoolId, {
            level: studentsQueryRef.current.level,
            cls: studentsQueryRef.current.cls
        });
        if (count !== null) {
            setStudentsPage(prev => ({ ...prev, total: count }));
        }
    }, [userData]);

    const fetchBalancesPage = useCallback(async (opts = {}) => {
        let schoolId;
        try { schoolId = requireSchoolId(userData); }
        catch (e) { return; }

        const direction = opts.direction || 'first';
        const queryParams = { ...balancesQueryRef.current, ...opts, direction };

        setBalancesPage(prev => ({
            ...prev,
            loading: true,
            error: null,
            cursor: direction === 'first' ? null : prev.cursor,
            cursorPrev: direction === 'first' ? null : prev.cursorPrev,
            pageIndex: direction === 'first' ? 0 : (opts.pageIndex ?? prev.pageIndex)
        }));

        try {
            const res = await getBalancesPage(schoolId, {
                pageSize: balancesPage.pageSize,
                cursor: direction === 'prev' ? balancesPage.cursorPrev : balancesPage.cursor,
                direction,
                term: queryParams.term || scope.term,
                year: queryParams.year || scope.year,
                level: queryParams.level,
                cls: queryParams.cls,
                status: queryParams.status,
                sortField: queryParams.sortField || 'studentName',
                sortDirection: queryParams.sortDirection || 'asc'
            });

            setBalancesPage(prev => ({
                ...prev,
                items: res.items,
                cursor: res.cursor,
                cursorPrev: res.cursorPrev,
                hasMore: res.hasMore,
                hasPrev: direction !== 'first' ? true : false,
                loading: false,
                pageIndex: direction === 'next' ? prev.pageIndex + 1
                    : direction === 'prev' ? Math.max(0, prev.pageIndex - 1)
                    : 0
            }));
        } catch (err) {
            console.error('fetchBalancesPage failed:', err);
            setBalancesPage(prev => ({ ...prev, loading: false, error: err.message }));
        }
    }, [userData, balancesPage.pageSize, balancesPage.cursor, balancesPage.cursorPrev, scope.term, scope.year]);

    const fetchBalancesCount = useCallback(async () => {
        let schoolId;
        try { schoolId = requireSchoolId(userData); } catch { return; }
        const count = await getBalancesCount(schoolId, {
            term: balancesQueryRef.current.term || scope.term,
            year: balancesQueryRef.current.year || scope.year,
            level: balancesQueryRef.current.level,
            cls: balancesQueryRef.current.cls,
            status: balancesQueryRef.current.status
        });
        if (count !== null) setBalancesPage(prev => ({ ...prev, total: count }));
    }, [userData, scope.term, scope.year]);

    const fetchInvoicesPage = useCallback(async (opts = {}) => {
        let schoolId;
        try { schoolId = requireSchoolId(userData); }
        catch (e) { return; }

        const direction = opts.direction || 'first';
        const queryParams = { ...invoicesQueryRef.current, ...opts, direction };

        setInvoicesPage(prev => ({
            ...prev,
            loading: true,
            error: null,
            cursor: direction === 'first' ? null : prev.cursor,
            cursorPrev: direction === 'first' ? null : prev.cursorPrev,
            pageIndex: direction === 'first' ? 0 : (opts.pageIndex ?? prev.pageIndex)
        }));

        try {
            const res = await getInvoicesPage(schoolId, {
                pageSize: invoicesPage.pageSize,
                cursor: direction === 'prev' ? invoicesPage.cursorPrev : invoicesPage.cursor,
                direction,
                term: queryParams.term,
                year: queryParams.year,
                status: queryParams.status,
                studentId: queryParams.studentId,
                sortDirection: queryParams.sortDirection || 'desc'
            });

            setInvoicesPage(prev => ({
                ...prev,
                items: res.items,
                cursor: res.cursor,
                cursorPrev: res.cursorPrev,
                hasMore: res.hasMore,
                hasPrev: direction !== 'first' ? true : false,
                loading: false,
                pageIndex: direction === 'next' ? prev.pageIndex + 1
                    : direction === 'prev' ? Math.max(0, prev.pageIndex - 1)
                    : 0
            }));
        } catch (err) {
            console.error('fetchInvoicesPage failed:', err);
            setInvoicesPage(prev => ({ ...prev, loading: false, error: err.message }));
        }
    }, [userData, invoicesPage.pageSize, invoicesPage.cursor, invoicesPage.cursorPrev]);

    const fetchTransactionsPage = useCallback(async (opts = {}) => {
        let schoolId;
        try { schoolId = requireSchoolId(userData); }
        catch (e) { return; }

        const direction = opts.direction || 'first';
        const queryParams = { ...transactionsQueryRef.current, ...opts, direction };

        setTransactionsPage(prev => ({
            ...prev,
            loading: true,
            error: null,
            cursor: direction === 'first' ? null : prev.cursor,
            cursorPrev: direction === 'first' ? null : prev.cursorPrev,
            pageIndex: direction === 'first' ? 0 : (opts.pageIndex ?? prev.pageIndex)
        }));

        try {
            const res = await getFeeTransactionsPage(schoolId, {
                pageSize: transactionsPage.pageSize,
                cursor: direction === 'prev' ? transactionsPage.cursorPrev : transactionsPage.cursor,
                direction,
                term: queryParams.term,
                year: queryParams.year,
                studentId: queryParams.studentId,
                type: queryParams.type,
                sortDirection: queryParams.sortDirection || 'desc'
            });

            setTransactionsPage(prev => ({
                ...prev,
                items: res.items,
                cursor: res.cursor,
                cursorPrev: res.cursorPrev,
                hasMore: res.hasMore,
                hasPrev: direction !== 'first' ? true : false,
                loading: false,
                pageIndex: direction === 'next' ? prev.pageIndex + 1
                    : direction === 'prev' ? Math.max(0, prev.pageIndex - 1)
                    : 0
            }));
        } catch (err) {
            console.error('fetchTransactionsPage failed:', err);
            setTransactionsPage(prev => ({ ...prev, loading: false, error: err.message }));
        }
    }, [userData, transactionsPage.pageSize, transactionsPage.cursor, transactionsPage.cursorPrev]);

    // ============================================================
    // Filter changers (update refs then reset to first page)
    // ============================================================

    const setStudentsQuery = useCallback((patch) => {
        studentsQueryRef.current = { ...studentsQueryRef.current, ...patch };
        fetchStudentsPage({ direction: 'first' });
        fetchStudentsCount();
    }, [fetchStudentsPage, fetchStudentsCount]);

    const setBalancesQuery = useCallback((patch) => {
        balancesQueryRef.current = { ...balancesQueryRef.current, ...patch };
        fetchBalancesPage({ direction: 'first' });
        fetchBalancesCount();
    }, [fetchBalancesPage, fetchBalancesCount]);

    const setInvoicesQuery = useCallback((patch) => {
        invoicesQueryRef.current = { ...invoicesQueryRef.current, ...patch };
        fetchInvoicesPage({ direction: 'first' });
    }, [fetchInvoicesPage]);

    const setTransactionsQuery = useCallback((patch) => {
        transactionsQueryRef.current = { ...transactionsQueryRef.current, ...patch };
        fetchTransactionsPage({ direction: 'first' });
    }, [fetchTransactionsPage]);

    // ============================================================
    // Page navigation helpers
    // ============================================================

    const goToNextPage = useCallback((kind) => {
        if (kind === 'students') fetchStudentsPage({ direction: 'next' });
        else if (kind === 'balances') fetchBalancesPage({ direction: 'next' });
        else if (kind === 'invoices') fetchInvoicesPage({ direction: 'next' });
        else if (kind === 'transactions') fetchTransactionsPage({ direction: 'next' });
    }, [fetchStudentsPage, fetchBalancesPage, fetchInvoicesPage, fetchTransactionsPage]);

    const goToPrevPage = useCallback((kind) => {
        if (kind === 'students') fetchStudentsPage({ direction: 'prev' });
        else if (kind === 'balances') fetchBalancesPage({ direction: 'prev' });
        else if (kind === 'invoices') fetchInvoicesPage({ direction: 'prev' });
        else if (kind === 'transactions') fetchTransactionsPage({ direction: 'prev' });
    }, [fetchStudentsPage, fetchBalancesPage, fetchInvoicesPage, fetchTransactionsPage]);

    const setPageSize = useCallback((kind, size) => {
        const safe = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
        if (kind === 'students') {
            setStudentsPage(prev => ({ ...prev, pageSize: safe }));
            setTimeout(() => fetchStudentsPage({ direction: 'first' }), 0);
        } else if (kind === 'balances') {
            setBalancesPage(prev => ({ ...prev, pageSize: safe }));
            setTimeout(() => fetchBalancesPage({ direction: 'first' }), 0);
        } else if (kind === 'invoices') {
            setInvoicesPage(prev => ({ ...prev, pageSize: safe }));
            setTimeout(() => fetchInvoicesPage({ direction: 'first' }), 0);
        } else if (kind === 'transactions') {
            setTransactionsPage(prev => ({ ...prev, pageSize: safe }));
            setTimeout(() => fetchTransactionsPage({ direction: 'first' }), 0);
        }
    }, [fetchStudentsPage, fetchBalancesPage, fetchInvoicesPage, fetchTransactionsPage]);

    // ============================================================
    // Legacy load (non-paginated) - still used for backward compat
    // ============================================================

    const loadFeeData = useCallback(async (overrideScope) => {
        let schoolId;
        try { schoolId = requireSchoolId(userData); }
        catch (e) { setError(e.message); setLoading(false); return; }

        const s = { ...scope, ...(overrideScope || {}) };
        setLoading(true); setError(null);

        try {
            const [cStud, cTxn, cInv, cBal, cStruct] = await Promise.all([
                getFromIndexedDB(`students_${schoolId}_${s.level}_${s.cls}`),
                getFromIndexedDB(`txn_${schoolId}_${s.term}_${s.year}`),
                getFromIndexedDB(`inv_${schoolId}_${s.term}_${s.year}`),
                getFromIndexedDB(`bal_${schoolId}_${s.term}_${s.year}_${s.level}_${s.cls}`),
                getFromIndexedDB(`struct_${schoolId}_${s.year}`)
            ]);
            if (cStud?.length) setStudents(cStud);
            if (cTxn?.length) setFeeTransactions(cTxn);
            if (cInv?.length) setInvoices(cInv);
            if (cBal?.length) setBalances(Object.fromEntries(cBal.map(b => [b.studentId, b])));
            if (cStruct?.length) setFeeStructures(cStruct);

            const locked = await isTermLocked(schoolId, s.term, s.year).catch(() => false);
            setTermLocked(locked);

            if (isOnline) {
                const [stud, txn, inv, bal, sum, structs] = await Promise.all([
                    getStudents(schoolId, { level: s.level, cls: s.cls }).catch(() => []),
                    getFeeTransactions(schoolId, { term: s.term, year: s.year }).catch(() => []),
                    getInvoices(schoolId, { term: s.term, year: s.year }).catch(() => []),
                    getBalancesForSchool(schoolId, s.term, s.year, { level: s.level, cls: s.cls }).catch(() => []),
                    getInvoiceSummary(schoolId, s.term, s.year).catch(() => null),
                    getFeeStructures(schoolId, { year: s.year }).catch(() => [])
                ]);
                setStudents(stud || []);
                setFeeTransactions(txn || []);
                setInvoices(inv || []);
                setBalances(Object.fromEntries((bal || []).map(b => [b.studentId, b])));
                setSummary(sum);
                setFeeStructures(structs || []);

                await Promise.all([
                    saveToIndexedDB(`students_${schoolId}_${s.level}_${s.cls}`, stud),
                    saveToIndexedDB(`txn_${schoolId}_${s.term}_${s.year}`, txn),
                    saveToIndexedDB(`inv_${schoolId}_${s.term}_${s.year}`, inv),
                    saveToIndexedDB(`bal_${schoolId}_${s.term}_${s.year}_${s.level}_${s.cls}`, bal),
                    saveToIndexedDB(`struct_${schoolId}_${s.year}`, structs)
                ]);
            }
        } catch (err) {
            console.error('loadFeeData failed:', err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [userData, scope, isOnline, saveToIndexedDB, getFromIndexedDB]);

    // Initial mount: load both legacy data and first paginated pages
    useEffect(() => {
        if (!userData?.schoolId) return;
        loadFeeData();
        // Initialize paginated queries with scope
        fetchStudentsPage({ direction: 'first' });
        fetchBalancesPage({
            direction: 'first',
            term: scope.term,
            year: scope.year
        });
        fetchInvoicesPage({ direction: 'first', term: scope.term, year: scope.year });
        fetchTransactionsPage({ direction: 'first', term: scope.term, year: scope.year });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userData?.schoolId]);

    // Reload page data when scope changes
    useEffect(() => {
        if (!userData?.schoolId) return;
        fetchBalancesPage({ direction: 'first', term: scope.term, year: scope.year });
        fetchInvoicesPage({ direction: 'first', term: scope.term, year: scope.year });
        fetchTransactionsPage({ direction: 'first', term: scope.term, year: scope.year });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope.term, scope.year, scope.level, scope.cls]);

    // ============================================================
    // Mutations
    // ============================================================

    const createBulkInvoices = useCallback(async (entries, meta) => {
        const schoolId = requireSchoolId(userData);
        if (termLocked) return { count: 0, errors: [{ error: 'Term is locked' }] };

        const enriched = entries.map((e, i) => ({
            ...e,
            invoiceNumber: e.invoiceNumber || generateInvoiceNumber(schoolId, Date.now() + i),
            suffix: e.suffix || `${Date.now()}_${i}`
        }));

        const results = { count: 0, errors: [] };
        for (let i = 0; i < enriched.length; i += 500) {
            try {
                const r = await createInvoicesBatch(schoolId, enriched.slice(i, i + 500), meta);
                results.count += r.count;
            } catch (err) {
                results.errors.push({ chunk: i, error: err.message });
            }
        }
        setMemory(`inv_${schoolId}_${meta.term}_${meta.year}_all_all`, null, 0);
        await loadFeeData();
        // Refresh paginated views
        fetchInvoicesPage({ direction: 'first', term: meta.term, year: meta.year });
        fetchBalancesPage({ direction: 'first', term: meta.term, year: meta.year });
        return results;
    }, [userData, termLocked, loadFeeData, fetchInvoicesPage, fetchBalancesPage]);

    const addFeeTransaction = useCallback(async (txnData) => {
        const schoolId = requireSchoolId(userData);
        if (termLocked) return { success: false, error: 'Term is locked' };

        try {
            const result = await postTransaction(schoolId, {
                ...txnData,
                recordedBy: currentUser?.uid,
                recordedByName: userData?.fullName || userData?.firstName || 'System'
            }, {
                performedBy: currentUser?.uid,
                performedByName: userData?.fullName || userData?.firstName || 'System'
            });

            setFeeTransactions(prev => [{ id: result.id, ...txnData }, ...prev]);
            // Refresh balances and transactions pages
            fetchBalancesPage({ direction: 'first' });
            fetchTransactionsPage({ direction: 'first' });
            return { success: true, id: result.id, alreadyExisted: result.alreadyExisted };
        } catch (err) {
            console.error('addFeeTransaction failed:', err);
            return { success: false, error: err.message };
        }
    }, [userData, currentUser, termLocked, fetchBalancesPage, fetchTransactionsPage]);

    const voidTransactionById = useCallback(async (txnId, reason) => {
        const schoolId = requireSchoolId(userData);
        try {
            await voidTransaction(schoolId, txnId, reason,
                currentUser?.uid, userData?.fullName || userData?.firstName || 'System');
            await loadFeeData();
            fetchBalancesPage({ direction: 'first' });
            fetchTransactionsPage({ direction: 'first' });
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }, [userData, currentUser, loadFeeData, fetchBalancesPage, fetchTransactionsPage]);

    const cancelInvoiceById = useCallback(async (invoiceId, reason) => {
        const schoolId = requireSchoolId(userData);
        try {
            await cancelInvoice(schoolId, invoiceId, reason,
                currentUser?.uid, userData?.fullName || userData?.firstName || 'System');
            await loadFeeData();
            fetchInvoicesPage({ direction: 'first' });
            fetchBalancesPage({ direction: 'first' });
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }, [userData, currentUser, loadFeeData, fetchInvoicesPage, fetchBalancesPage]);

    const checkOverdueInvoices = useCallback(async () => {
        const now = new Date();
        const overdue = invoices.filter(inv =>
            inv.status !== 'paid' && inv.status !== 'cancelled' &&
            inv.status !== 'overdue' && inv.dueDate && new Date(inv.dueDate) < now);
        if (!overdue.length) return 0;
        setInvoices(prev => prev.map(inv =>
            overdue.find(o => o.id === inv.id) ? { ...inv, status: 'overdue' } : inv));
        return overdue.length;
    }, [invoices]);

    // ============================================================
    // Lookups
    // ============================================================

    const getStudentBalance = useCallback((studentId) => balances[studentId] || null, [balances]);

    const getStudentInvoices = useCallback((studentId, opts = {}) =>
        invoices.filter(i => i.studentId === studentId && (opts.includeCancelled || i.status !== 'cancelled'))
            .sort((a, b) => new Date(b.createdAt?.toDate?.() || b.createdAt) - new Date(a.createdAt?.toDate?.() || a.createdAt)),
        [invoices]);

    const getInvoiceStats = useCallback(() => {
        const total = invoices.length;
        const paid = invoices.filter(i => i.status === 'paid').length;
        const overdue = invoices.filter(i => i.status === 'overdue').length;
        const pending = invoices.filter(i => i.status === 'pending' || i.status === 'partial').length;
        const totalAmount = invoices.reduce((s, i) => s + (i.total || 0), 0);
        const paidAmount = invoices.reduce((s, i) => s + (i.paidAmount || 0), 0);
        return { total, paid, overdue, pending, draft: 0, totalAmount, paidAmount, outstandingAmount: totalAmount - paidAmount };
    }, [invoices]);

    const aging = useMemo(() => computeAging(invoices), [invoices]);

    const sendInvoiceReminder = useCallback(async (invoiceId) => {
        try {
            const token = await currentUser?.getIdToken();
            const res = await fetchNetlifyFunction('send-invoice-reminder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ invoiceId, schoolId: userData?.schoolId })
            });
            const data = await res.json();
            return data.success ? { success: true } : { success: false, error: data.error };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }, [userData, currentUser]);

    const saveFeeStructureAction = useCallback(async (targetKey, year, structure, term = 'all') => {
        const schoolId = requireSchoolId(userData);
        const res = await upsertFeeStructure(schoolId, targetKey, year, structure, {
            updatedBy: currentUser?.uid,
            updatedByName: userData?.fullName || userData?.firstName || 'System'
        }, term);
        await loadFeeData();
        return res;
    }, [userData, currentUser, loadFeeData]);

    const deleteFeeStructureAction = useCallback(async (id) => {
        const schoolId = requireSchoolId(userData);
        const res = await deleteFeeStructure(schoolId, id);
        await loadFeeData();
        return res;
    }, [userData, loadFeeData]);

    const reconcileBalanceAction = useCallback(async (studentId, term, year) => {
        const schoolId = requireSchoolId(userData);
        const res = await reconcileStudentBalance(schoolId, studentId, term, year);
        await loadFeeData();
        fetchBalancesPage({ direction: 'first' });
        return res;
    }, [userData, loadFeeData, fetchBalancesPage]);

    // ============================================================
    // Context value
    // ============================================================

    const value = {
        // Legacy
        students, feeBalances: balances, feeTransactions, invoices, loading, error,
        scope, setScope, summary, termLocked, aging, feeStructures,

        // Paginated state
        studentsPage,
        balancesPage,
        invoicesPage,
        transactionsPage,

        // Paginated fetchers
        fetchStudentsPage,
        fetchStudentsCount,
        fetchBalancesPage,
        fetchBalancesCount,
        fetchInvoicesPage,
        fetchTransactionsPage,

        // Filter setters
        setStudentsQuery,
        setBalancesQuery,
        setInvoicesQuery,
        setTransactionsQuery,

        // Navigation
        goToNextPage,
        goToPrevPage,
        setPageSize,

        // Mutations
        createInvoice: async (data) => {
            const r = await createBulkInvoices([data], {
                term: data.term, year: data.academicYear,
                createdBy: currentUser?.uid, createdByName: userData?.fullName || ''
            });
            return { success: r.count > 0, error: r.errors[0]?.error };
        },
        createBulkInvoices,
        addFeeTransaction,
        voidTransaction: voidTransactionById,
        cancelInvoice: cancelInvoiceById,
        sendInvoiceReminder,
        checkOverdueInvoices,
        getStudentInvoices,
        getInvoiceStats,
        getStudentBalance,
        saveFeeStructure: saveFeeStructureAction,
        deleteFeeStructure: deleteFeeStructureAction,
        reconcileBalance: reconcileBalanceAction,
        refreshData: () => {
            loadFeeData();
            fetchStudentsPage({ direction: 'first' });
            fetchBalancesPage({ direction: 'first' });
            fetchInvoicesPage({ direction: 'first' });
            fetchTransactionsPage({ direction: 'first' });
        },
        loadFeeData
    };

    return <FeeContext.Provider value={value}>{children}</FeeContext.Provider>;
}
