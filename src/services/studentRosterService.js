import { openDB } from 'idb';
import { loadAllStudents } from './studentService';

const DB_NAME = 'toplink_sync';
const DB_VERSION = 1;
const STORE_QUEUE = 'sync_queue';
const STORE_KV = 'kv';

let databasePromise;

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
    if (!refresh) {
        const cached = await getCachedStudentRoster(schoolId, { assignedClasses });
        if (cached) return cached;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const cached = await getCachedStudentRoster(schoolId, { assignedClasses });
        if (cached) return cached;
        throw new Error('No saved student roster is available while offline.');
    }

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
}

export async function saveStudentRoster(schoolId, students, { assignedClasses = [] } = {}) {
    if (!schoolId || !Array.isArray(students)) return;
    try {
        const database = await getDatabase();
        await database.put(STORE_KV, students, studentRosterCacheKey(schoolId, assignedClasses));
    } catch (error) {
        console.warn('Could not save the student roster for offline use:', error);
    }
}
