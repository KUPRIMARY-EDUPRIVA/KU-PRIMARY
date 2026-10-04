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
 * Level-specific timing and lesson structure per KICD/CBE standards.
 * Each level defines:
 *   - lessonsPerDay: number of academic lessons
 *   - lessonDuration: minutes per lesson
 *   - startTime: official start of academic day (after assembly)
 *   - endTime: official dismissal
 *   - assemblyStart/assemblyEnd: morning assembly block
 *   - breaks: array of { afterLesson, duration, name, label }
 *   - allowsDoubles: whether double lessons are permitted
 *   - doubleSubjects: subjects that may have double lessons (if allowsDoubles)
 *   - ppiSlot: which period index is reserved for PPI (Pastoral Programme)
 */
export const LEVEL_TIMING_CONFIG = Object.freeze({
  'pre-primary': {
    lessonsPerDay: 5,
    lessonDuration: 30,
    startTime: '09:00',
    endTime: '12:00',
    assemblyStart: '08:30',
    assemblyEnd: '09:00',
    assemblyLabel: 'Roll Call / Assembly',
    breaks: [
      { afterLesson: 2, duration: 10, name: 'Short Break', label: 'SHORT BREAK' },
      { afterLesson: 3, duration: 20, name: 'Lunch Break', label: 'LUNCH BREAK' },
    ],
    allowsDoubles: false,
    doubleSubjects: [],
    ppiSlot: 0, // First period on Friday is PPI
    weeklyLessons: 25,
    totalWithPPI: 25,
  },
  'lower-primary': {
    lessonsPerDay: 6,
    lessonDuration: 30,
    startTime: '08:20',
    endTime: '12:30',
    assemblyStart: '08:00',
    assemblyEnd: '08:20',
    assemblyLabel: 'Assembly / Health Check',
    breaks: [
      { afterLesson: 2, duration: 10, name: 'Short Break', label: 'SHORT BREAK' },
      { afterLesson: 4, duration: 30, name: 'Main Break', label: 'MAIN BREAK' },
    ],
    allowsDoubles: false,
    doubleSubjects: [],
    ppiSlot: 0, // First period on Friday is PPI
    weeklyLessons: 30,
    totalWithPPI: 31,
  },
  'upper-primary': {
    lessonsPerDay: 7,
    lessonDuration: 35,
    startTime: '08:20',
    endTime: '14:35',
    assemblyStart: '08:00',
    assemblyEnd: '08:20',
    assemblyLabel: 'Assembly / Health Check',
    breaks: [
      { afterLesson: 2, duration: 10, name: 'Short Break', label: 'SHORT BREAK' },
      { afterLesson: 5, duration: 30, name: 'Main Break', label: 'MAIN BREAK' },
    ],
    allowsDoubles: true,
    doubleSubjects: ['Integrated Science', 'Science and Technology', 'Pre-Technical Studies', 'Agriculture and Nutrition', 'Home Science'],
    ppiSlot: 0,
    weeklyLessons: 35,
    totalWithPPI: 35,
  },
  'junior-school': {
    lessonsPerDay: 8,
    lessonDuration: 40,
    startTime: '08:20',
    endTime: '15:20',
    assemblyStart: '08:00',
    assemblyEnd: '08:20',
    assemblyLabel: 'Assembly / Health Check',
    breaks: [
      { afterLesson: 2, duration: 10, name: 'Short Break', label: 'SHORT BREAK' },
      { afterLesson: 5, duration: 30, name: 'Main Break', label: 'MAIN BREAK' },
    ],
    allowsDoubles: true,
    doubleSubjects: ['Integrated Science', 'Biology', 'Chemistry', 'Physics', 'Pre-Technical Studies', 'Agriculture and Nutrition', 'Home Science'],
    ppiSlot: 0,
    weeklyLessons: 40,
    totalWithPPI: 41,
  },
  'senior-school': {
    lessonsPerDay: 8,
    lessonDuration: 40,
    startTime: '08:00',
    endTime: '15:20',
    assemblyStart: '07:40',
    assemblyEnd: '08:00',
    assemblyLabel: 'Assembly / Health Check',
    breaks: [
      { afterLesson: 2, duration: 10, name: 'Short Break', label: 'SHORT BREAK' },
      { afterLesson: 5, duration: 30, name: 'Main Break', label: 'MAIN BREAK' },
    ],
    allowsDoubles: true,
    doubleSubjects: ['Biology', 'Chemistry', 'Physics', 'Computer Studies', 'Home Science', 'Agriculture'],
    ppiSlot: 0,
    weeklyLessons: 40,
    totalWithPPI: 40,
  },
});

