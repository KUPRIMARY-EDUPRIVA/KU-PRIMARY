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
 * Period structures per level. Every level can define its own.
 * `type: 'class'` = teachable slot, `type: 'break'` = non-teachable.
 */
export const PERIOD_STRUCTURES = Object.freeze({
  'pre-primary': [
    { id: 'p1', name: 'Period 1', time: '08:00 - 08:30', type: 'class' },
    { id: 'p2', name: 'Period 2', time: '08:30 - 09:00', type: 'class' },
    { id: 'break1', name: 'Morning Break', time: '09:00 - 09:30', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', time: '09:30 - 10:00', type: 'class' },
    { id: 'p4', name: 'Period 4', time: '10:00 - 10:30', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', time: '10:30 - 11:30', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p5', name: 'Period 5', time: '11:30 - 12:00', type: 'class' },
    { id: 'p6', name: 'Period 6', time: '12:00 - 12:30', type: 'class' },
  ],
  'lower-primary': [
    { id: 'p1', name: 'Period 1', time: '08:00 - 08:40', type: 'class' },
    { id: 'p2', name: 'Period 2', time: '08:40 - 09:20', type: 'class' },
    { id: 'break1', name: 'Morning Break', time: '09:20 - 09:50', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', time: '09:50 - 10:30', type: 'class' },
    { id: 'p4', name: 'Period 4', time: '10:30 - 11:10', type: 'class' },
    { id: 'p5', name: 'Period 5', time: '11:10 - 11:50', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', time: '11:50 - 13:00', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p6', name: 'Period 6', time: '13:00 - 13:40', type: 'class' },
    { id: 'p7', name: 'Period 7', time: '13:40 - 14:20', type: 'class' },
  ],
  'upper-primary': [
    { id: 'p1', name: 'Period 1', time: '08:00 - 08:40', type: 'class' },
    { id: 'p2', name: 'Period 2', time: '08:40 - 09:20', type: 'class' },
    { id: 'break1', name: 'Morning Break', time: '09:20 - 09:50', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', time: '09:50 - 10:30', type: 'class' },
    { id: 'p4', name: 'Period 4', time: '10:30 - 11:10', type: 'class' },
    { id: 'p5', name: 'Period 5', time: '11:10 - 11:50', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', time: '11:50 - 13:00', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p6', name: 'Period 6', time: '13:00 - 13:40', type: 'class' },
    { id: 'p7', name: 'Period 7', time: '13:40 - 14:20', type: 'class' },
    { id: 'p8', name: 'Period 8', time: '14:20 - 15:00', type: 'class' },
  ],
  'junior-school': [
    { id: 'p1', name: 'Period 1', time: '08:00 - 08:40', type: 'class' },
    { id: 'p2', name: 'Period 2', time: '08:40 - 09:20', type: 'class' },
    { id: 'break1', name: 'Morning Break', time: '09:20 - 09:50', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', time: '09:50 - 10:30', type: 'class' },
    { id: 'p4', name: 'Period 4', time: '10:30 - 11:10', type: 'class' },
    { id: 'p5', name: 'Period 5', time: '11:10 - 11:50', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', time: '11:50 - 13:00', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p6', name: 'Period 6', time: '13:00 - 13:40', type: 'class' },
    { id: 'p7', name: 'Period 7', time: '13:40 - 14:20', type: 'class' },
    { id: 'p8', name: 'Period 8', time: '14:20 - 15:00', type: 'class' },
  ],
  'senior-school': [
    { id: 'p1', name: 'Period 1', time: '08:00 - 08:40', type: 'class' },
    { id: 'p2', name: 'Period 2', time: '08:40 - 09:20', type: 'class' },
    { id: 'break1', name: 'Morning Break', time: '09:20 - 09:50', type: 'break', label: 'TEA / RECREATION BREAK' },
    { id: 'p3', name: 'Period 3', time: '09:50 - 10:30', type: 'class' },
    { id: 'p4', name: 'Period 4', time: '10:30 - 11:10', type: 'class' },
    { id: 'p5', name: 'Period 5', time: '11:10 - 11:50', type: 'class' },
    { id: 'lunch', name: 'Lunch Break', time: '11:50 - 13:00', type: 'break', label: 'NOON LUNCH BREAK' },
    { id: 'p6', name: 'Period 6', time: '13:00 - 13:40', type: 'class' },
    { id: 'p7', name: 'Period 7', time: '13:40 - 14:20', type: 'class' },
    { id: 'p8', name: 'Period 8', time: '14:20 - 15:00', type: 'class' },
  ],
});

export const periodsForLevel = (level) =>
  PERIOD_STRUCTURES[level] || PERIOD_STRUCTURES['junior-school'];

export const classPeriodsForLevel = (level) =>
  periodsForLevel(level).filter((p) => p.type === 'class');

/**
 * Duty areas. `duration` in hours matters for clash detection.
 */
export const DUTY_AREAS = Object.freeze([
  { id: 'gate_morning', label: 'Main Gate (Morning)', start: 7,  end: 8 },
  { id: 'assembly',     label: 'Assembly Ground',     start: 8,  end: 8.33 },
  { id: 'break_duty',   label: 'Break Supervision',   start: 9.33, end: 9.83 },
  { id: 'dining',       label: 'Dining Hall',         start: 12, end: 13 },
  { id: 'gate_evening', label: 'Main Gate (Evening)', start: 15, end: 16.5 },
  { id: 'library',      label: 'Library',             start: 15, end: 16.5 },
  { id: 'playground',   label: 'Playground',          start: 16, end: 17 },
  { id: 'dormitory',    label: 'Dormitory (Night)',   start: 21, end: 22 },
]);

/**
 * Subject colours map to the CSS classes we ship in index.css.
 * Kept small and navy/gold-tinted on purpose — no loud rainbow.
 */
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
});

/**
 * Weekly period weights per subject. Used by the generator to bias
 * how many slots each subject gets in a class timetable.
 */
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
});

