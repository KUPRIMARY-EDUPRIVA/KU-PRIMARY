import {
    deleteField, doc, runTransaction, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { LEVEL_CLASSES, LEVEL_ORDER } from '../utils/constants';

export const YEAR_END_DECISIONS = Object.freeze({
    PROMOTE: 'promote',
    REPEAT: 'repeat',
    TRANSFER: 'transfer',
    GRADUATE: 'graduate',
    ARCHIVE: 'archive',
});

const EXIT_DECISIONS = new Set([
    YEAR_END_DECISIONS.TRANSFER,
    YEAR_END_DECISIONS.GRADUATE,
    YEAR_END_DECISIONS.ARCHIVE,
]);
const CLOSED_STATUSES = new Set(['archived', 'graduated', 'transferred', 'deleted']);

function requiredText(value, field, maxLength = 128) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error(`${field} is required`);
    if (text.length > maxLength) throw new Error(`${field} is too long`);
    return text;
}

async function operationDocumentId(schoolId, studentId, academicYear) {
    if (!window.crypto?.subtle || typeof window.TextEncoder === 'undefined') {
        throw new Error('Secure hashing is unavailable; cannot safely identify this year-end operation');
    }
    const input = new window.TextEncoder().encode(JSON.stringify([schoolId, studentId, academicYear]));
    const digest = await window.crypto.subtle.digest('SHA-256', input);
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `v1_${hash}`;
}

function canonicalize(value) {
    if (value instanceof Date) return { date: value.toISOString() };
    if (value && typeof value.toMillis === 'function') return { timestamp: value.toMillis() };
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((result, key) => {
            result[key] = canonicalize(value[key]);
            return result;
        }, {});
    }
    return value;
}

