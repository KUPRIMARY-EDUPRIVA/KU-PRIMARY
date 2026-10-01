// src/services/feeService.js
import {
    collection, query, where, getDocs, doc, getDoc, setDoc,
    limit, writeBatch, deleteDoc, startAfter, orderBy,
    updateDoc, serverTimestamp, runTransaction, increment,
    getCountFromServer, endBefore, limitToLast, startAt
} from 'firebase/firestore';
import { db } from '../firebase';
import { getMemory, setMemory } from './cache';

// ---------- Tenant guard ----------
export function requireSchoolId(userData) {
    const schoolId = userData?.schoolId;
    if (!schoolId) throw new Error('School context missing. Please re-login.');
    return schoolId;
}

// ---------- Deterministic IDs ----------
const slug = (s) => String(s).trim().replace(/\s+/g, '_').replace(/[/#$[\]]/g, '');

export function makeInvoiceId(schoolId, studentId, term, year, suffix = '') {
    return `${slug(schoolId)}__${slug(studentId)}__${slug(term)}__${slug(year)}${suffix ? '__' + slug(suffix) : ''}`;
}
export function makeBalanceId(studentId, term, year) {
    return `${slug(studentId)}__${slug(term)}__${slug(year)}`;
}
export function makeFeeStructureId(schoolId, targetKey, year, term = 'all') {
    return `${slug(schoolId)}__${slug(targetKey)}__${slug(year)}${term && term !== 'all' ? '__' + slug(term) : ''}`;
}
export function makeIdempotencyKey(schoolId, studentId, amount, date) {
    return `${slug(schoolId)}__${slug(studentId)}__${slug(amount)}__${slug(date)}`;
}

// ---------- Pagination constants ----------
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

// ============================================================
// PAGINATED STUDENT QUERIES
// ============================================================

/**
 * Fetch a single page of students with cursor-based pagination.
 * 
 * @param {string} schoolId
 * @param {object} opts
 * @param {number} opts.pageSize - items per page (default 25)
 * @param {object} opts.cursor - { id, sortValue } from previous page's last doc
 * @param {string} opts.direction - 'next' | 'prev' | 'first'
 * @param {string} opts.level
 * @param {string} opts.cls
 * @param {string} opts.searchTerm - client-side filtered after fetch if needed
 * @param {string} opts.sortField - 'firstName' | 'admissionNumber' | 'class' (default 'firstName')
 * @returns {Promise<{ items: Array, cursor: object|null, hasMore: boolean, total: number }>}
 */
export async function getStudentsPage(schoolId, opts = {}) {
    const {
        pageSize = DEFAULT_PAGE_SIZE,
        cursor = null,
        direction = 'first',
        level,
        cls,
        sortField = 'firstName',
        sortDirection = 'asc'
    } = opts;

    const safeSize = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);

    // Build constraints
    const constraints = [where('schoolId', '==', schoolId)];
    if (level) constraints.push(where('level', '==', level));
    if (cls) constraints.push(where('class', '==', cls));

    // Order by sortField then by documentId for stable cursor
    const orderField = sortField || 'firstName';
    const dir = sortDirection === 'desc' ? 'desc' : 'asc';
    constraints.push(orderBy(orderField, dir));
    constraints.push(orderBy('__name__', dir));

    let q;
    if (direction === 'prev' && cursor) {
        // For prev, we query backwards then reverse
        q = query(
            collection(db, 'students'),
            ...constraints,
            endBefore(cursor.sortValue, cursor.id),
            limitToLast(safeSize + 1)
        );
    } else if (direction === 'next' && cursor) {
        q = query(
            collection(db, 'students'),
            ...constraints,
            startAfter(cursor.sortValue, cursor.id),
            limit(safeSize + 1)
        );
    } else {
        q = query(
            collection(db, 'students'),
            ...constraints,
            limit(safeSize + 1)
        );
    }

    try {
        const snap = await getDocs(q);
        let docs = snap.docs;

        // Determine if there's a next page
        let hasMore = false;
        if (direction === 'prev') {
            hasMore = docs.length > safeSize; // we fetched extra going backwards
            docs = docs.slice(-safeSize); // keep last N (closest to original position)
        } else {
            hasMore = docs.length > safeSize;
            docs = docs.slice(0, safeSize);
        }

        const items = docs.map(d => ({ id: d.id, ...d.data() }));

        // Build cursor from first/last doc
        const firstDoc = docs[0];
        const lastDoc = docs[docs.length - 1];
        const cursorOut = lastDoc ? {
            id: lastDoc.id,
            sortValue: lastDoc.data()[orderField] ?? lastDoc.data().firstName ?? ''
        } : null;
        const cursorIn = firstDoc ? {
            id: firstDoc.id,
            sortValue: firstDoc.data()[orderField] ?? firstDoc.data().firstName ?? ''
        } : null;

        return {
            items,
            cursor: cursorOut,
            cursorPrev: cursorIn,
            hasMore,
            hasPrev: direction !== 'first' && cursorIn !== null,
            total: null // caller may request count separately
        };
    } catch (err) {
        console.warn('getStudentsPage primary query failed, falling back:', err);
        // Fallback: fetch all with schoolId filter and slice client-side
        const fallbackQ = query(
            collection(db, 'students'),
            where('schoolId', '==', schoolId),
            limit(2000)
        );
        const snap = await getDocs(fallbackQ);
        let all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (level) all = all.filter(s => s.level === level);
        if (cls) all = all.filter(s => s.class === cls);
        all.sort((a, b) => (a[orderField] || '').localeCompare(b[orderField] || ''));

        const items = all.slice(0, safeSize);
        return {
            items,
            cursor: items.length ? { id: items[items.length - 1].id, sortValue: items[items.length - 1][orderField] } : null,
            cursorPrev: items.length ? { id: items[0].id, sortValue: items[0][orderField] } : null,
            hasMore: all.length > safeSize,
            hasPrev: false,
            total: all.length
        };
    }
}

/**
 * Get total count of students matching filters using count aggregation.
 */
export async function getStudentsCount(schoolId, { level, cls } = {}) {
    const constraints = [where('schoolId', '==', schoolId)];
    if (level) constraints.push(where('level', '==', level));
    if (cls) constraints.push(where('class', '==', cls));

    try {
        const q = query(collection(db, 'students'), ...constraints);
        const snapshot = await getCountFromServer(q);
        return snapshot.data().count;
    } catch (err) {
        console.warn('getStudentsCount failed:', err);
        return null;
    }
}

// ============================================================
// PAGINATED BALANCE QUERIES
// ============================================================

/**
 * Fetch a page of student balances.
 * Uses cursor on (studentName, __name__) for stable pagination.
 */
export async function getBalancesPage(schoolId, opts = {}) {
    const {
        pageSize = DEFAULT_PAGE_SIZE,
        cursor = null,
        direction = 'first',
        term,
        year,
        level,
        cls,
        status,
        sortField = 'studentName',
        sortDirection = 'asc'
    } = opts;

    const safeSize = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);

    const constraints = [where('schoolId', '==', schoolId)];
    if (term) constraints.push(where('term', '==', term));
    if (year) constraints.push(where('year', '==', Number(year)));
    if (level) constraints.push(where('level', '==', level));
    if (cls) constraints.push(where('studentClass', '==', cls));
    if (status) constraints.push(where('status', '==', status));

    const orderField = sortField || 'studentName';
    const dir = sortDirection === 'desc' ? 'desc' : 'asc';
    constraints.push(orderBy(orderField, dir));
    constraints.push(orderBy('__name__', dir));

    let q;
    if (direction === 'prev' && cursor) {
        q = query(
            collection(db, 'student_balances'),
            ...constraints,
            endBefore(cursor.sortValue, cursor.id),
            limitToLast(safeSize + 1)
        );
    } else if (direction === 'next' && cursor) {
        q = query(
            collection(db, 'student_balances'),
            ...constraints,
            startAfter(cursor.sortValue, cursor.id),
            limit(safeSize + 1)
        );
    } else {
        q = query(
            collection(db, 'student_balances'),
            ...constraints,
            limit(safeSize + 1)
        );
    }

    try {
        const snap = await getDocs(q);
        let docs = snap.docs;
        let hasMore = false;

        if (direction === 'prev') {
            hasMore = docs.length > safeSize;
            docs = docs.slice(-safeSize);
        } else {
            hasMore = docs.length > safeSize;
            docs = docs.slice(0, safeSize);
        }

        const items = docs.map(d => ({ id: d.id, ...d.data() }));
        const firstDoc = docs[0];
        const lastDoc = docs[docs.length - 1];

        return {
            items,
            cursor: lastDoc ? {
                id: lastDoc.id,
                sortValue: lastDoc.data()[orderField] ?? lastDoc.data().studentName ?? ''
            } : null,
            cursorPrev: firstDoc ? {
                id: firstDoc.id,
                sortValue: firstDoc.data()[orderField] ?? firstDoc.data().studentName ?? ''
            } : null,
            hasMore,
            hasPrev: direction !== 'first' && !!firstDoc
        };
    } catch (err) {
        console.warn('getBalancesPage failed, falling back:', err);
        const fallbackQ = query(
            collection(db, 'student_balances'),
            where('schoolId', '==', schoolId),
            limit(2000)
        );
        const snap = await getDocs(fallbackQ);
        let all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (term) all = all.filter(b => b.term === term);
        if (year) all = all.filter(b => Number(b.year) === Number(year));
        if (level) all = all.filter(b => b.level === level);
        if (cls) all = all.filter(b => b.studentClass === cls);
        if (status) all = all.filter(b => b.status === status);
        all.sort((a, b) => (a[orderField] || '').localeCompare(b[orderField] || ''));

        const items = all.slice(0, safeSize);
        return {
            items,
            cursor: items.length ? { id: items[items.length - 1].id, sortValue: items[items.length - 1][orderField] } : null,
            cursorPrev: items.length ? { id: items[0].id, sortValue: items[0][orderField] } : null,
            hasMore: all.length > safeSize,
            hasPrev: false
        };
    }
}