/**
 * Build the period structure for a level from timing config.
 */
export function buildPeriodsFromConfig(level) {
  const config = LEVEL_TIMING_CONFIG[level] || LEVEL_TIMING_CONFIG['junior-school'];
  const periods = [];
  
  // Add assembly
  periods.push({
    id: 'assembly',
    name: config.assemblyLabel,
    start: config.assemblyStart,
    end: config.assemblyEnd,
    type: 'routine',
    label: config.assemblyLabel,
    isFixed: true,
  });

  let currentTime = config.startTime;
  let lessonCount = 0;
  let breakIndex = 0;

  for (let i = 0; i < config.lessonsPerDay; i++) {
    // Add lesson
    const lessonEnd = addMinutes(currentTime, config.lessonDuration);
    periods.push({
      id: `p${i + 1}`,
      name: `Period ${i + 1}`,
      start: currentTime,
      end: lessonEnd,
      type: 'class',
    });
    lessonCount++;
    currentTime = lessonEnd;

    // Check if a break should follow this lesson
    const breakConfig = config.breaks.find(b => b.afterLesson === lessonCount);
    if (breakConfig) {
      const breakEnd = addMinutes(currentTime, breakConfig.duration);
      periods.push({
        id: `break${breakIndex + 1}`,
        name: breakConfig.name,
        start: currentTime,
        end: breakEnd,
        type: 'break',
        label: breakConfig.label,
      });
      currentTime = breakEnd;
      breakIndex++;
    }
  }

  return periods;
}

function addMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

/**
 * Default period structures — now built from LEVEL_TIMING_CONFIG.
 * Schools can still override via Settings.
 */
export const DEFAULT_PERIOD_STRUCTURES = Object.freeze(
  Object.fromEntries(
    Object.keys(LEVEL_TIMING_CONFIG).map(level => [
      level,
      buildPeriodsFromConfig(level)
    ])
  )
);

/**
 * Cognitive load groups — subjects in the same group should not be
 * scheduled back-to-back (Anti-Monotony Rule).
 */
export const COGNITIVE_GROUPS = Object.freeze({
  'mathematical': ['Mathematics', 'Pre-Technical Studies'],
  'scientific': ['Science', 'Science and Technology', 'Integrated Science', 'Biology', 'Chemistry', 'Physics'],
  'linguistic': ['English', 'Kiswahili', 'Literacy', 'Indigenous Languages'],
  'humanities': ['Social Studies', 'CRE/IRE/HRE', 'Religious Education', 'Christian Religious Education', 'Islamic Religious Education', 'Hindu Religious Education'],
  'creative': ['Art and Craft', 'Creative Arts and Sports', 'Music', 'Physical Education', 'PE', 'Games'],
  'technical': ['Agriculture and Nutrition', 'Agriculture', 'Home Science', 'Computer Studies'],
});

/**
 * Psychomotor/creative subjects that must be placed before a break.
 */
export const PSYCHOMOTOR_SUBJECTS = new Set([
  'Creative Arts and Sports', 'Physical Education', 'PE', 'Games',
  'Art and Craft', 'Music', 'Home Science',
]);

/**
 * PPI (Pastoral Programme of Instruction) subject name.
 */
export const PPI_SUBJECT = 'PPI';

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
  'Home Science': 'tt-sub-agric',
  'Computer Studies': 'tt-sub-tech',
  'Games': 'tt-sub-games',
  'PE': 'tt-sub-games',
  'Clubs': 'tt-sub-clubs',
  'Library': 'tt-sub-library',
  'PPI': 'tt-sub-ppi',
});

