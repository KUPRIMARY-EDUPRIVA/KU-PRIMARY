// src/services/mpesaReconciliationService.js
import { db } from '../firebase';
import {
  collection, query, where, orderBy, limit, getDocs,
  doc, updateDoc, serverTimestamp, addDoc, writeBatch,
} from 'firebase/firestore';

/**
 * Reconciliation categories we surface in the UI. Each maps to a
 * specific Firestore collection and a set of actions.
 */
export const RECON_TYPES = Object.freeze({
  ORPHAN: 'orphan',       // success callback we couldn't route to a student
  ERROR:  'error',        // callback handler crashed before processing
  STUCK:  'stuck',        // pending txn never got a callback
});

/* ============================================================
   Reads
   ============================================================ */

export async function listOrphans(schoolId, { max = 200 } = {}) {
  if (!schoolId) return [];
  const q = query(
    collection(db, 'mpesa_orphan_callbacks'),
    where('schoolId', '==', schoolId),
    orderBy('receivedAt', 'desc'),
    limit(max)
  );
  try {
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, _type: RECON_TYPES.ORPHAN, ...d.data() }));
  } catch (err) {
    // Missing composite index? Fall back to unordered fetch.
    if (!/index/i.test(err?.message || '') && err?.code !== 'failed-precondition') throw err;
    const fallback = await getDocs(query(
      collection(db, 'mpesa_orphan_callbacks'),
      where('schoolId', '==', schoolId),
      limit(max)
    ));
    return fallback.docs
      .map((d) => ({ id: d.id, _type: RECON_TYPES.ORPHAN, ...d.data() }))
      .sort((a, b) => millisOf(b.receivedAt) - millisOf(a.receivedAt));
  }
}

export async function listErrors(schoolId, { max = 200 } = {}) {
  if (!schoolId) return [];
  // mpesa_callback_errors may not carry schoolId — we still scope by it
  // when present and fall back to a global recent-errors list otherwise.
  const q = query(
    collection(db, 'mpesa_callback_errors'),
    where('schoolId', '==', schoolId),
    orderBy('receivedAt', 'desc'),
    limit(max)
  );
  try {
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, _type: RECON_TYPES.ERROR, ...d.data() }));
  } catch {
    const fallback = await getDocs(query(
      collection(db, 'mpesa_callback_errors'),
      limit(max)
    ));
    return fallback.docs
      .map((d) => ({ id: d.id, _type: RECON_TYPES.ERROR, ...d.data() }))
      .sort((a, b) => millisOf(b.receivedAt) - millisOf(a.receivedAt));
  }
}

export async function listStuck(schoolId, { olderThanMinutes = 15, max = 200 } = {}) {
  if (!schoolId) return [];
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  const q = query(
    collection(db, 'mpesa_pending_transactions'),
    where('schoolId', '==', schoolId),
    where('status', '==', 'pending'),
    limit(max)
  );
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, _type: RECON_TYPES.STUCK, ...d.data() }))
    .filter((d) => {
      const ts = d.createdAt?.toMillis?.() ?? millisOf(d.createdAt);
      return ts > 0 && ts < cutoff.getTime();
    })
    .sort((a, b) => millisOf(b.createdAt) - millisOf(a.createdAt));
}

export async function listAll(schoolId, opts = {}) {
  const [orphans, errors, stuck] = await Promise.all([
    listOrphans(schoolId, opts),
    listErrors(schoolId, opts),
    listStuck(schoolId, opts),
  ]);
  return { orphans, errors, stuck };
}

/* ============================================================
   Resolution actions
   ============================================================ */

/**
 * Resolve an orphan callback by manually crediting the payment to a
 * specific student + term + year. This uses the same ledger primitives
 * the live callback would have used, so downstream reports are consistent.
 */
