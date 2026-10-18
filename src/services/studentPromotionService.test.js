jest.mock('firebase/firestore', () => {
    const documents = new Map();
    const reads = [];
    const pathFor = (parts) => parts.filter(Boolean).join('/');
    return {
        __documents: documents,
        __reads: reads,
        doc: (_db, ...parts) => ({ path: pathFor(parts) }),
        deleteField: () => ({ __deleteField: true }),
        serverTimestamp: () => 'SERVER_TIMESTAMP',
        runTransaction: async (_db, callback) => {
            const writes = [];
            const transaction = {
                get: async (reference) => {
                    reads.push(reference.path);
                    const value = documents.get(reference.path);
                    return {
                        exists: () => value !== undefined,
                        data: () => value,
                    };
                },
                set: (reference, value) => writes.push({ type: 'set', reference, value }),
                update: (reference, value) => writes.push({ type: 'update', reference, value }),
            };
            const result = await callback(transaction);
            writes.forEach(({ type, reference, value }) => {
                if (type === 'update') {
                    if (!documents.has(reference.path)) throw new Error('missing update target');
                    const updated = { ...documents.get(reference.path) };
                    Object.entries(value).forEach(([key, fieldValue]) => {
                        if (fieldValue?.__deleteField) delete updated[key];
                        else updated[key] = fieldValue;
                    });
                    documents.set(reference.path, updated);
                } else {
                    documents.set(reference.path, value);
                }
            });
            return result;
        },
    };
});

jest.mock('../firebase', () => ({ db: {} }));

const { webcrypto } = require('crypto');
const { TextEncoder } = require('util');
Object.defineProperty(window, 'crypto', { configurable: true, value: webcrypto });
window.TextEncoder = TextEncoder;

const { __documents } = require('firebase/firestore');
const {
    applyStudentYearEndDecision,
    getNextCbcGrade,
    rollbackStudentYearEndDecision,
    YEAR_END_DECISIONS,
} = require('./studentPromotionService');

const putStudent = (id, data) => __documents.set(`students/${id}`, data);
const readStudent = (id) => __documents.get(`students/${id}`);