export const DEFAULT_SUBJECT_WEIGHT = 2;

/** Sciences get double-periods when the level allows. */
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

/**
 * Bulk-load every class timetable for a level + term + year in one query.
 * Fixes the N+1 problem in the original (Promise.all of getDoc per class).
 */
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
  // writeBatch — max 500 ops, safe here.
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

/**
 * Build a schedule for a single class that:
 *  - respects per-teacher `maxPeriods` (weekly cap)
 *  - respects per-teacher `subjects` (never teaches outside it)
 *  - respects teacher busy slots from OTHER classes
 *  - assigns double-periods for sciences at senior/junior levels
 *  - avoids giving the same subject twice in a row unless it's a double
 *  - weights subjects according to SUBJECT_WEIGHTS
 *
 * Returns { schedule, unassigned } — unassigned is a list of
 * { day, periodId, reason } so the UI can tell admins which slots
 * couldn't be filled because there weren't enough qualified teachers.
 */
export function generateClassSchedule({
  level,
  cls,
  subjects,
  teachers,
  otherSchedules = {},
  existingTeacherLoad = {},
}) {
  const periods = classPeriodsForLevel(level);
  const allowDoubles = DOUBLE_PERIOD_LEVELS.has(level);

  // 1. Build the weekly pool of subjects for this class
  const pool = [];
  for (const sub of subjects) {
    const w = weightForSubject(sub);
    for (let i = 0; i < w; i += 1) pool.push(sub);
  }

  // 2. Compute teacher busy slots from other classes
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

  // 3. Copy teacher load so far this week so we don't over-assign
  const teacherLoad = { ...existingTeacherLoad };

  // 4. The schedule we'll build
  const schedule = {};
  const unassigned = [];

  for (const day of DAYS) {
    schedule[day] = {};
    const dayPool = shuffle([...pool]);

    for (let i = 0; i < periods.length; i += 1) {
      const period = periods[i];
      const busyKey = `${day}|${period.id}`;

      // First, try a double-period if the next period is free and the
      // subject qualifies. This must run before the single-period path.
      if (allowDoubles && i + 1 < periods.length) {
        const next = periods[i + 1];
        const nextBusyKey = `${day}|${next.id}`;
        const candidate = dayPool.find((s) => DOUBLE_PERIOD_SUBJECTS.has(s));
        if (candidate) {
          const teacher = pickTeacher(candidate, teachers, teacherBusy[busyKey], teacherBusy[nextBusyKey], teacherLoad);
          if (teacher) {
            const shared = slotFor(candidate, teacher, cls);
            schedule[day][period.id] = shared;
            schedule[day][next.id] = { ...shared, doubleWith: period.id };
            schedule[day][period.id].doubleWith = next.id;
            teacherBusy[busyKey].add(teacher.id);
            teacherBusy[nextBusyKey].add(teacher.id);
            teacherLoad[teacher.id] = (teacherLoad[teacher.id] || 0) + 2;
            removeFirst(dayPool, candidate);
            removeFirst(dayPool, candidate);
            i += 1; // skip next
            continue;
          }
        }
      }

      // Single-period assignment
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
        unassigned.push({
          day,
          periodId: period.id,
          reason: 'No qualified teacher available',
        });
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
  // Least-loaded first — a tie breaker of alphabetical keeps output stable
  candidates.sort((a, b) => {
    const d = (load[a.id] || 0) - (load[b.id] || 0);
    if (d !== 0) return d;
    return teacherFullName(a).localeCompare(teacherFullName(b));
  });
  return candidates[0];
}

/**
 * A teacher "teaches" a subject if they've declared it, or if they've
 * declared NO subjects at all (fallback: generalist). This preserves
 * the old behaviour for schools that haven't filled the field yet,
 * but is stricter when a teacher has explicitly opted in.
 */
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

/**
 * Returns an array of clash objects. `otherSchedules` must be
 * pre-loaded — the caller is responsible for fetching it. This
 * removes the silent-zero-clash bug the original had when
 * allSchedules was empty.
 */
export function detectClashes(level, cls, proposedSchedule, otherSchedules) {
  const periods = classPeriodsForLevel(level);
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

/**
 * Returns clashes between duty assignments for the same teacher on
 * overlapping time windows.
 */
export function detectDutyClashes(roster) {
  const clashes = [];
  for (const day of DAYS) {
    const entries = [];
    const dayRoster = roster?.[day] || {};
    for (const area of DUTY_AREAS) {
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

/**
 * Per-teacher workload summary — used by the teacher tab and by PDF.
 */
export function summarizeTeacherLoad(allSchedules, level) {
  const periods = classPeriodsForLevel(level);
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
 * Per-class health summary: which subjects are missing,
 * which subjects never got their weighted number of periods.
 */
export function summarizeClassCoverage(level, subjects, schedule) {
  const periods = classPeriodsForLevel(level);
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
