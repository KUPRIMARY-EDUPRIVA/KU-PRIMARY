// src/utils/ChatbotActions.js
import { auth, db } from '../firebase';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    getCountFromServer,
    limit,
    query,
    where,
} from 'firebase/firestore';

/**
 * Executes API calls to the Netlify functions backing the chatbot.
 */

async function authedFetch(path, { method = 'POST', body = {} } = {}) {
    const token = await auth.currentUser?.getIdToken();
    const res = await fetch(path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
}

/* ============================================================
   Student lookup (client-side, unchanged)
   ============================================================ */

export const findStudentByAdmissionNumber = async (admissionNumber, schoolId) => {
    const normalizedAdmission = String(admissionNumber || '').trim();
    if (!schoolId || !/^[A-Za-z0-9][A-Za-z0-9/-]{0,39}$/.test(normalizedAdmission)) {
        return null;
    }
    for (const field of ['admissionNumber', 'studentId']) {
        const result = await getDocs(query(
            collection(db, 'students'),
            where('schoolId', '==', schoolId),
            where(field, '==', normalizedAdmission),
            limit(1)
        ));
        if (!result.empty) {
            const student = result.docs[0];
            return { id: student.id, ...student.data() };
        }
    }
    return null;
};

/* ============================================================
   Payments
   ============================================================ */

export const triggerSTKPush = async (phone, amount, student, schoolId) => {
    try {
        if (!/^(?:(?:\+?254)|0)?[17]\d{8}$/.test(String(phone).replace(/[\s-]/g, ''))) {
            return { success: false, message: 'Enter a valid Kenyan mobile number.' };
        }
        const numericAmount = Number(amount);
        if (!Number.isInteger(numericAmount) || numericAmount <= 10) {
            return { success: false, message: 'The payment amount must be a whole number greater than KES 10.' };
        }
        if (!student?.id || !schoolId) {
            return { success: false, message: 'Select a valid student before sending the payment request.' };
        }

        const token = await auth.currentUser.getIdToken();
        const response = await fetch('/api/mpesa-stk-push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                phoneNumber: phone.replace(/[\s-]/g, ''),
                amount: numericAmount,
                studentId: student.id,
                studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim()
                    || student.fullName || student.name || '',
                admissionNumber: student.admissionNumber || student.studentId || '',
                studentClass: student.class || '',
                level: student.level || '',
                schoolId,
            }),
        });
        const data = await response.json();
        return { success: response.ok && data.success, message: data.message || 'STK Push sent.' };
    } catch (err) {
        return { success: false, message: 'Failed to initiate payment: ' + err.message };
    }
};

export const fetchFeeBalance = async (admissionNumber, schoolId) => {
    try {
        const token = await auth.currentUser.getIdToken();
        const response = await fetch('/api/get-student-balance', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ admissionNumber, schoolId }),
        });
        const data = await response.json();
        return {
            success: response.ok && data.success,
            balance: response.ok && data.success
                ? `KES ${Number(data.balance || 0).toLocaleString()}`
                : (data.message || 'Student not found'),
        };
    } catch {
        return { success: false, balance: 'Error fetching balance' };
    }
};

/* ============================================================
   School information
   ============================================================ */

/**
 * Fetch a school fact sheet. topic ∈
 *   'overview' | 'classes' | 'subjects' | 'teachers' | 'contact' | 'levels' | 'all'
 */
export const fetchSchoolInfo = async (topic = 'overview') => {
    try {
        const { ok, data } = await authedFetch('/api/chatbot-school-info', {
            method: 'POST',
            body: { topic },
        });
        if (!ok || !data?.success) {
            return { success: false, summary: data?.error || 'Could not load school info.' };
        }
        return { success: true, summary: data.summary, data: data.data };
    } catch (err) {
        return { success: false, summary: 'Error fetching school info: ' + err.message };
    }
};

/* ============================================================
   Performance
   ============================================================ */

/**
 * Fetch performance summary.
 * scope ∈ 'school' | 'class' | 'top'
 */
export const fetchPerformance = async ({ scope = 'school', className, level, term, year } = {}) => {
    try {
        const { ok, data } = await authedFetch('/api/chatbot-performance', {
            method: 'POST',
            body: { scope, class: className, level, term, year },
        });
        if (!ok || !data?.success) {
            return { success: false, summary: data?.error || 'Could not load performance data.' };
        }
        return { success: true, summary: data.summary, data: data.data };
    } catch (err) {
        return { success: false, summary: 'Error fetching performance: ' + err.message };
    }
};

/* ============================================================
   Daily collections (admin only)
   ============================================================ */

export const fetchDailyCollections = async (schoolId) => {
    try {
        const token = await auth.currentUser.getIdToken();
        const response = await fetch('/api/reports-rollup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ schoolId }),
        });
        const data = await response.json();
        return {
            success: response.ok && data.success,
            today: data.today || 'KES 0',
            week: data.week || 'KES 0',
        };
    } catch {
        return { success: false, today: 'Error', week: 'Error' };
    }
};

/* ============================================================
   Student count + class teacher (new)
   ============================================================ */

/**
 * Count students in a class (or whole school if no class given).
 *
 * Data source: the `students` collection, filtered by schoolId,
 * optionally by class, excluding soft-deleted students.
 *
 * Uses `getCountFromServer` — Firestore's server-side aggregation —
 * so the count itself costs 1 Firestore read per 1000 docs and
 * transfers no document payload.
 *
 * @param {Object}  args
 * @param {string}  args.schoolId
 * @param {string} [args.cls]        e.g. '4S', 'Grade 4S', 'Grade 7 East'
 * @returns {Promise<{success:boolean, count?:number, displayClass?:string, error?:string}>}
 */