describe('student year-end domain logic', () => {
    beforeEach(() => {
        __documents.clear();
        require('firebase/firestore').__reads.length = 0;
    });

    test.each([
        ['pre-primary', 'PP1', { level: 'pre-primary', class: 'PP2' }],
        ['pre-primary', 'PP2', { level: 'lower-primary', class: 'Grade 1' }],
        ['upper-primary', 'Grade 6', { level: 'junior-school', class: 'Grade 7' }],
        ['senior-school', 'Grade 12', null],
    ])('resolves next grade from %s %s', (level, studentClass, expected) => {
        expect(getNextCbcGrade(level, studentClass)).toEqual(expected);
    });

    test('promotion updates class and preserves a reversible operation snapshot', async () => {
        const original = {
            schoolId: 'school-a',
            firstName: 'Ada',
            level: 'pre-primary',
            class: 'PP2',
            status: 'active',
            history: [{ type: 'admission', year: '2020' }],
        };
        putStudent('student-a', original);

        const result = await applyStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: 'student-a',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.PROMOTE,
        });

        expect(result.status).toBe('applied');
        expect(readStudent('student-a')).toMatchObject({
            level: 'lower-primary',
            class: 'Grade 1',
            status: 'active',
            lastYearEndDecision: 'promote',
        });
        expect(readStudent('student-a').history).toHaveLength(2);
        const operation = __documents.get(`student_promotion_operations/${result.operationId}`);
        expect(operation.beforeStudent).toEqual(original);

        const retry = await applyStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: 'student-a',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.PROMOTE,
        });
        expect(retry.status).toBe('already_applied');
        expect(readStudent('student-a').history).toHaveLength(2);
    });

    test('repeaters remain in grade and cannot be counted twice', async () => {
        putStudent('student-b', {
            schoolId: 'school-a',
            level: 'lower-primary',
            class: 'Grade 2',
            status: 'active',
            repeatCount: 1,
        });
        const request = {
            schoolId: 'school-a',
            studentId: 'student-b',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.REPEAT,
        };

        expect((await applyStudentYearEndDecision(request)).status).toBe('applied');
        expect(require('firebase/firestore').__reads.some((path) => path.startsWith('student_archives/')))
            .toBe(false);
        require('firebase/firestore').__reads.length = 0;
        expect((await applyStudentYearEndDecision(request)).status).toBe('already_applied');
        expect(readStudent('student-b')).toMatchObject({
            level: 'lower-primary',
            class: 'Grade 2',
            repeatCount: 2,
        });
    });

    test('rollback of a non-exit decision does not read an archive document', async () => {
        putStudent('student-repeat-rollback', {
            schoolId: 'school-a',
            level: 'lower-primary',
            class: 'Grade 2',
            status: 'active',
            repeatCount: 0,
        });
        const applied = await applyStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: 'student-repeat-rollback',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.REPEAT,
        });
        expect(__documents.has(`student_archives/${applied.operationId}`)).toBe(false);

        const reads = require('firebase/firestore').__reads;
        reads.length = 0;
        const rollback = await rollbackStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: 'student-repeat-rollback',
            academicYear: '2025',
        });

        expect(rollback.status).toBe('rolled_back');
        expect(reads).toEqual([
            'students/student-repeat-rollback',
            `student_promotion_operations/${applied.operationId}`,
        ]);
        expect(__documents.has(`student_archives/${applied.operationId}`)).toBe(false);
        expect(readStudent('student-repeat-rollback')).toMatchObject({
            status: 'active',
            repeatCount: 0,
        });
    });

    test('transfer archives the original record and rollback restores it without deleting history', async () => {
        const original = {
            schoolId: 'school-a',
            firstName: 'Bea',
            level: 'upper-primary',
            class: 'Grade 5',
            status: 'active',
            isActive: true,
            history: [{ type: 'admission', year: '2021' }],
        };
        putStudent('student-c', original);
        const request = {
            schoolId: 'school-a',
            studentId: 'student-c',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.TRANSFER,
            destinationSchool: 'Other School',
        };

        const applied = await applyStudentYearEndDecision(request);
        const archivePath = `student_archives/${applied.operationId}`;
        expect(readStudent('student-c')).toMatchObject({ status: 'transferred', isActive: false });
        expect(__documents.get(archivePath).studentSnapshot).toEqual(original);
        __documents.set('students/student-c', {
            ...readStudent('student-c'),
            guardianPhone: 'updated-after-transfer',
        });

        const rollback = await rollbackStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: 'student-c',
            academicYear: '2025',
            reversedBy: 'admin-a',
        });
        expect(rollback.status).toBe('rolled_back');
        expect(readStudent('student-c')).toEqual({
            ...original,
            guardianPhone: 'updated-after-transfer',
            updatedAt: 'SERVER_TIMESTAMP',
        });
        expect(__documents.get(archivePath)).toMatchObject({ status: 'reversed' });
        expect(__documents.get(`student_promotion_operations/${applied.operationId}`))
            .toMatchObject({ status: 'rolled_back' });
    });

    test('graduation and manual archival preserve full student snapshots', async () => {
        const graduate = {
            schoolId: 'school-a',
            firstName: 'Cal',
            level: 'senior-school',
            class: 'Grade 12',
            status: 'active',
            guardian: { name: 'Guardian' },
        };
        const archive = {
            schoolId: 'school-a',
            firstName: 'Dee',
            level: 'junior-school',
            class: 'Grade 9',
            status: 'active',
            history: [{ type: 'promotion', academicYear: '2024' }],
        };
        putStudent('student-e', graduate);
        putStudent('student-f', archive);

        const graduated = await applyStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: 'student-e',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.GRADUATE,
        });
        const archived = await applyStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: 'student-f',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.ARCHIVE,
            archiveReason: 'Records retained after school closure',
        });

        expect(readStudent('student-e')).toMatchObject({ status: 'graduated', isActive: false });
        expect(__documents.get(`student_archives/${graduated.operationId}`).studentSnapshot)
            .toEqual(graduate);
        expect(readStudent('student-f')).toMatchObject({ status: 'archived', isActive: false });
        expect(__documents.get(`student_archives/${archived.operationId}`).studentSnapshot)
            .toEqual(archive);
    });

    test.each([
        ['lower-primary', 'Grade 5'],
        ['senior-school', 'Grade 11'],
    ])('rejects graduation before the final configured class (%s %s)', async (level, studentClass) => {
        putStudent(`student-${studentClass}`, {
            schoolId: 'school-a',
            level,
            class: studentClass,
            status: 'active',
        });

        await expect(applyStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: `student-${studentClass}`,
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.GRADUATE,
        })).rejects.toThrow('final configured CBC class');
        expect(__documents.size).toBe(1);
    });

    test('uses the supplied configured sequence to identify the final graduation class', async () => {
        putStudent('student-custom-final', {
            schoolId: 'school-a',
            level: 'upper-primary',
            class: 'Grade 6',
            status: 'active',
        });
        const result = await applyStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: 'student-custom-final',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.GRADUATE,
            levelClasses: {
                'pre-primary': ['PP1', 'PP2'],
                'lower-primary': ['Grade 1', 'Grade 2', 'Grade 3'],
                'upper-primary': ['Grade 4', 'Grade 5', 'Grade 6'],
            },
        });
        expect(result.status).toBe('applied');
        expect(readStudent('student-custom-final')).toMatchObject({ status: 'graduated' });
    });

    test('creates safe deterministic operation IDs for arbitrary Firestore identifier characters', async () => {
        const schoolId = 'school%2F #?🏫';
        const studentId = 'student%2F #?🎓';
        putStudent(studentId, {
            schoolId,
            level: 'lower-primary',
            class: 'Grade 2',
            status: 'active',
        });
        putStudent('student-second', {
            schoolId: 'school-other',
            level: 'lower-primary',
            class: 'Grade 2',
            status: 'active',
        });

        const result = await applyStudentYearEndDecision({
            schoolId,
            studentId,
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.REPEAT,
        });
        const other = await applyStudentYearEndDecision({
            schoolId: 'school-other',
            studentId: 'student-second',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.REPEAT,
        });

        expect(result.operationId).toMatch(/^v1_[0-9a-f]{64}$/);
        expect(other.operationId).toMatch(/^v1_[0-9a-f]{64}$/);
        expect(result.operationId).not.toBe(other.operationId);
        const retry = await applyStudentYearEndDecision({
            schoolId,
            studentId,
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.REPEAT,
        });
        expect(retry.operationId).toBe(result.operationId);
        expect(retry.status).toBe('already_applied');
    });

    test('refuses a non-sequential promotion and a tenant mismatch without writes', async () => {
        putStudent('student-d', {
            schoolId: 'school-a',
            level: 'upper-primary',
            class: 'Grade 6',
            status: 'active',
        });
        await expect(applyStudentYearEndDecision({
            schoolId: 'school-a',
            studentId: 'student-d',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.PROMOTE,
            targetLevel: 'senior-school',
            targetClass: 'Grade 10',
        })).rejects.toThrow('Promotion must advance');
        await expect(applyStudentYearEndDecision({
            schoolId: 'another-school',
            studentId: 'student-d',
            academicYear: '2025',
            decision: YEAR_END_DECISIONS.PROMOTE,
        })).rejects.toThrow('does not belong');
        expect(__documents.size).toBe(1);
    });
});
