// src/utils/ChatbotActions.js
import { auth, db } from '../firebase';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';

/**
 * Executes API calls to actual Netlify functions
 */

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
        const response = await fetch('/.netlify/functions/mpesa-stk-push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
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
                schoolId 
            })
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
        const response = await fetch('/.netlify/functions/get-student-balance', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ admissionNumber, schoolId })
        });
        const data = await response.json();
        return {
            success: response.ok && data.success,
            balance: response.ok && data.success
                ? `KES ${Number(data.balance || 0).toLocaleString()}`
                : (data.message || 'Student not found')
        };
    } catch (err) {
        return { success: false, balance: 'Error fetching balance' };
    }
};

export const fetchDailyCollections = async (schoolId) => {
    // Assuming a report generation endpoint exists
    try {
        const token = await auth.currentUser.getIdToken();
        // Placeholder, assuming this endpoint exists based on list of functions
        const response = await fetch('/.netlify/functions/reports-rollup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ schoolId })
        });
        const data = await response.json();
        return { success: true, today: data.today || 'KES 0', week: data.week || 'KES 0' };
    } catch (err) {
        return { success: false, today: 'Error', week: 'Error' };
    }
};
