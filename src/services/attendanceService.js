// src/services/attendanceService.js
import {
    collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
    query, where, orderBy, limit, serverTimestamp, writeBatch
} from 'firebase/firestore';
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

    // Sort by admissionNumber then name
    students.sort((a, b) => {
        const aId = a.admissionNumber || a.studentId || '';
        const bId = b.admissionNumber || b.studentId || '';
        if (aId && bId) return String(aId).localeCompare(String(bId), undefined, { numeric: true });
        const aN = `${a.firstName || ''} ${a.lastName || ''}`.toLowerCase();
        const bN = `${b.firstName || ''} ${b.lastName || ''}`.toLowerCase();
        return aN.localeCompare(bN);
    });
    return students;
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
