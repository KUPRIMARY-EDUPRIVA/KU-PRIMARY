const SCHEMA_VERSION = 1;

const identity = (value) => String(value ?? '').trim();
const tupleKey = (...parts) => JSON.stringify(parts);
const compareText = (left, right) => String(left).localeCompare(String(right));

function sortPeriods(periods = []) {
  return periods
    .map((period, index) => ({ ...period, id: identity(period.id), order: Number.isFinite(period.order) ? period.order : index }))
    .sort((left, right) => left.order - right.order || compareText(left.id, right.id));
}

function clockMinutes(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function periodWindow(period) {
  const start = clockMinutes(period?.start);
  const end = clockMinutes(period?.end);
  return start !== null && end !== null && end > start ? { start, end } : null;
}

function addError(errors, code, message, details = {}) {
  errors.push({ code, message, ...details });
}

function normalizeInput(input = {}) {
  const days = (input.days || []).map(identity).filter(Boolean);
  const periods = sortPeriods(input.periods || []);
  const classes = (input.classes || []).map((item) => ({ ...item, id: identity(item.id) }));
  const teachers = (input.teachers || []).map((item) => ({ ...item, id: identity(item.id) }));
  const rooms = (input.rooms || []).map((item) => ({ ...item, id: identity(item.id) }));
  const learningAreas = (input.learningAreas || []).map((item) => ({
    ...item,
    id: identity(item.id ?? item.subjectId),
  }));
  const errors = [];

  if (!days.length) addError(errors, 'missing_days', 'At least one day is required.');
  if (new Set(days).size !== days.length) addError(errors, 'duplicate_day', 'Day identifiers must be unique.');
  if (!periods.length) addError(errors, 'missing_periods', 'At least one period is required.');
  if (periods.some((period) => !period.id)) addError(errors, 'invalid_period', 'Every period must have an id.');
  if (new Set(periods.map((period) => period.id)).size !== periods.length) {
    addError(errors, 'duplicate_period', 'Period identifiers must be unique.');
  }
  if (classes.some((item) => !item.id) || new Set(classes.map((item) => item.id)).size !== classes.length) {
    addError(errors, 'invalid_class', 'Classes must have unique, non-empty ids.');
  }
  if (teachers.some((item) => !item.id) || new Set(teachers.map((item) => item.id)).size !== teachers.length) {
    addError(errors, 'invalid_teacher', 'Teachers must have unique, non-empty ids.');
  }
  if (rooms.some((item) => !item.id) || new Set(rooms.map((item) => item.id)).size !== rooms.length) {
    addError(errors, 'invalid_room', 'Rooms must have unique, non-empty ids.');
  }
  if (learningAreas.some((item) => !item.id) || new Set(learningAreas.map((item) => item.id)).size !== learningAreas.length) {
    addError(errors, 'invalid_learning_area', 'Learning areas must have unique, non-empty ids.');
  }

  const periodIndex = new Map(periods.map((period, index) => [period.id, index]));
  const periodById = new Map(periods.map((period) => [period.id, period]));
  const classById = new Map(classes.map((item) => [item.id, item]));
  const teacherById = new Map(teachers.map((item) => [item.id, item]));
  const roomById = new Map(rooms.map((item) => [item.id, item]));
  const requirements = [];
  const requirementByKey = new Map();

  for (const schoolClass of classes) {
    const classRequirements = schoolClass.requirements || schoolClass.lessons || [];
    if (!Array.isArray(classRequirements)) {
      addError(errors, 'invalid_requirements', 'Class requirements must be an array.', { classId: schoolClass.id });
      continue;
    }
    for (const requirement of classRequirements) {
      const subjectId = identity(requirement.subjectId ?? requirement.learningAreaId ?? requirement.subject);
      const rawCount = requirement.weeklyLessons ?? requirement.lessonsPerWeek ?? requirement.count;
      const count = Number(rawCount);
      const rawDoubles = requirement.doubleLessons ?? requirement.doubleLessonCount ?? 0;
      const doubleCount = rawDoubles === true ? Math.floor(count / 2) : Number(rawDoubles);
      if (!subjectId || !Number.isInteger(count) || count < 0 || !Number.isInteger(doubleCount) || doubleCount < 0 || doubleCount * 2 > count) {
        addError(errors, 'invalid_requirement', 'Requirements need a subject and valid weekly/double lesson counts.', {
          classId: schoolClass.id,
          subjectId,
        });
        continue;
      }
      const key = tupleKey(schoolClass.id, subjectId);
      if (requirementByKey.has(key)) {
        addError(errors, 'duplicate_requirement', 'Each class may declare a learning area only once.', {
          classId: schoolClass.id,
          subjectId,
        });
        continue;
      }
      const normalized = {
        ...requirement,
        id: identity(requirement.id) || `${schoolClass.id}::${subjectId}`,
        classId: schoolClass.id,
        subjectId,
        count,
        doubleCount,
        singleCount: count - (doubleCount * 2),
      };
      requirements.push(normalized);
      requirementByKey.set(key, normalized);
    }
  }

  return {
    days,
    periods,
    periodIndex,
    periodById,
    teachingPeriods: periods.filter((period) => period.type !== 'break' && period.type !== 'nonTeaching'),
    classes,
    classById,
    teachers,
    teacherById,
    rooms,
    roomById,
    learningAreaById: new Map(learningAreas.map((item) => [item.id, item])),
    requirements,
    requirementByKey,
    constraints: input.constraints || {},
    fixedAssignments: input.fixedAssignments || [],
    requireTeachers: input.requireTeachers !== false,
    requireRooms: input.requireRooms === true,
    errors,
  };
}

function entriesForUnavailable(value, day) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (!entry || (entry.day && entry.day !== day)) return [];
      if (Array.isArray(entry.periodIds)) return entry.periodIds.map(identity);
      return entry.periodId ? [identity(entry.periodId)] : [];
    });
  }
  if (typeof value === 'object') {
    const dayEntries = value[day];
    if (Array.isArray(dayEntries)) return dayEntries.map((entry) => identity(entry?.periodId ?? entry));
    if (dayEntries && typeof dayEntries === 'object') {
      return Object.entries(dayEntries).filter(([, unavailable]) => unavailable).map(([periodId]) => periodId);
    }
  }
  return [];
}