export const SUBJECT_WEIGHTS = Object.freeze({
  'Mathematics': 5, 'English': 5, 'Kiswahili': 4,
  'Science': 4, 'Science and Technology': 4, 'Integrated Science': 4,
  'Biology': 4, 'Chemistry': 4, 'Physics': 4,
  'Social Studies': 3, 'Pre-Technical Studies': 3, 'Agriculture and Nutrition': 3,
  'Agriculture': 3, 'Home Science': 3, 'Computer Studies': 3,
  'CRE/IRE/HRE': 3, 'Religious Education': 3,
  'Christian Religious Education': 3, 'Islamic Religious Education': 3,
  'Hindu Religious Education': 3,
  'Art and Craft': 2, 'Creative Arts and Sports': 2, 'Music': 2, 'Physical Education': 2,
  'Games': 2, 'PE': 2, 'Clubs': 1, 'Library': 1, 'PPI': 1,
});

export const DEFAULT_SUBJECT_WEIGHT = 2;

/* ============================================================
   Teacher Workload Constraints (CBE Alignment)
   ============================================================ */

export const WORKLOAD_STANDARD = 27; // Standard full-time teacher
export const WORKLOAD_MAX = 35;      // Maximum cap

/**
 * Administrative role offsets — these reduce the max teaching load.
 * e.g. Headteacher max = 35 - 12 = 23 periods/week
 */
export const ADMIN_ROLE_OFFSETS = Object.freeze({
  'headteacher': 12,
  'principal': 12,
  'deputy_headteacher': 8,
  'deputy_principal': 8,
  'senior_master': 6,
  'senior_mistress': 6,
  'hod': 4,
  'head_of_department': 4,
  'bursar': 10,
  'accountant': 10,
  'librarian': 10,
});

/**
 * Get the effective max workload for a teacher based on their role.
 */
export function getTeacherMaxWorkload(teacher) {
  const role = (teacher.adminRole || teacher.role || '').toLowerCase().replace(/\s+/g, '_');
  const offset = ADMIN_ROLE_OFFSETS[role] || 0;
  return Math.max(1, WORKLOAD_MAX - offset);
}

/**
 * Check if a teacher is overloaded.
 */
export function isTeacherOverloaded(teacher, currentLoad) {
  const max = getTeacherMaxWorkload(teacher);
  return currentLoad >= max;
}

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