export async function getBalancesCount(schoolId, { term, year, level, cls, status } = {}) {
    const constraints = [where('schoolId', '==', schoolId)];
    if (term) constraints.push(where('term', '==', term));
    if (year) constraints.push(where('year', '==', Number(year)));
    if (level) constraints.push(where('level', '==', level));
    if (cls) constraints.push(where('studentClass', '==', cls));
    if (status) constraints.push(where('status', '==', status));

    try {
        const q = query(collection(db, 'student_balances'), ...constraints);
        const snapshot = await getCountFromServer(q);
        return snapshot.data().count;
    } catch (err) {
        console.warn('getBalancesCount failed:', err);
        return null;
    }
}

// ============================================================
// PAGINATED INVOICE QUERIES
// ============================================================

export async function getInvoicesPage(schoolId, opts = {}) {
    const {
        pageSize = DEFAULT_PAGE_SIZE,
        cursor = null,
        direction = 'first',
        term,
        year,
        status,
        studentId,
        sortDirection = 'desc'
    } = opts;

    const safeSize = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
    const constraints = [where('schoolId', '==', schoolId)];
    if (term) constraints.push(where('term', '==', term));
    if (year) constraints.push(where('academicYear', '==', String(year)));
    if (status) constraints.push(where('status', '==', status));
    if (studentId) constraints.push(where('studentId', '==', studentId));

    // Order by createdAt for stable sort
    const dir = sortDirection === 'asc' ? 'asc' : 'desc';
    constraints.push(orderBy('createdAt', dir));
    constraints.push(orderBy('__name__', dir));

    let q;
    if (direction === 'prev' && cursor) {
        q = query(collection(db, 'invoices'), ...constraints, endBefore(cursor.sortValue, cursor.id), limitToLast(safeSize + 1));
    } else if (direction === 'next' && cursor) {
        q = query(collection(db, 'invoices'), ...constraints, startAfter(cursor.sortValue, cursor.id), limit(safeSize + 1));
    } else {
        q = query(collection(db, 'invoices'), ...constraints, limit(safeSize + 1));
    }

    try {
        const snap = await getDocs(q);
        let docs = snap.docs;
        let hasMore = false;
        if (direction === 'prev') {
            hasMore = docs.length > safeSize;
            docs = docs.slice(-safeSize);
        } else {
            hasMore = docs.length > safeSize;
            docs = docs.slice(0, safeSize);
        }

        const items = docs.map(d => ({ id: d.id, ...d.data() }));
        const firstDoc = docs[0];
        const lastDoc = docs[docs.length - 1];

        return {
            items,
            cursor: lastDoc ? {
                id: lastDoc.id,
                sortValue: lastDoc.data().createdAt ?? null
            } : null,
            cursorPrev: firstDoc ? {
                id: firstDoc.id,
                sortValue: firstDoc.data().createdAt ?? null
            } : null,
            hasMore,
            hasPrev: direction !== 'first' && !!firstDoc
        };
    } catch (err) {
        console.warn('getInvoicesPage fallback:', err);
        const q = query(collection(db, 'invoices'), where('schoolId', '==', schoolId), limit(2000));
        const snap = await getDocs(q);
        let all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (term) all = all.filter(i => i.term === term);
        if (year) all = all.filter(i => String(i.academicYear) === String(year));
        if (status) all = all.filter(i => i.status === status);
        if (studentId) all = all.filter(i => i.studentId === studentId);

        const items = all.slice(0, safeSize);
        return {
            items,
            cursor: items.length ? { id: items[items.length - 1].id, sortValue: items[items.length - 1].createdAt } : null,
            cursorPrev: items.length ? { id: items[0].id, sortValue: items[0].createdAt } : null,
            hasMore: all.length > safeSize,
            hasPrev: false
        };
    }
}