export async function fetchStudentCount({ schoolId, cls } = {}) {
    try {
        if (!schoolId) {
            return { success: false, error: 'Missing schoolId.' };
        }
        const studentsRef = collection(db, 'students');
        const displayClass = normaliseClassDisplay(cls);

        if (!cls) {
            // Whole-school count.
            const snap = await getCountFromServer(
                query(
                    studentsRef,
                    where('schoolId', '==', schoolId),
                    where('isDeleted', '==', false)
                )
            );
            return { success: true, count: snap.data().count, displayClass: 'the whole school' };
        }

        // Try the class as given and a few common variants.
        const candidates = buildClassCandidates(cls);
        let count = 0;
        let matchedClass = null;

        for (const candidate of candidates) {
            const snap = await getCountFromServer(
                query(
                    studentsRef,
                    where('schoolId', '==', schoolId),
                    where('class', '==', candidate),
                    where('isDeleted', '==', false)
                )
            );
            const c = snap.data().count;
            if (c > 0) {
                count = c;
                matchedClass = candidate;
                break;
            }
        }

        if (matchedClass === null) {
            return {
                success: true,
                count: 0,
                displayClass: displayClass || cls
            };
        }

        return {
            success: true,
            count,
            displayClass: matchedClass
        };
    } catch (err) {
        console.error('fetchStudentCount failed:', err);
        return { success: false, error: err.message || 'Failed to count students.' };
    }
}

/**
 * Find the class teacher for a class.
 *
 * Reads `schools/{schoolId}.classTeachers`, which is a map:
 *     { 'Grade 4S': '<teacherUid>', 'Grade 5 East': '<teacherUid>', ... }
 * Then looks up the teacher's user doc for their display name.
 *
 * @param {Object}  args
 * @param {string}  args.schoolId
 * @param {string} [args.cls]
 * @returns {Promise<{success:boolean, teacher?:{name:string,email?:string,phone?:string}, displayClass?:string, error?:string}>}
 */
export async function fetchClassTeacher({ schoolId, cls } = {}) {
    try {
        if (!schoolId) {
            return { success: false, error: 'Missing schoolId.' };
        }
        if (!cls) {
            return { success: false, error: 'Please specify a class.' };
        }

        const displayClass = normaliseClassDisplay(cls);
        const candidates = buildClassCandidates(cls);

        // Read the school doc once.
        const schoolSnap = await getDoc(doc(db, 'schools', schoolId));
        if (!schoolSnap.exists()) {
            return { success: false, error: 'School not found.' };
        }
        const classTeachers = schoolSnap.data().classTeachers || {};

        // Find the key that matches one of our candidates.
        let matchedKey = null;
        for (const key of Object.keys(classTeachers)) {
            if (candidates.some((c) => c.toLowerCase() === key.toLowerCase())) {
                matchedKey = key;
                break;
            }
        }

        if (!matchedKey) {
            return {
                success: true,
                teacher: null,
                displayClass: displayClass || cls
            };
        }

        const teacherUid = classTeachers[matchedKey];
        if (!teacherUid) {
            return {
                success: true,
                teacher: null,
                displayClass: matchedKey
            };
        }

        // Look up the teacher profile. Try `users` first, then `teachers`.
        let profile = null;
        try {
            const uSnap = await getDoc(doc(db, 'users', teacherUid));
            if (uSnap.exists()) profile = uSnap.data();
        } catch { /* ignore */ }

        if (!profile) {
            try {
                const tSnap = await getDoc(doc(db, 'teachers', teacherUid));
                if (tSnap.exists()) profile = tSnap.data();
            } catch { /* ignore */ }
        }

        if (!profile) {
            return {
                success: true,
                teacher: { name: 'a teacher on file' },
                displayClass: matchedKey
            };
        }

        const name =
            profile.fullName
            || [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim()
            || profile.name
            || 'a teacher on file';

        return {
            success: true,
            teacher: {
                name,
                email: profile.email || '',
                phone: profile.phone || profile.phoneNumber || ''
            },
            displayClass: matchedKey
        };
    } catch (err) {
        console.error('fetchClassTeacher failed:', err);
        return { success: false, error: err.message || 'Failed to look up class teacher.' };
    }
}

/* ------------------------------------------------------------
   Small helpers used by both functions above
   ------------------------------------------------------------ */

// Turn '4S' or 'grade 4s' into 'Grade 4S' for display purposes.
function normaliseClassDisplay(cls) {
    if (!cls) return '';
    const s = String(cls).trim();
    if (/^(grade|form|pp)\b/i.test(s)) {
        return s.replace(/^(grade|form|pp)\s*/i, (m) => m.trim() + ' ');
    }
    if (/^\d/.test(s)) {
        return `Grade ${s}`;
    }
    return s;
}

// Build a list of class-name variants to try against the students
// `class` field and the school's `classTeachers` map.
// E.g. '4S' -> ['4S', 'Grade 4S', 'grade 4s', '4s', 'GRADE 4S']
//      'Grade 4S' -> ['Grade 4S', 'grade 4s', '4S', '4s', 'GRADE 4S']
function buildClassCandidates(cls) {
    const s = String(cls).trim();
    const set = new Set();
    set.add(s);

    const display = normaliseClassDisplay(s);
    set.add(display);

    const stripped = s.replace(/^(grade|form|pp)\s*/i, '');
    if (stripped) {
        set.add(stripped);
        set.add(`Grade ${stripped}`);
        set.add(`grade ${stripped.toLowerCase()}`);
    }

    set.add(s.toUpperCase());
    set.add(s.toLowerCase());

    return [...set].filter(Boolean);
}