export function routinePeriodsForLevel(level, customConfig = null) {
  return periodsForLevel(level, customConfig).filter((p) => p.type === 'routine');
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
   Cognitive group helpers
   ============================================================ */

function getCognitiveGroup(subject) {
  for (const [group, subjects] of Object.entries(COGNITIVE_GROUPS)) {
    if (subjects.includes(subject)) return group;
  }
  return null;
}

function areSameCognitiveGroup(subjA, subjB) {
  const groupA = getCognitiveGroup(subjA);
  const groupB = getCognitiveGroup(subjB);
  return groupA && groupB && groupA === groupB;
}

function isPsychomotor(subject) {
  return PSYCHOMOTOR_SUBJECTS.has(subject);
}

/* ============================================================
   Generator with Full Standards Compliance
   ============================================================ */

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
  const timingConfig = LEVEL_TIMING_CONFIG[level] || LEVEL_TIMING_CONFIG['junior-school'];
  const allowDoubles = timingConfig.allowsDoubles;
  const doubleSubjects = new Set(timingConfig.doubleSubjects || []);
  const totalPeriods = periods.length;

  // Build the weekly pool of subjects for this class
  const pool = [];
  for (const sub of subjects) {
    const w = weightForSubject(sub);
    for (let i = 0; i < w; i += 1) pool.push(sub);
  }

  // Ensure PPI is included (one slot per week)
  const hasPPI = subjects.includes(PPI_SUBJECT) || subjects.some(s => s.toLowerCase().includes('ppi') || s.toLowerCase().includes('pastoral'));
  if (!hasPPI && timingConfig.ppiSlot !== undefined) {
    // Add PPI to the pool
    pool.push(PPI_SUBJECT);
  }

  // Compute teacher busy slots from other classes
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

  // Copy teacher load
  const teacherLoad = { ...existingTeacherLoad };

  // Build event lookup: day|periodId -> event
  const eventSlots = {};
  for (const ev of events) {
    if (ev.classes && !ev.classes.includes(cls)) continue;
    if (ev.level && ev.level !== level) continue;
    for (const day of DAYS) {
      if (ev.days && !ev.days.includes(day)) continue;
      if (ev.periodIds) {
        for (const pid of ev.periodIds) {
          eventSlots[`${day}|${pid}`] = ev;
        }
      }
    }
  }

  const schedule = {};
  const unassigned = [];

  // Track last subject per day to enforce anti-monotony
  const lastSubjectByDay = {};

  for (const day of DAYS) {
    schedule[day] = {};
    lastSubjectByDay[day] = null;
    
    // Create day pool
    let dayPool = shuffle([...pool]);
    
    // On Friday, reserve the PPI slot
    const isFriday = day === 'Friday';
    const ppiSlotIndex = isFriday ? timingConfig.ppiSlot : -1;

    for (let i = 0; i < periods.length; i += 1) {
      const period = periods[i];
      const busyKey = `${day}|${period.id}`;
      const isLastPeriodBeforeBreak = isPeriodBeforeBreak(periods, i);

      // Check for event override
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
        continue;
      }

      // PPI slot on Friday
      if (isFriday && i === ppiSlotIndex) {
        const ppiTeacher = pickTeacher(PPI_SUBJECT, teachers, teacherBusy[busyKey], null, teacherLoad, level);
        schedule[day][period.id] = ppiTeacher
          ? slotFor(PPI_SUBJECT, ppiTeacher, cls)
          : {
              subject: PPI_SUBJECT,
              teacherId: '',
              teacherInitials: 'PPI',
              teacherFullName: 'Pastoral Programme',
              room: 'Assembly Hall',
            };
        if (ppiTeacher) {
          teacherBusy[busyKey].add(ppiTeacher.id);
          teacherLoad[ppiTeacher.id] = (teacherLoad[ppiTeacher.id] || 0) + 1;
        }
        // Remove PPI from pool if present
        const ppiIdx = dayPool.findIndex(s => s === PPI_SUBJECT);
        if (ppiIdx >= 0) dayPool.splice(ppiIdx, 1);
        lastSubjectByDay[day] = PPI_SUBJECT;
        continue;
      }

      // Double-period logic (only for allowed levels and subjects)
      if (allowDoubles && i + 1 < periods.length) {
        const next = periods[i + 1];
        const nextBusyKey = `${day}|${next.id}`;
        const nextIsBreak = next.type === 'break';
        
        if (!nextIsBreak && !eventSlots[nextBusyKey]) {
          // Find a double-eligible subject that hasn't been used recently
          const candidate = dayPool.find((s) => 
            doubleSubjects.has(s) && 
            !areSameCognitiveGroup(s, lastSubjectByDay[day])
          );
          
          if (candidate) {
            const teacher = pickTeacher(candidate, teachers, teacherBusy[busyKey], teacherBusy[nextBusyKey], teacherLoad, level);
            if (teacher) {
              const shared = slotFor(candidate, teacher, cls);
              schedule[day][period.id] = { ...shared, doubleWith: next.id };
              schedule[day][next.id] = { ...shared, doubleWith: period.id };
              teacherBusy[busyKey].add(teacher.id);
              teacherBusy[nextBusyKey].add(teacher.id);
              teacherLoad[teacher.id] = (teacherLoad[teacher.id] || 0) + 2;
              removeFirst(dayPool, candidate);
              removeFirst(dayPool, candidate);
              lastSubjectByDay[day] = candidate;
              i += 1;
              continue;
            }
          }
        }
      }

      // Single period — find best subject
      let assigned = null;
      let bestCandidate = null;
      let bestScore = -Infinity;

      for (const candidateSubject of dayPool) {
        // Anti-monotony: skip if same cognitive group as last subject
        if (areSameCognitiveGroup(candidateSubject, lastSubjectByDay[day])) {
          continue;
        }

        // Psychomotor placement: prefer before break
        let score = 0;
        if (isLastPeriodBeforeBreak && isPsychomotor(candidateSubject)) {
          score += 10;
        }
        if (!isLastPeriodBeforeBreak && isPsychomotor(candidateSubject)) {
          score -= 5;
        }

        // Check teacher availability
        const teacher = pickTeacher(candidateSubject, teachers, teacherBusy[busyKey], null, teacherLoad, level);
        if (!teacher) {
          score -= 20;
        } else {
          score += 5;
        }

        if (score > bestScore) {
          bestScore = score;
          bestCandidate = candidateSubject;
          assigned = teacher ? slotFor(candidateSubject, teacher, cls) : null;
        }
      }

      // Fallback: if no candidate passed anti-monotony, allow same group
      if (!bestCandidate) {
        for (const candidateSubject of dayPool) {
          const teacher = pickTeacher(candidateSubject, teachers, teacherBusy[busyKey], null, teacherLoad, level);
          if (teacher) {
            bestCandidate = candidateSubject;
            assigned = slotFor(candidateSubject, teacher, cls);
            break;
          }
        }
      }

      if (assigned && bestCandidate) {
        schedule[day][period.id] = assigned;
        teacherBusy[busyKey].add(assigned.teacherId);
        teacherLoad[assigned.teacherId] = (teacherLoad[assigned.teacherId] || 0) + 1;
        removeFirst(dayPool, bestCandidate);
        lastSubjectByDay[day] = bestCandidate;
      } else {
        unassigned.push({ 
          day, 
          periodId: period.id, 
          reason: 'No qualified teacher available or workload cap reached' 
        });
      }
    }
  }

  return { schedule, unassigned, finalTeacherLoad: teacherLoad };
}