export async function getInvoicesCount(schoolId, { term, year, status, studentId } = {}) {
    const constraints = [where('schoolId', '==', schoolId)];
    if (term) constraints.push(where('term', '==', term));
    if (year) constraints.push(where('academicYear', '==', String(year)));
    if (status) constraints.push(where('status', '==', status));
    if (studentId) constraints.push(where('studentId', '==', studentId));
    try {
        const snapshot = await getCountFromServer(query(collection(db, 'invoices'), ...constraints));
        return snapshot.data().count;
    } catch (err) {
        console.warn('getInvoicesCount failed:', err);
        return null;
    }
}

// ============================================================
// PAGINATED TRANSACTION QUERIES
// ============================================================

export async function getFeeTransactionsPage(schoolId, opts = {}) {
    const {
        pageSize = DEFAULT_PAGE_SIZE,
        cursor = null,
        direction = 'first',
        term,
        year,
        studentId,
        type,
        sortDirection = 'desc'
    } = opts;

    const safeSize = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
    const constraints = [where('schoolId', '==', schoolId)];
    if (term) constraints.push(where('term', '==', term));
    if (year) constraints.push(where('year', '==', Number(year)));
    if (studentId) constraints.push(where('studentId', '==', studentId));
    if (type) constraints.push(where('type', '==', type));

    const dir = sortDirection === 'asc' ? 'asc' : 'desc';
    constraints.push(orderBy('createdAt', dir));
    constraints.push(orderBy('__name__', dir));

    let q;
    if (direction === 'prev' && cursor) {
        q = query(collection(db, 'fee_transactions'), ...constraints, endBefore(cursor.sortValue, cursor.id), limitToLast(safeSize + 1));
    } else if (direction === 'next' && cursor) {
        q = query(collection(db, 'fee_transactions'), ...constraints, startAfter(cursor.sortValue, cursor.id), limit(safeSize + 1));
    } else {
        q = query(collection(db, 'fee_transactions'), ...constraints, limit(safeSize + 1));
    }

    try {
        const snap = await getDocs(q);
        let docs = snap.docs;
        let hasMore = false;
        if (direction === 'prev') {
            hasMore = docs.length > safeSize;
            docs = docs.slice(-safeSize);
        } else {
            hasMore = docs.length > safeSize;
            docs = docs.slice(0, safeSize);
        }

        const items = docs.map(d => ({ id: d.id, ...d.data() }));
        const firstDoc = docs[0];
        const lastDoc = docs[docs.length - 1];

        return {
            items,
            cursor: lastDoc ? { id: lastDoc.id, sortValue: lastDoc.data().createdAt ?? null } : null,
            cursorPrev: firstDoc ? { id: firstDoc.id, sortValue: firstDoc.data().createdAt ?? null } : null,
            hasMore,
            hasPrev: direction !== 'first' && !!firstDoc
        };
    } catch (err) {
        console.warn('getFeeTransactionsPage fallback:', err);
        const q = query(collection(db, 'fee_transactions'), where('schoolId', '==', schoolId), limit(2000));
        const snap = await getDocs(q);
        let all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (term) all = all.filter(t => t.term === term);
        if (year) all = all.filter(t => Number(t.year) === Number(year));
        if (studentId) all = all.filter(t => t.studentId === studentId);
        if (type) all = all.filter(t => t.type === type);

        const items = all.slice(0, safeSize);
        return {
            items,
            cursor: items.length ? { id: items[items.length - 1].id, sortValue: items[items.length - 1].createdAt } : null,
            cursorPrev: items.length ? { id: items[0].id, sortValue: items[0].createdAt } : null,
            hasMore: all.length > safeSize,
            hasPrev: false
        };
    }
}

