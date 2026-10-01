// ============================================================
// LIVE STUDENT SEARCH (independent of pagination)
// ============================================================

/**
 * Case-insensitive prefix search across admissionNumber, firstName, lastName.
 * Returns up to `maxResults` matches scoped to the school.
 *
 * Requires 3 composite indexes on `students`:
 *   (schoolId ASC, admissionNumber ASC)
 *   (schoolId ASC, firstName ASC)
 *   (schoolId ASC, lastName ASC)
 * If `level`/`cls` are also passed, add those fields to each index too.
 */
export async function searchStudentsLive(schoolId, searchTerm, opts = {}) {
    const { limit: maxResults = 15, level, cls } = opts;
    const term = String(searchTerm || '').trim();
    if (!schoolId || term.length < 2) return [];

    const normalizedUpper = term.toUpperCase();
    const normalizedCap = term.charAt(0).toUpperCase() + term.slice(1);

    const baseConstraints = [where('schoolId', '==', schoolId)];
    if (level) baseConstraints.push(where('level', '==', level));
    if (cls) baseConstraints.push(where('class', '==', cls));

    const queries = [
        // admissionNumber — uppercase range
        query(
            collection(db, 'students'),
            ...baseConstraints,
            where('admissionNumber', '>=', normalizedUpper),
            where('admissionNumber', '<=', normalizedUpper + '\uf8ff'),
            limit(maxResults)
        ),
        // firstName — capitalized range
        query(
            collection(db, 'students'),
            ...baseConstraints,
            where('firstName', '>=', normalizedCap),
            where('firstName', '<=', normalizedCap + '\uf8ff'),
            limit(maxResults)
        ),
        // lastName — capitalized range
        query(
            collection(db, 'students'),
            ...baseConstraints,
            where('lastName', '>=', normalizedCap),
            where('lastName', '<=', normalizedCap + '\uf8ff'),
            limit(maxResults)
        )
    ];

    try {
        const snaps = await Promise.all(queries.map(q =>
            getDocs(q).catch(err => {
                if (err.code === 'failed-precondition') {
                    console.warn('searchStudentsLive: missing composite index. Create it in Firebase Console.', err.message);
                    return { docs: [] };
                }
                throw err;
            })
        ));

        const byId = new Map();
        for (const snap of snaps) {
            for (const d of snap.docs) {
                if (!byId.has(d.id)) byId.set(d.id, { id: d.id, ...d.data() });
            }
        }

        const results = [...byId.values()];
        results.sort((a, b) => {
            const aAdm = (a.admissionNumber || a.studentId || '').toUpperCase();
            const bAdm = (b.admissionNumber || b.studentId || '').toUpperCase();
            if (aAdm === normalizedUpper && bAdm !== normalizedUpper) return -1;
            if (bAdm === normalizedUpper && aAdm !== normalizedUpper) return 1;
            return (a.firstName || '').localeCompare(b.firstName || '');
        });
        return results.slice(0, maxResults);
    } catch (err) {
        console.error('searchStudentsLive failed:', err);
        return [];
    }
}

/**
 * Fetch one student by exact admission number (or studentId fallback).
 */
export async function getStudentByAdmission(schoolId, admissionNumber) {
    if (!schoolId || !admissionNumber) return null;
    const normalized = String(admissionNumber).trim().toUpperCase();
    for (const field of ['admissionNumber', 'studentId']) {
        try {
            const q = query(
                collection(db, 'students'),
                where('schoolId', '==', schoolId),
                where(field, '==', normalized),
                limit(1)
            );
            const snap = await getDocs(q);
            if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
        } catch (err) {
            console.warn(`getStudentByAdmission (${field}) failed:`, err.message);
        }
    }
    return null;
}