/* ---- generator internals ---- */

function isPeriodBeforeBreak(periods, index) {
  if (index + 1 >= periods.length) return false;
  return periods[index + 1].type === 'break';
}

function slotFor(subject, teacher, cls) {
  return {
    subject,
    teacherId: teacher.id,
    teacherInitials: teacherInitials(teacher),
    teacherFullName: teacherFullName(teacher),
    room: `${cls} Room`,
  };
}

function pickTeacher(subject, teachers, busySet, extraBusySet, load, level) {
  const candidates = teachers
    .filter((t) => teacherTeaches(t, subject))
    .filter((t) => !busySet.has(t.id))
    .filter((t) => !extraBusySet || !extraBusySet.has(t.id))
    .filter((t) => {
      const currentLoad = load[t.id] || 0;
      const maxLoad = getTeacherMaxWorkload(t);
      return currentLoad < maxLoad;
    });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const d = (load[a.id] || 0) - (load[b.id] || 0);
    if (d !== 0) return d;
    return teacherFullName(a).localeCompare(teacherFullName(b));
  });
  return candidates[0];
}

function teacherTeaches(teacher, subject) {
  // PPI can be taught by any teacher
  if (subject === PPI_SUBJECT) return true;
  
  const declared = Array.isArray(teacher.subjects) ? teacher.subjects : [];
  if (declared.length === 0) return true;
  return declared.includes(subject);
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

/**
 * Get detailed workload summary with compliance status.
 */
export function summarizeTeacherWorkload(allSchedules, teachers, level, customConfig = null) {
  const periods = classPeriodsForLevel(level, customConfig);
  const load = {};
  
  // Initialize all teachers
  for (const t of teachers) {
    load[t.id] = {
      teacherId: t.id,
      initials: teacherInitials(t),
      fullName: teacherFullName(t),
      adminRole: t.adminRole || t.role || '',
      maxWorkload: getTeacherMaxWorkload(t),
      standardWorkload: WORKLOAD_STANDARD,
      assignments: [],
      classes: new Set(),
      totalPeriods: 0,
    };
  }
  
  // Count assignments
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
            adminRole: '',
            maxWorkload: WORKLOAD_MAX,
            standardWorkload: WORKLOAD_STANDARD,
            assignments: [],
            classes: new Set(),
            totalPeriods: 0,
          };
        }
        load[slot.teacherId].assignments.push({
          day, period: p, subject: slot.subject, className: clsName,
        });
        load[slot.teacherId].classes.add(clsName);
        load[slot.teacherId].totalPeriods++;
      }
    }
  }
  
  // Add compliance status
  return Object.values(load).map(t => ({
    ...t,
    classes: [...t.classes],
    isOverloaded: t.totalPeriods > t.maxWorkload,
    isAtStandard: t.totalPeriods >= t.standardWorkload,
    utilizationPercent: Math.round((t.totalPeriods / t.maxWorkload) * 100),
    status: t.totalPeriods > t.maxWorkload ? 'overloaded' 
           : t.totalPeriods >= t.standardWorkload ? 'optimal'
           : t.totalPeriods > 0 ? 'underutilized'
           : 'unassigned',
  })).sort((a, b) => b.totalPeriods - a.totalPeriods);
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
   Teacher scoping
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