export async function resolveOrphan({
  orphan,
  schoolId,
  studentId,
  studentName = '',
  admissionNumber = '',
  studentClass = '',
  level = '',
  term,
  year,
  amount,
  userId,
  userName = '',
  note = '',
}) {
  if (!schoolId || !studentId || !term || !year || !amount) {
    throw new Error('Missing required fields for resolution');
  }

  const receiptNumber = orphan.receiptNumber || orphan.CheckoutRequestID || orphan.id;
  const deterministicTxnId = `MPESA_${orphan.CheckoutRequestID || orphan.id}`;
  const balanceId = `${slug(studentId)}__${slug(term)}__${slug(year)}`;
  const receiptDocId = `RCP_MPESA_${receiptNumber}`;

  const balRef = doc(db, 'student_balances', balanceId);
  const txnRef = doc(db, 'fee_transactions', deterministicTxnId);
  const receiptRef = doc(db, 'receipts', receiptDocId);
  const orphanRef = doc(db, 'mpesa_orphan_callbacks', orphan.id);
  const auditRef = doc(db, 'fee_audit_log', `AUDIT_MPESA_${orphan.CheckoutRequestID || orphan.id}_RESOLVED`);

  await db.runTransaction(async (trx) => {
    // 1. Ensure we haven't already resolved this orphan.
    const orphanSnap = await trx.get(orphanRef);
    if (orphanSnap.exists && orphanSnap.data()?.resolved) {
      throw new Error('Orphan has already been resolved');
    }

    // 2. Balance
    const balSnap = await trx.get(balRef);
    const curBal = balSnap.exists ? balSnap.data() : {
      studentId, studentName, admissionNumber, studentClass, level,
      term, year, schoolId,
      totalInvoiced: 0, totalPaid: 0, totalDiscount: 0, totalWaived: 0,
      balance: 0, status: 'no_invoice',
    };
    const totalInvoiced = curBal.totalInvoiced || 0;
    const totalPaid = (curBal.totalPaid || 0) + amount;
    const totalDiscount = curBal.totalDiscount || 0;
    const totalWaived = curBal.totalWaived || 0;
    const newBalance = totalInvoiced - totalPaid - totalDiscount - totalWaived;
    const balStatus =
      totalInvoiced === 0 ? 'no_invoice' :
      newBalance <= 0 ? 'paid' :
      totalPaid + totalDiscount + totalWaived > 0 ? 'partial' : 'pending';

    // 3. fee_transactions
    trx.set(txnRef, {
      idempotencyKey: deterministicTxnId,
      reference: receiptNumber,
      mpesaReceiptNumber: receiptNumber,
      schoolId, studentId, studentName, admissionNumber,
      class: studentClass, level,
      term, year,
      amount,
      type: 'payment',
      status: 'completed',
      paymentMethod: 'mpesa',
      source: 'mpesa_manual_reconciliation',
      checkoutRequestID: orphan.CheckoutRequestID || orphan.id,
      merchantRequestID: orphan.MerchantRequestID || '',
      phoneNumber: orphan.paidPhone || '',
      description: `Manual reconciliation${note ? ` — ${note}` : ''}`,
      actor: { uid: userId || 'admin', name: userName || 'Admin', source: 'mpesa_reconciliation' },
      recordedBy: userId || 'admin',
      recordedByName: userName || 'Admin',
      reconciled: true,
      reconciledAt: serverTimestamp(),
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    // 4. Balance
    trx.set(balRef, {
      ...curBal, schoolId, studentId, studentName, admissionNumber,
      studentClass, level, term, year,
      totalInvoiced, totalPaid, totalDiscount, totalWaived,
      balance: newBalance, status: balStatus,
      lastPaymentDate: new Date().toISOString().split('T')[0],
      lastPaymentAmount: amount,
      lastPaymentMethod: 'mpesa',
      lastTransactionId: deterministicTxnId,
      lastTransactionAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    // 5. Receipt
    trx.set(receiptRef, {
      receiptNumber: `RCP-${receiptNumber}`,
      schoolId, studentId, studentName, admissionNumber,
      studentClass, level,
      amount, paymentMethod: 'mpesa',
      reference: receiptNumber,
      mpesaReceiptNumber: receiptNumber,
      transactionId: deterministicTxnId,
      term, year,
      status: 'valid',
      issuedBy: userId || 'admin',
      issuedByName: userName || 'Admin',
      issuedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      reconciled: true,
    }, { merge: true });

    // 6. Audit
    trx.set(auditRef, {
      schoolId, action: 'MPESA_ORPHAN_RESOLVED',
      transactionId: deterministicTxnId,
      receiptNumber: `RCP-${receiptNumber}`,
      studentId, amount,
      previousBalance: curBal.balance || 0,
      newBalance,
      actor: { uid: userId || 'admin', name: userName || 'Admin', source: 'mpesa_reconciliation' },
      source: 'mpesa_reconciliation',
      status: 'completed',
      metadata: {
        orphanDocId: orphan.id,
        checkoutRequestId: orphan.CheckoutRequestID || orphan.id,
        note,
      },
      timestamp: serverTimestamp(),
    });

    // 7. Mark orphan resolved
    trx.update(orphanRef, {
      resolved: true,
      resolvedAt: serverTimestamp(),
      resolvedBy: userId || 'admin',
      resolvedByName: userName || 'Admin',
      resolvedStudentId: studentId,
      resolvedTerm: term,
      resolvedYear: year,
      resolutionNote: note || '',
    });
  });
}

/**
 * Mark an orphan as "ignored" — for cases where the amount never
 * reached the school (Safaricom-side reversal, duplicate delivery, etc.).
 */
export async function ignoreOrphan({ orphan, reason, userId, userName = '' }) {
  await updateDoc(doc(db, 'mpesa_orphan_callbacks', orphan.id), {
    ignored: true,
    ignoredAt: serverTimestamp(),
    ignoredBy: userId || 'admin',
    ignoredByName: userName || 'Admin',
    ignoredReason: reason || '',
  });
  await addDoc(collection(db, 'fee_audit_log'), {
    action: 'MPESA_ORPHAN_IGNORED',
    orphanDocId: orphan.id,
    actor: { uid: userId || 'admin', name: userName || 'Admin' },
    metadata: { reason: reason || '' },
    timestamp: serverTimestamp(),
  });
}

/**
 * Resolve a stuck pending txn by marking it as a timeout. Safe to
 * call repeatedly — the sweep function does the same thing on a timer.
 */
export async function markStuckAsTimeout({ pending, userId, userName = '' }) {
  const txnId = `MPESA_${pending.id}`;
  const batch = writeBatch(db);

  batch.set(doc(db, 'fee_transactions', txnId), {
    idempotencyKey: txnId,
    schoolId: pending.schoolId,
    studentId: pending.studentId || 'unknown',
    studentName: pending.studentName || '',
    admissionNumber: pending.admissionNumber || '',
    class: pending.class || '',
    level: pending.level || '',
    term: pending.term || 'Term 1',
    year: Number(pending.year) || new Date().getFullYear(),
    amount: pending.amount || 0,
    expectedAmount: pending.amount || 0,
    type: 'payment',
    status: 'timeout',
    paymentMethod: 'mpesa',
    source: 'mpesa_stk',
    checkoutRequestID: pending.id,
    phoneNumber: pending.phoneNumber || '',
    mpesaResultCode: 'SWEEP',
    mpesaResultDesc: 'No callback received within timeout window',
    failedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });

  batch.update(doc(db, 'mpesa_pending_transactions', pending.id), {
    status: 'timeout',
    sweptAt: serverTimestamp(),
    sweptBy: userId || 'system',
    mpesaResultDesc: 'No callback received within timeout window',
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'fee_audit_log', `AUDIT_MPESA_${pending.id}_TIMEOUT`), {
    schoolId: pending.schoolId,
    action: 'MPESA_PAYMENT_TIMEOUT',
    transactionId: txnId,
    studentId: pending.studentId || 'unknown',
    amount: pending.amount || 0,
    status: 'timeout',
    source: 'mpesa_sweep',
    actor: { uid: userId || 'system', name: userName || 'Timeout Sweep' },
    timestamp: serverTimestamp(),
  });

  await batch.commit();
}

/**
 * Dismiss a callback_error record once ops has reviewed it.
 */
export async function dismissError({ errorDoc, userId, userName = '' }) {
  await updateDoc(doc(db, 'mpesa_callback_errors', errorDoc.id), {
    dismissed: true,
    dismissedAt: serverTimestamp(),
    dismissedBy: userId || 'admin',
    dismissedByName: userName || 'Admin',
  });
}

/* ---- internals ---- */

function slug(s) {
  return String(s || '').trim().replace(/\s+/g, '_').replace(/[/#$[\]\\]/g, '');
}

function millisOf(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : 0;
}