function isUnavailable(entity, category, day, periodId, constraints) {
  const scoped = constraints?.unavailability?.[category]?.[entity?.id]
    ?? constraints?.unavailable?.[category]?.[entity?.id]
    ?? constraints?.[`${category}Unavailable`]?.[entity?.id];
  return entriesForUnavailable(entity?.unavailable ?? entity?.unavailableSlots, day).includes(periodId)
    || entriesForUnavailable(scoped, day).includes(periodId);
}

function teacherCanTeach(teacher, requirement, schoolClass) {
  if (!teacher) return false;
  const allowedTeachers = requirement.teacherIds || requirement.allowedTeacherIds;
  if (Array.isArray(allowedTeachers) && allowedTeachers.length && !allowedTeachers.map(identity).includes(teacher.id)) return false;

  const assignments = Array.isArray(teacher.assignments) ? teacher.assignments : [];
  if (assignments.length) {
    return assignments.some((assignment) => {
      const subject = identity(assignment.subjectId ?? assignment.subject);
      const level = identity(assignment.level);
      const classIds = assignment.classIds ?? assignment.classes;
      if (subject !== requirement.subjectId) return false;
      if (level && schoolClass.level && level !== identity(schoolClass.level)) return false;
      return !Array.isArray(classIds) || classIds.length === 0 || classIds.map(identity).includes(schoolClass.id);
    });
  }

  const subjects = teacher.subjectIds ?? teacher.subjects;
  return !Array.isArray(subjects) || subjects.length === 0 || subjects.map(identity).includes(requirement.subjectId);
}

function eligibleTeachers(input, requirement) {
  const schoolClass = input.classById.get(requirement.classId);
  return input.teachers
    .filter((teacher) => teacherCanTeach(teacher, requirement, schoolClass))
    .sort((left, right) => compareText(left.id, right.id));
}

function classPeriodSequence(input, schoolClass) {
  const configured = schoolClass?.periodSequence ?? schoolClass?.periodIds ?? schoolClass?.periods;
  if (!Array.isArray(configured)) return input.periods.map((period) => period.id);
  return configured.map((item) => identity(item?.id ?? item)).filter(Boolean);
}

function declaredPeriodPairs(requirement) {
  const configured = requirement?.consecutivePeriodPairs ?? requirement?.allowedPeriodPairs;
  if (!Array.isArray(configured)) return null;
  return configured.map((pair) => {
    if (Array.isArray(pair)) return pair.map(identity);
    if (pair && Array.isArray(pair.periodIds)) return pair.periodIds.map(identity);
    if (pair) return [identity(pair.firstPeriodId ?? pair.from), identity(pair.secondPeriodId ?? pair.to)];
    return [];
  }).filter((pair) => pair.length === 2 && pair.every(Boolean));
}

function breakAppliesToClass(period, schoolClass) {
  if (period?.type !== 'break') return false;
  const classIds = period.classIds ?? period.classes;
  if (Array.isArray(classIds) && classIds.length && !classIds.map(identity).includes(schoolClass?.id)) return false;
  return !period.level || !schoolClass?.level || identity(period.level) === identity(schoolClass.level);
}

function hasBreakBetween(input, schoolClass, pair, sequence) {
  const positions = pair.map((periodId) => sequence.indexOf(periodId));
  if (positions.some((position) => position < 0)) return false;
  const start = Math.min(...positions);
  const end = Math.max(...positions);
  return sequence.slice(start + 1, end)
    .some((periodId) => breakAppliesToClass(input.periodById.get(periodId), schoolClass));
}

function allowedDoublePairs(input, requirement, schoolClass) {
  const declared = declaredPeriodPairs(requirement)
    || declaredPeriodPairs(schoolClass)
    || declaredPeriodPairs({ allowedPeriodPairs: requirement?.allowedPeriodPairs })
    || declaredPeriodPairs({ allowedPeriodPairs: schoolClass?.allowedPeriodPairs });
  if (declared) {
    const classSequence = classPeriodSequence(input, schoolClass);
    return declared.filter((pair) => pair.every((periodId) => (
      input.teachingPeriods.some((period) => period.id === periodId)
    )) && !hasBreakBetween(input, schoolClass, pair, classSequence));
  }
  const sequence = classPeriodSequence(input, schoolClass);
  const pairs = [];
  for (let index = 0; index < sequence.length - 1; index += 1) {
    const first = sequence[index];
    const second = sequence[index + 1];
    if (input.teachingPeriods.some((period) => period.id === first)
      && input.teachingPeriods.some((period) => period.id === second)) {
      pairs.push([first, second]);
    }
  }
  return pairs;
}

function isConsecutive(input, periodIds, requirement, schoolClass) {
  if (periodIds.length < 1 || periodIds.length > 2) return false;
  if (periodIds.some((periodId) => !input.teachingPeriods.some((period) => period.id === periodId))) return false;
  if (periodIds.length === 1) return true;
  return allowedDoublePairs(input, requirement, schoolClass)
    .some(([first, second]) => first === periodIds[0] && second === periodIds[1]);
}

function roomCandidates(input, requirement, schoolClass) {
  const allowed = requirement.roomIds || requirement.allowedRoomIds;
  const requiredRoomId = identity(schoolClass.roomId ?? schoolClass.homeRoomId);
  const hasAllowedRooms = Array.isArray(allowed) && allowed.length > 0;
  let candidates = input.rooms;
  if (requiredRoomId) candidates = candidates.filter((room) => room.id === requiredRoomId);
  if (Array.isArray(allowed) && allowed.length) {
    const allowedIds = allowed.map(identity);
    candidates = candidates.filter((room) => allowedIds.includes(room.id));
  }
  const areaIds = candidates.filter((room) => {
    const supported = room.subjectIds ?? room.subjects;
    if (Array.isArray(supported) && supported.length && !supported.map(identity).includes(requirement.subjectId)) return false;
    const classes = room.classIds ?? room.classes;
    return !Array.isArray(classes) || !classes.length || classes.map(identity).includes(schoolClass.id);
  });
  const roomNeeded = input.requireRooms || Boolean(requiredRoomId) || requirement.requiresRoom || hasAllowedRooms;
  if (areaIds.length) {
    const roomIds = areaIds.map((room) => room.id).sort(compareText);
    return roomNeeded ? roomIds : [...roomIds, null];
  }
  if (roomNeeded) return [];
  return [null];
}

