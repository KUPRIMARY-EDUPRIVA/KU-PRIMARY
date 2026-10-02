// netlify/functions/chatbot-performance.js
//
// Computes performance summaries for the chatbot.
//
// POST body:
//   {
//     class?: 'Grade 7',            // optional, exact class name
//     level?: 'junior-school',      // optional
//     term?: 'Term 1',
//     year?: 2026,
//     scope?: 'school' | 'class' | 'top'
//   }
//
// Response: { success, summary, data }

const { requireAuth, json, errorResponse } = require('./_lib/chatbotAuth');
const { initAdmin } = require('./_lib/firebaseAdmin');

// Cap per-query reads. Chatbot answers are summaries — we don't need
// every single score. If a school exceeds this, results are still
// representative (they come back in Firestore's default order).
const MAX_SCORES = 5000;
const MAX_STUDENT_LOOKUPS = 500;
const STUDENT_IN_CHUNK = 10;

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
        return json(405, { success: false, error: 'Method not allowed' });
    }

    try {
        const { schoolId } = await requireAuth(event);

        let params = {};
        if (event.httpMethod === 'POST') {
            try { params = JSON.parse(event.body || '{}'); } catch {}
        } else {
            params = event.queryStringParameters || {};
        }

        const term = params.term || 'Term 1';
        const year = Number(params.year || new Date().getFullYear());
        const scope = params.scope || 'school';
        const className = params.class || null;
        const level = params.level || null;

        const admin = initAdmin();
        const db = admin.firestore();

        // ------------------------------------------------------------
        // 1. Query scores for this term (and optionally level/class).
        //
        // NOTE: student_scores documents — as written by Results.jsx —
        // do NOT carry a `year` field. They carry `recordedAt` (a
        // Firestore Timestamp) and `createdAt`. To honour the caller's
        // `year` we filter by date range on `recordedAt` when possible.
        //
        // If older scores lack `recordedAt`, the where clause silently
        // excludes them. That's a deliberate trade-off — a wrong answer
        // is worse than a missing one for a chatbot.
        // ------------------------------------------------------------
        const yearStart = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
        const yearEnd   = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0));

        let scoresQuery = db.collection('student_scores')
            .where('schoolId', '==', schoolId)
            .where('term', '==', term)
            .where('recordedAt', '>=', yearStart)
            .where('recordedAt', '<', yearEnd)
            .limit(MAX_SCORES);

        if (level)     scoresQuery = scoresQuery.where('level', '==', level);
        if (className) scoresQuery = scoresQuery.where('class', '==', className);

        let scoresSnap;
        try {
            scoresSnap = await scoresQuery.get();
        } catch (queryErr) {
            // Missing composite index, or old docs without recordedAt.
            // Retry once without the date range so the chatbot still
            // produces *something* useful, and flag it in the response.
            console.warn('[chatbot-performance] year-filtered query failed, retrying without year:', queryErr.message);
            let fallback = db.collection('student_scores')
                .where('schoolId', '==', schoolId)
                .where('term', '==', term)
                .limit(MAX_SCORES);
            if (level)     fallback = fallback.where('level', '==', level);
            if (className) fallback = fallback.where('class', '==', className);
            scoresSnap = await fallback.get();
        }

        if (scoresSnap.empty) {
            return json(200, {
                success: true,
                summary: `No scores recorded yet for ${term} ${year}${className ? ` in ${className}` : ''}.`,
                data: { term, year, scope, className, level, studentsCount: 0, warnings: [] },
            });
        }

        // ------------------------------------------------------------
        // 2. Aggregate by studentId.
        // ------------------------------------------------------------
        const byStudent = new Map();
        scoresSnap.forEach((d) => {
            const s = d.data();
            if (!s.studentId || s.score == null) return;
            const score = Number(s.score);
            if (!Number.isFinite(score)) return;

            if (!byStudent.has(s.studentId)) {
                byStudent.set(s.studentId, {
                    studentId: s.studentId,
                    studentName: s.studentName || s.name || null, // may be null
                    className: s.class || s.className || 'N/A',
                    level: s.level || 'N/A',
                    totalScore: 0,
                    subjectCount: 0,
                    subjects: new Set(),
                });
            }
            const agg = byStudent.get(s.studentId);
            agg.totalScore += score;
            agg.subjectCount += 1;
            if (s.subject) agg.subjects.add(s.subject);
        });

        if (byStudent.size === 0) {
            return json(200, {
                success: true,
                summary: `No usable scores found for ${term} ${year}.`,
                data: { term, year, scope, className, level, studentsCount: 0, warnings: [] },
            });
        }

        // ------------------------------------------------------------
        // 3. Resolve student names from the `students` collection for
        //    any studentId whose score record doesn't carry a name.
        //
        //    Firestore's `in` operator allows at most 10 values per
        //    query, so chunk the IDs.
        // ------------------------------------------------------------
        const warnings = [];
        const needNames = [...byStudent.values()]
            .filter((s) => !s.studentName)
            .map((s) => s.studentId)
            .slice(0, MAX_STUDENT_LOOKUPS);

        if (needNames.length > 0) {
            const chunks = [];
            for (let i = 0; i < needNames.length; i += STUDENT_IN_CHUNK) {
                chunks.push(needNames.slice(i, i + STUDENT_IN_CHUNK));
            }

            const nameMap = new Map();
            await Promise.all(chunks.map(async (chunk) => {
                try {
                    const snap = await db.collection('students')
                        .where('__name__', 'in', chunk)
                        .get();
                    snap.forEach((docSnap) => {
                        const data = docSnap.data() || {};
                        const fullName = data.fullName
                            || [data.firstName, data.lastName].filter(Boolean).join(' ').trim()
                            || data.name
                            || '';
                        if (fullName) nameMap.set(docSnap.id, fullName);
                    });
                } catch (err) {
                    console.warn('[chatbot-performance] student lookup failed for chunk:', err.message);
                }
            }));

            byStudent.forEach((s) => {
                if (!s.studentName && nameMap.has(s.studentId)) {
                    s.studentName = nameMap.get(s.studentId);
                }
            });
        }

        const stillNameless = [...byStudent.values()].filter((s) => !s.studentName).length;
        if (stillNameless > 0) {
            warnings.push(`${stillNameless} student name${stillNameless === 1 ? '' : 's'} could not be resolved from the students collection.`);
        }
        if (needNames.length === MAX_STUDENT_LOOKUPS) {
            warnings.push(`Name lookup was capped at ${MAX_STUDENT_LOOKUPS} students.`);
        }

        // ------------------------------------------------------------
        // 4. Compute averages + sort.
        // ------------------------------------------------------------
        const students = [...byStudent.values()].map((s) => ({
            studentId: s.studentId,
            studentName: s.studentName || 'Student',
            className: s.className,
            level: s.level,
            totalScore: s.totalScore,
            subjectCount: s.subjectCount,
            subjectCount2: s.subjectCount,
            subjects: [...s.subjects],
            average: s.subjectCount > 0
                ? Math.round((s.totalScore / s.subjectCount) * 100) / 100
                : 0,
        }));

        const ranked = [...students].sort((a, b) => b.average - a.average);
        const overallAverage = Math.round(
            (ranked.reduce((sum, s) => sum + s.average, 0) / ranked.length) * 100
        ) / 100;

        const scopeLabel = className
            ? `class ${className}`
            : level
                ? `level ${level}`
                : 'the whole school';

        // ------------------------------------------------------------
        // 5. "Top performers" scope.
        // ------------------------------------------------------------
        if (scope === 'top') {
            const topN = ranked.slice(0, Math.min(5, ranked.length));
            const lines = topN.map((s, i) =>
                `${i + 1}. ${s.studentName} (${s.className}) — ${s.average}%`
            );
            return json(200, {
                success: true,
                summary: `Top performers for ${term} ${year} (${scopeLabel}):\n${lines.join('\n')}`,
                data: {
                    top: topN,
                    overallAverage,
                    studentsCount: students.length,
                    term,
                    year,
                    className,
                    level,
                    warnings,
                },
            });
        }

        // ------------------------------------------------------------
        // 6. Default scope: school / class overview.
        // ------------------------------------------------------------
        const best = ranked[0];
        const worst = ranked[ranked.length - 1];

        const summary =
            `Performance summary for ${scopeLabel}, ${term} ${year}:\n` +
            `• Students assessed: ${students.length}\n` +
            `• Average score: ${overallAverage}%\n` +
            `• Top student: ${best.studentName} (${best.className}) — ${best.average}%\n` +
            (students.length > 1
                ? `• Lowest: ${worst.studentName} (${worst.className}) — ${worst.average}%`
                : '');

        return json(200, {
            success: true,
            summary,
            data: {
                overallAverage,
                studentsCount: students.length,
                best,
                worst,
                ranked: ranked.slice(0, 10),
                term,
                year,
                className,
                level,
                warnings,
            },
        });
    } catch (err) {
        console.error('[chatbot-performance]', err);
        return errorResponse(err);
    }
};
