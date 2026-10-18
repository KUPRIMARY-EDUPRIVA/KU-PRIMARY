import {
  deserializeTimetable,
  generateTimetable,
  serializeTimetable,
  validateManualOverrides,
  validateTimetable,
} from './timetableEngine';

const makeInput = (overrides = {}) => ({
  days: ['Monday', 'Tuesday'],
  periods: [
    { id: 'P1', name: 'Period 1', order: 1 },
    { id: 'P2', name: 'Period 2', order: 2 },
  ],
  classes: [
    { id: 'A', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 2 }] },
    { id: 'B', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 2 }] },
  ],
  teachers: [
    { id: 'T1', subjects: ['Mathematics'], maxLessons: 4 },
    { id: 'T2', subjects: ['Mathematics'], maxLessons: 4 },
  ],
  rooms: [{ id: 'R1' }, { id: 'R2' }],
  ...overrides,
});

describe('timetableEngine', () => {
  test('allocates whole-school requirements without teacher, class, or room clashes', () => {
    const input = makeInput();
    const result = generateTimetable(input);

    expect(result.status).toBe('solved');
    expect(result.schedule.assignments).toHaveLength(4);
    expect(validateTimetable(input, result.schedule)).toEqual({ valid: true, errors: [] });

    const unique = new Set(result.schedule.assignments.map((item) => (
      `${item.classId}|${item.day}|${item.periodIds[0]}`
    )));
    expect(unique.size).toBe(result.schedule.assignments.length);
  });

  test('reports an explicit diagnostic when a double cannot cross a break', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [
        { id: 'P1', order: 1, type: 'class' },
        { id: 'Break', order: 2, type: 'break' },
        { id: 'P2', order: 3, type: 'class' },
      ],
      classes: [{
        id: 'A',
        periodSequence: ['P1', 'Break', 'P2'],
        requirements: [{
          subjectId: 'Science',
          weeklyLessons: 2,
          doubleLessons: 1,
          consecutivePeriodPairs: [['P1', 'P2']],
        }],
      }],
      teachers: [{ id: 'T1', subjects: ['Science'] }],
      rooms: [],
    });
    const result = generateTimetable(input);

    expect(result.status).toBe('unsatisfied');
    expect(result.diagnostics.blockers[0].code).toBe('no_consecutive_double_slot');
    expect(result.diagnostics.unsatisfied[0].remainingDoubles).toBe(1);
  });

  test('rejects manual overrides that violate teacher availability', () => {
    const input = makeInput({
      days: ['Monday'],
      classes: [{
        id: 'A',
        requirements: [{ subjectId: 'Mathematics', weeklyLessons: 2, doubleLessons: 1 }],
      }],
      teachers: [{
        id: 'T1',
        subjects: ['Mathematics'],
        unavailable: [{ day: 'Monday', periodId: 'P2' }],
      }],
      rooms: [],
    });
    const override = [{
      classId: 'A',
      subjectId: 'Mathematics',
      day: 'Monday',
      periodIds: ['P1', 'P2'],
      teacherId: 'T1',
    }];

    const validation = validateManualOverrides(input, override);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.code === 'teacher_unavailable')).toBe(true);
    expect(generateTimetable({ ...input, manualOverrides: override }).status).toBe('invalid_overrides');
  });

  test('validates school-wide room clashes in manual overrides', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [{ id: 'P1', order: 1 }],
      classes: [
        { id: 'A', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1 }] },
        { id: 'B', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1 }] },
      ],
      teachers: [
        { id: 'T1', subjects: ['Mathematics'] },
        { id: 'T2', subjects: ['Mathematics'] },
      ],
      rooms: [{ id: 'R1' }],
    });
    const validation = validateManualOverrides(input, [
      { classId: 'A', subjectId: 'Mathematics', day: 'Monday', periodIds: ['P1'], teacherId: 'T1', roomId: 'R1' },
      { classId: 'B', subjectId: 'Mathematics', day: 'Monday', periodIds: ['P1'], teacherId: 'T2', roomId: 'R1' },
    ]);

    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.code === 'room_clash')).toBe(true);
  });

  test('honors learning-area unavailability', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [{ id: 'P1', order: 1 }],
      classes: [{ id: 'A', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1 }] }],
      teachers: [{ id: 'T1', subjects: ['Mathematics'] }],
      rooms: [],
      learningAreas: [{
        id: 'Mathematics',
        unavailable: [{ day: 'Monday', periodId: 'P1' }],
      }],
    });
    const result = generateTimetable(input);

    expect(result.status).toBe('unsatisfied');
    expect(result.diagnostics.blockers[0].code).toBe('no_available_period');
  });

  test('serializes schedules deterministically and round-trips the schema', () => {
    const { schedule } = generateTimetable(makeInput());
    const reordered = {
      ...schedule,
      assignments: [...schedule.assignments].reverse(),
    };

    const serialized = serializeTimetable(schedule);
    expect(serializeTimetable(reordered)).toBe(serialized);
    expect(serializeTimetable(deserializeTimetable(serialized))).toBe(serialized);
  });

  test('enforces teacher weekly load caps', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [{ id: 'P1', order: 1 }, { id: 'P2', order: 2 }],
      classes: [{
        id: 'A',
        requirements: [{ subjectId: 'Mathematics', weeklyLessons: 2 }],
      }],
      teachers: [{ id: 'T1', subjects: ['Mathematics'], maxLessons: 1 }],
      rooms: [],
    });
    const result = generateTimetable(input);

    expect(result.status).toBe('unsatisfied');
    expect(result.diagnostics.unsatisfied[0].reason.code).toBe('constraints_conflict');
  });

  test('backtracks from a locally valid choice to satisfy the whole-school teacher cap', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [{ id: 'P1', order: 1 }, { id: 'P2', order: 2 }],
      classes: [
        { id: 'A', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1, allowedPeriods: ['P1'] }] },
        { id: 'B', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1 }] },
      ],
      teachers: [
        {
          id: 'T1',
          assignments: [{ subjectId: 'Mathematics', classIds: ['A', 'B'] }],
          maxLessons: 1,
        },
        {
          id: 'T2',
          assignments: [{ subjectId: 'Mathematics', classIds: ['A'] }],
          maxLessons: 2,
        },
      ],
      rooms: [],
    });
    const result = generateTimetable(input);

    expect(result.status).toBe('solved');
    expect(result.stats.backtracks).toBeGreaterThan(0);
    expect(result.schedule.assignments.find((assignment) => assignment.classId === 'A').teacherId).toBe('T2');
    expect(validateTimetable(input, result.schedule).valid).toBe(true);
  });

  test('returns normalized fixed assignments together with generated lessons', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [{ id: 'P1', order: 1 }, { id: 'P2', order: 2 }],
      classes: [{ id: 'A', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 2 }] }],
      teachers: [{ id: 'T1', subjects: ['Mathematics'] }],
      rooms: [],
      fixedAssignments: [{
        classId: 'A',
        subjectId: 'Mathematics',
        day: 'Monday',
        periodId: 'P1',
        teacherId: 'T1',
      }],
    });
    const result = generateTimetable(input);

    expect(result.status).toBe('solved');
    expect(result.schedule.assignments).toHaveLength(2);
    expect(result.schedule.assignments.find((assignment) => assignment.source === 'fixed')).toMatchObject({
      classId: 'A',
      subjectId: 'Mathematics',
      day: 'Monday',
      periodIds: ['P1'],
      teacherId: 'T1',
    });
    expect(validateTimetable(input, result.schedule)).toEqual({ valid: true, errors: [] });
  });

  test('rejects fixed assignments and overrides that exceed exact weekly allocation', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [
        { id: 'P1', order: 1 },
        { id: 'P2', order: 2 },
        { id: 'P3', order: 3 },
      ],
      classes: [{ id: 'A', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1 }] }],
      teachers: [{ id: 'T1', subjects: ['Mathematics'] }],
      rooms: [],
      fixedAssignments: [{
        classId: 'A',
        subjectId: 'Mathematics',
        day: 'Monday',
        periodId: 'P1',
        teacherId: 'T1',
      }],
      manualOverrides: [{
        classId: 'A',
        subjectId: 'Mathematics',
        day: 'Monday',
        periodId: 'P2',
        teacherId: 'T1',
      }],
    });
    const result = generateTimetable(input);
    const schedule = {
      schemaVersion: result.schedule.schemaVersion,
      days: result.schedule.days,
      periods: result.schedule.periods,
      assignments: [
        { ...input.fixedAssignments[0], periodIds: ['P1'], source: 'fixed' },
        { ...input.manualOverrides[0], periodIds: ['P2'], source: 'manual' },
      ],
    };

    expect(result.status).toBe('invalid_overrides');
    expect(result.diagnostics.errors.some((error) => error.code === 'override_exceeds_allocation')).toBe(true);
    expect(validateTimetable(input, schedule).errors.some((error) => error.code === 'allocation_exceeded')).toBe(true);
    expect(validateTimetable(input, schedule).errors.some((error) => error.code === 'allocation_mismatch')).toBe(true);
  });

  test('detects overlapping clock times across different level period ids for teachers and rooms', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [
        { id: 'L1-P1', order: 1, start: '08:20', end: '08:55' },
        { id: 'L2-P1', order: 2, start: '08:50', end: '09:20' },
      ],
      classes: [
        {
          id: 'L1-A',
          level: 'L1',
          requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1, allowedPeriods: ['L1-P1'] }],
        },
        {
          id: 'L2-A',
          level: 'L2',
          requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1, allowedPeriods: ['L2-P1'] }],
        },
      ],
      teachers: [{ id: 'T1', subjects: ['Mathematics'] }],
      rooms: [{ id: 'R1' }],
    });
    const overrides = [
      { classId: 'L1-A', subjectId: 'Mathematics', day: 'Monday', periodId: 'L1-P1', teacherId: 'T1', roomId: 'R1' },
      { classId: 'L2-A', subjectId: 'Mathematics', day: 'Monday', periodId: 'L2-P1', teacherId: 'T1', roomId: 'R1' },
    ];
    const validation = validateManualOverrides(input, overrides);

    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.code === 'teacher_clash')).toBe(true);
    expect(validation.errors.some((error) => error.code === 'room_clash')).toBe(true);
    expect(generateTimetable({ ...input, manualOverrides: overrides }).status).toBe('invalid_overrides');
    const completeSchedule = {
      schemaVersion: 1,
      days: input.days,
      periods: input.periods,
      assignments: overrides.map((assignment) => ({
        ...assignment,
        periodIds: [assignment.periodId],
        source: 'manual',
      })),
    };
    const fullValidation = validateTimetable(input, completeSchedule);
    expect(fullValidation.errors.some((error) => error.code === 'teacher_clash')).toBe(true);
    expect(fullValidation.errors.some((error) => error.code === 'room_clash')).toBe(true);
  });

  test('keeps exact-period conflict behavior when clock times are absent', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [{ id: 'P1', order: 1 }, { id: 'P2', order: 2 }],
      classes: [
        { id: 'A', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1, allowedPeriods: ['P1'] }] },
        { id: 'B', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1, allowedPeriods: ['P2'] }] },
      ],
      teachers: [{ id: 'T1', subjects: ['Mathematics'] }],
      rooms: [{ id: 'R1' }],
    });
    const validation = validateManualOverrides(input, [
      { classId: 'A', subjectId: 'Mathematics', day: 'Monday', periodId: 'P1', teacherId: 'T1', roomId: 'R1' },
      { classId: 'B', subjectId: 'Mathematics', day: 'Monday', periodId: 'P2', teacherId: 'T1', roomId: 'R1' },
    ]);

    expect(validation.valid).toBe(true);
  });

  test('honors requirement/class consecutive-period pairs despite mixed-level global ordering', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [
        { id: 'L1-P1', order: 1, start: '08:20', end: '08:55' },
        { id: 'L2-P1', order: 2, start: '08:30', end: '09:00' },
        { id: 'L1-P2', order: 3, start: '08:55', end: '09:30' },
      ],
      classes: [{
        id: 'L1-A',
        level: 'L1',
        periodSequence: ['L1-P1', 'L1-P2'],
        consecutivePeriodPairs: [['L1-P1', 'L1-P2']],
        requirements: [{
          subjectId: 'Science',
          weeklyLessons: 2,
          doubleLessons: 1,
        }],
      }],
      teachers: [{ id: 'T1', subjects: ['Science'] }],
      rooms: [],
    });
    const result = generateTimetable(input);

    expect(result.status).toBe('solved');
    expect(result.schedule.assignments).toHaveLength(1);
    expect(result.schedule.assignments[0].periodIds).toEqual(['L1-P1', 'L1-P2']);
    expect(validateTimetable(input, result.schedule).valid).toBe(true);
  });

  test('does not require rooms merely because the school configured them', () => {
    const input = makeInput({
      days: ['Monday'],
      periods: [{ id: 'P1', order: 1 }],
      classes: [
        {
          id: 'A',
          requirements: [{
            subjectId: 'Science',
            weeklyLessons: 1,
            requiresRoom: true,
            roomIds: ['R1'],
          }],
        },
        { id: 'B', requirements: [{ subjectId: 'Mathematics', weeklyLessons: 1 }] },
      ],
      teachers: [
        { id: 'T1', subjects: ['Science'] },
        { id: 'T2', subjects: ['Mathematics'] },
      ],
      rooms: [{ id: 'R1' }],
    });
    const result = generateTimetable(input);

    expect(result.status).toBe('solved');
    expect(result.schedule.assignments.find((assignment) => assignment.classId === 'A').roomId).toBe('R1');
    expect(result.schedule.assignments.find((assignment) => assignment.classId === 'B').roomId).toBeNull();
  });
});
