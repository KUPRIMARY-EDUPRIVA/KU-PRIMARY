// src/services/admissionNumberService.js
import {
    doc, runTransaction, collection, query, where,
    getDocs, limit, serverTimestamp
} from 'firebase/firestore';
import { db } from '../firebase';

const PAD = 4;

export function formatAdmissionNumber(n, padding = PAD) {
    return normalizeAdmissionNumber(n, padding);
}

export function normalizeAdmissionNumber(value, padding = PAD) {
    const admission = String(value ?? '').trim();
    return /^\d+$/.test(admission)
        ? admission.padStart(padding, '0')
        : admission.toUpperCase();
}

/**
 * Atomically reserve `count` admission numbers for a school.
 * Uses a Firestore transaction so two concurrent admins can never collide.
 *
 * Returns an array of formatted IDs, e.g. ['0007','0008','0009'].
 *
 * If the school document doesn't have `nextAdmissionNumber`, we
 * initialize it from the highest existing student ID on first use.
 */
export async function reserveAdmissionNumbers(schoolId, count = 1) {
    if (!schoolId) throw new Error('schoolId required');
    if (count < 1 || count > 500) throw new Error('count must be 1..500');

    const schoolRef = doc(db, 'schools', schoolId);

    const result = await runTransaction(db, async (tx) => {
        const snap = await tx.get(schoolRef);
        if (!snap.exists()) throw new Error('School not found');

        const data = snap.data();
        let next = typeof data.nextAdmissionNumber === 'number'
            ? data.nextAdmissionNumber
            : null;

        // Initialize from existing students if never set
        if (next === null) {
            // Look outside the transaction to seed — transactions can't query.
            // We do a best-effort seed by reading the maximum existing numeric ID.
            next = await seedFromExistingStudents(schoolId);
        }

        const start = next;
        const end = next + count - 1;

        tx.update(schoolRef, {
            nextAdmissionNumber: end + 1,
            admissionNumberUpdatedAt: serverTimestamp()
        });

        const ids = [];
        for (let n = start; n <= end; n++) ids.push(formatAdmissionNumber(n));
        return ids;
    });

    return result;
}

/**
 * Fallback seed: scans existing students to find the highest numeric ID.
 * Runs only once per school (or after a data reset).
 */
async function seedFromExistingStudents(schoolId) {
    // Firestore doesn't support ORDER BY on cast numbers, so we scan.
    // Bounded to a reasonable page to avoid runaway reads.
    const snap = await getDocs(query(
        collection(db, 'students'),
        where('schoolId', '==', schoolId),
        limit(1000)
    ));

    let max = 0;
    snap.forEach((d) => {
        const sid = String(d.data().studentId || '');
        if (/^\d+$/.test(sid)) {
            const n = parseInt(sid, 10);
            if (n > max) max = n;
        }
    });
    return max + 1;
}

/**
 * Check whether a list of candidate IDs collide with existing students.
 * Returns { duplicates: string[], available: string[] }.
 *
 * Runs one Firestore `in` query per 10 IDs (Firestore limit).
 */
export async function checkAdmissionNumberCollisions(schoolId, candidateIds) {
    if (!candidateIds || candidateIds.length === 0) {
        return { duplicates: [], available: [] };
    }
    const normalized = [...new Set(candidateIds.map((s) => String(s)))];

    // De-dupe internally
    if (normalized.length !== candidateIds.length) {
        return {
            duplicates: candidateIds.filter(
                (id, i) => candidateIds.indexOf(id) !== i
            ),
            available: normalized
        };
    }

    const found = new Set();
    for (let i = 0; i < normalized.length; i += 10) {
        const chunk = normalized.slice(i, i + 10);
        const snap = await getDocs(query(
            collection(db, 'students'),
            where('schoolId', '==', schoolId),
            where('studentId', 'in', chunk)
        ));
        snap.forEach((d) => found.add(String(d.data().studentId)));
    }

    return {
        duplicates: normalized.filter((id) => found.has(id)),
        available: normalized.filter((id) => !found.has(id))
    };
}

/**
 * Compute the "next" value from a set of IDs so the school counter can be
 * advanced when a CSV imports explicit higher numbers.
 */
export function maxNumericId(ids) {
    let max = 0;
    for (const id of ids) {
        if (/^\d+$/.test(String(id))) {
            const n = parseInt(id, 10);
            if (n > max) max = n;
        }
    }
    return max;
}

/**
 * Ensure the school counter is at least `value`. Uses a transaction so it's
 * safe under concurrency. No-ops if the counter is already >= value.
 */
export async function ensureSchoolCounterAtLeast(schoolId, value) {
    if (!schoolId || !Number.isFinite(value) || value < 1) return;
    const schoolRef = doc(db, 'schools', schoolId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(schoolRef);
        if (!snap.exists()) return;
        const current = Number(snap.data().nextAdmissionNumber) || 0;
        if (current < value) {
            tx.update(schoolRef, {
                nextAdmissionNumber: value,
                admissionNumberUpdatedAt: serverTimestamp()
            });
        }
    });
}
