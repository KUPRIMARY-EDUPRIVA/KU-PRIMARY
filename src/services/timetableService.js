// src/services/timetableService.js
import { db } from '../firebase';
import {
  collection, query, where, getDocs, doc, getDoc, setDoc,
  serverTimestamp, writeBatch,
} from 'firebase/firestore';

/* ============================================================
   Constants
   ============================================================ */

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/**
 * Default period structures per level — aligned with the Kenyan
 * Class-Level Time and Lesson Structures (Hard Rules).
 *
 * Rules encoded here:
 *  - Pre-Primary:    5 lessons/day, 30 min each, start 08:30 (roll call 08:00)
 *  - Lower Primary:  6 lessons/day + 1 PPI, 30 min each, start 08:20
 *  - Upper Primary:  7 lessons/day, 35 min each, start 08:20
 *  - Junior School:  8 lessons/day, 40 min each, start 08:20
 *  - Senior School:  8 lessons/day, 40 min each, start 08:00
 *
 * Two rigid morning breaks are inserted for every level:
 *   - Short break after the first 2 lessons (10–15 min)
 *   - Main break after the next 2 lessons (25–30 min)
 *
 * An Assembly / Health-Check block (08:00–08:20) is locked for
 * every level except Pre-Primary, where roll-call happens at 08:30.
 */
