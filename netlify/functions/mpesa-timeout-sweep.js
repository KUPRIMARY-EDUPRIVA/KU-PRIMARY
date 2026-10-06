const { withCors } = require('./_lib/cors');
// netlify/functions/mpesa-timeout-sweep.js
//
// Scheduled sweep of mpesa_pending_transactions that never received a callback.
// Configure in netlify.toml:
//   [functions.mpesa-timeout-sweep]
//     schedule = "*/15 * * * *"
//
// Safe to call repeatedly. Uses a Firestore transaction to avoid double-marking.

const { initAdmin } = require('./_lib/firebaseAdmin');

const STUCK_MINUTES = 15;
const MAX_PER_RUN = 200;

exports.handler = async () => {
  let admin, db, FieldValue;
  try {
    admin = initAdmin();
    db = admin.firestore();
    FieldValue = admin.firestore.FieldValue;
  } catch (e) {
    console.error('[mpesa-timeout-sweep] Admin init failed:', e.message);
    return { statusCode: 500, body: 'Server not ready' };
  }

  const cutoff = new Date(Date.now() - STUCK_MINUTES * 60 * 1000);

  // Query pending docs created before the cutoff.
  // (Requires composite index: status == 'pending' + createdAt ASC.)
  let snap;
  try {
    snap = await db.collection('mpesa_pending_transactions')
      .where('status', '==', 'pending')
      .where('createdAt', '<', cutoff)
      .limit(MAX_PER_RUN)
      .get();
  } catch (err) {
    // Fall back to a full scan if the composite index isn't deployed.
    console.warn('[mpesa-timeout-sweep] falling back to unordered query:', err.message);
    snap = await db.collection('mpesa_pending_transactions')
      .where('status', '==', 'pending')
      .limit(MAX_PER_RUN)
      .get();
  }

  const candidates = snap.docs
    .map((d) => ({ id: d.id, ref: d.ref, ...d.data() }))
    .filter((p) => {
      const ts = p.createdAt?.toMillis?.() ?? (p.createdAt ? new Date(p.createdAt).getTime() : 0);
      return ts > 0 && ts < cutoff.getTime();
    });

  if (candidates.length === 0) {
    console.log('[mpesa-timeout-sweep] nothing to sweep');
    return {
      statusCode: 200,
      body: JSON.stringify({ swept: 0 }),
    };
  }

  let swept = 0;
  const errors = [];

  for (const pending of candidates) {
    try {
      await sweepOne({ db, FieldValue, pending });
      swept++;
    } catch (err) {
      console.error(`[mpesa-timeout-sweep] failed for ${pending.id}:`, err.message);
      errors.push({ id: pending.id, error: err.message });
    }
  }

  console.log(`[mpesa-timeout-sweep] swept ${swept}/${candidates.length}`);
  return {
    statusCode: 200,
    body: JSON.stringify({ swept, errors, cutoff: cutoff.toISOString() }),
  };
};

async function sweepOne({ db, FieldValue, pending }) {
  const txnId = `MPESA_${pending.id}`;
  const txnRef = db.collection('fee_transactions').doc(txnId);
  const pendingRef = db.collection('mpesa_pending_transactions').doc(pending.id);
  const auditRef = db.collection('fee_audit_log').doc(`AUDIT_MPESA_${pending.id}_TIMEOUT`);

  await db.runTransaction(async (trx) => {
    const [txnSnap, pendingSnap] = await Promise.all([
      trx.get(txnRef),
      trx.get(pendingRef),
    ]);

    // Already finalized — nothing to do.
    if (txnSnap.exists) {
      const s = txnSnap.data()?.status;
      if (s && s !== 'pending' && s !== 'processing') return;
    }
    if (pendingSnap.exists && pendingSnap.data()?.status !== 'pending') return;

    // fee_transactions — record the timeout
    trx.set(txnRef, {
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
      invoiceId: pending.invoiceId || null,
      mpesaResultCode: 'SWEEP',
      mpesaResultDesc: `No callback received within ${STUCK_MINUTES} minutes`,
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    // pending doc — terminal
    trx.set(pendingRef, {
      status: 'timeout',
      sweptAt: FieldValue.serverTimestamp(),
      sweptBy: 'system_sweep',
      mpesaResultDesc: `No callback received within ${STUCK_MINUTES} minutes`,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    // audit log
    trx.set(auditRef, {
      schoolId: pending.schoolId,
      action: 'MPESA_PAYMENT_TIMEOUT',
      transactionId: txnId,
      studentId: pending.studentId || 'unknown',
      amount: pending.amount || 0,
      status: 'timeout',
      source: 'mpesa_sweep',
      actor: { uid: 'system_sweep', name: 'Timeout Sweep' },
      timestamp: FieldValue.serverTimestamp(),
    });
  });
}

exports.handler = withCors(exports.handler);
