const { db, FieldValue } = require('../lib/admin');
const crypto = require('crypto');

const slug = (s) => String(s).trim().replace(/\s+/g, '_').replace(/[\/\\.#$\[\]]/g, '');
const summaryId = (schoolId, term, year) => `${slug(schoolId)}__${slug(term)}__${slug(year)}`;

exports.onFeeTransactionWrite = require('firebase-functions/v2/firestore')
    .onDocumentWritten('fee_transactions/{txnId}', async (event) => {
        const before = event.data?.before?.data();
        const after = event.data?.after?.data();
        const txn = after || before;
        if (!txn) return;

        const { schoolId, term, year, type, amount = 0, status } = txn;
        if (!schoolId || !term || !year) return;

        // Only completed payments & their reversals move money
        const isMoney = ['payment', 'reversal', 'refund'].includes(type) &&
            (status === 'completed' || status === 'success' || type === 'reversal');

        const signedAmount = type === 'reversal' || type === 'refund' ? -Math.abs(amount) : Math.abs(amount);
        const isDiscount = type === 'discount' || type === 'waiver';

        // Build deltas
        const delta = { totalCollected: 0, totalDiscount: 0, txnCount: 0 };
        const prevDelta = { totalCollected: 0, totalDiscount: 0, txnCount: 0 };

        if (isMoney && (after?.status === 'completed' || after?.status === 'success' || after?.type === 'reversal')) {
            delta.totalCollected = signedAmount;
            delta.txnCount = 1;
        }
        if (isDiscount && after) {
            delta.totalDiscount = Math.abs(amount);
        }
        if (isMoney && (before?.status === 'completed' || before?.status === 'success' || before?.type === 'reversal')) {
            const signedBefore = before.type === 'reversal' || before.type === 'refund'
                ? -Math.abs(before.amount || 0) : Math.abs(before.amount || 0);
            prevDelta.totalCollected = signedBefore;
            prevDelta.txnCount = 1;
        }
        if (isDiscount && before) {
            prevDelta.totalDiscount = Math.abs(before.amount || 0);
        }

        const netCollected = delta.totalCollected - prevDelta.totalCollected;
        const netDiscount = delta.totalDiscount - prevDelta.totalDiscount;
        const netCount = delta.txnCount - prevDelta.txnCount;

        if (netCollected === 0 && netDiscount === 0 && netCount === 0) return;

        const id = summaryId(schoolId, term, year);
        const ref = db.collection('invoice_summaries').doc(id);
        const eventRef = db.collection('fee_summary_events')
            .doc(crypto.createHash('sha256').update(event.id).digest('hex'));

        await db.runTransaction(async (trx) => {
            const eventSnap = await trx.get(eventRef);
            if (eventSnap.exists) return;
            const snap = await trx.get(ref);
            const cur = snap.exists() ? snap.data() : {
                schoolId, term, year: Number(year),
                totalInvoices: 0, totalPaid: 0, totalOutstanding: 0,
                totalCollected: 0, totalDiscount: 0, txnCount: 0,
                paidCount: 0, pendingCount: 0, overdueCount: 0,
                updatedAt: FieldValue.serverTimestamp()
            };
            trx.set(ref, {
                ...cur,
                totalCollected: (cur.totalCollected || 0) + netCollected,
                totalDiscount: (cur.totalDiscount || 0) + netDiscount,
                txnCount: (cur.txnCount || 0) + netCount,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            trx.create(eventRef, {
                eventId: event.id,
                transactionId: event.params.txnId,
                processedAt: FieldValue.serverTimestamp()
            });
        });
    });