// ============================================================
// LEGACY (non-paginated) - kept for backwards compatibility
// ============================================================

export async function getStudents(schoolId, { level, cls, maxResults = 1000 } = {}) {
    const cacheKey = `students_${schoolId}_${level || 'all'}_${cls || 'all'}`;
    const cached = getMemory(cacheKey);
    if (cached) return cached;

    const constraints = [where('schoolId', '==', schoolId)];
    if (level) constraints.push(where('level', '==', level));
    if (cls) constraints.push(where('class', '==', cls));

    try {
        const q = query(collection(db, 'students'), ...constraints, limit(maxResults));
        const snap = await getDocs(q);
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (a.firstName || '').localeCompare(b.firstName || ''));
        setMemory(cacheKey, list, 5 * 60 * 1000);
        return list;
    } catch (err) {
        console.warn('getStudents query error, falling back:', err);
        const q = query(collection(db, 'students'), where('schoolId', '==', schoolId), limit(maxResults));
        const snap = await getDocs(q);
        let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (level) list = list.filter(s => s.level === level);
        if (cls) list = list.filter(s => s.class === cls);
        list.sort((a, b) => (a.firstName || '').localeCompare(b.firstName || ''));
        setMemory(cacheKey, list, 5 * 60 * 1000);
        return list;
    }
}

// ---------- Idempotent transaction writer (LEDGER) ----------
export async function postTransaction(schoolId, txn, opts = {}) {
    const idemKey = txn.idempotencyKey || makeIdempotencyKey(
        schoolId, txn.studentId, txn.amount, txn.paymentDate || new Date().toISOString().split('T')[0]
    );
    const txnRef = doc(db, 'fee_transactions', idemKey);
    const balanceId = makeBalanceId(txn.studentId, txn.term, txn.year);
    const balanceRef = doc(db, 'student_balances', balanceId);

    const res = await runTransaction(db, async (trx) => {
        const existing = await trx.get(txnRef);
        if (existing.exists()) return { id: idemKey, alreadyExisted: true };

        const balSnap = await trx.get(balanceRef);
        const current = balSnap.exists() ? balSnap.data() : {
            studentId: txn.studentId, studentName: txn.studentName, admissionNumber: txn.admissionNumber,
            studentClass: txn.class, level: txn.level, term: txn.term, year: txn.year, schoolId,
            totalInvoiced: 0, totalPaid: 0, totalDiscount: 0, totalWaived: 0, balance: 0,
            status: 'no_invoice', updatedAt: serverTimestamp()
        };

        const isPayment = txn.type === 'payment' && (txn.status === 'completed' || txn.status === 'success');
        const isDiscount = txn.type === 'discount';
        const isWaiver = txn.type === 'waiver';
        const isRefund = txn.type === 'refund';

        let deltaPaid = 0, deltaDiscount = 0, deltaWaived = 0;
        if (isPayment) deltaPaid = txn.amount;
        if (isRefund) deltaPaid = -txn.amount;
        if (isDiscount) deltaDiscount = txn.amount;
        if (isWaiver) deltaWaived = txn.amount;

        const totalInvoiced = current.totalInvoiced || 0;
        const totalPaid = (current.totalPaid || 0) + deltaPaid;
        const totalDiscount = (current.totalDiscount || 0) + deltaDiscount;
        const totalWaived = (current.totalWaived || 0) + deltaWaived;
        const balance = totalInvoiced - totalPaid - totalDiscount - totalWaived;

        let status = 'pending';
        if (totalInvoiced === 0) status = 'no_invoice';
        else if (balance <= 0) status = 'paid';
        else if (totalPaid + totalDiscount + totalWaived > 0) status = 'partial';

        trx.set(txnRef, {
            ...txn, schoolId, idempotencyKey: idemKey, createdAt: serverTimestamp(),
            voided: false, voidedAt: null, voidedBy: null, voidReason: null
        });

        trx.set(balanceRef, {
            ...current, totalInvoiced, totalPaid, totalDiscount, totalWaived, balance, status,
            lastTransactionAt: serverTimestamp(), updatedAt: serverTimestamp()
        }, { merge: true });

        const auditRef = doc(collection(db, 'fee_audit_log'));
        trx.set(auditRef, {
            schoolId, action: 'POST_TRANSACTION', transactionId: idemKey, studentId: txn.studentId,
            amount: txn.amount, type: txn.type,
            performedBy: opts.performedBy || txn.recordedBy || 'system',
            performedByName: opts.performedByName || txn.recordedByName || 'System',
            timestamp: serverTimestamp(), ip: opts.ip || null
        });

        return { id: idemKey, alreadyExisted: false };
    });

    if (!res.alreadyExisted) {
        await reconcileStudentBalance(schoolId, txn.studentId, txn.term, txn.year);
    }
    return res;
}