export const DEFAULT_PERIOD_STRUCTURES = Object.freeze({
  'pre-primary': [
    { id: 'assembly', name: 'Roll Call / Health Check', start: '08:00', end: '08:30', type: 'break', label: 'ROLL CALL & HEALTH CHECK' },
    { id: 'p1', name: 'Period 1', start: '08:30', end: '09:00', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '09:00', end: '09:30', type: 'class' },
    { id: 'break1', name: 'Short Break', start: '09:30', end: '09:40', type: 'break', label: 'SHORT BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:40', end: '10:10', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:10', end: '10:40', type: 'class' },
    { id: 'break2', name: 'Main Break', start: '10:40', end: '11:10', type: 'break', label: 'MAIN BREAK' },
    { id: 'p5', name: 'Period 5', start: '11:10', end: '11:40', type: 'class' },
    { id: 'ppi', name: 'PPI / Pastoral', start: '11:40', end: '12:10', type: 'class', isPPI: true },
  ],
  'lower-primary': [
    { id: 'assembly', name: 'Assembly / Health Check', start: '08:00', end: '08:20', type: 'break', label: 'ASSEMBLY & HEALTH CHECK' },
    { id: 'p1', name: 'Period 1', start: '08:20', end: '08:50', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '08:50', end: '09:20', type: 'class' },
    { id: 'break1', name: 'Short Break', start: '09:20', end: '09:30', type: 'break', label: 'SHORT BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:30', end: '10:00', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:00', end: '10:30', type: 'class' },
    { id: 'break2', name: 'Main Break', start: '10:30', end: '11:00', type: 'break', label: 'MAIN BREAK' },
    { id: 'p5', name: 'Period 5', start: '11:00', end: '11:30', type: 'class' },
    { id: 'p6', name: 'Period 6', start: '11:30', end: '12:00', type: 'class' },
    { id: 'ppi', name: 'PPI / Pastoral', start: '12:00', end: '12:30', type: 'class', isPPI: true },
  ],
  'upper-primary': [
    { id: 'assembly', name: 'Assembly / Health Check', start: '08:00', end: '08:20', type: 'break', label: 'ASSEMBLY & HEALTH CHECK' },
    { id: 'p1', name: 'Period 1', start: '08:20', end: '08:55', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '08:55', end: '09:30', type: 'class' },
    { id: 'break1', name: 'Short Break', start: '09:30', end: '09:45', type: 'break', label: 'SHORT BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:45', end: '10:20', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:20', end: '10:55', type: 'class' },
    { id: 'break2', name: 'Main Break', start: '10:55', end: '11:25', type: 'break', label: 'MAIN BREAK' },
    { id: 'p5', name: 'Period 5', start: '11:25', end: '12:00', type: 'class' },
    { id: 'p6', name: 'Period 6', start: '12:00', end: '12:35', type: 'class' },
    { id: 'p7', name: 'Period 7', start: '12:35', end: '13:10', type: 'class' },
    { id: 'ppi', name: 'PPI / Pastoral', start: '13:10', end: '13:45', type: 'class', isPPI: true },
  ],
  'junior-school': [
    { id: 'assembly', name: 'Assembly / Health Check', start: '08:00', end: '08:20', type: 'break', label: 'ASSEMBLY & HEALTH CHECK' },
    { id: 'p1', name: 'Period 1', start: '08:20', end: '09:00', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '09:00', end: '09:40', type: 'class' },
    { id: 'break1', name: 'Short Break', start: '09:40', end: '09:55', type: 'break', label: 'SHORT BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:55', end: '10:35', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:35', end: '11:15', type: 'class' },
    { id: 'break2', name: 'Main Break', start: '11:15', end: '11:45', type: 'break', label: 'MAIN BREAK' },
    { id: 'p5', name: 'Period 5', start: '11:45', end: '12:25', type: 'class' },
    { id: 'p6', name: 'Period 6', start: '12:25', end: '13:05', type: 'class' },
    { id: 'p7', name: 'Period 7', start: '13:05', end: '13:45', type: 'class' },
    { id: 'p8', name: 'Period 8', start: '13:45', end: '14:25', type: 'class' },
    { id: 'ppi', name: 'PPI / Pastoral', start: '14:25', end: '15:05', type: 'class', isPPI: true },
  ],
  'senior-school': [
    { id: 'assembly', name: 'Assembly / Health Check', start: '08:00', end: '08:20', type: 'break', label: 'ASSEMBLY & HEALTH CHECK' },
    { id: 'p1', name: 'Period 1', start: '08:20', end: '09:00', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '09:00', end: '09:40', type: 'class' },
    { id: 'break1', name: 'Short Break', start: '09:40', end: '09:55', type: 'break', label: 'SHORT BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:55', end: '10:35', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:35', end: '11:15', type: 'class' },
    { id: 'break2', name: 'Main Break', start: '11:15', end: '11:45', type: 'break', label: 'MAIN BREAK' },
    { id: 'p5', name: 'Period 5', start: '11:45', end: '12:25', type: 'class' },
    { id: 'p6', name: 'Period 6', start: '12:25', end: '13:05', type: 'class' },
    { id: 'p7', name: 'Period 7', start: '13:05', end: '13:45', type: 'class' },
    { id: 'p8', name: 'Period 8', start: '13:45', end: '14:25', type: 'class' },
    { id: 'ppi', name: 'PPI / Pastoral', start: '14:25', end: '15:05', type: 'class', isPPI: true },
  ],
});

export const DUTY_AREAS = Object.freeze([
  { id: 'gate_morning', label: 'Main Gate (Morning)', start: 7, end: 8 },
  { id: 'assembly', label: 'Assembly Ground', start: 8, end: 8.33 },
  { id: 'break_duty', label: 'Break Supervision', start: 9.33, end: 9.83 },
  { id: 'dining', label: 'Dining Hall', start: 12, end: 13 },
  { id: 'gate_evening', label: 'Main Gate (Evening)', start: 15, end: 16.5 },
  { id: 'library', label: 'Library', start: 15, end: 16.5 },
  { id: 'playground', label: 'Playground', start: 16, end: 17 },
  { id: 'dormitory', label: 'Dormitory (Night)', start: 21, end: 22 },
]);

export const SUBJECT_CLASS = Object.freeze({
  'Mathematics': 'tt-sub-math',
  'English': 'tt-sub-english',
  'Kiswahili': 'tt-sub-kiswahili',
  'Science': 'tt-sub-science',
  'Science and Technology': 'tt-sub-science',
  'Integrated Science': 'tt-sub-science',
  'Biology': 'tt-sub-science',
  'Chemistry': 'tt-sub-science',
  'Physics': 'tt-sub-science',
  'Social Studies': 'tt-sub-social',
  'CRE/IRE/HRE': 'tt-sub-cre',
  'Religious Education': 'tt-sub-cre',
  'Christian Religious Education': 'tt-sub-cre',
  'Islamic Religious Education': 'tt-sub-cre',
  'Hindu Religious Education': 'tt-sub-cre',
  'Art and Craft': 'tt-sub-creative',
  'Creative Arts and Sports': 'tt-sub-creative',
  'Music': 'tt-sub-creative',
  'Physical Education': 'tt-sub-creative',
  'Pre-Technical Studies': 'tt-sub-tech',
  'Agriculture and Nutrition': 'tt-sub-agric',
  'Agriculture': 'tt-sub-agric',
  'Games': 'tt-sub-games',
  'PE': 'tt-sub-games',
  'Clubs': 'tt-sub-clubs',
  'Library': 'tt-sub-library',
  'PPI': 'tt-sub-ppi',
  'Pastoral Programme': 'tt-sub-ppi',
});

export const SUBJECT_WEIGHTS = Object.freeze({
  'Mathematics': 5, 'English': 5, 'Kiswahili': 4,
  'Science': 4, 'Science and Technology': 4, 'Integrated Science': 4,
  'Biology': 4, 'Chemistry': 4, 'Physics': 4,
  'Social Studies': 3, 'Pre-Technical Studies': 3, 'Agriculture and Nutrition': 3,
  'Agriculture': 3,
  'CRE/IRE/HRE': 3, 'Religious Education': 3,
  'Christian Religious Education': 3, 'Islamic Religious Education': 3,
  'Hindu Religious Education': 3,
  'Art and Craft': 2, 'Creative Arts and Sports': 2, 'Music': 2, 'Physical Education': 2,
  'Games': 2, 'PE': 2, 'Clubs': 1, 'Library': 1,
  'PPI': 1, 'Pastoral Programme': 1,
});

export const DEFAULT_SUBJECT_WEIGHT = 2;

/* ------------------------------------------------------------------
   Pedagogical constants
   ------------------------------------------------------------------ */

// Subjects that should never sit next to each other (Anti-Monotony).
// Pairs are unordered; the generator checks both directions.
export const ANTI_MONOTONY_PAIRS = Object.freeze([
  ['Mathematics', 'Science'],
  ['Mathematics', 'Science and Technology'],
  ['Mathematics', 'Integrated Science'],
  ['Mathematics', 'Biology'],
  ['Mathematics', 'Chemistry'],
  ['Mathematics', 'Physics'],
  ['English', 'Kiswahili'],
  ['Social Studies', 'Religious Education'],
  ['Social Studies', 'CRE/IRE/HRE'],
]);

// Practical / laboratory subjects eligible for double lessons in
// Upper Primary and above.
const DOUBLE_PERIOD_SUBJECTS = new Set([
  'Science', 'Science and Technology', 'Integrated Science',
  'Biology', 'Chemistry', 'Physics',
  'Pre-Technical Studies', 'Agriculture and Nutrition', 'Agriculture',
  'Home Science', 'Computer Studies',
]);

// Levels where doubles are strictly forbidden.
const NO_DOUBLE_LEVELS = new Set(['pre-primary', 'lower-primary']);

// Levels where doubles are permitted for practical subjects.
const DOUBLE_PERIOD_LEVELS = new Set(['upper-primary', 'junior-school', 'senior-school']);

// Creative / psychomotor subjects that must precede a break.
export const PSYCHOMOTOR_SUBJECTS = new Set([
  'Physical Education', 'PE', 'Creative Arts and Sports',
  'Art and Craft', 'Music', 'Games', 'Sports',
]);

// Administrative roles and their teaching-load reductions.
// `reduction` is the number of teaching periods removed from the
// standard 27-period target.
export const ADMIN_ROLE_OFFSETS = Object.freeze({
  headteacher:        { label: 'Headteacher',        maxPeriods: 6  },
  deputy_headteacher: { label: 'Deputy Headteacher', maxPeriods: 12 },
  senior_master:      { label: 'Senior Master',      maxPeriods: 18 },
  hod:                { label: 'Head of Department', maxPeriods: 22 },
});

// CBE alignment targets (lessons per week).
export const TEACHER_TARGET_LOAD = 27;
export const TEACHER_MAX_LOAD = 35;

/* ============================================================
   Small utils
   ============================================================ */

export function safeSlug(s) {
  return String(s || '').trim().replace(/\s+/g, '_').replace(/[\/\\.#$[\]]/g, '');
}

export function normalizeTerm(term) {
  const t = String(term || '').toLowerCase().replace(/\s+/g, '');
  if (t === 'term1' || t === '1') return 'Term 1';
  if (t === 'term2' || t === '2') return 'Term 2';
  if (t === 'term3' || t === '3') return 'Term 3';
  return term || 'Term 1';
}

export function normalizeYear(year) {
  const n = parseInt(year, 10);
  return Number.isFinite(n) && n >= 2000 && n <= 2100 ? n : new Date().getFullYear();
}

export function teacherInitials(t) {
  if (!t) return 'TBA';
  if (t.initials && String(t.initials).trim()) return String(t.initials).trim().toUpperCase();
  const f = (t.firstName || '').trim();
  const l = (t.lastName || '').trim();
  if (f && l) return (f[0] + l[0]).toUpperCase();
  if (f) return f.slice(0, 2).toUpperCase();
  if (t.email) return String(t.email).slice(0, 2).toUpperCase();
  return 'TBA';
}

export function teacherFullName(t) {
  if (!t) return 'Unassigned';
  const f = (t.firstName || '').trim();
  const l = (t.lastName || '').trim();
  return `${f} ${l}`.trim() || t.email || 'Unassigned';
}

export function weightForSubject(subject) {
  return SUBJECT_WEIGHTS[subject] ?? DEFAULT_SUBJECT_WEIGHT;
}

export function fmtTime(t) {
  if (!t) return '';
  return t;
}

/* ============================================================
   Period config helpers
   ============================================================ */

export function periodsForLevel(level, customConfig = null) {
  if (customConfig?.periods?.[level]) {
    return customConfig.periods[level];
  }
  return DEFAULT_PERIOD_STRUCTURES[level] || DEFAULT_PERIOD_STRUCTURES['junior-school'];
}

export function classPeriodsForLevel(level, customConfig = null) {
  return periodsForLevel(level, customConfig).filter((p) => p.type === 'class');
}

export function breakPeriodsForLevel(level, customConfig = null) {
  return periodsForLevel(level, customConfig).filter((p) => p.type === 'break');
}

export function calcDuration(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

export function formatPeriodTime(period) {
  if (period.time) return period.time;
  if (period.start && period.end) return `${period.start} - ${period.end}`;
  return '';
}

/* ============================================================
   Settings
   ============================================================ */

export async function loadTimetableSettings(schoolId) {
  if (!schoolId) return null;
  const id = `${safeSlug(schoolId)}_timetable_settings`;
  const snap = await getDoc(doc(db, 'timetable_settings', id));
  return snap.exists() ? snap.data() : null;
}

export async function saveTimetableSettings(schoolId, settings, userId) {
  const id = `${safeSlug(schoolId)}_timetable_settings`;
  await setDoc(doc(db, 'timetable_settings', id), {
    ...settings,
    schoolId,
    updatedAt: serverTimestamp(),
    updatedBy: userId || 'admin',
  }, { merge: true });
}

/* ============================================================
   Events
   ============================================================ */

export async function loadEvents(schoolId, term, year) {
  if (!schoolId) return [];
  const q = query(
    collection(db, 'timetable_events'),
    where('schoolId', '==', schoolId),
    where('term', '==', normalizeTerm(term)),
    where('year', '==', normalizeYear(year))
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function saveEvent(schoolId, term, year, event, userId) {
  const id = event.id || `${safeSlug(schoolId)}_${safeSlug(event.title)}_${Date.now()}`;
  await setDoc(doc(db, 'timetable_events', id), {
    ...event,
    id,
    schoolId,
    term: normalizeTerm(term),
    year: normalizeYear(year),
    updatedAt: serverTimestamp(),
    updatedBy: userId || 'admin',
  }, { merge: true });
  return id;
}

export async function deleteEvent(eventId) {
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(doc(db, 'timetable_events', eventId));
}

/* ============================================================
   Document id builders
   ============================================================ */

export function buildClassKey(schoolId, level, cls, term, year) {
  return `${safeSlug(schoolId)}_${safeSlug(level)}_${safeSlug(cls)}_${safeSlug(normalizeTerm(term))}_${normalizeYear(year)}`;
}

export function buildRosterKey(schoolId, term, year) {
  return `${safeSlug(schoolId)}_${safeSlug(normalizeTerm(term))}_${normalizeYear(year)}`;
}

/* ============================================================
   Firestore reads
   ============================================================ */

export async function loadSchoolAndTeachers(schoolId) {
  if (!schoolId) return { school: null, teachers: [] };
  const [schoolSnap, teachersSnap] = await Promise.all([
    getDoc(doc(db, 'schools', schoolId)),
    getDocs(query(collection(db, 'teachers'), where('schoolId', '==', schoolId))),
  ]);
  return {
    school: schoolSnap.exists() ? { id: schoolSnap.id, ...schoolSnap.data() } : null,
    teachers: teachersSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
}

export async function loadClassTimetable(schoolId, level, cls, term, year) {
  if (!schoolId || !level || !cls) return {};
  const id = buildClassKey(schoolId, level, cls, term, year);
  const snap = await getDoc(doc(db, 'school_timetables', id));
  return snap.exists() ? (snap.data().schedule || {}) : {};
}

export async function loadAllSchedulesForLevel(schoolId, level, term, year) {
  if (!schoolId || !level) return {};
  const q = query(
    collection(db, 'school_timetables'),
    where('schoolId', '==', schoolId),
    where('level', '==', level),
    where('term', '==', normalizeTerm(term)),
    where('year', '==', normalizeYear(year))
  );
  const snap = await getDocs(q);
  const result = {};
  snap.docs.forEach((d) => {
    const data = d.data();
    if (data.class) result[data.class] = data.schedule || {};
  });
  return result;
}

export async function loadDutyRoster(schoolId, term, year) {
  if (!schoolId) return {};
  const id = buildRosterKey(schoolId, term, year);
  const snap = await getDoc(doc(db, 'duty_rosters', id));
  return snap.exists() ? (snap.data().roster || {}) : {};
}

/* ============================================================
   Firestore writes
   ============================================================ */

export async function saveClassTimetable(schoolId, level, cls, term, year, schedule, userId) {
  const id = buildClassKey(schoolId, level, cls, term, year);
  await setDoc(doc(db, 'school_timetables', id), {
    schoolId, level, class: cls,
    term: normalizeTerm(term), year: normalizeYear(year),
    schedule,
    updatedAt: serverTimestamp(),
    updatedBy: userId || 'admin',
  }, { merge: true });
}

export async function saveManyClassTimetables(schoolId, level, term, year, schedulesByClass, userId) {
  const batch = writeBatch(db);
  for (const [cls, schedule] of Object.entries(schedulesByClass)) {
    const id = buildClassKey(schoolId, level, cls, term, year);
    batch.set(doc(db, 'school_timetables', id), {
      schoolId, level, class: cls,
      term: normalizeTerm(term), year: normalizeYear(year),
      schedule,
      updatedAt: serverTimestamp(),
      updatedBy: userId || 'admin',
    }, { merge: true });
  }
  await batch.commit();
}

export async function saveDutyRoster(schoolId, term, year, roster, userId) {
  const id = buildRosterKey(schoolId, term, year);
  await setDoc(doc(db, 'duty_rosters', id), {
    schoolId,
    term: normalizeTerm(term),
    year: normalizeYear(year),
    roster,
    updatedAt: serverTimestamp(),
    updatedBy: userId || 'admin',
  }, { merge: true });
}

/* ============================================================
   Teacher-assignment aware helpers
   ============================================================ */

/**
 * Returns the teacher's effective teaching cap, honouring any
 * administrative-role offset stored on the teacher profile.
 */
export function teacherMaxLoad(teacher) {
  if (!teacher) return TEACHER_MAX_LOAD;
  // Explicit override wins.
  if (Number.isFinite(teacher.maxPeriods) && teacher.maxPeriods > 0) {
    return teacher.maxPeriods;
  }
  // Admin-role offset.
  const roleKey = (teacher.adminRole || teacher.role || '').toString().toLowerCase();
  if (ADMIN_ROLE_OFFSETS[roleKey]) {
    return ADMIN_ROLE_OFFSETS[roleKey].maxPeriods;
  }
  return TEACHER_MAX_LOAD;
}

/**
 * Does this teacher teach `subject` at `level` (optionally for `cls`)?
 *
 * Priority:
 *   1. teacher.assignments — [{ level, subject, classes: [...] }]
 *   2. teacher.subjects    — flat list (legacy) → treated as level-agnostic
 *   3. []                  — generalist (teaches anything)
 */
export function teacherTeaches(teacher, subject, level = null, cls = null) {
  if (!teacher) return false;

  // 1. New assignment-pairing model.
  const assignments = Array.isArray(teacher.assignments) ? teacher.assignments : [];
  if (assignments.length > 0) {
    return assignments.some((a) => {
      if (!a || a.subject !== subject) return false;
      if (level && a.level && a.level !== level) return false;
      if (cls && Array.isArray(a.classes) && a.classes.length > 0) {
        return a.classes.includes(cls);
      }
      return true;
    });
  }

  // 2. Legacy flat subjects list — level-agnostic.
  const declared = Array.isArray(teacher.subjects) ? teacher.subjects : [];
  if (declared.length > 0) {
    return declared.includes(subject);
  }

  // 3. No restrictions → generalist.
  return true;
}

/**
 * Return the classes a teacher is explicitly assigned to at a given
 * level. Returns [] when the teacher has no restriction (generalist)
 * — callers should interpret [] as "any class".
 */
export function teacherClassesAtLevel(teacher, level) {
  const assignments = Array.isArray(teacher?.assignments) ? teacher.assignments : [];
  const set = new Set();
  for (const a of assignments) {
    if (a?.level && a.level !== level) continue;
    (a?.classes || []).forEach((c) => { if (c) set.add(c); });
  }
  return [...set];
}

/* ============================================================
   Generator
   ============================================================ */

/**
 * Generate a clash-free, pedagogically-aware class timetable.
 *
 * Honours:
 *  - teacher.assignments (level/subject/classes)
 *  - anti-monotony rule (no Maths next to Science, English next to Kiswahili…)
 *  - psychomotor-subject-before-break rule
 *  - double-lesson restrictions (lab subjects only, and only from Upper Primary up)
 *  - PPI slot (locked once per week, not used for regular subjects)
 *  - teacher workload caps (target 27, hard cap 35, admin offsets)
 */
export function generateClassSchedule({
  level,
  cls,
  subjects,
  teachers,
  otherSchedules = {},
  existingTeacherLoad = {},
  customConfig = null,
  events = [],
}) {
  const periods = classPeriodsForLevel(level, customConfig);
  const allowDoubles = DOUBLE_PERIOD_LEVELS.has(level) && !NO_DOUBLE_LEVELS.has(level);

  // ---- Build the weekly pool of subjects for this class ----
  // PPI is handled separately (one locked slot per week).
  const regularSubjects = subjects.filter((s) => s !== 'PPI' && s !== 'Pastoral Programme');
  const pool = [];
  for (const sub of regularSubjects) {
    const w = weightForSubject(sub);
    for (let i = 0; i < w; i += 1) pool.push(sub);
  }

  // ---- Teachers available for this class at this level ----
  const eligibleTeachers = teachers.filter((t) => {
    if (teacherClassesAtLevel(t, level).length === 0) return true; // generalist
    return teacherClassesAtLevel(t, level).includes(cls);
  });

  // ---- Teacher busy slots from other classes ----
  const teacherBusy = {};
  for (const day of DAYS) {
    for (const p of periods) teacherBusy[`${day}|${p.id}`] = new Set();
  }
  for (const [otherCls, sched] of Object.entries(otherSchedules)) {
    if (otherCls === cls) continue;
    for (const day of DAYS) {
      for (const p of periods) {
        const slot = sched?.[day]?.[p.id];
        if (slot?.teacherId) teacherBusy[`${day}|${p.id}`].add(slot.teacherId);
      }
    }
  }

  const teacherLoad = { ...existingTeacherLoad };

  // ---- Event overrides ----
  const eventSlots = {};
  for (const ev of events) {
    if (ev.classes && !ev.classes.includes(cls)) continue;
    if (ev.level && ev.level !== level) continue;
    for (const day of DAYS) {
      if (ev.days && !ev.days.includes(day)) continue;
      (ev.periodIds || []).forEach((pid) => { eventSlots[`${day}|${pid}`] = ev; });
    }
  }

  // ---- PPI slot: one per week, anchored to a fixed weekday/period ----
  const ppiPeriod = periods.find((p) => p.isPPI);
  const PPI_DAY = 'Wednesday';
  const ppiSubject = subjects.find((s) => s === 'PPI' || s === 'Pastoral Programme');

  const schedule = {};
  const unassigned = [];

  for (const day of DAYS) {
    schedule[day] = {};
    // Build today's pool by copying the weekly pool.
    const dayPool = shuffle([...pool]);

    // Track the previous subject to enforce anti-monotony.
    let prevSubject = null;
    // Track the period *after* which a break follows (for psychomotor rule).
    const periodBeforeBreak = getPeriodBeforeBreak(periods);

    for (let i = 0; i < periods.length; i += 1) {
      const period = periods[i];
      const busyKey = `${day}|${period.id}`;

      // 1) Event override
      const ev = eventSlots[busyKey];
      if (ev) {
        schedule[day][period.id] = {
          subject: ev.title,
          teacherId: '',
          teacherInitials: ev.teacherInitials || 'EVT',
          teacherFullName: ev.teacherName || 'Event',
          room: ev.location || '',
          isEvent: true,
          eventId: ev.id,
          eventColor: ev.color || '#d4a017',
        };
        prevSubject = null;
        continue;
      }

      // 2) PPI locked slot
      if (ppiPeriod && ppiSubject && day === PPI_DAY && period.id === ppiPeriod.id) {
        const teacher = pickTeacher(
          ppiSubject, eligibleTeachers,
          teacherBusy[busyKey], null, teacherLoad, level, cls
        );
        schedule[day][period.id] = teacher
          ? slotFor(ppiSubject, teacher, cls)
          : {
              subject: ppiSubject,
              teacherId: '',
              teacherInitials: 'TBA',
              teacherFullName: '',
              room: `${cls} Room`,
            };
        if (teacher) {
          teacherBusy[busyKey].add(teacher.id);
          teacherLoad[teacher.id] = (teacherLoad[teacher.id] || 0) + 1;
        }
        prevSubject = ppiSubject;
        continue;
      }

      // 3) Double-period candidate (practical subjects, upper levels only)
      if (allowDoubles && i + 1 < periods.length) {
        const next = periods[i + 1];
        const nextBusyKey = `${day}|${next.id}`;

        // Don't double into a break, PPI, or event.
        const nextIsBlocked =
          next.type === 'break' ||
          next.isPPI ||
          eventSlots[nextBusyKey] ||
          (ppiPeriod && day === PPI_DAY && next.id === ppiPeriod.id);

        if (!nextIsBlocked) {
          const candidate = pickDoubleCandidate(dayPool, prevSubject, periodBeforeBreak, period);
          if (candidate) {
            const teacher = pickTeacher(
              candidate, eligibleTeachers,
              teacherBusy[busyKey], teacherBusy[nextBusyKey],
              teacherLoad, level, cls
            );
            if (teacher) {
              const shared = slotFor(candidate, teacher, cls);
              schedule[day][period.id] = { ...shared, doubleWith: next.id };
              schedule[day][next.id] = { ...shared, doubleWith: period.id };
              teacherBusy[busyKey].add(teacher.id);
              teacherBusy[nextBusyKey].add(teacher.id);
              teacherLoad[teacher.id] = (teacherLoad[teacher.id] || 0) + 2;
              removeFirst(dayPool, candidate);
              removeFirst(dayPool, candidate);
              prevSubject = candidate;
              i += 1;
              continue;
            }
          }
        }
      }

      // 4) Single period — pick the next subject that respects the rules.
      const chosen = chooseSubjectForSlot({
        dayPool,
        prevSubject,
        isBeforeBreak: periodBeforeBreak.has(period.id),
        eligibleTeachers,
        busySet: teacherBusy[busyKey],
        teacherLoad,
        level,
        cls,
      });

      if (chosen) {
        const { subject, teacher } = chosen;
        schedule[day][period.id] = slotFor(subject, teacher, cls);
        teacherBusy[busyKey].add(teacher.id);
        teacherLoad[teacher.id] = (teacherLoad[teacher.id] || 0) + 1;
        removeFirst(dayPool, subject);
        prevSubject = subject;
      } else {
        unassigned.push({
          day,
          periodId: period.id,
          reason: 'No qualified teacher available or pedagogical rule blocked',
        });
        prevSubject = null;
      }
    }
  }

  return { schedule, unassigned, finalTeacherLoad: teacherLoad };
}

/* ---- generator internals ---- */

function slotFor(subject, teacher, cls) {
  return {
    subject,
    teacherId: teacher.id,
    teacherInitials: teacherInitials(teacher),
    teacherFullName: teacherFullName(teacher),
    room: `${cls} Room`,
  };
}

/**
 * Pick a teacher for `subject` who:
 *  - actually teaches this subject at this level/class
 *  - is free in this slot (and, optionally, in the double slot)
 *  - is under their effective max load
 * Prefer the least-loaded candidate, tie-broken by name.
 */
function pickTeacher(subject, teachers, busySet, extraBusySet, load, level = null, cls = null) {
  const candidates = teachers
    .filter((t) => teacherTeaches(t, subject, level, cls))
    .filter((t) => !busySet.has(t.id))
    .filter((t) => !extraBusySet || !extraBusySet.has(t.id))
    .filter((t) => (load[t.id] || 0) < teacherMaxLoad(t));

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const d = (load[a.id] || 0) - (load[b.id] || 0);
    if (d !== 0) return d;
    return teacherFullName(a).localeCompare(teacherFullName(b));
  });
  return candidates[0];
}

/**
 * Ids of periods immediately followed by a break. Used to place
 * psychomotor subjects so they sit right before a break.
 */
function getPeriodBeforeBreak(periods) {
  const set = new Set();
  for (let i = 0; i < periods.length - 1; i += 1) {
    if (periods[i + 1].type === 'break') set.add(periods[i].id);
  }
  return set;
}

function isMonotonyBlocked(prev, next) {
  if (!prev || !next || prev === next) return false;
  return ANTI_MONOTONY_PAIRS.some(([a, b]) => (
    (prev === a && next === b) || (prev === b && next === a)
  ));
}

/**
 * Pick a double-lesson candidate: must be a practical subject, must
 * not violate monotony, and must not be a psychomotor subject placed
 * somewhere it doesn't belong.
 */
function pickDoubleCandidate(dayPool, prevSubject, periodBeforeBreak, currentPeriod) {
  const unique = [...new Set(dayPool)];
  return unique.find((s) => {
    if (!DOUBLE_PERIOD_SUBJECTS.has(s)) return false;
    if (isMonotonyBlocked(prevSubject, s)) return false;
    // Psychomotor subjects shouldn't be doubled.
    if (PSYCHOMOTOR_SUBJECTS.has(s)) return false;
    // Only place doubles in a non-before-break slot; a double that
    // straddles a break would be pedagogically wrong.
    if (periodBeforeBreak.has(currentPeriod.id)) return false;
    return true;
  });
}

/**
 * Choose the best subject for a single slot, honouring:
 *  - psychomotor-before-break (hard requirement when possible)
 *  - anti-monotony rule
 *  - teacher availability
 *  - subject still has remaining weekly allocation
 */
function chooseSubjectForSlot({
  dayPool,
  prevSubject,
  isBeforeBreak,
  eligibleTeachers,
  busySet,
  teacherLoad,
  level,
  cls,
}) {
  const unique = [...new Set(dayPool)];

  // 1) Psychomotor subjects get priority if this slot precedes a break.
  if (isBeforeBreak) {
    for (const s of unique) {
      if (!PSYCHOMOTOR_SUBJECTS.has(s)) continue;
      if (isMonotonyBlocked(prevSubject, s)) continue;
      const t = pickTeacher(s, eligibleTeachers, busySet, null, teacherLoad, level, cls);
      if (t) return { subject: s, teacher: t };
    }
  }

  // 2) General case — pick the least-loaded, rule-respecting subject.
  // Build (subject, teacher) pairs and sort by teacher load ascending.
  const candidates = [];
  for (const s of unique) {
    if (isMonotonyBlocked(prevSubject, s)) continue;
    // De-prioritise psychomotor subjects outside pre-break slots.
    if (PSYCHOMOTOR_SUBJECTS.has(s) && !isBeforeBreak) continue;
    const t = pickTeacher(s, eligibleTeachers, busySet, null, teacherLoad, level, cls);
    if (!t) continue;
    candidates.push({ subject: s, teacher: t, load: teacherLoad[t.id] || 0 });
  }
  candidates.sort((a, b) => a.load - b.load);
  if (candidates.length > 0) {
    return { subject: candidates[0].subject, teacher: candidates[0].teacher };
  }

  // 3) Relax the monotony rule as a last resort, but keep the
  //    psychomotor constraint.
  for (const s of unique) {
    if (PSYCHOMOTOR_SUBJECTS.has(s) && !isBeforeBreak) continue;
    const t = pickTeacher(s, eligibleTeachers, busySet, null, teacherLoad, level, cls);
    if (t) return { subject: s, teacher: t };
  }

  return null;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function removeFirst(arr, value) {
  const idx = arr.indexOf(value);
  if (idx !== -1) arr.splice(idx, 1);
}

/* ============================================================
   Clash engine
   ============================================================ */

export function detectClashes(level, cls, proposedSchedule, otherSchedules, customConfig = null) {
  const periods = classPeriodsForLevel(level, customConfig);
  const clashes = [];
  const otherEntries = Object.entries(otherSchedules || {}).filter(([c]) => c !== cls);

  for (const day of DAYS) {
    for (const p of periods) {
      const slot = proposedSchedule?.[day]?.[p.id];
      if (!slot?.teacherId) continue;
      for (const [otherCls, sched] of otherEntries) {
        const other = sched?.[day]?.[p.id];
        if (other?.teacherId === slot.teacherId) {
          clashes.push({
            type: 'teacher',
            day, periodId: p.id, periodName: p.name,
            teacherId: slot.teacherId,
            teacherName: slot.teacherFullName || slot.teacherInitials,
            otherClass: otherCls,
            otherSubject: other.subject,
          });
        }
      }
    }
  }
  return clashes;
}

export function detectDutyClashes(roster, dutyAreas = DUTY_AREAS) {
  const clashes = [];
  for (const day of DAYS) {
    const entries = [];
    const dayRoster = roster?.[day] || {};
    for (const area of dutyAreas) {
      const entry = dayRoster[area.id];
      if (!entry?.teacherId) continue;
      entries.push({ area, teacherId: entry.teacherId, teacherName: entry.teacherFullName });
    }
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i], b = entries[j];
        if (a.teacherId !== b.teacherId) continue;
        if (a.area.end > b.area.start && b.area.end > a.area.start) {
          clashes.push({
            type: 'duty',
            day,
            teacherId: a.teacherId,
            teacherName: a.teacherName,
            areaA: a.area.label,
            areaB: b.area.label,
          });
        }
      }
    }
  }
  return clashes;
}

/* ============================================================
   Analytics
   ============================================================ */

export function summarizeTeacherLoad(allSchedules, level, customConfig = null) {
  const periods = classPeriodsForLevel(level, customConfig);
  const load = {};
  for (const [clsName, sched] of Object.entries(allSchedules || {})) {
    for (const day of DAYS) {
      for (const p of periods) {
        const slot = sched?.[day]?.[p.id];
        if (!slot?.teacherId) continue;
        if (!load[slot.teacherId]) {
          load[slot.teacherId] = {
            teacherId: slot.teacherId,
            initials: slot.teacherInitials,
            fullName: slot.teacherFullName,
            assignments: [],
            classes: new Set(),
          };
        }
        load[slot.teacherId].assignments.push({
          day, period: p, subject: slot.subject, className: clsName,
        });
        load[slot.teacherId].classes.add(clsName);
      }
    }
  }
  return Object.values(load)
    .map((t) => ({ ...t, classes: [...t.classes] }))
    .sort((a, b) => b.assignments.length - a.assignments.length);
}

export function summarizeClassCoverage(level, subjects, schedule, customConfig = null) {
  const periods = classPeriodsForLevel(level, customConfig);
  const counts = {};
  for (const sub of subjects) counts[sub] = 0;
  for (const day of DAYS) {
    for (const p of periods) {
      const slot = schedule?.[day]?.[p.id];
      if (slot?.subject && counts[slot.subject] != null) counts[slot.subject] += 1;
    }
  }
  const missing = subjects.filter((s) => counts[s] === 0);
  const under = subjects.filter((s) => {
    const expected = weightForSubject(s);
    return counts[s] > 0 && counts[s] < expected;
  });
  return { counts, missing, under };
}

/* ============================================================
   Duty roster generation
   ============================================================ */

export function generateDutyRoster(teachers, customAreas = DUTY_AREAS) {
  if (!teachers.length) return {};

  const roster = {};
  const teacherLoad = {};
  teachers.forEach((t) => { teacherLoad[t.id] = 0; });

  for (const day of DAYS) {
    roster[day] = {};
    const availableTeachers = shuffle([...teachers]);

    for (const area of customAreas) {
      const assigned = [];
      for (const a of customAreas) {
        if (a.id === area.id) continue;
        const entry = roster[day][a.id];
        if (entry?.teacherId) {
          const overlap = entry.area?.end > area.start && area.end > entry.area?.start;
          if (overlap || (a.start < area.end && area.start < a.end)) {
            assigned.push(entry.teacherId);
          }
        }
      }

      const candidates = availableTeachers
        .filter((t) => !assigned.includes(t.id))
        .sort((a, b) => (teacherLoad[a.id] || 0) - (teacherLoad[b.id] || 0));

      if (candidates.length > 0) {
        const t = candidates[0];
        roster[day][area.id] = {
          teacherId: t.id,
          teacherInitials: teacherInitials(t),
          teacherFullName: teacherFullName(t),
          area,
        };
        teacherLoad[t.id] = (teacherLoad[t.id] || 0) + 1;
      }
    }
  }

  return roster;
}

/* ============================================================
   Teacher scoping — which classes can this teacher see?
   ============================================================ */

export function getTeacherClassScope(userData) {
  if (!userData) return [];
  const set = new Set();

  const assignments = Array.isArray(userData.assignments) ? userData.assignments : [];
  for (const a of assignments) {
    (a.classes || []).forEach((c) => { if (c) set.add(c); });
  }

  if (set.size === 0 && Array.isArray(userData.classes)) {
    userData.classes.forEach((c) => { if (c) set.add(c); });
  }

  if (set.size === 0 && userData.class) {
    set.add(userData.class);
  }

  return [...set].sort();
}

export function getTeacherLevelScope(userData) {
  if (!userData) return [];
  if (Array.isArray(userData.levels) && userData.levels.length > 0) {
    return [...userData.levels];
  }
  if (userData.level) return [userData.level];
  return [];
}

/* ============================================================
   Teacher-scoped timetable reads
   ============================================================ */

export async function loadSchedulesForTeacher(schoolId, level, term, year, allowedClasses) {
  const all = await loadAllSchedulesForLevel(schoolId, level, term, year);
  if (!Array.isArray(allowedClasses) || allowedClasses.length === 0) return all;
  const allow = new Set(allowedClasses);
  const filtered = {};
  for (const [cls, sched] of Object.entries(all)) {
    if (allow.has(cls)) filtered[cls] = sched;
  }
  return filtered;
}

/* ============================================================
   Teacher workload summary (for the current user's own view)
   ============================================================ */

export function summarizeTeacherLoadForTeacher(allSchedules, teacherId, level, customConfig = null) {
  const periods = classPeriodsForLevel(level, customConfig);
  const assignments = [];
  const classes = new Set();

  for (const [clsName, sched] of Object.entries(allSchedules || {})) {
    for (const day of DAYS) {
      for (const p of periods) {
        const slot = sched?.[day]?.[p.id];
        if (slot?.teacherId !== teacherId) continue;
        assignments.push({
          day,
          period: p,
          subject: slot.subject,
          className: clsName,
          room: slot.room || '',
        });
        classes.add(clsName);
      }
    }
  }

  return {
    teacherId,
    assignments,
    classes: [...classes].sort(),
    totalPeriods: assignments.length,
  };
}
