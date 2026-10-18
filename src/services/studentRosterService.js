import { openDB } from 'idb';
import { loadAllStudents } from './studentService';

const DB_NAME = 'toplink_sync';
const DB_VERSION = 1;
const STORE_QUEUE = 'sync_queue';
const STORE_KV = 'kv';
const ROSTER_TTL_MS = 15 * 60 * 1000;

let databasePromise;
const rosterLoads = new Map();

function getDatabase() {
    if (!databasePromise) {
        databasePromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(database) {
                if (!database.objectStoreNames.contains(STORE_QUEUE)) {
                    const queue = database.createObjectStore(STORE_QUEUE, {
                        keyPath: 'id',
                        autoIncrement: true,
                    });
                    queue.createIndex('by-createdAt', 'createdAt');
                }
                if (!database.objectStoreNames.contains(STORE_KV)) {
                    database.createObjectStore(STORE_KV);
                }
            },
        }).catch((error) => {
            databasePromise = null;
            throw error;
        });
    }
    return databasePromise;
}

export function studentRosterCacheKey(schoolId, assignedClasses = []) {
    if (!assignedClasses?.length) return `students_${schoolId}`;
    const classes = [...assignedClasses].map(String).sort();
    return `students_${schoolId}_classes_${classes.join('|')}`;
}

function filterClasses(students, assignedClasses) {
    if (!assignedClasses?.length) return students;
    const allowed = new Set(assignedClasses.map(String));
    return students.filter((student) => allowed.has(String(student.class || '')));
}

export async function getCachedStudentRoster(schoolId, { assignedClasses = [] } = {}) {
    if (!schoolId) return null;
    try {
        const database = await getDatabase();
        const key = studentRosterCacheKey(schoolId, assignedClasses);
        const roster = await database.get(STORE_KV, key);
        if (Array.isArray(roster)) return filterClasses(roster, assignedClasses);

        if (assignedClasses.length) {
            const fullRoster = await database.get(STORE_KV, studentRosterCacheKey(schoolId, []));
            if (Array.isArray(fullRoster)) return filterClasses(fullRoster, assignedClasses);
        }
    } catch (error) {
        console.warn('Saved student roster is unavailable:', error);
    }
    return null;
}

export async function loadStudentRoster(
    schoolId,
    { assignedClasses = [], refresh = false } = {}
) {
    if (!schoolId) throw new Error('School context is required to load students.');
    const key = studentRosterCacheKey(schoolId, assignedClasses);
    const metaKey = `${key}__meta`;

    if (!refresh) {
        const cached = await getCachedStudentRoster(schoolId, { assignedClasses });
        if (cached) {
            try {
                const database = await getDatabase();
                const metadata = await database.get(STORE_KV, metaKey);
                if (Number(metadata?.savedAt) > Date.now() - ROSTER_TTL_MS) return cached;
                if (typeof navigator !== 'undefined' && !navigator.onLine) return cached;
            } catch (error) {
                console.warn('Student roster cache metadata is unavailable:', error);
                if (typeof navigator !== 'undefined' && !navigator.onLine) return cached;
            }
        }
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const cached = await getCachedStudentRoster(schoolId, { assignedClasses });
        if (cached) return cached;
        throw new Error('No saved student roster is available while offline.');
    }

    if (rosterLoads.has(key)) return rosterLoads.get(key);

    const load = (async () => {
        try {
            const students = await loadAllStudents(schoolId, assignedClasses);
            await saveStudentRoster(schoolId, students, { assignedClasses });
            return students;
        } catch (error) {
            const cached = await getCachedStudentRoster(schoolId, { assignedClasses });
            if (cached) {
                console.warn('Student roster refresh failed; using the saved roster:', error);
                return cached;
            }
            throw error;
        }
    })();
    rosterLoads.set(key, load);
    try {
        return await load;
    } finally {
        if (rosterLoads.get(key) === load) rosterLoads.delete(key);
    }
}

export async function saveStudentRoster(schoolId, students, { assignedClasses = [] } = {}) {
    if (!schoolId || !Array.isArray(students)) return;
    try {
        const database = await getDatabase();
        const key = studentRosterCacheKey(schoolId, assignedClasses);
        const tx = database.transaction(STORE_KV, 'readwrite');
        await Promise.all([
            tx.store.put(students, key),
            tx.store.put({ savedAt: Date.now() }, `${key}__meta`),
            tx.done,
        ]);
    } catch (error) {
        console.warn('Could not save the student roster for offline use:', error);
    }
}