export async function voidTransaction(schoolId, txnId, reason, performedBy, performedByName) {
    const txnRef = doc(db, 'fee_transactions', txnId);
    const txnSnap = await getDoc(txnRef);
    if (!txnSnap.exists()) throw new Error('Transaction not found');
    const txn = txnSnap.data();
    if (txn.voided) throw new Error('Already voided');

    const reversalIdem = `${txnId}__VOID__${Date.now()}`;
    await postTransaction(schoolId, {
        ...txn, amount: -Math.abs(txn.amount), type: 'reversal',
        description: `VOID: ${reason}`, reference: txn.reference, idempotencyKey: reversalIdem,
        recordedBy: performedBy, recordedByName: performedByName, reversalOf: txnId
    });

    await updateDoc(txnRef, {
        voided: true, voidedAt: serverTimestamp(), voidedBy: performedBy, voidReason: reason
    });
    await reconcileStudentBalance(schoolId, txn.studentId, txn.term, txn.year);
    return { success: true };
}

// ---------- Fee structures ----------
export async function getFeeStructure(schoolId, targetKey, year, term = 'all') {
    const idWithTerm = makeFeeStructureId(schoolId, targetKey, year, term);
    const snapWithTerm = await getDoc(doc(db, 'fee_structures', idWithTerm));
    if (snapWithTerm.exists()) return { id: idWithTerm, ...snapWithTerm.data() };

    if (term && term !== 'all') {
        const idWithoutTerm = makeFeeStructureId(schoolId, targetKey, year, 'all');
        const snapWithoutTerm = await getDoc(doc(db, 'fee_structures', idWithoutTerm));
        if (snapWithoutTerm.exists()) return { id: idWithoutTerm, ...snapWithoutTerm.data() };
    }
    return null;
}

export async function getFeeStructures(schoolId, { year, term } = {}) {
    const constraints = [where('schoolId', '==', schoolId)];
    if (year) constraints.push(where('year', '==', Number(year)));
    if (term && term !== 'all') constraints.push(where('term', '==', term));

    try {
        const q = query(collection(db, 'fee_structures'), ...constraints, limit(100));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        const q = query(collection(db, 'fee_structures'), where('schoolId', '==', schoolId), limit(100));
        const snap = await getDocs(q);
        let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (year) list = list.filter(s => Number(s.year) === Number(year));
        if (term && term !== 'all') list = list.filter(s => s.term === term);
        return list;
    }
}

export async function upsertFeeStructure(schoolId, targetKey, year, structure, meta = {}, term = 'all') {
    const id = makeFeeStructureId(schoolId, targetKey, year, term);
    const items = (structure.items || []).map(i => ({
        description: i.description || '', category: i.category || 'Tuition',
        amount: Number(i.amount) || 0, optional: Boolean(i.optional)
    }));
    const totalAmount = items.reduce((s, i) => s + i.amount, 0);
    const mandatoryAmount = items.filter(i => !i.optional).reduce((s, i) => s + i.amount, 0);
    const optionalAmount = items.filter(i => i.optional).reduce((s, i) => s + i.amount, 0);

    await setDoc(doc(db, 'fee_structures', id), {
        schoolId, targetKey, targetType: structure.targetType || 'level',
        level: structure.level || (structure.targetType === 'level' ? targetKey : null),
        className: structure.className || (structure.targetType === 'class' ? targetKey : null),
        name: structure.name || targetKey, term: term || structure.term || 'all', year: Number(year),
        items, totalAmount, mandatoryAmount, optionalAmount,
        updatedBy: meta.updatedBy || '', updatedByName: meta.updatedByName || 'System',
        updatedAt: serverTimestamp()
    }, { merge: true });
    return { id, totalAmount, mandatoryAmount, optionalAmount };
}

