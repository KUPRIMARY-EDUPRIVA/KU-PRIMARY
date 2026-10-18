// src/services/studentService.js
import {
    collection, query, where, getDocs, doc, getDoc,
    updateDoc, addDoc, orderBy, limit, startAfter,
    serverTimestamp, writeBatch
} from 'firebase/firestore';
import { db } from '../firebase';

const DEFAULT_PAGE = 100;

export async function loadStudentsPage(schoolId, { pageSize = DEFAULT_PAGE, cursor = null } = {}) {
    const constraints = [
        where('schoolId', '==', schoolId),
        orderBy('createdAt', 'desc'),
        limit(pageSize + 1),
    ];
    if (cursor) constraints.splice(2, 0, startAfter(cursor));

    const snap = await getDocs(query(collection(db, 'students'), ...constraints));
    const docs = snap.docs;
    const hasMore = docs.length > pageSize;
    const page = hasMore ? docs.slice(0, pageSize) : docs;

    return {
        students: page.map((d) => ({ id: d.id, ...d.data() })),
        lastCursor: page.length ? page[page.length - 1] : null,
        hasMore,
    };
}

export async function getStudent(studentId) {
    const snap = await getDoc(doc(db, 'students', studentId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createStudent(payload) {
    const ref = await addDoc(collection(db, 'students'), {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
    });
    return { id: ref.id, ...payload };
}

export async function updateStudent(studentId, updates, currentUser) {
    const { studentId: _, schoolId: __, id: ___, ...safe } = updates;
    await updateDoc(doc(db, 'students', studentId), {
        ...safe,
        updatedAt: serverTimestamp(),
    });
    
    // Log audit - Assuming auditService exists as in previous versions
    // const { AuditLogService } = require('./auditService');
    // await AuditLogService.logAction(currentUser?.uid, 'STUDENT_UPDATED', studentId, { updates: Object.keys(safe) });
}

export async function softDeleteStudent(studentId, actorUid) {
    await updateDoc(doc(db, 'students', studentId), {
        isDeleted: true,
        status: 'deleted',
        deletedAt: serverTimestamp(),
        deletedBy: actorUid || null,
        updatedAt: serverTimestamp(),
    });
}

export async function restoreStudent(studentId) {
    await updateDoc(doc(db, 'students', studentId), {
        isDeleted: false,
        status: 'active',
        deletedAt: null,
        deletedBy: null,
        updatedAt: serverTimestamp(),
    });
}

export async function bulkUpdateStudents(updates) {
    for (let i = 0; i < updates.length; i += 400) {
        const chunk = updates.slice(i, i + 400);
        const batch = writeBatch(db);
        chunk.forEach(({ id, data }) => {
            batch.update(doc(db, 'students', id), {
                ...data,
                updatedAt: serverTimestamp(),
            });
        });
        await batch.commit();
    }
}

export async function loadAllStudents(schoolId, assignedClasses = []) {
    if (!schoolId) throw new Error('School ID is required to load students.');

    const classScopes = [];
    for (let i = 0; i < assignedClasses.length; i += 30) {
        classScopes.push(assignedClasses.slice(i, i + 30));
    }
    if (classScopes.length === 0) classScopes.push([]);

    const loadScope = async (classes) => {
        const students = [];
        let cursor = null;
        while (true) {
            const constraints = [where('schoolId', '==', schoolId)];
            if (classes.length) constraints.push(where('class', 'in', classes));
            constraints.push(orderBy('createdAt', 'desc'));
            if (cursor) constraints.push(startAfter(cursor));
            constraints.push(limit(500));

            const snapshot = await getDocs(query(collection(db, 'students'), ...constraints));
            students.push(...snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
            if (snapshot.size < 500) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
        }
        return students;
    };

    const scopedStudents = await Promise.all(classScopes.map(loadScope));
    const byId = new Map();
    scopedStudents.flat().forEach((student) => byId.set(student.id, student));
    return [...byId.values()];
}