function valuesMatch(left, right) {
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function getClassSequence(levelClasses) {
    return LEVEL_ORDER.flatMap((level) => (
        Array.isArray(levelClasses[level])
            ? levelClasses[level].map((studentClass) => ({ level, class: studentClass }))
            : []
    ));
}

/**
 * Return the next sequential CBC grade, including transitions between levels.
 * School-specific class lists can be supplied to support configured class names.
 */
export function getNextCbcGrade(level, studentClass, levelClasses = LEVEL_CLASSES) {
    const sequence = getClassSequence(levelClasses);
    const currentIndex = sequence.findIndex(
        (item) => item.level === level && item.class === studentClass
    );
    return currentIndex >= 0 ? sequence[currentIndex + 1] || null : null;
}

function prepareDecision({
    student, decision, targetLevel, targetClass, destinationSchool, archiveReason, levelClasses,
}) {
    if (!Object.values(YEAR_END_DECISIONS).includes(decision)) {
        throw new Error(`Unsupported year-end decision: ${decision}`);
    }
    if (!student.level || !student.class) {
        throw new Error('Student level and class are required for a year-end decision');
    }

    if (decision === YEAR_END_DECISIONS.PROMOTE) {
        const next = getNextCbcGrade(student.level, student.class, levelClasses);
        if (!next) throw new Error('Student has no next CBC grade; choose a graduation or archive decision');
        const resolvedLevel = targetLevel || next.level;
        const resolvedClass = targetClass || next.class;
        if (resolvedLevel !== next.level || resolvedClass !== next.class) {
            throw new Error(`Promotion must advance to ${next.level} ${next.class}`);
        }
        return { decision, targetLevel: resolvedLevel, targetClass: resolvedClass };
    }

    if (decision === YEAR_END_DECISIONS.TRANSFER) {
        return {
            decision,
            destinationSchool: requiredText(destinationSchool, 'destinationSchool', 256),
        };
    }
    if (decision === YEAR_END_DECISIONS.ARCHIVE) {
        return { decision, archiveReason: requiredText(archiveReason, 'archiveReason', 256) };
    }
    if (decision === YEAR_END_DECISIONS.GRADUATE) {
        const sequence = getClassSequence(levelClasses);
        const finalClass = sequence[sequence.length - 1];
        if (!finalClass || finalClass.level !== student.level || finalClass.class !== student.class) {
            throw new Error('Graduation is only valid for the final configured CBC class');
        }
    }
    return { decision };
}

function makeHistoryEntry({ decision, academicYear, student, request, occurredAt, notes }) {
    const entry = {
        type: decision === YEAR_END_DECISIONS.PROMOTE ? 'promotion' : decision,
        decision,
        year: academicYear,
        academicYear,
        date: occurredAt.toISOString(),
        fromLevel: student.level,
        fromClass: student.class,
    };
    if (decision === YEAR_END_DECISIONS.PROMOTE) {
        entry.toLevel = request.targetLevel;
        entry.toClass = request.targetClass;
    }
    if (decision === YEAR_END_DECISIONS.TRANSFER) {
        entry.destinationSchool = request.destinationSchool;
    }
    if (decision === YEAR_END_DECISIONS.ARCHIVE) entry.reason = request.archiveReason;
    if (notes) entry.notes = notes;
    return entry;
}

function makeStudentUpdate({ decision, academicYear, operationId, student, request, historyEntry, actorId, occurredAt }) {
    const update = {
        status: 'active',
        isActive: true,
        history: [...(Array.isArray(student.history) ? student.history : []), historyEntry],
        lastYearEndOperationId: operationId,
        lastYearEndDecision: decision,
        lastYearEndAcademicYear: academicYear,
        updatedAt: serverTimestamp(),
    };

    if (decision === YEAR_END_DECISIONS.PROMOTE) {
        update.level = request.targetLevel;
        update.class = request.targetClass;
        update.promotedAt = occurredAt.toISOString();
        update.promotionYear = academicYear;
        update.promotedBy = actorId || '';
    } else if (decision === YEAR_END_DECISIONS.REPEAT) {
        update.repeatCount = (Number(student.repeatCount) || 0) + 1;
        update.lastRepeatedYear = academicYear;
        update.repeatedAt = occurredAt.toISOString();
        update.repeatedBy = actorId || '';
    } else if (decision === YEAR_END_DECISIONS.TRANSFER) {
        update.status = 'transferred';
        update.isActive = false;
        update.destinationSchool = request.destinationSchool;
        update.transferredAt = occurredAt.toISOString();
        update.transferYear = academicYear;
        update.transferredBy = actorId || '';
    } else if (decision === YEAR_END_DECISIONS.GRADUATE) {
        update.status = 'graduated';
        update.isActive = false;
        update.graduatedAt = occurredAt.toISOString();
        update.graduationYear = academicYear;
        update.graduatedBy = actorId || '';
    } else {
        update.status = 'archived';
        update.isActive = false;
        update.archivedAt = occurredAt.toISOString();
        update.archiveReason = request.archiveReason;
        update.archivedBy = actorId || '';
    }
    return update;
}

/**
 * Atomically records one student's year-end decision.
 * Each student is an independent transaction, so bulk callers can safely retry
 * failed students without repeating decisions that were already committed.
 */
export async function applyStudentYearEndDecision({
    schoolId: rawSchoolId,
    studentId: rawStudentId,
    academicYear: rawAcademicYear,
    decision,
    targetLevel,
    targetClass,
    destinationSchool,
    archiveReason,
    notes = '',
    recordedBy = '',
    levelClasses = LEVEL_CLASSES,
}) {
    const schoolId = requiredText(rawSchoolId, 'schoolId');
    const studentId = requiredText(rawStudentId, 'studentId');
    const academicYear = requiredText(rawAcademicYear, 'academicYear', 32);
    const actorId = String(recordedBy ?? '').trim();
    const cleanNotes = String(notes ?? '').trim();
    const operationId = await operationDocumentId(schoolId, studentId, academicYear);
    const studentRef = doc(db, 'students', studentId);
    const operationRef = doc(db, 'student_promotion_operations', operationId);
    const archiveRef = doc(db, 'student_archives', operationId);
    const occurredAt = new Date();

    return runTransaction(db, async (transaction) => {
        const [studentSnapshot, operationSnapshot] = await Promise.all([
            transaction.get(studentRef),
            transaction.get(operationRef),
        ]);

        if (!studentSnapshot.exists()) throw new Error('Student not found');
        const student = studentSnapshot.data();
        if (student.schoolId !== schoolId) throw new Error('Student does not belong to this school');

        const existingOperation = operationSnapshot.exists() ? operationSnapshot.data() : null;
        if (operationSnapshot.exists()) {
            if (existingOperation.schoolId !== schoolId || existingOperation.studentId !== studentId) {
                throw new Error('Year-end operation marker does not match the requested student');
            }
        }
        const decisionStudent = existingOperation?.beforeStudent || student;
        const request = prepareDecision({
            student: decisionStudent,
            decision,
            targetLevel: targetLevel || existingOperation?.request?.targetLevel,
            targetClass: targetClass || existingOperation?.request?.targetClass,
            destinationSchool: destinationSchool || existingOperation?.request?.destinationSchool,
            archiveReason: archiveReason || existingOperation?.request?.archiveReason,
            levelClasses,
        });
        const requestRecord = { ...request, notes: cleanNotes };

        if (existingOperation) {
            if (JSON.stringify(existingOperation.request) !== JSON.stringify(requestRecord)) {
                throw new Error(`A different year-end decision is already recorded for ${academicYear}`);
            }
            if (EXIT_DECISIONS.has(existingOperation.action)) {
                await transaction.get(archiveRef);
            }
            return {
                operationId,
                status: existingOperation.status === 'rolled_back' ? 'rolled_back' : 'already_applied',
            };
        }
        const archiveSnapshot = EXIT_DECISIONS.has(decision)
            ? await transaction.get(archiveRef)
            : null;
        if (archiveSnapshot?.exists()) {
            throw new Error('Archive exists without its operation marker; refusing to overwrite it');
        }
        if (student.isDeleted || student.isActive === false || CLOSED_STATUSES.has(student.status)) {
            throw new Error('Student is inactive or already archived');
        }
        if ((Array.isArray(student.history) ? student.history : []).some(
            (entry) => String(entry?.academicYear ?? entry?.year ?? '') === academicYear
                && ['promotion', 'repeat', 'transfer', 'graduate', 'graduation', 'archive'].includes(entry?.type)
        )) {
            throw new Error(`A year-end decision is already present in student history for ${academicYear}`);
        }

        const historyEntry = makeHistoryEntry({
            decision, academicYear, student, request, occurredAt, notes: cleanNotes,
        });
        const studentUpdate = makeStudentUpdate({
            decision,
            academicYear,
            operationId,
            student,
            request,
            historyEntry,
            actorId,
            occurredAt,
        });
        const changedFields = Object.keys(studentUpdate).filter((field) => field !== 'updatedAt');
        const operationData = {
            schoolId,
            studentId,
            academicYear,
            operationId,
            action: decision,
            request: requestRecord,
            status: 'applied',
            beforeStudent: student,
            changedFields,
            after: {
                ...changedFields.reduce((result, field) => {
                    result[field] = studentUpdate[field];
                    return result;
                }, {}),
            },
            recordedBy: actorId,
            createdAt: serverTimestamp(),
        };

        if (EXIT_DECISIONS.has(decision)) {
            transaction.set(archiveRef, {
                schoolId,
                studentId,
                operationId,
                academicYear,
                action: decision,
                archivedAt: occurredAt.toISOString(),
                archivedBy: actorId,
                reason: decision === YEAR_END_DECISIONS.TRANSFER
                    ? 'transfer'
                    : decision === YEAR_END_DECISIONS.GRADUATE
                        ? 'graduation'
                        : request.archiveReason,
                studentSnapshot: student,
                createdAt: serverTimestamp(),
            });
        }
        transaction.update(studentRef, studentUpdate);
        transaction.set(operationRef, operationData);
        return { operationId, status: 'applied' };
    });
}

/**
 * Apply independent per-student operations. Results identify successes and
 * failures so a caller can retry only failed student transactions.
 */
export async function applyStudentYearEndDecisions(decisions) {
    if (!Array.isArray(decisions)) throw new Error('decisions must be an array');
    const results = [];
    for (const item of decisions) {
        try {
            results.push({
                studentId: item.studentId,
                ...(await applyStudentYearEndDecision(item)),
            });
        } catch (error) {
            results.push({
                studentId: item.studentId,
                status: 'failed',
                error: error.message,
            });
        }
    }
    return results;
}

/**
 * Reverse a committed operation only when its marker is still the student's
 * latest year-end operation. Snapshot restoration and rollback markers commit
 * atomically; archive records are retained and marked reversed, never deleted.
 */
export async function rollbackStudentYearEndDecision({
    schoolId: rawSchoolId,
    studentId: rawStudentId,
    academicYear: rawAcademicYear,
    reversedBy = '',
}) {
    const schoolId = requiredText(rawSchoolId, 'schoolId');
    const studentId = requiredText(rawStudentId, 'studentId');
    const academicYear = requiredText(rawAcademicYear, 'academicYear', 32);
    const operationId = await operationDocumentId(schoolId, studentId, academicYear);
    const studentRef = doc(db, 'students', studentId);
    const operationRef = doc(db, 'student_promotion_operations', operationId);
    const archiveRef = doc(db, 'student_archives', operationId);
    const actorId = String(reversedBy ?? '').trim();

    return runTransaction(db, async (transaction) => {
        const [studentSnapshot, operationSnapshot] = await Promise.all([
            transaction.get(studentRef),
            transaction.get(operationRef),
        ]);
        if (!operationSnapshot.exists()) throw new Error('Year-end operation not found');
        const operation = operationSnapshot.data();
        if (operation.schoolId !== schoolId || operation.studentId !== studentId) {
            throw new Error('Year-end operation does not belong to this student');
        }
        if (operation.status === 'rolled_back') {
            return { operationId, status: 'already_rolled_back' };
        }
        const archiveSnapshot = EXIT_DECISIONS.has(operation.action)
            ? await transaction.get(archiveRef)
            : null;
        if (!studentSnapshot.exists()) throw new Error('Student record is missing; refusing rollback');
        const student = studentSnapshot.data();
        if (student.schoolId !== schoolId) throw new Error('Student does not belong to this school');
        if (student.lastYearEndOperationId !== operationId) {
            throw new Error('Student has changed since this operation; refusing to overwrite newer data');
        }

        if (!Array.isArray(operation.changedFields) || !operation.beforeStudent || !operation.after) {
            throw new Error('Year-end operation is missing rollback data; refusing to modify the student');
        }
        const restore = {};
        operation.changedFields.forEach((field) => {
            const existedBefore = Object.prototype.hasOwnProperty.call(operation.beforeStudent, field);
            const existsNow = Object.prototype.hasOwnProperty.call(student, field);
            if (existsNow !== Object.prototype.hasOwnProperty.call(operation.after, field)
                || (existsNow && !valuesMatch(student[field], operation.after[field]))) {
                throw new Error(`Student field "${field}" changed after this operation; refusing rollback`);
            }
            restore[field] = existedBefore ? operation.beforeStudent[field] : deleteField();
        });
        restore.updatedAt = serverTimestamp();

        transaction.update(studentRef, restore);
        transaction.update(operationRef, {
            status: 'rolled_back',
            rolledBackAt: serverTimestamp(),
            rolledBackBy: actorId,
        });
        if (archiveSnapshot?.exists()) {
            transaction.update(archiveRef, {
                status: 'reversed',
                reversedAt: serverTimestamp(),
                reversedBy: actorId,
            });
        }
        return { operationId, status: 'rolled_back' };
    });
}