export async function deleteFeeStructure(schoolId, id) {
    const ref = doc(db, 'fee_structures', id);
    const snap = await getDoc(ref);
    if (!snap.exists()) return { success: true };
    if (snap.data().schoolId !== schoolId) throw new Error('Unauthorized to delete this fee structure');
    await deleteDoc(ref);
    return { success: true };
}

// ---------- Authoritative Balance Reconciliation ----------
export async function reconcileStudentBalance(schoolId, studentId, term, year) {
    const balanceId = makeBalanceId(studentId, term, year);
    const balanceRef = doc(db, 'student_balances', balanceId);

    let invSnap;
    try {
        invSnap = await getDocs(query(
            collection(db, 'invoices'),
            where('schoolId', '==', schoolId),
            where('studentId', '==', studentId),
            where('term', '==', term),
            where('academicYear', '==', String(year))
        ));
    } catch (error) {
        if (error.code !== 'failed-precondition') throw error;
        invSnap = await getDocs(query(collection(db, 'invoices'), where('schoolId', '==', schoolId)));
    }
    const activeInvoices = invSnap.docs
        .map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
        .filter(i => i.studentId === studentId && i.term === term &&
            String(i.academicYear) === String(year) && i.status !== 'cancelled');

    activeInvoices.sort((a, b) => {
        const da = a.createdAt?.toDate?.() || (a.createdAt ? new Date(a.createdAt) : 0);
        const db_ = b.createdAt?.toDate?.() || (b.createdAt ? new Date(b.createdAt) : 0);
        return da - db_;
    });

    const totalInvoiced = activeInvoices.reduce((sum, i) => sum + (Number(i.total) || 0), 0);

    let txnSnap;
    try {
        txnSnap = await getDocs(query(
            collection(db, 'fee_transactions'),
            where('schoolId', '==', schoolId),
            where('studentId', '==', studentId),
            where('term', '==', term),
            where('year', '==', Number(year))
        ));
    } catch (error) {
        if (error.code !== 'failed-precondition') throw error;
        txnSnap = await getDocs(query(collection(db, 'fee_transactions'), where('schoolId', '==', schoolId)));
    }
    const activeTxns = txnSnap.docs
        .map(d => d.data())
        .filter(t => t.studentId === studentId && t.term === term &&
            Number(t.year) === Number(year) && !t.voided);

    let totalPaid = 0, totalDiscount = 0, totalWaived = 0;
    for (const t of activeTxns) {
        const amt = Number(t.amount) || 0;
        if (t.type === 'payment' && (t.status === 'completed' || t.status === 'success')) totalPaid += amt;
        else if (t.type === 'refund') totalPaid -= amt;
        else if (t.type === 'discount') totalDiscount += amt;
        else if (t.type === 'waiver') totalWaived += amt;
        else if (t.type === 'reversal') totalPaid += amt;
    }

    let remainingPool = totalPaid;
    const batch = writeBatch(db);
    for (const inv of activeInvoices) {
        const invTotal = Number(inv.total) || 0;
        const paidForInv = Math.max(0, Math.min(remainingPool, invTotal));
        remainingPool -= paidForInv;
        const remainingBal = Math.max(0, invTotal - paidForInv);
        const invStatus = remainingBal <= 0 && invTotal > 0 ? 'paid' : paidForInv > 0 ? 'partial' : 'pending';

        batch.update(inv.ref, {
            paidAmount: paidForInv, remainingBalance: remainingBal, status: invStatus,
            updatedAt: serverTimestamp(),
            ...(invStatus === 'paid' && !inv.paidAt ? { paidAt: serverTimestamp() } : {})
        });
    }
    await batch.commit();

    const balance = totalInvoiced - totalPaid - totalDiscount - totalWaived;
    let status = 'pending';
    if (totalInvoiced === 0) status = 'no_invoice';
    else if (balance <= 0) status = 'paid';
    else if (totalPaid + totalDiscount + totalWaived > 0) status = 'partial';

    const updatedData = {
        schoolId, studentId, term, year: Number(year),
        totalInvoiced, totalPaid, totalDiscount, totalWaived, balance, status,
        lastReconciledAt: serverTimestamp(), updatedAt: serverTimestamp()
    };
    await setDoc(balanceRef, updatedData, { merge: true });
    return { id: balanceId, ...updatedData };
}

