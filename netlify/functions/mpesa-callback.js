// netlify/functions/mpesa-callback.js
//
// Handles M-Pesa STK Push callbacks from Safaricom Daraja.
//
// Design goals:
//   1. Every ResultCode is mapped to a canonical status.
//   2. Every callback — success, failure, timeout, cancel, validation error —
//      writes a consistent, auditable record.
//   3. Idempotency holds under retries: a second callback never mutates
//      financial state once a terminal status is set.
//   4. Ledger invariants (fee_transactions + student_balances + receipts +
//      invoices + fee_audit_log + mpesa_pending_transactions) are updated
//      atomically inside a single Firestore transaction.
//   5. The handler always returns 200 so Safaricom stops retrying.

const { initAdmin } = require('./_lib/firebaseAdmin');

/* ============================================================
   Constants
   ============================================================ */

/**
 * Canonical statuses we persist. Do not use free-form strings anywhere
 * else in the codebase — import from here or mirror exactly.
 */
const TXN_STATUS = Object.freeze({
  PENDING:          'pending',
  PROCESSING:       'processing',
  COMPLETED:        'completed',
  FAILED:           'failed',
  CANCELLED:        'cancelled',
  TIMEOUT:          'timeout',
  INSUFFICIENT:     'insufficient_funds',
  INVALID_ACCOUNT:  'invalid_account',
  WRONG_PIN:        'wrong_pin',
  SYSTEM_ERROR:     'system_error',
  DUPLICATE:        'duplicate',
});

/**
 * Mapping of every meaningful Daraja ResultCode to a canonical status
 * plus a human-readable label. Sources:
 *   - Safaricom Daraja STK Push documentation
 *   - Production observations
 *
 * Codes not listed here fall back to FAILED.
 */
const RESULT_CODE_MAP = Object.freeze({
  0:    { status: TXN_STATUS.COMPLETED,        label: 'Success' },
  1:    { status: TXN_STATUS.INSUFFICIENT,     label: 'Insufficient funds' },
  1001: { status: TXN_STATUS.FAILED,           label: 'Unable to lock subscriber, another transaction in progress' },
  1002: { status: TXN_STATUS.CANCELLED,        label: 'Request cancelled by user' },
  1019: { status: TXN_STATUS.TIMEOUT,          label: 'Transaction expired' },
  1032: { status: TXN_STATUS.CANCELLED,        label: 'Request cancelled by user' },
  1037: { status: TXN_STATUS.TIMEOUT,          label: 'DS timeout — no response from subscriber phone' },
  1038: { status: TXN_STATUS.FAILED,           label: 'Request rejected by subscriber' },
  1039: { status: TXN_STATUS.FAILED,           label: 'Request rejected due to invalid PIN' },
  1040: { status: TXN_STATUS.FAILED,           label: 'Request rejected by initiator' },
  1041: { status: TXN_STATUS.FAILED,           label: 'Unable to lock subscriber' },
  2001: { status: TXN_STATUS.WRONG_PIN,        label: 'Wrong PIN entered' },
  2002: { status: TXN_STATUS.FAILED,           label: 'Invalid request parameters' },
  2003: { status: TXN_STATUS.FAILED,           label: 'Invalid transaction amount' },
  2004: { status: TXN_STATUS.SYSTEM_ERROR,     label: 'System error' },
  2005: { status: TXN_STATUS.FAILED,           label: 'Duplicate request' },
  2006: { status: TXN_STATUS.FAILED,           label: 'Transaction already in progress' },
  5001: { status: TXN_STATUS.SYSTEM_ERROR,     label: 'System error' },
  9999: { status: TXN_STATUS.SYSTEM_ERROR,     label: 'Unknown error' },
});

/**
 * Result codes where the user is known to have cancelled, so we can
 * avoid spamming them with "payment failed" notifications.
 */
const USER_CANCELLED_CODES = new Set([1002, 1032]);

/* ============================================================
   Helpers
   ============================================================ */