/* ============================================================
   Standards Compliance Validation
   ============================================================ */

/**
 * Validate a generated schedule against all standards.
 * Returns { valid, violations: [] }
 */
export function validateScheduleCompliance(level, schedule, teachers, teacherLoad, customConfig = null) {
  const violations = [];
  const periods = classPeriodsForLevel(level, customConfig);
  const timingConfig = LEVEL_TIMING_CONFIG[level];

  // 1. Check double lesson restrictions
  if (!timingConfig.allowsDoubles) {
    for (const day of DAYS) {
      for (const p of periods) {
        const slot = schedule?.[day]?.[p.id];
        if (slot?.doubleWith) {
          violations.push({
            type: 'double_lesson',
            severity: 'error',
            message: `Double lesson not allowed for ${level} on ${day} ${p.name}`,
          });
        }
      }
    }
  }

  // 2. Check psychomotor placement (should be before break)
  const breakAfterIndices = new Set();
  periods.forEach((p, i) => {
    if (i > 0 && periods[i - 1]?.type === 'break') return;
    if (i + 1 < periods.length && periods[i + 1]?.type === 'break') {
      breakAfterIndices.add(i);
    }
  });

  for (const day of DAYS) {
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      const slot = schedule?.[day]?.[p.id];
      if (!slot?.subject) continue;
      
      if (isPsychomotor(slot.subject) && !breakAfterIndices.has(i)) {
        // Warning, not error — soft rule
        violations.push({
          type: 'psychomotor_placement',
          severity: 'warning',
          message: `Psychomotor subject "${slot.subject}" should be placed before a break (${day} ${p.name})`,
        });
      }
    }
  }

  // 3. Check teacher workload caps
  for (const [teacherId, load] of Object.entries(teacherLoad || {})) {
    const teacher = teachers.find(t => t.id === teacherId);
    if (!teacher) continue;
    const maxWorkload = getTeacherMaxWorkload(teacher);
    if (load > maxWorkload) {
      violations.push({
        type: 'workload_exceeded',
        severity: 'error',
        message: `${teacherFullName(teacher)} has ${load} periods (max: ${maxWorkload})`,
        teacherId,
      });
    }
  }

  // 4. Check PPI is present (one per week)
  const hasPPI = Object.values(schedule || {}).some(day =>
    Object.values(day || {}).some(slot =>
      slot?.subject === PPI_SUBJECT || slot?.subject?.toLowerCase().includes('ppi')
    )
  );
  if (!hasPPI && timingConfig.ppiSlot !== undefined) {
    violations.push({
      type: 'missing_ppi',
      severity: 'error',
      message: 'PPI (Pastoral Programme of Instruction) slot is missing',
    });
  }

  return {
    valid: violations.filter(v => v.severity === 'error').length === 0,
    violations,
  };
}

/**
 * Get recommended periods per day for a level.
 */
export function getRecommendedPeriodsPerDay(level) {
  return LEVEL_TIMING_CONFIG[level]?.lessonsPerDay || 8;
}

/**
 * Get total weekly periods for a level.
 */
export function getWeeklyPeriodsForLevel(level) {
  return LEVEL_TIMING_CONFIG[level]?.totalWithPPI || 40;
}