// ---------- Invoices (batch) ----------
export async function createInvoicesBatch(schoolId, entries, meta) {
    if (!entries?.length) return { count: 0 };
    if (entries.length > 250) {
        const stamp = Date.now();
        const prepared = entries.map((entry, index) => ({
            ...entry, suffix: entry.suffix || `${stamp}_${index}`
        }));
        let count = 0;
        for (let index = 0; index < prepared.length; index += 250) {
            const result = await createInvoicesBatch(schoolId, prepared.slice(index, index + 250), meta);
            count += result.count;
        }
        return { count };
    }

    const preparedEntries = entries.map((entry, index) => ({
        ...entry, suffix: entry.suffix || `${Date.now()}_${index}`
    }));
    const batch = writeBatch(db);
    for (let index = 0; index < preparedEntries.length; index++) {
        const entry = preparedEntries[index];
        const ref = doc(db, 'invoices', makeInvoiceId(
            schoolId, entry.studentId, entry.term, entry.academicYear, entry.suffix
        ));
        batch.set(ref, {
            invoiceNumber: entry.invoiceNumber, studentId: entry.studentId,
            studentName: entry.studentName, studentClass: entry.studentClass,
            studentLevel: entry.studentLevel, admissionNumber: entry.admissionNumber,
            items: (entry.items || []).map(i => ({
                description: i.description || '', amount: i.amount || 0,
                quantity: i.quantity || 1, unitPrice: i.unitPrice || i.amount || 0
            })),
            subtotal: entry.subtotal || 0, tax: entry.tax || 0, discount: entry.discount || 0,
            total: entry.total || 0, paidAmount: 0, remainingBalance: entry.total || 0,
            term: entry.term, academicYear: String(entry.academicYear), dueDate: entry.dueDate,
            status: 'pending', notes: entry.notes || '', payments: [], schoolId,
            createdBy: meta.createdBy || '', createdByName: meta.createdByName || '',
            createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        }, { merge: true });
    }

    const newInvoiceTotals = new Map();
    preparedEntries.forEach((entry) => {
        const key = JSON.stringify([entry.studentId, entry.term, entry.academicYear]);
        const current = newInvoiceTotals.get(key) || { entry, amount: 0 };
        current.amount += Number(entry.total) || 0;
        newInvoiceTotals.set(key, current);
    });

    if (newInvoiceTotals.size) {
        const balanceEntries = [...newInvoiceTotals.values()];
        balanceEntries.forEach(({ entry, amount }) => {
            const balanceRef = doc(db, 'student_balances', makeBalanceId(
                entry.studentId, entry.term, entry.academicYear
            ));
            batch.set(balanceRef, {
                schoolId, studentId: entry.studentId, studentName: entry.studentName || '',
                admissionNumber: entry.admissionNumber || '', studentClass: entry.studentClass || '',
                level: entry.studentLevel || '', term: entry.term, year: Number(entry.academicYear),
                totalInvoiced: increment(amount), balance: increment(amount), status: 'pending',
                updatedAt: serverTimestamp(), lastReconciledAt: serverTimestamp()
            }, { merge: true });
        });
    }

    await batch.commit();
    setMemory(`inv_${schoolId}_all_all_all_all`, null, 0);
    return { count: preparedEntries.length };
}

export async function cancelInvoice(schoolId, invoiceId, reason, performedBy, performedByName) {
    const invRef = doc(db, 'invoices', invoiceId);
    const invSnap = await getDoc(invRef);
    if (!invSnap.exists()) throw new Error('Invoice not found');
    const invoice = invSnap.data();
    if (invoice.status === 'cancelled') throw new Error('Invoice already cancelled');

    await updateDoc(invRef, {
        status: 'cancelled', cancelledAt: serverTimestamp(), cancelledBy: performedBy,
        cancelledByName: performedByName, cancelReason: reason, updatedAt: serverTimestamp()
    });
    await reconcileStudentBalance(schoolId, invoice.studentId, invoice.term, invoice.academicYear);
    return { success: true };
}

// ---------- Legacy queries (kept for backwards compat) ----------
export async function getInvoices(schoolId, { term, year, status, studentId, maxResults = 500 } = {}) {
    const constraints = [where('schoolId', '==', schoolId)];
    if (term) constraints.push(where('term', '==', term));
    if (year) constraints.push(where('academicYear', '==', String(year)));
    if (status) constraints.push(where('status', '==', status));
    if (studentId) constraints.push(where('studentId', '==', studentId));
    try {
        const q = query(collection(db, 'invoices'), ...constraints, limit(maxResults));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
            const da = a.createdAt?.toDate?.() || 0, db_ = b.createdAt?.toDate?.() || 0;
            return db_ - da;
        });
    } catch (err) {
        const q = query(collection(db, 'invoices'), where('schoolId', '==', schoolId), limit(maxResults));
        const snap = await getDocs(q);
        let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (term) list = list.filter(i => i.term === term);
        if (year) list = list.filter(i => String(i.academicYear) === String(year));
        if (status) list = list.filter(i => i.status === status);
        if (studentId) list = list.filter(i => i.studentId === studentId);
        return list;
    }
}

export async function getFeeTransactions(schoolId, { term, year, studentId, maxResults = 500 } = {}) {
    const constraints = [where('schoolId', '==', schoolId)];
    if (term) constraints.push(where('term', '==', term));
    if (year) constraints.push(where('year', '==', Number(year)));
    if (studentId) constraints.push(where('studentId', '==', studentId));
    try {
        const q = query(collection(db, 'fee_transactions'), ...constraints, limit(maxResults));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
            const da = a.createdAt?.toDate?.() || 0, db_ = b.createdAt?.toDate?.() || 0;
            return db_ - da;
        });
    } catch (err) {
        const q = query(collection(db, 'fee_transactions'), where('schoolId', '==', schoolId), limit(maxResults));
        const snap = await getDocs(q);
        let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (term) list = list.filter(t => t.term === term);
        if (year) list = list.filter(t => Number(t.year) === Number(year));
        if (studentId) list = list.filter(t => t.studentId === studentId);
        return list;
    }
}

