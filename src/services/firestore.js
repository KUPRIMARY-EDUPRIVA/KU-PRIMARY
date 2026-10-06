// src/services/firestore.js
import {
    collection, query, where, getDocs, doc, getDoc,
    orderBy, limit, startAfter, writeBatch, setDoc,
    serverTimestamp, onSnapshot
} from 'firebase/firestore';
import { db } from '../firebase';
import { normalizeAdmissionNumber } from './admissionNumberService';
import {
    makeScoreId, makeAssessmentConfigId,
    makePaperConfigId
} from '../utils/scoreId';
import {
    withMemoryCache, getMemory, setMemory, idbGet, idbSet
} from './cache';
import { computeScorePercentage } from '../utils/constants';

// ============================================================
// TENANT GUARD
// ============================================================
export function requireSchoolId(userData) {
    const schoolId = userData?.schoolId;
    if (!schoolId) {
        throw new Error('School context missing. Please re-login.');
    }
    return schoolId;
}

// ============================================================
// ASSESSMENT CONFIGS
// ============================================================
export async function getAssessmentConfigs(schoolId, { level, cls, subject } = {}) {
    const cacheKey = `configs_${schoolId}_${level || 'all'}_${cls || 'all'}_${subject || 'all'}`;
    const cached = getMemory(cacheKey);
    if (cached) return cached;

    const constraints = [where('schoolId', '==', schoolId)];
    if (level) constraints.push(where('level', '==', level));
    if (cls) constraints.push(where('class', '==', cls));
    if (subject) constraints.push(where('subject', '==', subject));

    const q = query(collection(db, 'assessment_configs'), ...constraints);
    const snap = await getDocs(q);
    const configs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setMemory(cacheKey, configs, 30 * 60 * 1000);
    return configs;
}

export async function saveAssessmentConfig(schoolId, { level, cls, subject, assessmentType, term, deadline, createdBy }) {
    const id = makeAssessmentConfigId(schoolId, level, cls, subject, assessmentType, term);
    const ref = doc(db, 'assessment_configs', id);
    await setDoc(ref, {
        schoolId, level, class: cls, subject, assessmentType, term,
        deadline: deadline instanceof Date ? deadline : new Date(deadline),
        createdBy: createdBy || '',
        createdAt: serverTimestamp(),
        isActive: true
    }, { merge: true });
    setMemory(`configs_${schoolId}_${level}_${cls}_${subject}`, null, 0);
    return id;
}

// ============================================================
// PAPER CONFIGS — multi-paper subject support
// ============================================================

/**
 * Fetch the paper configuration for a single (school, level, subject).
 * Returns { papers: [{ name, maxScore, weight }] } or { papers: [] }
 * if the subject is single-paper (default).
 */
export async function getPaperConfig(schoolId, level, subject) {
    if (!schoolId || !level || !subject) return { papers: [] };

    const cacheKey = `papercfg_${schoolId}_${level}_${subject}`;
    const cached = getMemory(cacheKey);
    if (cached) return cached;

    const id = makePaperConfigId(schoolId, level, subject);
    const snap = await getDoc(doc(db, 'subject_paper_configs', id));
    if (!snap.exists()) {
        const empty = { papers: [] };
        setMemory(cacheKey, empty, 10 * 60 * 1000);
        return empty;
    }
    const data = snap.data();
    const result = {
        papers: Array.isArray(data.papers) ? data.papers : []
    };
    setMemory(cacheKey, result, 10 * 60 * 1000);
    return result;
}

/**
 * Fetch all paper configs for a level in one query.
 * Returns a map: { subjectName: [papers] }
 */
export async function getAllPaperConfigsForLevel(schoolId, level) {
    if (!schoolId || !level) return {};

    const cacheKey = `papercfgs_${schoolId}_${level}`;
    const cached = getMemory(cacheKey);
    if (cached) return cached;

    const q = query(
        collection(db, 'subject_paper_configs'),
        where('schoolId', '==', schoolId),
        where('level', '==', level)
    );
    const snap = await getDocs(q);
    const out = {};
    snap.docs.forEach(d => {
        const data = d.data();
        if (data.subject) {
            out[data.subject] = Array.isArray(data.papers) ? data.papers : [];
        }
    });
    setMemory(cacheKey, out, 10 * 60 * 1000);
    return out;
}

