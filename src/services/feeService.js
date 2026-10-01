// src/services/feeService.js
import {
    collection,
    query,
    where,
    getDocs,
    doc,
    getDoc,
    setDoc,
    limit,
    writeBatch,
    deleteDoc,
    updateDoc,
    serverTimestamp,
    runTransaction,
    increment,
    orderBy,
    startAfter,
    getCountFromServer
} from 'firebase/firestore';

import { db } from '../firebase';
import { getMemory, setMemory } from './cache';

// ---------- Tenant guard ----------

export function requireSchoolId(userData) {
    const schoolId = userData?.schoolId;

    if (!schoolId) {
        throw new Error('School context missing. Please re-login.');
    }

    return schoolId;
}

// ---------- Deterministic IDs ----------

const slug = (s) =>
    String(s)
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[/#$[\]]/g, '');

export function makeInvoiceId(
    schoolId,
    studentId,
    term,
    year,
    suffix = ''
) {
    return `${slug(schoolId)}__${slug(studentId)}__${slug(term)}__${slug(year)}${
        suffix ? '__' + slug(suffix) : ''
    }`;
}

export function makeBalanceId(studentId, term, year) {
    return `${slug(studentId)}__${slug(term)}__${slug(year)}`;
}

export function makeFeeStructureId(
    schoolId,
    targetKey,
    year,
    term = 'all'
) {
    return `${slug(schoolId)}__${slug(targetKey)}__${slug(year)}${
        term && term !== 'all' ? '__' + slug(term) : ''
    }`;
}

export function makeIdempotencyKey(
    schoolId,
    studentId,
    amount,
    date
) {
    return `${slug(schoolId)}__${slug(studentId)}__${slug(amount)}__${slug(
        date
    )}`;
}

// ============================================================================
// IDempotent transaction writer
// ============================================================================

export async function postTransaction(
    schoolId,
    txn,
    opts = {}
) {
    const idemKey =
        txn.idempotencyKey ||
        makeIdempotencyKey(
            schoolId,
            txn.studentId,
            txn.amount,
            txn.paymentDate ||
                new Date().toISOString().split('T')[0]
        );

    const txnRef = doc(
        db,
        'fee_transactions',
        idemKey
    );

    const balanceId = makeBalanceId(
        txn.studentId,
        txn.term,
        txn.year
    );

    const balanceRef = doc(
        db,
        'student_balances',
        balanceId
    );

    const res = await runTransaction(
        db,
        async (trx) => {
            const existing = await trx.get(txnRef);

            if (existing.exists()) {
                return {
                    id: idemKey,
                    alreadyExisted: true
                };
            }

            // ---------------------------------------------------------------
            // 1. Read balance
            // ---------------------------------------------------------------

            const balSnap = await trx.get(balanceRef);

            const current = balSnap.exists()
                ? balSnap.data()
                : {
                      studentId: txn.studentId,
                      studentName: txn.studentName,
                      admissionNumber: txn.admissionNumber,
                      studentClass: txn.class,
                      level: txn.level,
                      term: txn.term,
                      year: txn.year,
                      schoolId,

                      totalInvoiced: 0,
                      totalPaid: 0,
                      totalDiscount: 0,
                      totalWaived: 0,
                      balance: 0,

                      status: 'no_invoice',

                      updatedAt: serverTimestamp()
                  };

            const isPayment =
                txn.type === 'payment' &&
                (
                    txn.status === 'completed' ||
                    txn.status === 'success'
                );

            const isDiscount = txn.type === 'discount';
            const isWaiver = txn.type === 'waiver';
            const isRefund = txn.type === 'refund';

            let deltaPaid = 0;
            let deltaDiscount = 0;
            let deltaWaived = 0;

            if (isPayment) {
                deltaPaid = Number(txn.amount) || 0;
            }

            if (isRefund) {
                deltaPaid = -(Number(txn.amount) || 0);
            }

            if (isDiscount) {
                deltaDiscount = Number(txn.amount) || 0;
            }

            if (isWaiver) {
                deltaWaived = Number(txn.amount) || 0;
            }

            const totalInvoiced =
                Number(current.totalInvoiced) || 0;

            const totalPaid =
                (Number(current.totalPaid) || 0) +
                deltaPaid;

            const totalDiscount =
                (Number(current.totalDiscount) || 0) +
                deltaDiscount;

            const totalWaived =
                (Number(current.totalWaived) || 0) +
                deltaWaived;

            const balance =
                totalInvoiced -
                totalPaid -
                totalDiscount -
                totalWaived;

            let status = 'pending';

            if (totalInvoiced === 0) {
                status = 'no_invoice';
            } else if (balance <= 0) {
                status = 'paid';
            } else if (
                totalPaid +
                    totalDiscount +
                    totalWaived >
                0
            ) {
                status = 'partial';
            }

            // ---------------------------------------------------------------
            // 2. Write ledger transaction
            // ---------------------------------------------------------------

            trx.set(txnRef, {
                ...txn,

                schoolId,

                idempotencyKey: idemKey,

                createdAt: serverTimestamp(),

                voided: false,
                voidedAt: null,
                voidedBy: null,
                voidReason: null
            });

            // ---------------------------------------------------------------
            // 3. Update materialized balance
            // ---------------------------------------------------------------

            trx.set(
                balanceRef,
                {
                    ...current,

                    totalInvoiced,
                    totalPaid,
                    totalDiscount,
                    totalWaived,

                    balance,
                    status,

                    lastTransactionAt:
                        serverTimestamp(),

                    updatedAt:
                        serverTimestamp()
                },
                {
                    merge: true
                }
            );

            // ---------------------------------------------------------------
            // 4. Audit log
            // ---------------------------------------------------------------

            const auditRef = doc(
                collection(db, 'fee_audit_log')
            );

            trx.set(auditRef, {
                schoolId,

                action: 'POST_TRANSACTION',

                transactionId: idemKey,

                studentId: txn.studentId,

                amount: txn.amount,

                type: txn.type,

                performedBy:
                    opts.performedBy ||
                    txn.recordedBy ||
                    'system',

                performedByName:
                    opts.performedByName ||
                    txn.recordedByName ||
                    'System',

                timestamp: serverTimestamp(),

                ip: opts.ip || null
            });

            return {
                id: idemKey,
                alreadyExisted: false
            };
        }
    );

    if (!res.alreadyExisted) {
        await reconcileStudentBalance(
            schoolId,
            txn.studentId,
            txn.term,
            txn.year
        );
    }

    return res;
}

// ============================================================================
// Void transaction
// ============================================================================

export async function voidTransaction(
    schoolId,
    txnId,
    reason,
    performedBy,
    performedByName
) {
    const txnRef = doc(
        db,
        'fee_transactions',
        txnId
    );

    const txnSnap = await getDoc(txnRef);

    if (!txnSnap.exists()) {
        throw new Error('Transaction not found');
    }

    const txn = txnSnap.data();

    if (txn.voided) {
        throw new Error('Already voided');
    }

    const reversalIdem =
        `${txnId}__VOID__${Date.now()}`;

    await postTransaction(
        schoolId,
        {
            ...txn,

            amount: -Math.abs(
                Number(txn.amount) || 0
            ),

            type: 'reversal',

            description: `VOID: ${reason}`,

            reference: txn.reference,

            idempotencyKey: reversalIdem,

            recordedBy: performedBy,

            recordedByName: performedByName,

            reversalOf: txnId
        }
    );

    await updateDoc(txnRef, {
        voided: true,

        voidedAt: serverTimestamp(),

        voidedBy: performedBy,

        voidReason: reason
    });

    await reconcileStudentBalance(
        schoolId,
        txn.studentId,
        txn.term,
        txn.year
    );

    return {
        success: true
    };
}

// ============================================================================
// Students - cursor pagination
// ============================================================================

/**
 * Fetch one page of students from Firestore.
 *
 * IMPORTANT:
 * - Does not download the whole school.
 * - Does not use a hardcoded "1000 students" limit.
 * - Uses Firestore cursor pagination.
 * - pageSize is controlled by the caller/UI.
 *
 * Search is handled by FeeContext against the currently loaded page.
 *
 * If you later need true server-side contains-search across the entire
 * student database, add normalized searchable fields such as:
 *
 *   searchName
 *   searchAdmissionNumber
 *
 * and implement prefix queries against those fields.
 */
export async function getStudentsPage(
    schoolId,
    {
        level = '',
        cls = '',
        pageSize = 25,
        cursor = null
    } = {}
) {
    if (!schoolId) {
        throw new Error(
            'School context missing. Please re-login.'
        );
    }

    const safePageSize = Math.max(
        1,
        Math.floor(Number(pageSize) || 25)
    );

    const constraints = [
        where('schoolId', '==', schoolId)
    ];

    if (level) {
        constraints.push(
            where('level', '==', level)
        );
    }

    if (cls) {
        constraints.push(
            where('class', '==', cls)
        );
    }

    // Stable Firestore ordering for cursor pagination.
    constraints.push(orderBy('firstName'));

    if (cursor) {
        constraints.push(startAfter(cursor));
    }

    /*
     * Fetch one additional record solely to determine whether
     * another page exists.
     */
    const pageQuery = query(
        collection(db, 'students'),
        ...constraints,
        limit(safePageSize + 1)
    );

    const snap = await getDocs(pageQuery);

    const docs = snap.docs.slice(
        0,
        safePageSize
    );

    return {
        students: docs.map((studentDoc) => ({
            id: studentDoc.id,
            ...studentDoc.data()
        })),

        nextCursor:
            snap.docs.length > safePageSize
                ? docs[docs.length - 1] || null
                : null,

        hasNextPage:
            snap.docs.length > safePageSize,

        pageSize: safePageSize,

        firstDocument:
            docs[0] || null,

        lastDocument:
            docs[docs.length - 1] || null
    };
}

// ============================================================================
// Student count
// ============================================================================

/**
 * Count matching students without downloading student documents.
 *
 * Used by FeeContext to calculate:
 *
 *   Page 1 of N
 *
 * without loading the whole collection.
 */
export async function countStudents(
    schoolId,
    {
        level = '',
        cls = ''
    } = {}
) {
    if (!schoolId) {
        throw new Error(
            'School context missing. Please re-login.'
        );
    }

    const constraints = [
        where('schoolId', '==', schoolId)
    ];

    if (level) {
        constraints.push(
            where('level', '==', level)
        );
    }

    if (cls) {
        constraints.push(
            where('class', '==', cls)
        );
    }

    const countQuery = query(
        collection(db, 'students'),
        ...constraints
    );

    const snap =
        await getCountFromServer(countQuery);

    return snap.data().count;
}

// ============================================================================
// Backwards-compatible student helper
// ============================================================================

/**
 * Existing code can continue using getStudents().
 *
 * New code should use getStudentsPage() when it needs
 * cursor information.
 */
export async function getStudents(
    schoolId,
    {
        level = '',
        cls = '',
        pageSize = 25,
        cursor = null
    } = {}
) {
    const result = await getStudentsPage(
        schoolId,
        {
            level,
            cls,
            pageSize,
            cursor
        }
    );

    return result.students;
}

// ============================================================================
// Fee structures
// ============================================================================

export async function getFeeStructure(
    schoolId,
    targetKey,
    year,
    term = 'all'
) {
    const idWithTerm =
        makeFeeStructureId(
            schoolId,
            targetKey,
            year,
            term
        );

    const snapWithTerm = await getDoc(
        doc(
            db,
            'fee_structures',
            idWithTerm
        )
    );

    if (snapWithTerm.exists()) {
        return {
            id: idWithTerm,
            ...snapWithTerm.data()
        };
    }

    if (term && term !== 'all') {
        const idWithoutTerm =
            makeFeeStructureId(
                schoolId,
                targetKey,
                year,
                'all'
            );

        const snapWithoutTerm =
            await getDoc(
                doc(
                    db,
                    'fee_structures',
                    idWithoutTerm
                )
            );

        if (snapWithoutTerm.exists()) {
            return {
                id: idWithoutTerm,
                ...snapWithoutTerm.data()
            };
        }
    }

    return null;
}

export async function getFeeStructures(
    schoolId,
    {
        year,
        term
    } = {}
) {
    const constraints = [
        where('schoolId', '==', schoolId)
    ];

    if (year) {
        constraints.push(
            where(
                'year',
                '==',
                Number(year)
            )
        );
    }

    if (term && term !== 'all') {
        constraints.push(
            where(
                'term',
                '==',
                term
            )
        );
    }

    try {
        const q = query(
            collection(
                db,
                'fee_structures'
            ),
            ...constraints,
            limit(100)
        );

        const snap = await getDocs(q);

        return snap.docs.map((d) => ({
            id: d.id,
            ...d.data()
        }));
    } catch (err) {
        console.warn(
            'getFeeStructures fallback:',
            err
        );

        const q = query(
            collection(
                db,
                'fee_structures'
            ),
            where(
                'schoolId',
                '==',
                schoolId
            ),
            limit(100)
        );

        const snap = await getDocs(q);

        let list = snap.docs.map((d) => ({
            id: d.id,
            ...d.data()
        }));

        if (year) {
            list = list.filter(
                (s) =>
                    Number(s.year) ===
                    Number(year)
            );
        }

        if (
            term &&
            term !== 'all'
        ) {
            list = list.filter(
                (s) =>
                    s.term === term
            );
        }

        return list;
    }
}

export async function upsertFeeStructure(
    schoolId,
    targetKey,
    year,
    structure,
    meta = {},
    term = 'all'
) {
    const id =
        makeFeeStructureId(
            schoolId,
            targetKey,
            year,
            term
        );

    const items =
        (structure.items || []).map(
            (i) => ({
                description:
                    i.description || '',

                category:
                    i.category ||
                    'Tuition',

                amount:
                    Number(i.amount) || 0,

                optional:
                    Boolean(i.optional)
            })
        );

    const totalAmount =
        items.reduce(
            (sum, item) =>
                sum + item.amount,
            0
        );

    const mandatoryAmount =
        items
            .filter(
                (item) => !item.optional
            )
            .reduce(
                (sum, item) =>
                    sum + item.amount,
                0
            );

    const optionalAmount =
        items
            .filter(
                (item) => item.optional
            )
            .reduce(
                (sum, item) =>
                    sum + item.amount,
                0
            );

    await setDoc(
        doc(
            db,
            'fee_structures',
            id
        ),
        {
            schoolId,

            targetKey,

            targetType:
                structure.targetType ||
                'level',

            level:
                structure.level ||
                (
                    structure.targetType ===
                    'level'
                        ? targetKey
                        : null
                ),

            className:
                structure.className ||
                (
                    structure.targetType ===
                    'class'
                        ? targetKey
                        : null
                ),

            name:
                structure.name ||
                targetKey,

            term:
                term ||
                structure.term ||
                'all',

            year:
                Number(year),

            items,

            totalAmount,

            mandatoryAmount,

            optionalAmount,

            updatedBy:
                meta.updatedBy || '',

            updatedByName:
                meta.updatedByName ||
                'System',

            updatedAt:
                serverTimestamp()
        },
        {
            merge: true
        }
    );

    return {
        id,
        totalAmount,
        mandatoryAmount,
        optionalAmount
    };
}

export async function deleteFeeStructure(
    schoolId,
    id
) {
    const ref = doc(
        db,
        'fee_structures',
        id
    );

    const snap = await getDoc(ref);

    if (!snap.exists()) {
        return {
            success: true
        };
    }

    if (
        snap.data().schoolId !==
        schoolId
    ) {
        throw new Error(
            'Unauthorized to delete this fee structure'
        );
    }

    await deleteDoc(ref);

    return {
        success: true
    };
}

// ============================================================================
// Authoritative balance reconciliation
// ============================================================================

export async function reconcileStudentBalance(
    schoolId,
    studentId,
    term,
    year
) {
    const balanceId =
        makeBalanceId(
            studentId,
            term,
            year
        );

    const balanceRef =
        doc(
            db,
            'student_balances',
            balanceId
        );

    // ------------------------------------------------------------------------
    // Read invoices
    // ------------------------------------------------------------------------

    let invSnap;

    try {
        invSnap = await getDocs(
            query(
                collection(
                    db,
                    'invoices'
                ),
                where(
                    'schoolId',
                    '==',
                    schoolId
                ),
                where(
                    'studentId',
                    '==',
                    studentId
                ),
                where(
                    'term',
                    '==',
                    term
                ),
                where(
                    'academicYear',
                    '==',
                    String(year)
                )
            )
        );
    } catch (error) {
        if (
            error.code !==
            'failed-precondition'
        ) {
            throw error;
        }

        console.warn(
            'Invoice reconciliation is using a school-scoped fallback query; deploy the invoices composite index for faster reconciliation.'
        );

        invSnap = await getDocs(
            query(
                collection(
                    db,
                    'invoices'
                ),
                where(
                    'schoolId',
                    '==',
                    schoolId
                )
            )
        );
    }

    const activeInvoices =
        invSnap.docs
            .map((d) => ({
                id: d.id,
                ref: d.ref,
                ...d.data()
            }))
            .filter(
                (invoice) =>
                    invoice.studentId ===
                        studentId &&
                    invoice.term === term &&
                    String(
                        invoice.academicYear
                    ) === String(year) &&
                    invoice.status !==
                        'cancelled'
            );

    activeInvoices.sort(
        (a, b) => {
            const da =
                a.createdAt?.toDate?.() ||
                (
                    a.createdAt
                        ? new Date(
                              a.createdAt
                          )
                        : 0
                );

            const dbDate =
                b.createdAt?.toDate?.() ||
                (
                    b.createdAt
                        ? new Date(
                              b.createdAt
                          )
                        : 0
                );

            return da - dbDate;
        }
    );

    const totalInvoiced =
        activeInvoices.reduce(
            (sum, invoice) =>
                sum +
                (
                    Number(
                        invoice.total
                    ) || 0
                ),
            0
        );

    // ------------------------------------------------------------------------
    // Read transactions
    // ------------------------------------------------------------------------

    let txnSnap;

    try {
        txnSnap = await getDocs(
            query(
                collection(
                    db,
                    'fee_transactions'
                ),
                where(
                    'schoolId',
                    '==',
                    schoolId
                ),
                where(
                    'studentId',
                    '==',
                    studentId
                ),
                where(
                    'term',
                    '==',
                    term
                ),
                where(
                    'year',
                    '==',
                    Number(year)
                )
            )
        );
    } catch (error) {
        if (
            error.code !==
            'failed-precondition'
        ) {
            throw error;
        }

        console.warn(
            'Transaction reconciliation is using a school-scoped fallback query; deploy the fee transactions composite index for faster reconciliation.'
        );

        txnSnap = await getDocs(
            query(
                collection(
                    db,
                    'fee_transactions'
                ),
                where(
                    'schoolId',
                    '==',
                    schoolId
                )
            )
        );
    }

    const activeTxns =
        txnSnap.docs
            .map((d) => d.data())
            .filter(
                (transaction) =>
                    transaction.studentId ===
                        studentId &&
                    transaction.term === term &&
                    Number(
                        transaction.year
                    ) === Number(year) &&
                    !transaction.voided
            );

    let totalPaid = 0;
    let totalDiscount = 0;
    let totalWaived = 0;

    for (const transaction of activeTxns) {
        const amount =
            Number(
                transaction.amount
            ) || 0;

        if (
            transaction.type ===
                'payment' &&
            (
                transaction.status ===
                    'completed' ||
                transaction.status ===
                    'success'
            )
        ) {
            totalPaid += amount;
        } else if (
            transaction.type ===
            'refund'
        ) {
            totalPaid -= amount;
        } else if (
            transaction.type ===
            'discount'
        ) {
            totalDiscount += amount;
        } else if (
            transaction.type ===
            'waiver'
        ) {
            totalWaived += amount;
        } else if (
            transaction.type ===
            'reversal'
        ) {
            totalPaid += amount;
        }
    }

    // ------------------------------------------------------------------------
    // FIFO allocation
    // ------------------------------------------------------------------------

    let remainingPool =
        totalPaid;

    const batch =
        writeBatch(db);

    for (const invoice of activeInvoices) {
        const invoiceTotal =
            Number(
                invoice.total
            ) || 0;

        const paidForInvoice =
            Math.max(
                0,
                Math.min(
                    remainingPool,
                    invoiceTotal
                )
            );

        remainingPool -=
            paidForInvoice;

        const remainingBalance =
            Math.max(
                0,
                invoiceTotal -
                    paidForInvoice
            );

        const invoiceStatus =
            remainingBalance <= 0 &&
            invoiceTotal > 0
                ? 'paid'
                : paidForInvoice > 0
                    ? 'partial'
                    : 'pending';

        batch.update(
            invoice.ref,
            {
                paidAmount:
                    paidForInvoice,

                remainingBalance,

                status:
                    invoiceStatus,

                updatedAt:
                    serverTimestamp(),

                ...(invoiceStatus ===
                    'paid' &&
                !invoice.paidAt
                    ? {
                          paidAt:
                              serverTimestamp()
                      }
                    : {})
            }
        );
    }

    await batch.commit();

    const balance =
        totalInvoiced -
        totalPaid -
        totalDiscount -
        totalWaived;

    let status = 'pending';

    if (totalInvoiced === 0) {
        status = 'no_invoice';
    } else if (balance <= 0) {
        status = 'paid';
    } else if (
        totalPaid +
            totalDiscount +
            totalWaived >
        0
    ) {
        status = 'partial';
    }

    const updatedData = {
        schoolId,

        studentId,

        term,

        year: Number(year),

        totalInvoiced,

        totalPaid,

        totalDiscount,

        totalWaived,

        balance,

        status,

        lastReconciledAt:
            serverTimestamp(),

        updatedAt:
            serverTimestamp()
    };

    await setDoc(
        balanceRef,
        updatedData,
        {
            merge: true
        }
    );

    return {
        id: balanceId,
        ...updatedData
    };
}

// ============================================================================
// Invoices
// ============================================================================

export async function createInvoicesBatch(
    schoolId,
    entries,
    meta
) {
    if (!entries?.length) {
        return {
            count: 0
        };
    }

    /*
     * 250 is deliberately retained here because this is a Firestore
     * write-batch safety boundary, not a UI pagination limit.
     */
    if (entries.length > 250) {
        const stamp = Date.now();

        const prepared =
            entries.map(
                (entry, index) => ({
                    ...entry,

                    suffix:
                        entry.suffix ||
                        `${stamp}_${index}`
                })
            );

        let count = 0;

        for (
            let index = 0;
            index < prepared.length;
            index += 250
        ) {
            const result =
                await createInvoicesBatch(
                    schoolId,
                    prepared.slice(
                        index,
                        index + 250
                    ),
                    meta
                );

            count += result.count;
        }

        return {
            count
        };
    }

    const preparedEntries =
        entries.map(
            (entry, index) => ({
                ...entry,

                suffix:
                    entry.suffix ||
                    `${Date.now()}_${index}`
            })
        );

    const batch =
        writeBatch(db);

    for (
        let index = 0;
        index <
        preparedEntries.length;
        index++
    ) {
        const entry =
            preparedEntries[index];

        const ref =
            doc(
                db,
                'invoices',
                makeInvoiceId(
                    schoolId,
                    entry.studentId,
                    entry.term,
                    entry.academicYear,
                    entry.suffix
                )
            );

        batch.set(
            ref,
            {
                invoiceNumber:
                    entry.invoiceNumber,

                studentId:
                    entry.studentId,

                studentName:
                    entry.studentName,

                studentClass:
                    entry.studentClass,

                studentLevel:
                    entry.studentLevel,

                admissionNumber:
                    entry.admissionNumber,

                items:
                    (
                        entry.items ||
                        []
                    ).map(
                        (item) => ({
                            description:
                                item.description ||
                                '',

                            amount:
                                item.amount ||
                                0,

                            quantity:
                                item.quantity ||
                                1,

                            unitPrice:
                                item.unitPrice ||
                                item.amount ||
                                0
                        })
                    ),

                subtotal:
                    entry.subtotal ||
                    0,

                tax:
                    entry.tax ||
                    0,

                discount:
                    entry.discount ||
                    0,

                total:
                    entry.total ||
                    0,

                paidAmount: 0,

                remainingBalance:
                    entry.total ||
                    0,

                term:
                    entry.term,

                academicYear:
                    String(
                        entry.academicYear
                    ),

                dueDate:
                    entry.dueDate,

                status:
                    'pending',

                notes:
                    entry.notes ||
                    '',

                payments: [],

                schoolId,

                createdBy:
                    meta.createdBy ||
                    '',

                createdByName:
                    meta.createdByName ||
                    '',

                createdAt:
                    serverTimestamp(),

                updatedAt:
                    serverTimestamp()
            },
            {
                merge: true
            }
        );
    }

    const newInvoiceTotals =
        new Map();

    preparedEntries.forEach(
        (entry) => {
            const key =
                JSON.stringify([
                    entry.studentId,
                    entry.term,
                    entry.academicYear
                ]);

            const current =
                newInvoiceTotals.get(
                    key
                ) || {
                    entry,
                    amount: 0
                };

            current.amount +=
                Number(
                    entry.total
                ) || 0;

            newInvoiceTotals.set(
                key,
                current
            );
        }
    );

    if (newInvoiceTotals.size) {
        const balanceEntries =
            [
                ...newInvoiceTotals.values()
            ];

        balanceEntries.forEach(
            ({
                entry,
                amount
            }) => {
                const balanceRef =
                    doc(
                        db,
                        'student_balances',
                        makeBalanceId(
                            entry.studentId,
                            entry.term,
                            entry.academicYear
                        )
                    );

                batch.set(
                    balanceRef,
                    {
                        schoolId,

                        studentId:
                            entry.studentId,

                        studentName:
                            entry.studentName ||
                            '',

                        admissionNumber:
                            entry.admissionNumber ||
                            '',

                        studentClass:
                            entry.studentClass ||
                            '',

                        level:
                            entry.studentLevel ||
                            '',

                        term:
                            entry.term,

                        year:
                            Number(
                                entry.academicYear
                            ),

                        totalInvoiced:
                            increment(
                                amount
                            ),

                        balance:
                            increment(
                                amount
                            ),

                        status:
                            'pending',

                        updatedAt:
                            serverTimestamp(),

                        lastReconciledAt:
                            serverTimestamp()
                    },
                    {
                        merge: true
                    }
                );
            }
        );
    }

    await batch.commit();

    setMemory(
        `inv_${schoolId}_all_all_all_all`,
        null,
        0
    );

    return {
        count:
            preparedEntries.length
    };
}

export async function cancelInvoice(
    schoolId,
    invoiceId,
    reason,
    performedBy,
    performedByName
) {
    const invRef =
        doc(
            db,
            'invoices',
            invoiceId
        );

    const invSnap =
        await getDoc(invRef);

    if (!invSnap.exists()) {
        throw new Error(
            'Invoice not found'
        );
    }

    const invoice =
        invSnap.data();

    if (
        invoice.status ===
        'cancelled'
    ) {
        throw new Error(
            'Invoice already cancelled'
        );
    }

    await updateDoc(
        invRef,
        {
            status:
                'cancelled',

            cancelledAt:
                serverTimestamp(),

            cancelledBy:
                performedBy,

            cancelledByName:
                performedByName,

            cancelReason:
                reason,

            updatedAt:
                serverTimestamp()
        }
    );

    await reconcileStudentBalance(
        schoolId,
        invoice.studentId,
        invoice.term,
        invoice.academicYear
    );

    return {
        success: true
    };
}

// ============================================================================
// Invoice queries
// ============================================================================

export async function getInvoices(
    schoolId,
    {
        term,
        year,
        status,
        studentId,
        maxResults = 500
    } = {}
) {
    const constraints = [
        where(
            'schoolId',
            '==',
            schoolId
        )
    ];

    if (term) {
        constraints.push(
            where(
                'term',
                '==',
                term
            )
        );
    }

    if (year) {
        constraints.push(
            where(
                'academicYear',
                '==',
                String(year)
            )
        );
    }

    if (status) {
        constraints.push(
            where(
                'status',
                '==',
                status
            )
        );
    }

    if (studentId) {
        constraints.push(
            where(
                'studentId',
                '==',
                studentId
            )
        );
    }

    try {
        const q = query(
            collection(
                db,
                'invoices'
            ),
            ...constraints,
            limit(maxResults)
        );

        const snap =
            await getDocs(q);

        const list =
            snap.docs.map(
                (d) => ({
                    id: d.id,
                    ...d.data()
                })
            );

        return list.sort(
            (a, b) => {
                const da =
                    a.createdAt?.toDate?.() ||
                    (
                        a.createdAt
                            ? new Date(
                                  a.createdAt
                              )
                            : 0
                    );

                const dbDate =
                    b.createdAt?.toDate?.() ||
                    (
                        b.createdAt
                            ? new Date(
                                  b.createdAt
                              )
                            : 0
                    );

                return dbDate - da;
            }
        );
    } catch (err) {
        console.warn(
            'getInvoices query fallback:',
            err
        );

        const q = query(
            collection(
                db,
                'invoices'
            ),
            where(
                'schoolId',
                '==',
                schoolId
            ),
            limit(maxResults)
        );

        const snap =
            await getDocs(q);

        let list =
            snap.docs.map(
                (d) => ({
                    id: d.id,
                    ...d.data()
                })
            );

        if (term) {
            list =
                list.filter(
                    (invoice) =>
                        invoice.term ===
                        term
                );
        }

        if (year) {
            list =
                list.filter(
                    (invoice) =>
                        String(
                            invoice.academicYear
                        ) ===
                        String(year)
                );
        }

        if (status) {
            list =
                list.filter(
                    (invoice) =>
                        invoice.status ===
                        status
                );
        }

        if (studentId) {
            list =
                list.filter(
                    (invoice) =>
                        invoice.studentId ===
                        studentId
                );
        }

        return list.sort(
            (a, b) => {
                const da =
                    a.createdAt?.toDate?.() ||
                    (
                        a.createdAt
                            ? new Date(
                                  a.createdAt
                              )
                            : 0
                    );

                const dbDate =
                    b.createdAt?.toDate?.() ||
                    (
                        b.createdAt
                            ? new Date(
                                  b.createdAt
                              )
                            : 0
                    );

                return dbDate - da;
            }
        );
    }
}

// ============================================================================
// Fee transactions
// ============================================================================

export async function getFeeTransactions(
    schoolId,
    {
        term,
        year,
        studentId,
        maxResults = 500
    } = {}
) {
    const constraints = [
        where(
            'schoolId',
            '==',
            schoolId
        )
    ];

    if (term) {
        constraints.push(
            where(
                'term',
                '==',
                term
            )
        );
    }

    if (year) {
        constraints.push(
            where(
                'year',
                '==',
                Number(year)
            )
        );
    }

    if (studentId) {
        constraints.push(
            where(
                'studentId',
                '==',
                studentId
            )
        );
    }

    try {
        const q = query(
            collection(
                db,
                'fee_transactions'
            ),
            ...constraints,
            limit(maxResults)
        );

        const snap =
            await getDocs(q);

        const list =
            snap.docs.map(
                (d) => ({
                    id: d.id,
                    ...d.data()
                })
            );

        return list.sort(
            (a, b) => {
                const da =
                    a.createdAt?.toDate?.() ||
                    (
                        a.createdAt
                            ? new Date(
                                  a.createdAt
                              )
                            : 0
                    );

                const dbDate =
                    b.createdAt?.toDate?.() ||
                    (
                        b.createdAt
                            ? new Date(
                                  b.createdAt
                              )
                            : 0
                    );

                return dbDate - da;
            }
        );
    } catch (err) {
        console.warn(
            'getFeeTransactions fallback:',
            err
        );

        const q = query(
            collection(
                db,
                'fee_transactions'
            ),
            where(
                'schoolId',
                '==',
                schoolId
            ),
            limit(maxResults)
        );

        const snap =
            await getDocs(q);

        let list =
            snap.docs.map(
                (d) => ({
                    id: d.id,
                    ...d.data()
                })
            );

        if (term) {
            list =
                list.filter(
                    (transaction) =>
                        transaction.term ===
                        term
                );
        }

        if (year) {
            list =
                list.filter(
                    (transaction) =>
                        Number(
                            transaction.year
                        ) ===
                        Number(year)
                );
        }

        if (studentId) {
            list =
                list.filter(
                    (transaction) =>
                        transaction.studentId ===
                        studentId
                );
        }

        return list.sort(
            (a, b) => {
                const da =
                    a.createdAt?.toDate?.() ||
                    (
                        a.createdAt
                            ? new Date(
                                  a.createdAt
                              )
                            : 0
                    );

                const dbDate =
                    b.createdAt?.toDate?.() ||
                    (
                        b.createdAt
                            ? new Date(
                                  b.createdAt
                              )
                            : 0
                    );

                return dbDate - da;
            }
        );
    }
}

// ============================================================================
// Student balance
// ============================================================================

export async function getStudentBalance(
    studentId,
    term,
    year
) {
    const id =
        makeBalanceId(
            studentId,
            term,
            year
        );

    const snap =
        await getDoc(
            doc(
                db,
                'student_balances',
                id
            )
        );

    return snap.exists()
        ? {
              id,
              ...snap.data()
          }
        : null;
}

// ============================================================================
// School balances
// ============================================================================

export async function getBalancesForSchool(
    schoolId,
    term,
    year,
    {
        level,
        cls,
        maxResults = 1000
    } = {}
) {
    const constraints = [
        where(
            'schoolId',
            '==',
            schoolId
        )
    ];

    if (term) {
        constraints.push(
            where(
                'term',
                '==',
                term
            )
        );
    }

    if (year) {
        constraints.push(
            where(
                'year',
                '==',
                Number(year)
            )
        );
    }

    if (level) {
        constraints.push(
            where(
                'level',
                '==',
                level
            )
        );
    }

    if (cls) {
        constraints.push(
            where(
                'studentClass',
                '==',
                cls
            )
        );
    }

    try {
        const q = query(
            collection(
                db,
                'student_balances'
            ),
            ...constraints,
            limit(maxResults)
        );

        const snap =
            await getDocs(q);

        const list =
            snap.docs.map(
                (d) => ({
                    id: d.id,
                    ...d.data()
                })
            );

        return list.sort(
            (a, b) =>
                (
                    a.studentName ||
                    ''
                ).localeCompare(
                    b.studentName ||
                    ''
                )
        );
    } catch (err) {
        console.warn(
            'getBalancesForSchool fallback:',
            err
        );

        const q = query(
            collection(
                db,
                'student_balances'
            ),
            where(
                'schoolId',
                '==',
                schoolId
            ),
            limit(maxResults)
        );

        const snap =
            await getDocs(q);

        let list =
            snap.docs.map(
                (d) => ({
                    id: d.id,
                    ...d.data()
                })
            );

        if (term) {
            list =
                list.filter(
                    (balance) =>
                        balance.term ===
                        term
                );
        }

        if (year) {
            list =
                list.filter(
                    (balance) =>
                        Number(
                            balance.year
                        ) ===
                        Number(year)
                );
        }

        if (level) {
            list =
                list.filter(
                    (balance) =>
                        balance.level ===
                        level
                );
        }

        if (cls) {
            list =
                list.filter(
                    (balance) =>
                        balance.studentClass ===
                        cls
                );
        }

        return list.sort(
            (a, b) =>
                (
                    a.studentName ||
                    ''
                ).localeCompare(
                    b.studentName ||
                    ''
                )
        );
    }
}

// ============================================================================
// Aging report
// ============================================================================

export function computeAging(
    invoices,
    asOf = new Date()
) {
    const buckets = {
        current: 0,
        d30: 0,
        d60: 0,
        d90: 0,
        d90plus: 0
    };

    for (const invoice of invoices) {
        if (
            invoice.status === 'paid' ||
            invoice.status === 'cancelled'
        ) {
            continue;
        }

        const due = invoice.dueDate
            ? new Date(
                  invoice.dueDate
              )
            : null;

        const remaining =
            invoice.remainingBalance ||
            (
                invoice.total -
                (
                    invoice.paidAmount ||
                    0
                )
            );

        if (
            !due ||
            due >= asOf
        ) {
            buckets.current +=
                remaining;

            continue;
        }

        const days = Math.floor(
            (
                asOf - due
            ) /
                86400000
        );

        if (days <= 30) {
            buckets.d30 +=
                remaining;
        } else if (days <= 60) {
            buckets.d60 +=
                remaining;
        } else if (days <= 90) {
            buckets.d90 +=
                remaining;
        } else {
            buckets.d90plus +=
                remaining;
        }
    }

    return buckets;
}

// ============================================================================
// Daily collections
// ============================================================================

export async function getDailyCollections(
    schoolId,
    date
) {
    const start =
        new Date(date);

    start.setHours(
        0,
        0,
        0,
        0
    );

    const end =
        new Date(date);

    end.setHours(
        23,
        59,
        59,
        999
    );

    try {
        const q = query(
            collection(
                db,
                'fee_transactions'
            ),
            where(
                'schoolId',
                '==',
                schoolId
            ),
            where(
                'type',
                '==',
                'payment'
            ),
            where(
                'createdAt',
                '>=',
                start
            ),
            where(
                'createdAt',
                '<=',
                end
            )
        );

        const snap =
            await getDocs(q);

        const txns =
            snap.docs
                .map(
                    (d) => ({
                        id: d.id,
                        ...d.data()
                    })
                )
                .sort(
                    (a, b) =>
                        (
                            b.createdAt
                                ?.toDate?.() ||
                            new Date(
                                b.createdAt
                            )
                        ) -
                        (
                            a.createdAt
                                ?.toDate?.() ||
                            new Date(
                                a.createdAt
                            )
                        )
                );

        const total =
            txns.reduce(
                (sum, transaction) =>
                    sum +
                    (
                        Number(
                            transaction.amount
                        ) || 0
                    ),
                0
            );

        const byMethod =
            txns.reduce(
                (acc, transaction) => {
                    const method =
                        transaction.paymentMethod ||
                        'unknown';

                    acc[method] =
                        (
                            acc[method] ||
                            0
                        ) +
                        (
                            Number(
                                transaction.amount
                            ) || 0
                        );

                    return acc;
                },
                {}
            );

        return {
            total,
            count: txns.length,
            byMethod,
            transactions: txns
        };
    } catch (err) {
        console.warn(
            'getDailyCollections fallback:',
            err
        );

        const q = query(
            collection(
                db,
                'fee_transactions'
            ),
            where(
                'schoolId',
                '==',
                schoolId
            )
        );

        const snap =
            await getDocs(q);

        const txns =
            snap.docs
                .map(
                    (d) => ({
                        id: d.id,
                        ...d.data()
                    })
                )
                .filter(
                    (transaction) => {
                        if (
                            transaction.type !==
                            'payment'
                        ) {
                            return false;
                        }

                        const transactionDate =
                            transaction.createdAt
                                ?.toDate?.() ||
                            (
                                transaction.createdAt
                                    ? new Date(
                                          transaction.createdAt
                                      )
                                    : null
                            );

                        return (
                            transactionDate &&
                            transactionDate >=
                                start &&
                            transactionDate <=
                                end
                        );
                    }
                )
                .sort(
                    (a, b) =>
                        (
                            b.createdAt
                                ?.toDate?.() ||
                            new Date(
                                b.createdAt
                            )
                        ) -
                        (
                            a.createdAt
                                ?.toDate?.() ||
                            new Date(
                                a.createdAt
                            )
                        )
                );

        const total =
            txns.reduce(
                (sum, transaction) =>
                    sum +
                    (
                        Number(
                            transaction.amount
                        ) || 0
                    ),
                0
            );

        const byMethod =
            txns.reduce(
                (acc, transaction) => {
                    const method =
                        transaction.paymentMethod ||
                        'unknown';

                    acc[method] =
                        (
                            acc[method] ||
                            0
                        ) +
                        (
                            Number(
                                transaction.amount
                            ) || 0
                        );

                    return acc;
                },
                {}
            );

        return {
            total,
            count: txns.length,
            byMethod,
            transactions: txns
        };
    }
}

// ============================================================================
// Term locking
// ============================================================================

export async function isTermLocked(
    schoolId,
    term,
    year
) {
    const id =
        `${slug(schoolId)}__${slug(term)}__${slug(year)}`;

    const snap =
        await getDoc(
            doc(
                db,
                'term_locks',
                id
            )
        );

    return (
        snap.exists() &&
        snap.data().locked === true
    );
}

export async function lockTerm(
    schoolId,
    term,
    year,
    performedBy,
    performedByName
) {
    const id =
        `${slug(schoolId)}__${slug(term)}__${slug(year)}`;

    await setDoc(
        doc(
            db,
            'term_locks',
            id
        ),
        {
            schoolId,

            term,

            year:
                Number(year),

            locked: true,

            lockedBy:
                performedBy,

            lockedByName:
                performedByName,

            lockedAt:
                serverTimestamp()
        }
    );
}

// ============================================================================
// Student lookup
// ============================================================================

export async function findStudentByAdmission(
    schoolId,
    admissionNumber
) {
    if (!admissionNumber) {
        return null;
    }

    const normalized =
        admissionNumber
            .trim()
            .toUpperCase();

    for (
        const field of [
            'admissionNumber',
            'studentId'
        ]
    ) {
        const q = query(
            collection(
                db,
                'students'
            ),
            where(
                'schoolId',
                '==',
                schoolId
            ),
            where(
                field,
                '==',
                normalized
            ),
            limit(1)
        );

        const snap =
            await getDocs(q);

        if (!snap.empty) {
            return {
                id:
                    snap.docs[0].id,
                ...snap.docs[0].data()
            };
        }
    }

    return null;
}

// ============================================================================
// School data
// ============================================================================

export async function getSchoolData(
    schoolId
) {
    const cacheKey =
        `school_${schoolId}`;

    const cached =
        getMemory(cacheKey);

    if (cached) {
        return cached;
    }

    const snap =
        await getDoc(
            doc(
                db,
                'schools',
                schoolId
            )
        );

    if (!snap.exists()) {
        return null;
    }

    const data =
        snap.data();

    setMemory(
        cacheKey,
        data,
        30 * 60 * 1000
    );

    return data;
}

// ============================================================================
// Invoice summary
// ============================================================================

export async function getInvoiceSummary(
    schoolId,
    term,
    year
) {
    const id =
        `${slug(schoolId)}__${slug(term)}__${slug(year)}`;

    const snap =
        await getDoc(
            doc(
                db,
                'invoice_summaries',
                id
            )
        );

    return snap.exists()
        ? snap.data()
        : null;
}
