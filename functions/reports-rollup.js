// functions/reports-rollup.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Assumes admin.initializeApp() already ran in functions/index.js.
// If this is a standalone file, uncomment:
// if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// ---------------------------------------------------------------------------
// Nightly rollup: builds a snapshot per school with pre-aggregated stats.
// Runs at 02:00 Africa/Nairobi by default.
// ---------------------------------------------------------------------------

exports.nightlyReportSnapshot = functions
    .runWith({ timeoutSeconds: 540, memory: '512MB' })
    .pubsub
    .schedule('every day 02:00')
    .timeZone('Africa/Nairobi')
    .onRun(async () => {
        console.log('▶ Starting nightly report snapshot');

        const schoolsSnap = await db.collection('schools').get();
        console.log(`  Found ${schoolsSnap.size} schools`);

        const results = { ok: 0, failed: 0, skipped: 0 };

        for (const schoolDoc of schoolsSnap.docs) {
            const schoolId = schoolDoc.id;
            try {
                const wrote = await buildSnapshotForSchool(schoolId);
                if (wrote) results.ok++;
                else results.skipped++;
            } catch (err) {
                console.error(`  ✘ ${schoolId}:`, err.message);
                results.failed++;
            }
        }

        console.log('✔ Nightly rollup done', results);
        return results;
    });

// ---------------------------------------------------------------------------
// Manual trigger — call from an admin page or CLI to rebuild a school's
// snapshot without waiting for 02:00.
// ---------------------------------------------------------------------------
exports.rebuildReportSnapshot = functions
    .runWith({ timeoutSeconds: 540, memory: '512MB' })
    .https
    .onCall(async (data, context) => {
        // Require an authenticated admin
        if (!context.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'Login required');
        }
        const { schoolId } = data || {};
        if (!schoolId) {
            throw new functions.https.HttpsError('invalid-argument', 'schoolId required');
        }

        // Verify caller belongs to the school (or is a super-admin)
        const claims = context.auth.token || {};
        const isSuper = claims.role === 'super-admin';
        const sameSchool = claims.schoolId === schoolId;
        if (!isSuper && !sameSchool) {
            throw new functions.https.HttpsError('permission-denied', 'Not your school');
        }

        const wrote = await buildSnapshotForSchool(schoolId);
        return { ok: wrote, schoolId };
    });

// ---------------------------------------------------------------------------
// Snapshot builder — the actual aggregation logic.
// Streams student_scores in pages to avoid loading everything into memory.
// ---------------------------------------------------------------------------
async function buildSnapshotForSchool(schoolId) {
    const PAGE_SIZE = 500;
    const totals = {
        totalScores: 0,
        scoreSum: 0,
        passed: 0,       // score >= 50
        mastered: 0,     // score >= 70
        excellent: 0,    // score >= 80
        good: 0,         // 70..79
        satisfactory: 0, // 50..69
        needsImprovement: 0, // 40..49
        belowExpectation: 0  // < 40
    };
    const bySubject = {};
    const byLevel = {};
    const seenStudents = new Set();
    const seenSubjects = new Set();

    let lastDoc = null;
    let pages = 0;

    while (true) {
        let q = db.collection('student_scores')
            .where('schoolId', '==', schoolId)
            .orderBy('__name__')
            .limit(PAGE_SIZE);
        if (lastDoc) q = q.startAfter(lastDoc);

        const snap = await q.get();
        if (snap.empty) break;

        for (const doc of snap.docs) {
            const s = doc.data();
            if (typeof s.score !== 'number') continue;

            totals.totalScores++;
            totals.scoreSum += s.score;
            if (s.score >= 80) totals.excellent++;
            else if (s.score >= 70) totals.good++;
            else if (s.score >= 50) totals.satisfactory++;
            else if (s.score >= 40) totals.needsImprovement++;
            else totals.belowExpectation++;

            if (s.score >= 50) totals.passed++;
            if (s.score >= 70) totals.mastered++;

            if (s.studentId) seenStudents.add(s.studentId);
            if (s.subject) {
                seenSubjects.add(s.subject);
                if (!bySubject[s.subject]) {
                    bySubject[s.subject] = {
                        total: 0, sum: 0, passed: 0, mastered: 0
                    };
                }
                const b = bySubject[s.subject];
                b.total++;
                b.sum += s.score;
                if (s.score >= 50) b.passed++;
                if (s.score >= 70) b.mastered++;
            }
            if (s.level) {
                if (!byLevel[s.level]) byLevel[s.level] = { total: 0, sum: 0 };
                byLevel[s.level].total++;
                byLevel[s.level].sum += s.score;
            }
        }

        lastDoc = snap.docs[snap.docs.length - 1];
        pages++;
        if (snap.size < PAGE_SIZE) break;
    }

    if (totals.totalScores === 0) {
        console.log(`  ⏭ ${schoolId}: no scores, skipping snapshot`);
        return false;
    }

    // Compute derived metrics
    const avgScore = Math.round(totals.scoreSum / totals.totalScores);
    const passRate = Math.round((totals.passed / totals.totalScores) * 100);
    const mastery = Math.round((totals.mastered / totals.totalScores) * 100);

    const subjectSummary = {};
    for (const [subject, b] of Object.entries(bySubject)) {
        subjectSummary[subject] = {
            total: b.total,
            avgScore: Math.round(b.sum / b.total),
            passRate: Math.round((b.passed / b.total) * 100),
            mastery: Math.round((b.mastered / b.total) * 100)
        };
    }

    const levelSummary = {};
    for (const [level, b] of Object.entries(byLevel)) {
        levelSummary[level] = {
            total: b.total,
            avgScore: Math.round(b.sum / b.total)
        };
    }

    // Total students & teachers — cheap count reads via aggregation
    // (Firestore supports count() since v9.11 / Admin SDK 11.5+)
    let totalStudents = 0;
    let totalTeachers = 0;
    try {
        const [studentsAgg, teachersAgg] = await Promise.all([
            db.collection('students').where('schoolId', '==', schoolId).count().get(),
            db.collection('teachers').where('schoolId', '==', schoolId).count().get()
        ]);
        totalStudents = studentsAgg.data().count;
        totalTeachers = teachersAgg.data().count;
    } catch (e) {
        // Fallback if count() isn't available — do not fail the whole snapshot
        console.warn(`  count() unavailable for ${schoolId}:`, e.message);
    }

    const today = new Date().toISOString().slice(0, 10);
    const snapshotId = `${schoolId}_${today}`;

    await db.collection('report_snapshots').doc(snapshotId).set({
        schoolId,
        date: today,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),

        // Headline numbers
        totalStudents,
        totalTeachers,
        totalScores: totals.totalScores,
        studentsAssessed: seenStudents.size,
        subjectsTaught: seenSubjects.size,

        avgScore,
        passRate,
        competencyMastery: mastery,

        // Distribution of scores across CBC bands
        bands: {
            excellent: totals.excellent,
            good: totals.good,
            satisfactory: totals.satisfactory,
            needsImprovement: totals.needsImprovement,
            belowExpectation: totals.belowExpectation
        },

        // Per-subject and per-level breakdowns
        bySubject: subjectSummary,
        byLevel: levelSummary
    }, { merge: true });

    // Also keep a rolling "latest" pointer so Reports.jsx doesn't
    // have to guess today's date.
    await db.collection('report_latest').doc(schoolId).set({
        snapshotId,
        schoolId,
        date: today,
        generatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`  ✔ ${schoolId}: snapshot ${snapshotId} (${totals.totalScores} scores)`);
    return true;
}
