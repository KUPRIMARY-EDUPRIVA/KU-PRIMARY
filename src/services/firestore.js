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

const pendingReads = new Map();
const readVersions = new Map();
const knownReadKeys = new Set();

async function readCached(cacheKey, ttlMs, fetcher) {
    knownReadKeys.add(cacheKey);
    const cached = getMemory(cacheKey);
    if (cached !== null && cached !== undefined) return cached;
    if (pendingReads.has(cacheKey)) return pendingReads.get(cacheKey);

    const version = readVersions.get(cacheKey) || 0;
    const request = (async () => {
        const value = await fetcher();
        if ((readVersions.get(cacheKey) || 0) === version) setMemory(cacheKey, value, ttlMs);
        return value;
    })();
    pendingReads.set(cacheKey, request);
    try {
        return await request;
    } finally {
        if (pendingReads.get(cacheKey) === request) pendingReads.delete(cacheKey);
    }
}

function invalidateRead(cacheKey) {
    readVersions.set(cacheKey, (readVersions.get(cacheKey) || 0) + 1);
    pendingReads.delete(cacheKey);
    setMemory(cacheKey, null, 0);
}

function invalidateReadsForPrefix(prefix) {
    knownReadKeys.forEach((cacheKey) => {
        if (cacheKey.startsWith(prefix)) invalidateRead(cacheKey);
    });
}

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
    return readCached(cacheKey, 30 * 60 * 1000, async () => {
        const constraints = [where('schoolId', '==', schoolId)];
        if (level) constraints.push(where('level', '==', level));
        if (cls) constraints.push(where('class', '==', cls));
        if (subject) constraints.push(where('subject', '==', subject));

        const q = query(collection(db, 'assessment_configs'), ...constraints);
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    });
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
    invalidateReadsForPrefix(`configs_${schoolId}_`);
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
    return readCached(cacheKey, 10 * 60 * 1000, async () => {
        const id = makePaperConfigId(schoolId, level, subject);
        const snap = await getDoc(doc(db, 'subject_paper_configs', id));
        if (!snap.exists()) return { papers: [] };
        const data = snap.data();
        return { papers: Array.isArray(data.papers) ? data.papers : [] };
    });
}

/**
 * Fetch all paper configs for a level in one query.
 * Returns a map: { subjectName: [papers] }
 */
export async function getAllPaperConfigsForLevel(schoolId, level) {
    if (!schoolId || !level) return {};

    const cacheKey = `papercfgs_${schoolId}_${level}`;
    return readCached(cacheKey, 10 * 60 * 1000, async () => {
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
        return out;
    });
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
    invalidateRead(`papercfg_${schoolId}_${level}_${subject}`);
    invalidateRead(`papercfgs_${schoolId}_${level}`);

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
    return readCached(cacheKey, 2 * 60 * 1000, async () => {
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
        return scores;
    });
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
    invalidateRead(`scores_${schoolId}_${level}_${cls}_${subject}_${term}_${assessmentType}`);

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
    invalidateRead(`scores_${schoolId}_${level}_${cls}_${subject}_${term}_${assessmentType}`);
}

// ============================================================
// CLASS SUMMARIES
// ============================================================
export async function getClassSummary(schoolId, level, cls, subject, term) {
    const cacheKey = `summary_${schoolId}_${level}_${cls}_${subject}_${term}`;
    return readCached(cacheKey, 5 * 60 * 1000, async () => {
        const id = `${schoolId}__${level}__${cls}__${subject}__${term}`.replace(/\s+/g, '_');
        const snap = await getDoc(doc(db, 'class_summaries', id));
        return snap.exists() ? snap.data() : null;
    });
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