export async function getStudentBalance(studentId, term, year) {
    const id = makeBalanceId(studentId, term, year);
    const snap = await getDoc(doc(db, 'student_balances', id));
    return snap.exists() ? { id, ...snap.data() } : null;
}

export async function getBalancesForSchool(schoolId, term, year, { level, cls, maxResults = 1000 } = {}) {
    const constraints = [where('schoolId', '==', schoolId)];
    if (term) constraints.push(where('term', '==', term));
    if (year) constraints.push(where('year', '==', Number(year)));
    if (level) constraints.push(where('level', '==', level));
    if (cls) constraints.push(where('studentClass', '==', cls));
    try {
        const q = query(collection(db, 'student_balances'), ...constraints, limit(maxResults));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) =>
            (a.studentName || '').localeCompare(b.studentName || ''));
    } catch (err) {
        const q = query(collection(db, 'student_balances'), where('schoolId', '==', schoolId), limit(maxResults));
        const snap = await getDocs(q);
        let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (term) list = list.filter(b => b.term === term);
        if (year) list = list.filter(b => Number(b.year) === Number(year));
        if (level) list = list.filter(b => b.level === level);
        if (cls) list = list.filter(b => b.studentClass === cls);
        return list.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''));
    }
}

// ---------- Aging report ----------
export function computeAging(invoices, asOf = new Date()) {
    const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
    for (const inv of invoices) {
        if (inv.status === 'paid' || inv.status === 'cancelled') continue;
        const due = inv.dueDate ? new Date(inv.dueDate) : null;
        const remaining = inv.remainingBalance || (inv.total - (inv.paidAmount || 0));
        if (!due || due >= asOf) { buckets.current += remaining; continue; }
        const days = Math.floor((asOf - due) / 86400000);
        if (days <= 30) buckets.d30 += remaining;
        else if (days <= 60) buckets.d60 += remaining;
        else if (days <= 90) buckets.d90 += remaining;
        else buckets.d90plus += remaining;
    }
    return buckets;
}

// ---------- Daily collections ----------
export async function getDailyCollections(schoolId, date) {
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end = new Date(date); end.setHours(23, 59, 59, 999);
    try {
        const q = query(
            collection(db, 'fee_transactions'),
            where('schoolId', '==', schoolId),
            where('type', '==', 'payment'),
            where('createdAt', '>=', start),
            where('createdAt', '<=', end)
        );
        const snap = await getDocs(q);
        const txns = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const total = txns.reduce((s, t) => s + (t.amount || 0), 0);
        const byMethod = txns.reduce((acc, t) => {
            acc[t.paymentMethod] = (acc[t.paymentMethod] || 0) + t.amount;
            return acc;
        }, {});
        return { total, count: txns.length, byMethod, transactions: txns };
    } catch (err) {
        const q = query(collection(db, 'fee_transactions'), where('schoolId', '==', schoolId));
        const snap = await getDocs(q);
        const txns = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => {
            if (t.type !== 'payment') return false;
            const d = t.createdAt?.toDate?.() || (t.createdAt ? new Date(t.createdAt) : null);
            return d && d >= start && d <= end;
        });
        const total = txns.reduce((s, t) => s + (t.amount || 0), 0);
        const byMethod = txns.reduce((acc, t) => {
            acc[t.paymentMethod] = (acc[t.paymentMethod] || 0) + t.amount;
            return acc;
        }, {});
        return { total, count: txns.length, byMethod, transactions: txns };
    }
}

// ---------- Term locking ----------
export async function isTermLocked(schoolId, term, year) {
    const id = `${slug(schoolId)}__${slug(term)}__${slug(year)}`;
    const snap = await getDoc(doc(db, 'term_locks', id));
    return snap.exists() && snap.data().locked === true;
}

export async function lockTerm(schoolId, term, year, performedBy, performedByName) {
    const id = `${slug(schoolId)}__${slug(term)}__${slug(year)}`;
    await setDoc(doc(db, 'term_locks', id), {
        schoolId, term, year: Number(year), locked: true,
        lockedBy: performedBy, lockedByName: performedByName, lockedAt: serverTimestamp()
    });
}

// ---------- Student lookup ----------
export async function findStudentByAdmission(schoolId, admissionNumber) {
    if (!admissionNumber) return null;
    const normalized = admissionNumber.trim().toUpperCase();
    for (const field of ['admissionNumber', 'studentId']) {
        const q = query(collection(db, 'students'),
            where('schoolId', '==', schoolId),
            where(field, '==', normalized), limit(1));
        const snap = await getDocs(q);
        if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
    }
    return null;
}

// ---------- School data ----------
export async function getSchoolData(schoolId) {
    const cacheKey = `school_${schoolId}`;
    const cached = getMemory(cacheKey);
    if (cached) return cached;
    const snap = await getDoc(doc(db, 'schools', schoolId));
    if (!snap.exists()) return null;
    const data = snap.data();
    setMemory(cacheKey, data, 30 * 60 * 1000);
    return data;
}

export async function getInvoiceSummary(schoolId, term, year) {
    const id = `${slug(schoolId)}__${slug(term)}__${slug(year)}`;
    const snap = await getDoc(doc(db, 'invoice_summaries', id));
    return snap.exists() ? snap.data() : null;
}