function roomIsRequired(input, requirement, schoolClass) {
  const allowed = requirement.roomIds || requirement.allowedRoomIds;
  return input.requireRooms === true
    || Boolean(schoolClass.roomId ?? schoolClass.homeRoomId)
    || requirement.requiresRoom === true
    || (Array.isArray(allowed) && allowed.length > 0);
}

function makeOccupancy() {
  return {
    classes: new Map(),
    teachers: new Map(),
    rooms: new Map(),
    teacherIntervals: new Map(),
    roomIntervals: new Map(),
  };
}

function cloneOccupancy(occupancy) {
  return {
    classes: new Map(occupancy.classes),
    teachers: new Map(occupancy.teachers),
    rooms: new Map(occupancy.rooms),
    teacherIntervals: new Map([...occupancy.teacherIntervals].map(([key, value]) => [key, [...value]])),
    roomIntervals: new Map([...occupancy.roomIntervals].map(([key, value]) => [key, [...value]])),
  };
}

function occupancyOwner(map, ownerId, day, periodId) {
  return map.get(tupleKey(ownerId, day, periodId));
}

function occupiedKeys(assignment) {
  return assignment.periodIds.map((periodId) => ({
    day: assignment.day,
    periodId,
    classId: assignment.classId,
    teacherId: assignment.teacherId || null,
    roomId: assignment.roomId || null,
  }));
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function intervalKey(ownerId, day) {
  return tupleKey(ownerId, day);
}

function conflictsFor(occupancy, assignment, input) {
  const conflicts = [];
  for (const slot of occupiedKeys(assignment)) {
    const classOwner = occupancyOwner(occupancy.classes, slot.classId, slot.day, slot.periodId);
    if (classOwner) conflicts.push({ code: 'class_clash', classId: slot.classId, day: slot.day, periodId: slot.periodId });
    if (slot.teacherId && occupancyOwner(occupancy.teachers, slot.teacherId, slot.day, slot.periodId)) {
      conflicts.push({ code: 'teacher_clash', teacherId: slot.teacherId, day: slot.day, periodId: slot.periodId });
    }
    if (slot.roomId && occupancyOwner(occupancy.rooms, slot.roomId, slot.day, slot.periodId)) {
      conflicts.push({ code: 'room_clash', roomId: slot.roomId, day: slot.day, periodId: slot.periodId });
    }
    const window = periodWindow(input.periodById.get(slot.periodId));
    if (window && slot.teacherId) {
      const existing = occupancy.teacherIntervals.get(intervalKey(slot.teacherId, slot.day)) || [];
      if (existing.some((item) => item.periodId !== slot.periodId && overlaps(window, item))) {
        conflicts.push({ code: 'teacher_clash', teacherId: slot.teacherId, day: slot.day, periodId: slot.periodId });
      }
    }
    if (window && slot.roomId) {
      const existing = occupancy.roomIntervals.get(intervalKey(slot.roomId, slot.day)) || [];
      if (existing.some((item) => item.periodId !== slot.periodId && overlaps(window, item))) {
        conflicts.push({ code: 'room_clash', roomId: slot.roomId, day: slot.day, periodId: slot.periodId });
      }
    }
  }
  return conflicts;
}

function occupy(occupancy, assignment, input) {
  for (const slot of occupiedKeys(assignment)) {
    const marker = assignment.id || tupleKey(slot.classId, slot.day, slot.periodId, assignment.subjectId);
    occupancy.classes.set(tupleKey(slot.classId, slot.day, slot.periodId), marker);
    if (slot.teacherId) occupancy.teachers.set(tupleKey(slot.teacherId, slot.day, slot.periodId), marker);
    if (slot.roomId) occupancy.rooms.set(tupleKey(slot.roomId, slot.day, slot.periodId), marker);
    const window = periodWindow(input.periodById.get(slot.periodId));
    if (window && slot.teacherId) {
      const key = intervalKey(slot.teacherId, slot.day);
      occupancy.teacherIntervals.set(key, [
        ...(occupancy.teacherIntervals.get(key) || []),
        { ...window, periodId: slot.periodId, marker },
      ]);
    }
    if (window && slot.roomId) {
      const key = intervalKey(slot.roomId, slot.day);
      occupancy.roomIntervals.set(key, [
        ...(occupancy.roomIntervals.get(key) || []),
        { ...window, periodId: slot.periodId, marker },
      ]);
    }
  }
}

function release(occupancy, assignment, input) {
  for (const slot of occupiedKeys(assignment)) {
    occupancy.classes.delete(tupleKey(slot.classId, slot.day, slot.periodId));
    if (slot.teacherId) occupancy.teachers.delete(tupleKey(slot.teacherId, slot.day, slot.periodId));
    if (slot.roomId) occupancy.rooms.delete(tupleKey(slot.roomId, slot.day, slot.periodId));
    if (slot.teacherId) {
      const key = intervalKey(slot.teacherId, slot.day);
      const remaining = (occupancy.teacherIntervals.get(key) || [])
        .filter((item) => item.marker !== assignment.id && item.periodId !== slot.periodId);
      if (remaining.length) occupancy.teacherIntervals.set(key, remaining);
      else occupancy.teacherIntervals.delete(key);
    }
    if (slot.roomId) {
      const key = intervalKey(slot.roomId, slot.day);
      const remaining = (occupancy.roomIntervals.get(key) || [])
        .filter((item) => item.marker !== assignment.id && item.periodId !== slot.periodId);
      if (remaining.length) occupancy.roomIntervals.set(key, remaining);
      else occupancy.roomIntervals.delete(key);
    }
  }
}

function normalizeAssignment(raw, source = 'manual') {
  const periodIds = Array.isArray(raw.periodIds) ? raw.periodIds.map(identity) : [identity(raw.periodId)].filter(Boolean);
  return {
    id: identity(raw.id) || `${identity(raw.classId)}::${identity(raw.day)}::${periodIds.join('+')}::${identity(raw.subjectId)}`,
    classId: identity(raw.classId),
    subjectId: identity(raw.subjectId ?? raw.learningAreaId ?? raw.subject),
    day: identity(raw.day),
    periodIds,
    teacherId: identity(raw.teacherId) || null,
    roomId: identity(raw.roomId) || null,
    source: raw.source || source,
  };
}

function assignmentIdentity(assignment) {
  return tupleKey(
    assignment.classId,
    assignment.subjectId,
    assignment.day,
    [...assignment.periodIds].sort(compareText),
    assignment.teacherId || null,
    assignment.roomId || null,
  );
}

function validatePlacement(input, requirement, assignment, occupancy, errors, { checkDemand = false } = {}) {
  const { classId, subjectId, day, periodIds, teacherId, roomId } = assignment;
  const schoolClass = input.classById.get(classId);
  if (!schoolClass) addError(errors, 'unknown_class', 'Assignment references an unknown class.', { classId });
  if (!input.days.includes(day)) addError(errors, 'unknown_day', 'Assignment references an unknown day.', { classId, day });
  if (!requirement) addError(errors, 'unknown_learning_area', 'Assignment does not match a class learning-area requirement.', { classId, subjectId });
  if (!periodIds.length || !isConsecutive(input, periodIds, requirement, schoolClass)) {
    addError(errors, 'invalid_period_span', 'Assignments must use one teaching period or two consecutive teaching periods.', {
      classId, day, periodIds,
    });
    return;
  }
  if (periodIds.some((periodId) => !input.periodIndex.has(periodId))) {
    addError(errors, 'unknown_period', 'Assignment references an unknown period.', { classId, day, periodIds });
    return;
  }
  const learningArea = input.learningAreaById.get(subjectId) || { id: subjectId };
  if (Array.isArray(learningArea.allowedDays) && !learningArea.allowedDays.map(identity).includes(day)) {
    addError(errors, 'learning_area_day_not_allowed', 'Learning area is not scheduled on this day.', { classId, subjectId, day });
  }
  if (Array.isArray(learningArea.allowedPeriods)
    && periodIds.some((periodId) => !learningArea.allowedPeriods.map(identity).includes(periodId))) {
    addError(errors, 'learning_area_period_not_allowed', 'Learning area is not scheduled in this period.', {
      classId, subjectId, day, periodIds,
    });
  }
  if (Array.isArray(requirement?.allowedDays) && !requirement.allowedDays.map(identity).includes(day)) {
    addError(errors, 'day_not_allowed', 'Requirement is not scheduled on this day.', { classId, subjectId, day });
  }
  if (Array.isArray(requirement?.allowedPeriods)
    && periodIds.some((periodId) => !requirement.allowedPeriods.map(identity).includes(periodId))) {
    addError(errors, 'period_not_allowed', 'Requirement is not scheduled in this period.', { classId, subjectId, day, periodIds });
  }
  if (periodIds.length === 2 && requirement && requirement.doubleCount < 1) {
    addError(errors, 'double_not_allowed', 'This learning area has no double lessons in its weekly allocation.', { classId, subjectId });
  }
  if (periodIds.length === 1 && requirement && requirement.singleCount < 1) {
    addError(errors, 'single_not_allowed', 'The remaining allocation for this learning area is reserved for double lessons.', { classId, subjectId });
  }
  for (const periodId of periodIds) {
    if (isUnavailable(learningArea, 'learningAreas', day, periodId, input.constraints)
      || isUnavailable(requirement, 'learningAreas', day, periodId, input.constraints)) {
      addError(errors, 'learning_area_unavailable', 'Learning area is unavailable for the requested period.', {
        classId, subjectId, day, periodId,
      });
    }
    if (isUnavailable(schoolClass, 'classes', day, periodId, input.constraints)
      || isUnavailable(requirement, 'classes', day, periodId, input.constraints)) {
      addError(errors, 'class_unavailable', 'Class is unavailable for the requested period.', { classId, day, periodId });
    }
  }
  if (teacherId) {
    const teacher = input.teacherById.get(teacherId);
    if (!teacher) {
      addError(errors, 'unknown_teacher', 'Assignment references an unknown teacher.', { classId, subjectId, teacherId });
    } else {
      if (requirement && schoolClass && !teacherCanTeach(teacher, requirement, schoolClass)) {
        addError(errors, 'teacher_not_qualified', 'Teacher is not assigned to this learning area and class.', {
          classId, subjectId, teacherId,
        });
      }
      for (const periodId of periodIds) {
        if (isUnavailable(teacher, 'teachers', day, periodId, input.constraints)) {
          addError(errors, 'teacher_unavailable', 'Teacher is unavailable for the requested period.', {
            classId, subjectId, teacherId, day, periodId,
          });
        }
      }
    }
  } else if (input.requireTeachers && requirement?.requiresTeacher !== false) {
    addError(errors, 'teacher_required', 'A teacher is required for this lesson.', { classId, subjectId, day, periodIds });
  }
  if (roomId) {
    const room = input.roomById.get(roomId);
    if (!room) addError(errors, 'unknown_room', 'Assignment references an unknown room.', { classId, subjectId, roomId });
    if (requirement && schoolClass && !roomCandidates(input, requirement, schoolClass).includes(roomId)) {
      addError(errors, 'room_not_allowed', 'Room is not allowed for this class and learning area.', { classId, subjectId, roomId });
    }
    for (const periodId of periodIds) {
      if (room && isUnavailable(room, 'rooms', day, periodId, input.constraints)) {
        addError(errors, 'room_unavailable', 'Room is unavailable for the requested period.', { classId, subjectId, roomId, day, periodId });
      }
    }
  } else if (requirement && schoolClass && roomIsRequired(input, requirement, schoolClass)) {
    addError(errors, 'room_required', 'A room is required for this lesson.', { classId, subjectId, day, periodIds });
  }
  if (requirement && checkDemand && periodIds.length > 2) {
    addError(errors, 'invalid_period_span', 'A lesson block cannot exceed two periods.', { classId, subjectId });
  }
  for (const conflict of conflictsFor(occupancy, assignment, input)) {
    addError(errors, conflict.code, `Assignment conflicts with another lesson (${conflict.code.replace('_', ' ')}).`, {
      classId, subjectId, day, periodId: conflict.periodId,
      ...(conflict.teacherId ? { teacherId: conflict.teacherId } : {}),
      ...(conflict.roomId ? { roomId: conflict.roomId } : {}),
    });
  }
}

function validateFixedAssignments(input, occupancy, errors) {
  const assignments = [];
  for (const raw of input.fixedAssignments) {
    const assignment = { ...normalizeAssignment(raw, 'fixed'), source: 'fixed' };
    const requirement = input.requirementByKey.get(tupleKey(assignment.classId, assignment.subjectId));
    const errorsBefore = errors.length;
    validatePlacement(input, requirement, assignment, occupancy, errors);
    if (errors.length === errorsBefore) {
      occupy(occupancy, assignment, input);
      assignments.push(assignment);
    }
  }
  validateAllocationLimits(input, assignments, errors, 'fixed_exceeds_allocation');
  validateTeacherLoads(input, assignments, errors);
  return assignments;
}

function countRequirementUsage(assignments) {
  const usage = new Map();
  for (const assignment of assignments) {
    const key = tupleKey(assignment.classId, assignment.subjectId);
    const counts = usage.get(key) || { singles: 0, doubles: 0 };
    if (assignment.periodIds.length === 2) counts.doubles += 1;
    else if (assignment.periodIds.length === 1) counts.singles += 1;
    usage.set(key, counts);
  }
  return usage;
}

function validateAllocationLimits(input, assignments, errors, code = 'allocation_exceeded') {
  const usage = countRequirementUsage(assignments);
  for (const requirement of input.requirements) {
    const counts = usage.get(tupleKey(requirement.classId, requirement.subjectId)) || { singles: 0, doubles: 0 };
    if (counts.singles > requirement.singleCount || counts.doubles > requirement.doubleCount) {
      addError(errors, code, 'Assignments exceed the exact weekly allocation for this learning area.', {
        classId: requirement.classId,
        subjectId: requirement.subjectId,
        requiredSingles: requirement.singleCount,
        assignedSingles: counts.singles,
        requiredDoubles: requirement.doubleCount,
        assignedDoubles: counts.doubles,
      });
    }
  }
  return usage;
}

function validateTeacherLoads(input, assignments, errors) {
  const loads = teacherLoads(assignments);
  for (const [teacherId, scheduledLoad] of loads) {
    const teacher = input.teacherById.get(teacherId);
    const capValue = Number(teacher?.maxLessons ?? teacher?.maxPeriods);
    const cap = Number.isFinite(capValue) && capValue >= 0 ? capValue : Infinity;
    const total = Number(teacher?.existingLoad ?? teacher?.weeklyLoad ?? 0) + scheduledLoad;
    if (total > cap) {
      addError(errors, 'teacher_load_exceeded', 'Teacher weekly load exceeds the configured maximum.', {
        teacherId,
        maximum: cap,
        scheduledLoad: total,
      });
    }
  }
}

function validateOverridesInternal(input, overrides = [], fixedOccupancy = makeOccupancy(), fixedAssignments = []) {
  const errors = [...input.errors];
  const occupancy = cloneOccupancy(fixedOccupancy);
  const assignments = [];
  const usage = countRequirementUsage(fixedAssignments);
  for (const raw of overrides) {
    const assignment = normalizeAssignment(raw, 'manual');
    const key = tupleKey(assignment.classId, assignment.subjectId);
    const current = usage.get(key) || { singles: 0, doubles: 0 };
    if (assignment.periodIds.length === 2) current.doubles += 1;
    else current.singles += 1;
    usage.set(key, current);
    const before = errors.length;
    const requirement = input.requirementByKey.get(key);
    validatePlacement(input, requirement, assignment, occupancy, errors);
    const placementIsValid = errors.length === before;
    if (placementIsValid) {
      occupy(occupancy, assignment, input);
      assignments.push(assignment);
    }
  }
  validateAllocationLimits(input, [...fixedAssignments, ...assignments], errors, 'override_exceeds_allocation');
  validateTeacherLoads(input, [...fixedAssignments, ...assignments], errors);
  return { valid: errors.length === 0, errors, assignments, occupancy, usage };
}

/**
 * Validate and normalize administrator-pinned lesson blocks before generation.
 *
 * Override shape: { classId, subjectId, day, periodIds: [periodId] | [first, second],
 *                   teacherId?, roomId?, id? }.
 */
export function validateManualOverrides(input, overrides = []) {
  const normalized = normalizeInput(input);
  const baseOccupancy = makeOccupancy();
  const fixedAssignments = validateFixedAssignments(normalized, baseOccupancy, normalized.errors);
  return validateOverridesInternal(normalized, overrides, baseOccupancy, fixedAssignments);
}

function placementDomain(input, requirement, blockKind) {
  const schoolClass = input.classById.get(requirement.classId);
  const teachers = eligibleTeachers(input, requirement);
  const rooms = roomCandidates(input, requirement, schoolClass);
  const needsTeacher = input.requireTeachers && requirement.requiresTeacher !== false;
  const teacherOptions = teachers.length ? teachers : (needsTeacher ? [] : [null]);
  const domains = [];
  const periods = input.teachingPeriods;
  const doublePairs = allowedDoublePairs(input, requirement, schoolClass);

  for (const day of input.days) {
    const learningArea = input.learningAreaById.get(requirement.subjectId);
    if ((Array.isArray(requirement.allowedDays) && !requirement.allowedDays.map(identity).includes(day))
      || (Array.isArray(learningArea?.allowedDays) && !learningArea.allowedDays.map(identity).includes(day))) continue;
    const periodBlocks = blockKind === 'double'
      ? doublePairs
      : periods.map((period) => [period.id]);
    for (const periodIds of periodBlocks) {
      const blockedByClass = periodIds.some((periodId) => isUnavailable(schoolClass, 'classes', day, periodId, input.constraints)
        || isUnavailable(requirement, 'classes', day, periodId, input.constraints)
        || isUnavailable(learningArea, 'learningAreas', day, periodId, input.constraints)
        || isUnavailable(requirement, 'learningAreas', day, periodId, input.constraints));
      if (blockedByClass) continue;
      if ((Array.isArray(requirement.allowedPeriods)
        && periodIds.some((periodId) => !requirement.allowedPeriods.map(identity).includes(periodId)))
        || (Array.isArray(learningArea?.allowedPeriods)
          && periodIds.some((periodId) => !learningArea.allowedPeriods.map(identity).includes(periodId)))) continue;
      for (const teacher of teacherOptions) {
        if (teacher && periodIds.some((periodId) => isUnavailable(teacher, 'teachers', day, periodId, input.constraints))) continue;
        for (const roomId of rooms) {
          const room = roomId ? input.roomById.get(roomId) : null;
          if (room && periodIds.some((periodId) => isUnavailable(room, 'rooms', day, periodId, input.constraints))) continue;
          domains.push({
            day,
            periodIds,
            teacherId: teacher?.id || null,
            roomId: roomId || null,
          });
        }
      }
    }
  }
  return { domains, qualifiedTeacherCount: teachers.length, roomCount: rooms.filter(Boolean).length };
}

function staticDiagnostic(input, requirement, blockKind, domain) {
  if (domain.qualifiedTeacherCount === 0 && input.requireTeachers && requirement.requiresTeacher !== false) {
    return { code: 'no_qualified_teacher', message: 'No teacher is assigned to this learning area and class.' };
  }
  const schoolClass = input.classById.get(requirement.classId);
  if (!domain.roomCount && roomIsRequired(input, requirement, schoolClass)) {
    return { code: 'no_eligible_room', message: 'No eligible room is configured for this learning area and class.' };
  }
  if (!domain.domains.length) {
    return {
      code: blockKind === 'double' ? 'no_consecutive_double_slot' : 'no_available_period',
      message: blockKind === 'double'
        ? 'No consecutive teaching-period pair satisfies the class, teacher, and room availability constraints.'
        : 'No teaching period satisfies the class, teacher, and room availability constraints.',
    };
  }
  return null;
}

function assignmentForBlock(block, placement, source = 'generated') {
  return {
    id: block.id,
    classId: block.classId,
    subjectId: block.subjectId,
    day: placement.day,
    periodIds: [...placement.periodIds],
    teacherId: placement.teacherId || null,
    roomId: placement.roomId || null,
    source,
  };
}

function placementIsFree(occupancy, block, placement, input) {
  return conflictsFor(occupancy, {
    classId: block.classId,
    day: placement.day,
    periodIds: placement.periodIds,
    teacherId: placement.teacherId,
    roomId: placement.roomId,
  }, input).length === 0;
}

function teacherLoads(assignments) {
  const loads = new Map();
  for (const assignment of assignments) {
    if (assignment.teacherId) loads.set(assignment.teacherId, (loads.get(assignment.teacherId) || 0) + assignment.periodIds.length);
  }
  return loads;
}

function teacherWithinLimit(input, teacherId, addedPeriods, loads) {
  if (!teacherId) return true;
  const teacher = input.teacherById.get(teacherId);
  const cap = Number(teacher?.maxLessons ?? teacher?.maxPeriods);
  const base = Number(teacher?.existingLoad ?? teacher?.weeklyLoad ?? 0);
  const limit = Number.isFinite(cap) && cap >= 0 ? cap : Infinity;
  return base + (loads.get(teacherId) || 0) + addedPeriods <= limit;
}

function stableAssignmentCompare(input, left, right) {
  const classOrder = compareText(left.classId, right.classId);
  if (classOrder) return classOrder;
  const dayOrder = input.days.indexOf(left.day) - input.days.indexOf(right.day);
  if (dayOrder) return dayOrder;
  const periodOrder = input.periodIndex.get(left.periodIds[0]) - input.periodIndex.get(right.periodIds[0]);
  if (periodOrder) return periodOrder;
  return compareText(left.subjectId, right.subjectId) || compareText(left.id, right.id);
}

function scheduleFor(input, assignments) {
  return {
    schemaVersion: SCHEMA_VERSION,
    days: [...input.days],
    periods: input.periods.map(({ id, name, order, type, start, end }) => ({
      id,
      ...(name ? { name } : {}),
      order,
      type: type || 'class',
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
    })),
    assignments: [...assignments].sort((left, right) => stableAssignmentCompare(input, left, right)),
  };
}

function unsatisfiedFor(input, manualUsage, reasonByRequirement = new Map()) {
  return input.requirements.flatMap((requirement) => {
    const used = manualUsage.get(tupleKey(requirement.classId, requirement.subjectId)) || { singles: 0, doubles: 0 };
    const remainingSingles = Math.max(0, requirement.singleCount - used.singles);
    const remainingDoubles = Math.max(0, requirement.doubleCount - used.doubles);
    const remainingPeriods = remainingSingles + remainingDoubles * 2;
    if (!remainingPeriods) return [];
    const reason = reasonByRequirement.get(tupleKey(requirement.classId, requirement.subjectId));
    return [{
      classId: requirement.classId,
      subjectId: requirement.subjectId,
      requiredPeriods: requirement.count,
      manuallyAssignedPeriods: used.singles + used.doubles * 2,
      remainingPeriods,
      remainingSingles,
      remainingDoubles,
      ...(reason ? { reason } : {}),
    }];
  });
}

/**
 * Solve a whole-school weekly timetable as a deterministic CSP.
 *
 * The solver uses minimum-remaining-values variable selection, forward checking,
 * and chronological backtracking. It does not use random ordering or greedy
 * commitment. Every requirement is an exact weekly lesson allocation.
 */
export function generateTimetable(input, options = {}) {
  const normalized = normalizeInput(input);
  const fixedOccupancy = makeOccupancy();
  const fixedAssignments = validateFixedAssignments(normalized, fixedOccupancy, normalized.errors);
  if (normalized.errors.length) {
    return {
      status: 'invalid_input',
      schedule: scheduleFor(normalized, fixedAssignments),
      diagnostics: { errors: normalized.errors, unsatisfied: [] },
      stats: { nodes: 0, backtracks: 0 },
    };
  }

  const manual = validateOverridesInternal(normalized, input.manualOverrides || [], fixedOccupancy, fixedAssignments);
  if (!manual.valid) {
    return {
      status: 'invalid_overrides',
      schedule: scheduleFor(normalized, [...fixedAssignments, ...manual.assignments]),
      diagnostics: { errors: manual.errors, unsatisfied: [] },
      stats: { nodes: 0, backtracks: 0 },
    };
  }

  const blocks = [];
  const domainsByBlock = new Map();
  const domainCache = new Map();
  const staticFailures = [];
  const failureReasons = new Map();

  for (const requirement of normalized.requirements) {
    const reqKey = tupleKey(requirement.classId, requirement.subjectId);
    const used = manual.usage.get(reqKey) || { singles: 0, doubles: 0 };
    const remainingDoubles = requirement.doubleCount - used.doubles;
    const remainingSingles = requirement.singleCount - used.singles;
    for (let index = 0; index < remainingDoubles; index += 1) {
      blocks.push({ id: `${requirement.id}::double::${used.doubles + index + 1}`, classId: requirement.classId, subjectId: requirement.subjectId, requirement, kind: 'double' });
    }
    for (let index = 0; index < remainingSingles; index += 1) {
      blocks.push({ id: `${requirement.id}::single::${used.singles + index + 1}`, classId: requirement.classId, subjectId: requirement.subjectId, requirement, kind: 'single' });
    }
  }

  for (const block of blocks) {
    const cacheKey = tupleKey(block.classId, block.subjectId, block.requirement.id, block.kind);
    let domain = domainCache.get(cacheKey);
    if (!domain) {
      domain = placementDomain(normalized, block.requirement, block.kind);
      domainCache.set(cacheKey, domain);
    }
    const staticFailure = staticDiagnostic(normalized, block.requirement, block.kind, domain);
    domainsByBlock.set(block.id, domain.domains);
    if (staticFailure) {
      staticFailures.push({ blockId: block.id, classId: block.classId, subjectId: block.subjectId, ...staticFailure });
      failureReasons.set(tupleKey(block.classId, block.subjectId), staticFailure);
    }
  }
  if (staticFailures.length) {
    const unsatisfied = unsatisfiedFor(normalized, manual.usage, failureReasons);
    return {
      status: 'unsatisfied',
      schedule: scheduleFor(normalized, [...fixedAssignments, ...manual.assignments]),
      diagnostics: { errors: [], unsatisfied, blockers: staticFailures },
      stats: { nodes: 0, backtracks: 0 },
    };
  }

  const maxNodes = Number.isInteger(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : 250000;
  const occupancy = cloneOccupancy(manual.occupancy);
  const placed = [];
  const loads = teacherLoads([...fixedAssignments, ...manual.assignments]);
  let nodes = 0;
  let backtracks = 0;
  let limitReached = false;
  let firstDynamicFailure = null;

  function availableFor(block) {
    return (domainsByBlock.get(block.id) || [])
      .filter((placement) => placementIsFree(occupancy, block, placement, normalized))
      .filter((placement) => teacherWithinLimit(normalized, placement.teacherId, placement.periodIds.length, loads))
      .sort((left, right) => {
        const loadDifference = (loads.get(left.teacherId) || 0) - (loads.get(right.teacherId) || 0);
        if (loadDifference) return loadDifference;
        const dayDifference = normalized.days.indexOf(left.day) - normalized.days.indexOf(right.day);
        if (dayDifference) return dayDifference;
        const periodDifference = normalized.periodIndex.get(left.periodIds[0]) - normalized.periodIndex.get(right.periodIds[0]);
        if (periodDifference) return periodDifference;
        return compareText(left.teacherId, right.teacherId) || compareText(left.roomId, right.roomId);
      });
  }

  function search(remaining) {
    if (!remaining.length) return true;
    if (nodes >= maxNodes) {
      limitReached = true;
      return false;
    }
    nodes += 1;

    let selectedIndex = -1;
    let selectedDomain = null;
    const seenGroups = new Set();
    for (let index = 0; index < remaining.length; index += 1) {
      const candidateBlock = remaining[index];
      const groupKey = tupleKey(candidateBlock.classId, candidateBlock.subjectId, candidateBlock.kind);
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);
      const domain = availableFor(candidateBlock);
      if (!selectedDomain || domain.length < selectedDomain.length
        || (domain.length === selectedDomain.length && compareText(candidateBlock.id, remaining[selectedIndex].id) < 0)) {
        selectedIndex = index;
        selectedDomain = domain;
      }
      if (domain.length === 0) {
        if (!firstDynamicFailure) {
          firstDynamicFailure = {
            blockId: candidateBlock.id,
            classId: candidateBlock.classId,
            subjectId: candidateBlock.subjectId,
            code: 'constraints_conflict',
            message: 'All otherwise valid placements are occupied or exceed a teacher workload limit.',
          };
        }
        return false;
      }
    }

    const [block] = remaining.splice(selectedIndex, 1);
    for (const placement of selectedDomain) {
      const assignment = assignmentForBlock(block, placement);
      occupy(occupancy, assignment, normalized);
      placed.push(assignment);
      if (assignment.teacherId) loads.set(assignment.teacherId, (loads.get(assignment.teacherId) || 0) + assignment.periodIds.length);
      if (search(remaining)) return true;
      if (assignment.teacherId) {
        const nextLoad = (loads.get(assignment.teacherId) || 0) - assignment.periodIds.length;
        if (nextLoad) loads.set(assignment.teacherId, nextLoad);
        else loads.delete(assignment.teacherId);
      }
      placed.pop();
      release(occupancy, assignment, normalized);
      backtracks += 1;
      if (limitReached) break;
    }
    remaining.splice(selectedIndex, 0, block);
    return false;
  }

  const solved = search([...blocks]);
  const pinnedAssignments = [...fixedAssignments, ...manual.assignments];
  const assignments = solved ? [...pinnedAssignments, ...placed] : pinnedAssignments;
  const failureReason = limitReached
    ? { code: 'search_limit', message: `Search stopped after ${maxNodes} backtracking nodes.` }
    : firstDynamicFailure || { code: 'whole_school_conflict', message: 'No complete schedule satisfies all whole-school constraints.' };
  const blockers = solved ? [] : (firstDynamicFailure ? [firstDynamicFailure] : []);
  const unsatisfied = solved ? [] : unsatisfiedFor(normalized, manual.usage, new Map(
    blocks.map((block) => [tupleKey(block.classId, block.subjectId), failureReason])
  ));

  return {
    status: solved ? 'solved' : (limitReached ? 'search_limit' : 'unsatisfied'),
    schedule: scheduleFor(normalized, assignments),
    diagnostics: { errors: [], unsatisfied, blockers },
    stats: { nodes, backtracks },
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort(compareText).reduce((result, key) => {
    result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

/** Serialize a schedule to canonical JSON with stable object-key ordering. */
export function serializeTimetable(schedule) {
  if (!schedule || schedule.schemaVersion !== SCHEMA_VERSION || !Array.isArray(schedule.assignments)) {
    throw new TypeError('Expected a timetable schedule with the supported schemaVersion and assignments.');
  }
  const dayOrder = new Map((schedule.days || []).map((day, index) => [day, index]));
  const periodOrder = new Map((schedule.periods || []).map((period, index) => [period.id, period.order ?? index]));
  const assignments = schedule.assignments.map((assignment) => ({
    ...assignment,
    periodIds: [...(assignment.periodIds || [])].sort((left, right) => (
      (periodOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (periodOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
      || compareText(left, right)
    )),
  })).sort((left, right) => (
    compareText(left.classId, right.classId)
    || (dayOrder.get(left.day) ?? Number.MAX_SAFE_INTEGER) - (dayOrder.get(right.day) ?? Number.MAX_SAFE_INTEGER)
    || (periodOrder.get(left.periodIds[0]) ?? Number.MAX_SAFE_INTEGER) - (periodOrder.get(right.periodIds[0]) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.subjectId, right.subjectId)
    || compareText(left.teacherId, right.teacherId)
    || compareText(left.roomId, right.roomId)
    || compareText(left.id, right.id)
  ));
  return JSON.stringify(canonicalize({ ...schedule, assignments }));
}

/** Parse the stable JSON representation emitted by serializeTimetable. */
export function deserializeTimetable(serialized) {
  const schedule = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  if (!schedule || schedule.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(schedule.days) || !Array.isArray(schedule.periods) || !Array.isArray(schedule.assignments)) {
    throw new TypeError('Serialized timetable has an unsupported or invalid schema.');
  }
  return schedule;
}

/**
 * Validate a complete schedule against the current constraints and allocations.
 * Manual overrides can be checked independently with validateManualOverrides.
 */
export function validateTimetable(input, schedule) {
  const normalized = normalizeInput(input);
  const errors = [...normalized.errors];
  if (!schedule || schedule.schemaVersion !== SCHEMA_VERSION || !Array.isArray(schedule.assignments)) {
    addError(errors, 'invalid_schedule', 'Schedule does not match the supported timetable schema.');
    return { valid: false, errors };
  }
  const occupancy = makeOccupancy();
  const usage = new Map();
  const validAssignments = [];
  const scheduledFixedKeys = new Set();
  for (const raw of schedule.assignments) {
    const assignment = normalizeAssignment(raw, raw.source || 'generated');
    const requirement = normalized.requirementByKey.get(tupleKey(assignment.classId, assignment.subjectId));
    const errorsBefore = errors.length;
    validatePlacement(normalized, requirement, assignment, occupancy, errors);
    if (errors.length === errorsBefore) {
      occupy(occupancy, assignment, normalized);
      validAssignments.push(assignment);
      usage.set(tupleKey(assignment.classId, assignment.subjectId), [
        ...(usage.get(tupleKey(assignment.classId, assignment.subjectId)) || []),
        assignment,
      ]);
      if (assignment.source === 'fixed') scheduledFixedKeys.add(assignmentIdentity(assignment));
    }
  }
  for (const raw of normalized.fixedAssignments) {
    const fixed = { ...normalizeAssignment(raw, 'fixed'), source: 'fixed' };
    if (!scheduledFixedKeys.has(assignmentIdentity(fixed))) {
      addError(errors, 'missing_fixed_assignment', 'Schedule is missing a configured fixed assignment.', {
        classId: fixed.classId,
        subjectId: fixed.subjectId,
        day: fixed.day,
        periodIds: fixed.periodIds,
      });
    }
  }
  validateAllocationLimits(normalized, validAssignments, errors);
  for (const requirement of normalized.requirements) {
    const assignments = usage.get(tupleKey(requirement.classId, requirement.subjectId)) || [];
    const singles = assignments.filter((assignment) => assignment.periodIds.length === 1).length;
    const doubles = assignments.filter((assignment) => assignment.periodIds.length === 2).length;
    if (singles !== requirement.singleCount || doubles !== requirement.doubleCount) {
      addError(errors, 'allocation_mismatch', 'Scheduled lessons do not exactly match the weekly allocation.', {
        classId: requirement.classId,
        subjectId: requirement.subjectId,
        requiredSingles: requirement.singleCount,
        scheduledSingles: singles,
        requiredDoubles: requirement.doubleCount,
        scheduledDoubles: doubles,
      });
    }
  }
  validateTeacherLoads(normalized, validAssignments, errors);
  return { valid: errors.length === 0, errors };
}

export const TIMETABLE_SCHEMA_VERSION = SCHEMA_VERSION;
