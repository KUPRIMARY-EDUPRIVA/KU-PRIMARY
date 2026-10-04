// src/utils/scoreId.js

/**
 * Deterministic Firestore doc IDs — eliminates existence-check queries.
 * Every helper slugifies its inputs so the resulting ID is URL-safe and
 * stable across calls with the same logical key.
 */

const slug = (s) =>
    String(s || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[\/\\.#$\[\]]/g, '');

/**
 * Deterministic ID for a student's score record.
 * One doc per (studentId, subject, term, assessmentType).
 */
export function makeScoreId(studentId, subject, term, assessmentType) {
    if (!studentId || !subject || !term || !assessmentType) {
        throw new Error('makeScoreId: all arguments are required');
    }
    return `${slug(studentId)}__${slug(subject)}__${slug(term)}__${slug(assessmentType)}`;
}

/**
 * Deterministic ID for an assessment config.
 * One doc per (schoolId, level, class, subject, assessmentType, term).
 */
export function makeAssessmentConfigId(schoolId, level, cls, subject, assessmentType, term) {
    if (!schoolId || !level || !cls || !subject || !assessmentType || !term) {
        throw new Error('makeAssessmentConfigId: all arguments are required');
    }
    return `${slug(schoolId)}__${slug(level)}__${slug(cls)}__${slug(subject)}__${slug(assessmentType)}__${slug(term)}`;
}

/**
 * Deterministic ID for a class summary.
 * One doc per (schoolId, level, class, subject, term).
 */
export function makeClassSummaryId(schoolId, level, cls, subject, term) {
    if (!schoolId || !level || !cls || !subject || !term) {
        throw new Error('makeClassSummaryId: all arguments are required');
    }
    return `${slug(schoolId)}__${slug(level)}__${slug(cls)}__${slug(subject)}__${slug(term)}`;
}

/**
 * Deterministic ID for a subject's paper configuration.
 * One config per (schoolId, level, subject).
 */
export function makePaperConfigId(schoolId, level, subject) {
    if (!schoolId || !level || !subject) {
        throw new Error('makePaperConfigId: schoolId, level and subject are required');
    }
    return `${slug(schoolId)}__${slug(level)}__${slug(subject)}`;
}