/**
 * Persist a subject's paper configuration.
 * papers: [{ name, maxScore, weight }, ...]  (empty array = single-paper subject)
 */
export async function savePaperConfig(schoolId, level, subject, papers, userId) {
    if (!schoolId || !level || !subject) {
        throw new Error('savePaperConfig: schoolId, level and subject are required');
    }
    const id = makePaperConfigId(schoolId, level, subject);
    const clean = Array.isArray(papers)
        ? papers.map(p => ({
            name: String(p.name || '').trim(),
            maxScore: Number(p.maxScore ?? p.max) || 100,
            weight: Number(p.weight) || 0
        }))
        : [];

    await setDoc(doc(db, 'subject_paper_configs', id), {
        schoolId, level, subject,
        papers: clean,
        updatedAt: serverTimestamp(),
        updatedBy: userId || 'system'
    }, { merge: true });

    // Invalidate caches
    setMemory(`papercfg_${schoolId}_${level}_${subject}`, null, 0);
    setMemory(`papercfgs_${schoolId}_${level}`, null, 0);

    return id;
}

// ============================================================
// STUDENTS
// ============================================================
export async function getStudents(schoolId, level, cls, { maxResults = 500 } = {}) {
    const q = query(
        collection(db, 'students'),
        where('schoolId', '==', schoolId),
        where('level', '==', level),
        where('class', '==', cls),
        orderBy('firstName'),
        limit(maxResults)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export function subscribeStudentsPage(schoolId, level, cls, pageSize = 10, callback) {
    const q = query(
        collection(db, 'students'),
        where('schoolId', '==', schoolId),
        where('level', '==', level),
        where('class', '==', cls),
        orderBy('firstName'),
        limit(pageSize)
    );
    return onSnapshot(q, (snap) => {
        callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
}

// ============================================================
// SCORES
// ============================================================

export async function getScores(schoolId, level, cls, subject, term, assessmentType) {
    const cacheKey = `scores_${schoolId}_${level}_${cls}_${subject}_${term}_${assessmentType}`;
    const cached = getMemory(cacheKey);
    if (cached) return cached;

    const q = query(
        collection(db, 'student_scores'),
        where('schoolId', '==', schoolId),
        where('level', '==', level),
        where('class', '==', cls),
        where('subject', '==', subject),
        where('term', '==', term),
        where('assessmentType', '==', assessmentType)
    );
    const snap = await getDocs(q);
    const scores = {};
    snap.forEach(d => {
        const data = d.data();
        // Backfill computedPercentage for legacy records
        const enriched = {
            id: d.id,
            ...data,
            computedPercentage:
                data.computedPercentage != null
                    ? data.computedPercentage
                    : computeScorePercentage(data)
        };
        if (!scores[data.studentId]) scores[data.studentId] = [];
        scores[data.studentId].push(enriched);
    });
    setMemory(cacheKey, scores, 2 * 60 * 1000);
    return scores;
}

/**
 * Normalise a raw entry into the storage payload.
 * Accepts either:
 *   { studentId, score, maxScore? }                -> single score
 *   { studentId, papers: { 'P1': {...}, ... } }    -> multi-paper
 */
function normalizeScoreEntry(entry) {
    const { studentId } = entry;

    // ---- Multi-paper ----
    if (entry.papers && typeof entry.papers === 'object' && Object.keys(entry.papers).length > 0) {
        const cleaned = {};
        let weighted = 0;
        let weightSum = 0;
        let valid = 0;

        Object.entries(entry.papers).forEach(([name, p]) => {
            const score = Number(p?.score);
            const max = Number(p?.max ?? p?.maxScore);
            const weight = Number(p?.weight) || 0;
            const hasValue = Number.isFinite(score);
            cleaned[name] = {
                score: hasValue ? score : null,
                max: Number.isFinite(max) && max > 0 ? max : 100,
                weight
            };
            if (hasValue && cleaned[name].max > 0) {
                const raw = (score / cleaned[name].max) * 100;
                weighted += raw * (weight / 100);
                weightSum += weight;
                valid++;
            }
        });

        let computed = null;
        if (valid > 0) {
            computed = weightSum > 0 && Math.abs(weightSum - 100) > 0.01
                ? Math.round((weighted / weightSum) * 100)
                : Math.round(weighted);
        }

        return {
            studentId,
            papers: cleaned,
            // convenience: store score = computed so legacy readers still work
            score: computed,
            maxScore: 100,
            computedPercentage: computed
        };
    }

    // ---- Single score ----
    const score = Number(entry.score);
    const maxScore = Number(entry.maxScore) > 0 ? Number(entry.maxScore) : 100;
    if (!Number.isFinite(score)) {
        return { studentId, score: null, maxScore, computedPercentage: null };
    }
    const computed = Math.round((score / maxScore) * 100);
    return { studentId, score, maxScore, computedPercentage: computed };
}

export async function saveScoresBatch(
    schoolId, level, cls, subject, term, assessmentType,
    entries, teacherMeta = {}
) {
    if (!entries || entries.length === 0) return { count: 0 };
    if (entries.length > 500) throw new Error('Batch exceeds 500 operations');

    const batch = writeBatch(db);

    for (const raw of entries) {
        const norm = normalizeScoreEntry(raw);
        if (norm.score == null && !norm.papers) continue; // skip fully-empty

        const id = makeScoreId(norm.studentId, subject, term, assessmentType);
        const ref = doc(db, 'student_scores', id);

        const payload = {
            studentId: norm.studentId,
            schoolId,
            level,
            class: cls,
            subject,
            term,
            assessmentType,
            score: norm.score,
            maxScore: norm.maxScore,
            computedPercentage: norm.computedPercentage,
            teacherId: teacherMeta.teacherId || '',
            teacherName: teacherMeta.teacherName || '',
            status: 'pending',
            recordedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        // Only add `papers` when multi-paper; otherwise ensure it's cleared.
        payload.papers = norm.papers || null;

        batch.set(ref, payload, { merge: true });
    }

    await batch.commit();

    // Invalidate caches
    setMemory(`scores_${schoolId}_${level}_${cls}_${subject}_${term}_${assessmentType}`, null, 0);

    return { count: entries.length };
}

export async function publishScoresBatch(schoolId, level, cls, subject, term, assessmentType, studentIds) {
    const batch = writeBatch(db);
    for (const studentId of studentIds) {
        const id = makeScoreId(studentId, subject, term, assessmentType);
        batch.update(doc(db, 'student_scores', id), {
            status: 'published',
            publishedAt: serverTimestamp()
        });
    }
    await batch.commit();
    setMemory(`scores_${schoolId}_${level}_${cls}_${subject}_${term}_${assessmentType}`, null, 0);
}

// ============================================================
// CLASS SUMMARIES
// ============================================================
export async function getClassSummary(schoolId, level, cls, subject, term) {
    const cacheKey = `summary_${schoolId}_${level}_${cls}_${subject}_${term}`;
    const cached = getMemory(cacheKey);
    if (cached) return cached;

    const id = `${schoolId}__${level}__${cls}__${subject}__${term}`.replace(/\s+/g, '_');
    const snap = await getDoc(doc(db, 'class_summaries', id));
    if (!snap.exists()) return null;
    const data = snap.data();
    setMemory(cacheKey, data, 5 * 60 * 1000);
    return data;
}

// ============================================================
// TENANT-SAFE STUDENT FETCH
// ============================================================
export async function findStudentByAdmission(schoolId, level, cls, admissionNumber) {
    const normalized = normalizeAdmissionNumber(admissionNumber);
    const candidates = [...new Set([
        normalized,
        String(admissionNumber ?? '').trim().toUpperCase(),
    ])];
    for (const candidate of candidates) {
        for (const field of ['admissionNumber', 'studentId']) {
            const q = query(
                collection(db, 'students'),
                where('schoolId', '==', schoolId),
                where('level', '==', level),
                where('class', '==', cls),
                where(field, '==', candidate),
                limit(1)
            );
            const snap = await getDocs(q);
            if (!snap.empty) {
                const d = snap.docs[0];
                return { id: d.id, ...d.data() };
            }
        }
    }
    return null;
}
