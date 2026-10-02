// netlify/functions/chatbot-performance.js
//
// Computes performance summaries for the chatbot.
//
// POST body: { class?: 'Grade 7', level?: 'junior-school', term?: 'Term 1', year?: 2026, scope: 'school'|'class'|'top' }
//
// Response: { success, summary, data }

const { requireAuth, json, errorResponse } = require('./_lib/chatbotAuth');
const { initAdmin } = require('./_lib/firebaseAdmin');

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

        // Pull scores for this term.
        // NOTE: this is a summary endpoint, so we cap the working set.
        let scoresQuery = db.collection('student_scores')
            .where('schoolId', '==', schoolId)
            .where('term', '==', term)
            .limit(5000);
        if (level) scoresQuery = scoresQuery.where('level', '==', level);
        if (className) scoresQuery = scoresQuery.where('class', '==', className);

        const scoresSnap = await scoresQuery.get();
        if (scoresSnap.empty) {
            return json(200, {
                success: true,
                summary: `No scores recorded yet for ${term} ${year}${className ? ` in ${className}` : ''}.`,
                data: { term, year, scope, className, level, studentsCount: 0 },
            });
        }

        // Aggregate: studentId -> { totalScore, subjectCount, subjectScores, className, name }
        const byStudent = new Map();
        scoresSnap.forEach((d) => {
            const s = d.data();
            if (!s.studentId || s.score == null) return;
            const score = Number(s.score);
            if (!Number.isFinite(score)) return;
            if (!byStudent.has(s.studentId)) {
                byStudent.set(s.studentId, {
                    studentId: s.studentId,
                    studentName: s.studentName || s.name || 'Student',
                    className: s.class || s.className || 'N/A',
                    level: s.level || 'N/A',
                    totalScore: 0,
                    subjectCount: 0,
                });
            }
            const agg = byStudent.get(s.studentId);
            agg.totalScore += score;
            agg.subjectCount += 1;
        });

        if (byStudent.size === 0) {
            return json(200, {
                success: true,
                summary: `No usable scores found for ${term} ${year}.`,
                data: { term, year, scope, className, level, studentsCount: 0 },
            });
        }

        const students = [...byStudent.values()].map((s) => ({
            ...s,
            average: s.subjectCount > 0 ? Math.round((s.totalScore / s.subjectCount) * 100) / 100 : 0,
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

        if (scope === 'top') {
            const topN = ranked.slice(0, Math.min(5, ranked.length));
            const lines = topN.map((s, i) =>
                `${i + 1}. ${s.studentName} (${s.className}) — ${s.average}%`
            );
            return json(200, {
                success: true,
                summary: `Top performers for ${term} ${year} (${scopeLabel}):\n${lines.join('\n')}`,
                data: { top: topN, overallAverage, studentsCount: students.length, term, year, className, level },
            });
        }

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
            },
        });
    } catch (err) {
        console.error('[chatbot-performance]', err);
        return errorResponse(err);
    }
};
