// src/services/attendanceService.js
import {
    collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
    query, where, orderBy, limit, serverTimestamp, writeBatch
} from 'firebase/firestore';
import { getCachedStudentRoster, saveStudentRoster } from './studentRosterService';
import { db } from '../firebase';

// ------------------------------------------------------------
// Doc ID scheme:  {schoolId}_{class}_{YYYY-MM-DD}_{session}
// `session` is 'morning' | 'afternoon' | 'full'
// This keeps one record per class per day per session — clean
// queries, no duplicates.
// ------------------------------------------------------------
const buildAttendanceDocId = (schoolId, cls, date, session) => {
    const safeClass = String(cls).replace(/[\/\s]+/g, '_');
    return `${schoolId}__${safeClass}__${date}__${session}`;
};

const sanitizeClass = (cls) => String(cls || '').trim();

// ------------------------------------------------------------
// Fetch one attendance record (or null)
// ------------------------------------------------------------
export async function getAttendanceRecord(schoolId, cls, date, session = 'full') {
    if (!schoolId || !cls || !date) return null;
    const id = buildAttendanceDocId(schoolId, cls, date, session);
    const snap = await getDoc(doc(db, 'attendance', id));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() };
}

// ------------------------------------------------------------
// Save (create or update) a full attendance record.
// `entries` = [{ studentId, admissionNumber, name, status, note }]
// ------------------------------------------------------------
export async function saveAttendanceRecord({
    schoolId, cls, level, date, session = 'full',
    entries, takenBy, takenByName, schoolName
}) {
    if (!schoolId || !cls || !date || !Array.isArray(entries)) {
        throw new Error('saveAttendanceRecord: missing required fields');
    }

    const id = buildAttendanceDocId(schoolId, cls, date, session);
    const counts = entries.reduce((acc, e) => {
        const key = e.status || 'present';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    const payload = {
        schoolId,
        schoolName: schoolName || '',
        class: cls,
        level: level || '',
        date,                 // YYYY-MM-DD
        session,
        entries,
        counts,
        takenBy,
        takenByName,
        updatedAt: serverTimestamp(),
        updatedAtIso: new Date().toISOString(),
    };

    const ref = doc(db, 'attendance', id);
    const existing = await getDoc(ref);

    if (existing.exists()) {
        await updateDoc(ref, payload);
    } else {
        await setDoc(ref, { ...payload, createdAt: serverTimestamp() });
    }
    return id;
}

// ------------------------------------------------------------
// List attendance records for a school (optionally filtered)
// ------------------------------------------------------------
export async function listAttendanceRecords({
    schoolId, cls, fromDate, toDate, max = 500
}) {
    if (!schoolId) return [];
    const constraints = [
        where('schoolId', '==', schoolId),
    ];
    if (cls) constraints.push(where('class', '==', cls));
    if (fromDate) constraints.push(where('date', '>=', fromDate));
    if (toDate) constraints.push(where('date', '<=', toDate));
    constraints.push(orderBy('date', 'desc'));
    constraints.push(limit(max));

    const q = query(collection(db, 'attendance'), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ------------------------------------------------------------
// Delete a record (admin-only, rarely used)
// ------------------------------------------------------------
export async function deleteAttendanceRecord(id) {
    if (!id) return;
    await deleteDoc(doc(db, 'attendance', id));
}

// ------------------------------------------------------------
// Student roster for a class
// ------------------------------------------------------------
export async function getClassRoster(schoolId, cls, level) {
    if (!schoolId || !cls) return [];
    const cached = await getCachedStudentRoster(schoolId, {
        assignedClasses: [sanitizeClass(cls)],
    });
    if (cached) {
        return cached
            .filter((student) => !student.isDeleted && (!level || student.level === level))
            .sort(compareStudents);
    }

    const constraints = [
        where('schoolId', '==', schoolId),
        where('class', '==', sanitizeClass(cls)),
    ];
    if (level) constraints.push(where('level', '==', level));

    const q = query(collection(db, 'students'), ...constraints);
    const snap = await getDocs(q);
    const students = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => !s.isDeleted);
    await saveStudentRoster(schoolId, students, {
        assignedClasses: [sanitizeClass(cls)],
    });

    // Sort by admissionNumber then name
    students.sort(compareStudents);
    return students;
}

function compareStudents(a, b) {
    const aId = a.admissionNumber || a.studentId || '';
    const bId = b.admissionNumber || b.studentId || '';
    if (aId && bId) return String(aId).localeCompare(String(bId), undefined, { numeric: true });
    const aN = `${a.firstName || ''} ${a.lastName || ''}`.toLowerCase();
    const bN = `${b.firstName || ''} ${b.lastName || ''}`.toLowerCase();
    return aN.localeCompare(bN);
}

// ------------------------------------------------------------
// Aggregate stats for a period — used by reports
// ------------------------------------------------------------
export function aggregateAttendance(records = [], roster = []) {
    const totals = {
        present: 0,
        absent: 0,
        late: 0,
        excused: 0,
        totalMarks: 0,
        days: records.length,
    };
    const perStudent = new Map();

    roster.forEach((s) => {
        perStudent.set(s.id, {
            studentId: s.id,
            name: `${s.firstName || ''} ${s.lastName || ''}`.trim(),
            admissionNumber: s.admissionNumber || s.studentId || '',
            present: 0,
            absent: 0,
            late: 0,
            excused: 0,
            total: 0,
        });
    });

    records.forEach((rec) => {
        (rec.entries || []).forEach((e) => {
            const status = e.status || 'present';
            if (totals[status] !== undefined) totals[status]++;
            totals.totalMarks++;
            const row = perStudent.get(e.studentId);
            if (row) {
                if (row[status] !== undefined) row[status]++;
                row.total++;
            }
        });
    });

    const rosterRows = [...perStudent.values()].map((r) => ({
        ...r,
        rate: r.total > 0
            ? Math.round(((r.present + r.late) / r.total) * 100)
            : 0,
    }));

    totals.rate = totals.totalMarks > 0
        ? Math.round(((totals.present + totals.late) / totals.totalMarks) * 100)
        : 0;

    return { totals, perStudent: rosterRows };
}

// ------------------------------------------------------------
// STUDENT SELF-SERVICE HELPERS
// ------------------------------------------------------------
// These are additive: they operate on the same `attendance`
// collection using the same schema, so nothing on the admin
// side changes.
// ------------------------------------------------------------

/**
 * Extract one student's personal attendance rows from a list of
 * class-level attendance records.
 *
 * @param {Array}  records           - records returned by listAttendanceRecords
 * @param {string} studentId         - student.id (the Firestore doc id)
 * @param {Object} [opts]
 * @param {string} [opts.session]    - optional filter: 'full' | 'morning' | 'afternoon'
 * @returns {Array<{
 *   id: string,
 *   date: string,
 *   session: string,
 *   class: string,
 *   level: string,
 *   status: 'present'|'absent'|'late'|'excused',
 *   note: string,
 *   takenByName: string,
 *   takenBy: string
 * }>}
 */
export function extractStudentAttendance(records = [], studentId, opts = {}) {
    if (!studentId) return [];
    const { session } = opts;
    const out = [];

    (records || []).forEach((rec) => {
        if (session && rec.session !== session) return;
        const entries = Array.isArray(rec.entries) ? rec.entries : [];
        const hit = entries.find((e) => e.studentId === studentId);
        if (!hit) return;
        out.push({
            id: rec.id,
            date: rec.date || '',
            session: rec.session || 'full',
            class: rec.class || '',
            level: rec.level || '',
            status: hit.status || 'present',
            note: hit.note || '',
            takenBy: rec.takenBy || '',
            takenByName: rec.takenByName || '',
        });
    });

    // Newest first, then by session order (full > morning > afternoon)
    const sessionRank = { full: 0, morning: 1, afternoon: 2 };
    out.sort((a, b) => {
        if (a.date !== b.date) return String(b.date).localeCompare(String(a.date));
        const ra = sessionRank[a.session] ?? 99;
        const rb = sessionRank[b.session] ?? 99;
        return ra - rb;
    });

    return out;
}

/**
 * Compute a personal attendance summary from a personal daily log
 * (the output of `extractStudentAttendance`).
 *
 * @param {Array} personalRows
 * @returns {{
 *   total: number,
 *   present: number,
 *   absent: number,
 *   late: number,
 *   excused: number,
 *   rate: number,     // 0–100
 *   months: Array<{ key: string, label: string, total: number, present: number, absent: number, late: number, excused: number, rate: number }>
 * }}
 */
export function summarizeStudentAttendance(personalRows = []) {
    const base = { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
    const months = new Map();

    (personalRows || []).forEach((r) => {
        const s = r.status || 'present';
        if (base[s] !== undefined) base[s]++;
        base.total++;

        const key = (r.date || '').slice(0, 7); // YYYY-MM
        if (!key) return;
        if (!months.has(key)) {
            months.set(key, {
                key,
                label: new Date(key + '-01').toLocaleDateString(undefined, {
                    month: 'long', year: 'numeric',
                }),
                total: 0, present: 0, absent: 0, late: 0, excused: 0,
            });
        }
        const m = months.get(key);
        m.total++;
        if (m[s] !== undefined) m[s]++;
    });

    const rate = base.total
        ? Math.round(((base.present + base.late) / base.total) * 100)
        : 0;

    const monthsArr = [...months.values()]
        .sort((a, b) => b.key.localeCompare(a.key))
        .map((m) => ({
            ...m,
            rate: m.total
                ? Math.round(((m.present + m.late) / m.total) * 100)
                : 0,
        }));

    return { ...base, rate, months: monthsArr };
}

/**
 * Convenience: fetch a single student's attendance for a date range.
 * Internally uses listAttendanceRecords + extractStudentAttendance.
 *
 * @param {Object} params
 * @param {string} params.schoolId
 * @param {string} params.cls         - the student's class
 * @param {string} params.studentId
 * @param {string} params.fromDate    - YYYY-MM-DD
 * @param {string} params.toDate      - YYYY-MM-DD
 * @param {number} [params.max=500]
 * @returns {Promise<Array>}          - personal daily rows
 */
export async function getStudentAttendanceInRange({
    schoolId, cls, studentId, fromDate, toDate, max = 500,
}) {
    if (!schoolId || !cls || !studentId) return [];
    const records = await listAttendanceRecords({
        schoolId, cls, fromDate, toDate, max,
    });
    return extractStudentAttendance(records, studentId);
}

// ------------------------------------------------------------
// Date helpers
// ------------------------------------------------------------
export const todayISO = () => {
    const d = new Date();
    const z = d.getTimezoneOffset() * 60000;
    return new Date(d - z).toISOString().slice(0, 10);
};

export const startOfWeek = (date = new Date()) => {
    const d = new Date(date);
    const day = d.getDay(); // 0 = Sun
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Mon
    d.setDate(diff);
    return d.toISOString().slice(0, 10);
};

export const startOfMonth = (date = new Date()) => {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

export const endOfMonth = (date = new Date()) => {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
};

export const startOfTerm = (termStart) => termStart || startOfMonth();
