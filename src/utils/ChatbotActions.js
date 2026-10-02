// src/utils/ChatbotActions.js
import { auth, db } from '../firebase';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';

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
   School information (new)
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
   Performance (new)
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