const slug = (s) =>
  String(s || '').trim().replace(/\s+/g, '_').replace(/[/#$[\]\\]/g, '');

const makeBalanceId = (studentId, term, year) =>
  `${slug(studentId)}__${slug(term)}__${slug(year)}`;

const canonicalStatusForResultCode = (code) => {
  const n = Number(code);
  if (RESULT_CODE_MAP[n]) return RESULT_CODE_MAP[n];
  return { status: TXN_STATUS.FAILED, label: `Unknown result code ${code}` };
};

const ok = (body) => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

/**
 * Extract a CallbackMetadata.Item by name.
 */
const getCallbackItem = (items, name) =>
  items.find((i) => i.Name === name)?.Value;

/* ============================================================
   Handler
   ============================================================ */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return ok({ message: 'Method not allowed' });
  }

  /* ---- 1. Firebase Admin bootstrap ---- */
  let admin, db, FieldValue;
  try {
    admin = initAdmin();
    db = admin.firestore();
    FieldValue = admin.firestore.FieldValue;
  } catch (e) {
    console.error('[mpesa-callback] Firebase Admin init failed:', e.message);
    return ok({ message: 'Server not ready' });
  }

  /* ---- 2. Parse body ---- */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('[mpesa-callback] Invalid JSON:', event.body);
    return ok({ message: 'Invalid JSON' });
  }

  const stkCallback = body?.Body?.stkCallback;
  if (!stkCallback) {
    console.error('[mpesa-callback] Missing Body.stkCallback');
    return ok({ message: 'Ignored — malformed payload' });
  }

  const {
    MerchantRequestID = '',
    CheckoutRequestID,
    ResultCode,
    ResultDesc = '',
  } = stkCallback;

  if (!CheckoutRequestID) {
    console.error('[mpesa-callback] Missing CheckoutRequestID');
    return ok({ message: 'Missing CheckoutRequestID' });
  }

  const resultInfo = canonicalStatusForResultCode(ResultCode);
  console.log(
    `[mpesa-callback] CheckoutRequestID=${CheckoutRequestID} ` +
    `MerchantRequestID=${MerchantRequestID} ` +
    `ResultCode=${ResultCode} (${ResultDesc}) ` +
    `-> ${resultInfo.status}`
  );

  /* ---- 3. Document refs ---- */
  const deterministicTxnId = `MPESA_${CheckoutRequestID}`;
  const pendingRef = db.collection('mpesa_pending_transactions').doc(CheckoutRequestID);
  const txnRef = db.collection('fee_transactions').doc(deterministicTxnId);
  const failAuditRef = db
    .collection('fee_audit_log')
    .doc(`AUDIT_MPESA_${CheckoutRequestID}_${resultInfo.status.toUpperCase()}`);

  try {
    /* ---- 4. Load pending (with race tolerance) ---- */
    let pendingSnap = await pendingRef.get();
    let attempts = 0;
    while (!pendingSnap.exists && attempts < 4) {
      await new Promise((r) => setTimeout(r, 600));
      attempts++;
      pendingSnap = await pendingRef.get();
      if (pendingSnap.exists) break;
    }
    const pending = pendingSnap.exists ? pendingSnap.data() : null;

    /* ---- 5. Idempotency — check both docs ---- */
    const existingTxnSnap = await txnRef.get();
    const existingTxn = existingTxnSnap.exists ? existingTxnSnap.data() : null;

    if (existingTxn && existingTxn.status && existingTxn.status !== TXN_STATUS.PENDING && existingTxn.status !== TXN_STATUS.PROCESSING) {
      console.log(
        `[mpesa-callback][idempotency] txn ${deterministicTxnId} already ${existingTxn.status}.`
      );
      if (pendingSnap.exists) {
        await pendingRef.update({
          duplicateCallbackReceivedAt: FieldValue.serverTimestamp(),
          duplicateCount: FieldValue.increment(1),
        }).catch(() => {});
      }
      return ok({ message: 'Already processed', duplicate: true, status: existingTxn.status });
    }

    if (pending && (pending.status === TXN_STATUS.COMPLETED || pending.status === TXN_STATUS.CANCELLED || pending.status === TXN_STATUS.FAILED || pending.status === TXN_STATUS.TIMEOUT || pending.status === TXN_STATUS.INSUFFICIENT)) {
      console.log(
        `[mpesa-callback][idempotency] pending ${CheckoutRequestID} already ${pending.status}.`
      );
      return ok({ message: 'Already processed', duplicate: true, status: pending.status });
    }

    /* ---- 6. Resolve shared context from pending or existing txn ---- */
    const schoolId = pending?.schoolId || existingTxn?.schoolId || null;
    const studentId = pending?.studentId || existingTxn?.studentId || null;
    const term = pending?.term || existingTxn?.term || 'Term 1';
    const year = Number(pending?.year || existingTxn?.year || new Date().getFullYear());
    const studentName = pending?.studentName || existingTxn?.studentName || '';
    const admissionNumber = pending?.admissionNumber || existingTxn?.admissionNumber || '';
    const studentClass = pending?.class || existingTxn?.class || '';
    const studentLevel = pending?.level || existingTxn?.level || '';
    const invoiceId = pending?.invoiceId || existingTxn?.invoiceId || null;
    const expectedAmount = Number(pending?.amount ?? existingTxn?.amount ?? 0);
    const requestedPhone = String(pending?.phoneNumber || existingTxn?.phoneNumber || '');

    /* ============================================================
       7. SUCCESS PATH (ResultCode === 0)
       ============================================================ */
    if (Number(ResultCode) === 0) {
      const items = stkCallback.CallbackMetadata?.Item || [];
      const receiptNumber = String(getCallbackItem(items, 'MpesaReceiptNumber') || '').trim();
      const paidAmount = Number(getCallbackItem(items, 'Amount') ?? expectedAmount);
      const paidPhone = String(getCallbackItem(items, 'PhoneNumber') ?? requestedPhone);
      const transactionDate = getCallbackItem(items, 'TransactionDate')
        ? String(getCallbackItem(items, 'TransactionDate'))
        : null;

      // Guard: missing student context — can't allocate, write a reconciliation entry.
      if (!schoolId || !studentId) {
        console.error(
          `[mpesa-callback][orphan] success callback with no schoolId/studentId ` +
          `(CheckoutRequestID=${CheckoutRequestID}). Writing reconciliation record.`
        );
        await db.collection('mpesa_orphan_callbacks').doc(CheckoutRequestID).set({
          CheckoutRequestID,
          MerchantRequestID,
          receiptNumber,
          paidAmount,
          paidPhone,
          transactionDate,
          reason: 'missing_school_or_student_context',
          payload: stkCallback,
          receivedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return ok({ message: 'Recorded orphan success callback' });
      }

      // Guard: missing receipt number despite ResultCode 0 (rare).
      if (!receiptNumber) {
        console.warn(
          `[mpesa-callback] success but no MpesaReceiptNumber for ${CheckoutRequestID}. ` +
          `Recording with CheckoutRequestID as reference.`
        );
      }

      // Guard: amount mismatch — record with flag, still credit the amount Safaricom confirms.
      const amountMismatch = expectedAmount > 0 && Math.abs(paidAmount - expectedAmount) > 0.5;

      const balRef = db.collection('student_balances').doc(makeBalanceId(studentId, term, year));
      const receiptDocId = `RCP_MPESA_${receiptNumber || CheckoutRequestID}`;
      const receiptRef = db.collection('receipts').doc(receiptDocId);
      const auditRef = db.collection('fee_audit_log').doc(`AUDIT_MPESA_${CheckoutRequestID}`);

      await db.runTransaction(async (trx) => {
        // Re-read txn inside the transaction for atomic idempotency.
        const innerTxn = await trx.get(txnRef);
        if (innerTxn.exists && innerTxn.data().status === TXN_STATUS.COMPLETED) {
          return; // Completed in a parallel invocation.
        }

        const balSnap = await trx.get(balRef);
        const curBal = balSnap.exists ? balSnap.data() : {
          studentId, studentName, admissionNumber,
          studentClass, level: studentLevel,
          term, year, schoolId,
          totalInvoiced: 0, totalPaid: 0, totalDiscount: 0, totalWaived: 0,
          balance: 0, status: 'no_invoice',
        };

        const totalInvoiced = curBal.totalInvoiced || 0;
        const totalPaid = (curBal.totalPaid || 0) + paidAmount;
        const totalDiscount = curBal.totalDiscount || 0;
        const totalWaived = curBal.totalWaived || 0;
        const newBalance = totalInvoiced - totalPaid - totalDiscount - totalWaived;

        let balStatus = 'pending';
        if (totalInvoiced === 0) balStatus = 'no_invoice';
        else if (newBalance <= 0) balStatus = 'paid';
        else if (totalPaid + totalDiscount + totalWaived > 0) balStatus = 'partial';

        /* A. fee_transactions — the authoritative ledger */
        trx.set(txnRef, {
          idempotencyKey: deterministicTxnId,
          reference: receiptNumber || CheckoutRequestID,
          mpesaReceiptNumber: receiptNumber,
          mpesaResultCode: ResultCode,
          mpesaResultDesc: ResultDesc,
          mpesaTransactionDate: transactionDate,
          schoolId, studentId, studentName, admissionNumber,
          class: studentClass, level: studentLevel,
          term, year,
          amount: paidAmount,
          expectedAmount,
          amountMismatch,
          type: 'payment',
          status: TXN_STATUS.COMPLETED,
          paymentMethod: 'mpesa',
          source: 'mpesa_stk',
          checkoutRequestID: CheckoutRequestID,
          merchantRequestID: MerchantRequestID,
          phoneNumber: paidPhone,
          description: pending?.description || `M-Pesa Fee Payment (Ref: ${receiptNumber || CheckoutRequestID})`,
          invoiceId: invoiceId || null,
          actor: {
            uid: 'safaricom_callback',
            name: 'M-Pesa Daraja Gateway',
            source: 'mpesa_stk_callback',
          },
          recordedBy: 'system',
          recordedByName: 'M-Pesa System',
          voided: false,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        /* B. student_balances */
        trx.set(balRef, {
          ...curBal,
          schoolId, studentId, studentName, admissionNumber,
          studentClass, level: studentLevel,
          term, year,
          totalInvoiced, totalPaid, totalDiscount, totalWaived,
          balance: newBalance,
          status: balStatus,
          lastPaymentDate: new Date().toISOString().split('T')[0],
          lastPaymentAmount: paidAmount,
          lastPaymentMethod: 'mpesa',
          lastTransactionId: deterministicTxnId,
          lastTransactionAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        /* C. Invoice allocation, if applicable */
        if (invoiceId) {
          const invRef = db.collection('invoices').doc(invoiceId);
          const invSnap = await trx.get(invRef);
          if (invSnap.exists) {
            const inv = invSnap.data();
            const newPaidOnInv = (inv.paidAmount || 0) + paidAmount;
            const remaining = Math.max(0, (inv.total || 0) - newPaidOnInv);
            const invStatus = remaining <= 0
              ? 'paid'
              : inv.status === 'overdue'
                ? 'overdue'
                : newPaidOnInv > 0
                  ? 'partial'
                  : 'pending';

            trx.update(invRef, {
              paidAmount: newPaidOnInv,
              remainingBalance: remaining,
              status: invStatus,
              payments: [
                ...(inv.payments || []),
                {
                  amount: paidAmount,
                  date: new Date().toISOString(),
                  method: 'mpesa',
                  transactionId: deterministicTxnId,
                  reference: receiptNumber || CheckoutRequestID,
                  notes: `M-Pesa Payment ${receiptNumber || CheckoutRequestID}`,
                },
              ],
              updatedAt: FieldValue.serverTimestamp(),
              ...(invStatus === 'paid' ? { paidAt: FieldValue.serverTimestamp() } : {}),
            });
          }
        }

        /* D. Immutable receipt record */
        trx.set(receiptRef, {
          receiptNumber: receiptNumber ? `RCP-${receiptNumber}` : `RCP-${CheckoutRequestID.slice(-8)}`,
          schoolId, studentId, studentName, admissionNumber,
          studentClass, level: studentLevel,
          amount: paidAmount,
          expectedAmount,
          amountMismatch,
          paymentMethod: 'mpesa',
          reference: receiptNumber || CheckoutRequestID,
          mpesaReceiptNumber: receiptNumber,
          transactionId: deterministicTxnId,
          term, year,
          status: 'valid',
          issuedBy: 'M-Pesa System',
          issuedByName: 'M-Pesa Daraja Gateway',
          issuedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        /* E. Audit log */
        trx.set(auditRef, {
          schoolId,
          action: 'MPESA_PAYMENT_COMPLETED',
          transactionId: deterministicTxnId,
          receiptNumber: receiptNumber ? `RCP-${receiptNumber}` : `RCP-${CheckoutRequestID.slice(-8)}`,
          studentId,
          amount: paidAmount,
          expectedAmount,
          amountMismatch,
          previousBalance: curBal.balance || 0,
          newBalance,
          actor: {
            uid: 'safaricom_callback',
            name: 'M-Pesa Daraja Gateway',
            source: 'mpesa_stk',
          },
          source: 'mpesa_stk',
          status: TXN_STATUS.COMPLETED,
          metadata: {
            checkoutRequestId: CheckoutRequestID,
            merchantRequestId: MerchantRequestID,
            phoneNumber: paidPhone,
            mpesaReceiptNumber: receiptNumber,
            transactionDate,
            resultCode: ResultCode,
            resultDesc: ResultDesc,
          },
          timestamp: FieldValue.serverTimestamp(),
        });

        /* F. Pending doc — terminal but kept for idempotency */
        trx.set(pendingRef, {
          status: TXN_STATUS.COMPLETED,
          mpesaReceiptNumber: receiptNumber,
          mpesaResultCode: ResultCode,
          mpesaResultDesc: ResultDesc,
          amountPaid: paidAmount,
          amountMismatch,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });

      console.log(
        `[mpesa-callback][success] ${receiptNumber || CheckoutRequestID} ` +
        `KES ${paidAmount} for student ${studentId}` +
        (amountMismatch ? ` [AMOUNT MISMATCH: expected ${expectedAmount}]` : '')
      );

      return ok({ message: 'Callback processed successfully', status: TXN_STATUS.COMPLETED });
    }

    /* ============================================================
       8. FAILURE PATHS (any non-zero ResultCode)
       ============================================================ */

    const { status: terminalStatus, label: statusLabel } = resultInfo;
    const isUserCancelled = USER_CANCELLED_CODES.has(Number(ResultCode));

    console.log(
      `[mpesa-callback][${terminalStatus}] ${CheckoutRequestID}: ${ResultDesc}`
    );

    await db.runTransaction(async (trx) => {
      // Re-read txn for atomic idempotency.
      const innerTxn = await trx.get(txnRef);
      if (
        innerTxn.exists &&
        innerTxn.data().status &&
        innerTxn.data().status !== TXN_STATUS.PENDING &&
        innerTxn.data().status !== TXN_STATUS.PROCESSING
      ) {
        return;
      }

      const innerPendingSnap = await trx.get(pendingRef);
      const innerPending = innerPendingSnap.exists ? innerPendingSnap.data() : null;

      /* A. fee_transactions — record failed attempt for full traceability */
      trx.set(txnRef, {
        idempotencyKey: deterministicTxnId,
        schoolId: schoolId || innerPending?.schoolId || 'unknown',
        studentId: studentId || innerPending?.studentId || 'unknown',
        studentName: studentName || innerPending?.studentName || '',
        admissionNumber: admissionNumber || innerPending?.admissionNumber || '',
        class: studentClass || innerPending?.class || '',
        level: studentLevel || innerPending?.level || '',
        term, year,
        amount: expectedAmount,
        expectedAmount,
        type: 'payment',
        status: terminalStatus,
        paymentMethod: 'mpesa',
        source: 'mpesa_stk',
        checkoutRequestID: CheckoutRequestID,
        merchantRequestID: MerchantRequestID,
        phoneNumber: requestedPhone,
        invoiceId: invoiceId || null,
        mpesaResultCode: ResultCode,
        mpesaResultDesc: ResultDesc,
        mpesaStatusLabel: statusLabel,
        isUserCancelled,
        failedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      /* B. Pending doc — keep it, set the terminal status */
      trx.set(pendingRef, {
        status: terminalStatus,
        mpesaResultCode: ResultCode,
        mpesaResultDesc: ResultDesc,
        mpesaStatusLabel: statusLabel,
        isUserCancelled,
        failedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      /* C. Audit log — one canonical entry per failure, no duplicates on retry */
      trx.set(failAuditRef, {
        schoolId: schoolId || innerPending?.schoolId || 'unknown',
        action: 'MPESA_PAYMENT_FAILED',
        transactionId: deterministicTxnId,
        studentId: studentId || innerPending?.studentId || 'unknown',
        amount: expectedAmount,
        status: terminalStatus,
        statusLabel,
        isUserCancelled,
        source: 'mpesa_stk',
        actor: {
          uid: 'safaricom_callback',
          name: 'M-Pesa Daraja Gateway',
          source: 'mpesa_stk',
        },
        metadata: {
          checkoutRequestId: CheckoutRequestID,
          merchantRequestId: MerchantRequestID,
          resultCode: ResultCode,
          resultDesc: ResultDesc,
          statusLabel,
        },
        timestamp: FieldValue.serverTimestamp(),
      });
    });

    return ok({ message: 'Callback processed successfully', status: terminalStatus });
  } catch (err) {
    // We must ALWAYS return 200 so Safaricom doesn't endlessly retry.
    // Log the full stack so we can find the record later.
    console.error('[mpesa-callback] Unexpected error:', err);
    try {
      await db.collection('mpesa_callback_errors').add({
        checkoutRequestID: CheckoutRequestID,
        merchantRequestID: MerchantRequestID,
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        canonicalStatus: resultInfo.status,
        errorMessage: err.message,
        errorStack: err.stack,
        receivedAt: FieldValue.serverTimestamp(),
      });
    } catch (logErr) {
      console.error('[mpesa-callback] Failed to persist error record:', logErr);
    }
    return ok({ message: 'Logged error' });
  }
};
