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
 * Default period structures per level. These are DEFAULTS — schools
 * can override via Settings which stores a custom config in Firestore.
 */
export const DEFAULT_PERIOD_STRUCTURES = Object.freeze({
  'pre-primary': [
    { id: 'p1', name: 'Period 1', start: '08:00', end: '08:30', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '08:30', end: '09:00', type: 'class' },
    { id: 'break1', name: 'Morning Break', start: '09:00', end: '09:30', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:30', end: '10:00', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:00', end: '10:30', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', start: '10:30', end: '11:30', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p5', name: 'Period 5', start: '11:30', end: '12:00', type: 'class' },
    { id: 'p6', name: 'Period 6', start: '12:00', end: '12:30', type: 'class' },
  ],
  'lower-primary': [
    { id: 'p1', name: 'Period 1', start: '08:00', end: '08:40', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '08:40', end: '09:20', type: 'class' },
    { id: 'break1', name: 'Morning Break', start: '09:20', end: '09:50', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:50', end: '10:30', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:30', end: '11:10', type: 'class' },
    { id: 'p5', name: 'Period 5', start: '11:10', end: '11:50', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', start: '11:50', end: '13:00', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p6', name: 'Period 6', start: '13:00', end: '13:40', type: 'class' },
    { id: 'p7', name: 'Period 7', start: '13:40', end: '14:20', type: 'class' },
  ],
  'upper-primary': [
    { id: 'p1', name: 'Period 1', start: '08:00', end: '08:40', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '08:40', end: '09:20', type: 'class' },
    { id: 'break1', name: 'Morning Break', start: '09:20', end: '09:50', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:50', end: '10:30', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:30', end: '11:10', type: 'class' },
    { id: 'p5', name: 'Period 5', start: '11:10', end: '11:50', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', start: '11:50', end: '13:00', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p6', name: 'Period 6', start: '13:00', end: '13:40', type: 'class' },
    { id: 'p7', name: 'Period 7', start: '13:40', end: '14:20', type: 'class' },
    { id: 'p8', name: 'Period 8', start: '14:20', end: '15:00', type: 'class' },
  ],
  'junior-school': [
    { id: 'p1', name: 'Period 1', start: '08:00', end: '08:40', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '08:40', end: '09:20', type: 'class' },
    { id: 'break1', name: 'Morning Break', start: '09:20', end: '09:50', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:50', end: '10:30', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:30', end: '11:10', type: 'class' },
    { id: 'p5', name: 'Period 5', start: '11:10', end: '11:50', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', start: '11:50', end: '13:00', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p6', name: 'Period 6', start: '13:00', end: '13:40', type: 'class' },
    { id: 'p7', name: 'Period 7', start: '13:40', end: '14:20', type: 'class' },
    { id: 'p8', name: 'Period 8', start: '14:20', end: '15:00', type: 'class' },
  ],
  'senior-school': [
    { id: 'p1', name: 'Period 1', start: '08:00', end: '08:40', type: 'class' },
    { id: 'p2', name: 'Period 2', start: '08:40', end: '09:20', type: 'class' },
    { id: 'break1', name: 'Morning Break', start: '09:20', end: '09:50', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', start: '09:50', end: '10:30', type: 'class' },
    { id: 'p4', name: 'Period 4', start: '10:30', end: '11:10', type: 'class' },
    { id: 'p5', name: 'Period 5', start: '11:10', end: '11:50', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', start: '11:50', end: '13:00', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p6', name: 'Period 6', start: '13:00', end: '13:40', type: 'class' },
    { id: 'p7', name: 'Period 7', start: '13:40', end: '14:20', type: 'class' },
    { id: 'p8', name: 'Period 8', start: '14:20', end: '15:00', type: 'class' },
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
});

export const DEFAULT_SUBJECT_WEIGHT = 2;

const DOUBLE_PERIOD_SUBJECTS = new Set([
  'Science', 'Science and Technology', 'Integrated Science',
  'Biology', 'Chemistry', 'Physics',
]);

const DOUBLE_PERIOD_LEVELS = new Set(['junior-school', 'senior-school']);

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

/**
 * Get the period structure for a level. If custom config exists, use it.
 */
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

/**
 * Calculate duration in minutes from start/end time strings.
 */
export function calcDuration(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

/**
 * Format period time display.
 */
export function formatPeriodTime(period) {
  if (period.time) return period.time; // legacy
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
   Events (games, clubs, assemblies, etc.)
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
   Generator
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
  const allowDoubles = DOUBLE_PERIOD_LEVELS.has(level);

  // Build the weekly pool of subjects for this class
  const pool = [];
  for (const sub of subjects) {
    const w = weightForSubject(sub);
    for (let i = 0; i < w; i += 1) pool.push(sub);
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

  for (const day of DAYS) {
    schedule[day] = {};
    const dayPool = shuffle([...pool]);

    for (let i = 0; i < periods.length; i += 1) {
      const period = periods[i];
      const busyKey = `${day}|${period.id}`;

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

      // Double-period logic
      if (allowDoubles && i + 1 < periods.length) {
        const next = periods[i + 1];
        const nextBusyKey = `${day}|${next.id}`;
        if (!eventSlots[nextBusyKey]) {
          const candidate = dayPool.find((s) => DOUBLE_PERIOD_SUBJECTS.has(s));
          if (candidate) {
            const teacher = pickTeacher(candidate, teachers, teacherBusy[busyKey], teacherBusy[nextBusyKey], teacherLoad);
            if (teacher) {
              const shared = slotFor(candidate, teacher, cls);
              schedule[day][period.id] = { ...shared, doubleWith: next.id };
              schedule[day][next.id] = { ...shared, doubleWith: period.id };
              teacherBusy[busyKey].add(teacher.id);
              teacherBusy[nextBusyKey].add(teacher.id);
              teacherLoad[teacher.id] = (teacherLoad[teacher.id] || 0) + 2;
              removeFirst(dayPool, candidate);
              removeFirst(dayPool, candidate);
              i += 1;
              continue;
            }
          }
        }
      }

      // Single period
      let assigned = null;
      for (const candidateSubject of dayPool) {
        const teacher = pickTeacher(candidateSubject, teachers, teacherBusy[busyKey], null, teacherLoad);
        if (teacher) {
          assigned = slotFor(candidateSubject, teacher, cls);
          teacherBusy[busyKey].add(teacher.id);
          teacherLoad[teacher.id] = (teacherLoad[teacher.id] || 0) + 1;
          removeFirst(dayPool, candidateSubject);
          break;
        }
      }

      if (assigned) {
        schedule[day][period.id] = assigned;
      } else {
        unassigned.push({ day, periodId: period.id, reason: 'No qualified teacher available' });
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

function pickTeacher(subject, teachers, busySet, extraBusySet, load) {
  const candidates = teachers
    .filter((t) => teacherTeaches(t, subject))
    .filter((t) => !busySet.has(t.id))
    .filter((t) => !extraBusySet || !extraBusySet.has(t.id))
    .filter((t) => (load[t.id] || 0) < (t.maxPeriods || 30));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const d = (load[a.id] || 0) - (load[b.id] || 0);
    if (d !== 0) return d;
    return teacherFullName(a).localeCompare(teacherFullName(b));
  });
  return candidates[0];
}

function teacherTeaches(teacher, subject) {
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
      // Find least-loaded teacher not already assigned to overlapping duty
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
