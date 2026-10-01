// src/context/FeeContext.jsx
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { useSync } from './SyncContext';
import {
    requireSchoolId, getStudents, getFeeTransactions, getInvoices, getBalancesForSchool,
    createInvoicesBatch, postTransaction, voidTransaction, getInvoiceSummary,
    isTermLocked, computeAging, getFeeStructures, upsertFeeStructure, deleteFeeStructure,
    reconcileStudentBalance, cancelInvoice
} from '../services/feeService';
import { setMemory } from '../services/cache';

const FeeContext = createContext();
export function useFee() {
    const ctx = useContext(FeeContext);
    if (!ctx) throw new Error('useFee must be used within a FeeProvider');
    return ctx;
}

const generateInvoiceNumber = (schoolId, seq) => {
    const prefix = (schoolId || 'SCH').substring(0, 4).toUpperCase();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    return `${prefix}-INV-${stamp}-${String(seq % 10000).padStart(4,'0')}`;
};

export function FeeProvider({ children }) {
    const { userData, currentUser } = useAuth();
    const { isOnline, saveToIndexedDB, getFromIndexedDB } = useSync();

    const [students, setStudents] = useState([]);
    const [balances, setBalances] = useState({});       // map studentId -> balance
    const [feeTransactions, setFeeTransactions] = useState([]);
    const [invoices, setInvoices] = useState([]);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [scope, setScope] = useState({ term: 'Term 1', year: new Date().getFullYear(), level: '', cls: '' });
    const [termLocked, setTermLocked] = useState(false);
    const [feeStructures, setFeeStructures] = useState([]);

    const loadFeeData = useCallback(async (overrideScope) => {
        let schoolId;
        try { schoolId = requireSchoolId(userData); }
        catch (e) { setError(e.message); setLoading(false); return; }

        const s = { ...scope, ...(overrideScope || {}) };
        setLoading(true); setError(null);

        try {
            // Cache
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
                    getStudents(schoolId, { level: s.level, cls: s.cls }).catch(err => { console.warn('getStudents failed:', err); return []; }),
                    getFeeTransactions(schoolId, { term: s.term, year: s.year }).catch(err => { console.warn('getFeeTransactions failed:', err); return []; }),
                    getInvoices(schoolId, { term: s.term, year: s.year }).catch(err => { console.warn('getInvoices failed:', err); return []; }),
                    getBalancesForSchool(schoolId, s.term, s.year, { level: s.level, cls: s.cls }).catch(err => { console.warn('getBalancesForSchool failed:', err); return []; }),
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

    useEffect(() => {
        if (userData?.schoolId) loadFeeData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userData?.schoolId, scope.term, scope.year, scope.level, scope.cls]);

    // ---------- Invoice creation ----------
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
        return results;
    }, [userData, termLocked, loadFeeData]);

    // ---------- Record payment (ledger) ----------
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

            // Optimistic local update
            setFeeTransactions(prev => [{ id: result.id, ...txnData }, ...prev]);
            return { success: true, id: result.id, alreadyExisted: result.alreadyExisted };
        } catch (err) {
            console.error('addFeeTransaction failed:', err);
            return { success: false, error: err.message };
        }
    }, [userData, currentUser, termLocked]);



    // ---------- Void ----------
    const voidTransactionById = useCallback(async (txnId, reason) => {
        const schoolId = requireSchoolId(userData);
        try {
            await voidTransaction(schoolId, txnId, reason,
                currentUser?.uid, userData?.fullName || userData?.firstName || 'System');
            await loadFeeData();
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }, [userData, currentUser, loadFeeData]);

    const cancelInvoiceById = useCallback(async (invoiceId, reason) => {
        const schoolId = requireSchoolId(userData);
        try {
            await cancelInvoice(schoolId, invoiceId, reason,
                currentUser?.uid, userData?.fullName || userData?.firstName || 'System');
            await loadFeeData();
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }, [userData, currentUser, loadFeeData]);

    // ---------- Overdue ----------
    const checkOverdueInvoices = useCallback(async () => {
        const now = new Date();
        const overdue = invoices.filter(inv =>
            inv.status !== 'paid' && inv.status !== 'cancelled' &&
            inv.status !== 'overdue' && inv.dueDate && new Date(inv.dueDate) < now);
        if (!overdue.length) return 0;
        // Optimistic local update only; Cloud Function does the write
        setInvoices(prev => prev.map(inv =>
            overdue.find(o => o.id === inv.id) ? { ...inv, status: 'overdue' } : inv));
        return overdue.length;
    }, [invoices]);

    // ---------- Lookups ----------
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
            const res = await fetch('/api/send-invoice-reminder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ invoiceId, schoolId: userData?.schoolId })
            });
            const data = await res.json();
            return data.success ? { success: true } : { success: false, error: data.error };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }, [userData]);

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
        return res;
    }, [userData, loadFeeData]);

    const value = {
        students, feeBalances: balances, feeTransactions, invoices, loading, error,
        scope, setScope, summary, termLocked, aging, feeStructures,
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
        refreshData: () => loadFeeData(),
        loadFeeData
    };

    return <FeeContext.Provider value={value}>{children}</FeeContext.Provider>;
}
