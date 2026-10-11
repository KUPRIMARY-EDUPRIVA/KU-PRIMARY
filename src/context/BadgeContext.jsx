// src/context/BadgeContext.jsx
import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, getCountFromServer } from 'firebase/firestore';
import { getCachedStudentRoster } from '../services/studentRosterService';

const BadgeContext = createContext();

export function useBadges() {
    return useContext(BadgeContext);
}

export function BadgeProvider({ children }) {
    const { userData } = useAuth();
    const [badges, setBadges] = useState({
        students: 0,
        teachers: 0,
        exams: 0,
        results: '0%'
    });

    useEffect(() => {
        if (!userData?.schoolId) return;

        let cancelled = false;
        const loadStudentCount = async () => {
            try {
                const cached = await getCachedStudentRoster(userData.schoolId);
                const count = cached
                    ? cached.length
                    : (await getCountFromServer(query(
                        collection(db, 'students'),
                        where('schoolId', '==', userData.schoolId)
                    ))).data().count;
                if (!cancelled) setBadges((prev) => ({ ...prev, students: count }));
            } catch (error) {
                console.error('Student count load failed:', error);
            }
        };
        loadStudentCount();

        // Listen to teachers count
        const teachersQuery = query(
            collection(db, 'teachers'),
            where('schoolId', '==', userData.schoolId)
        );
        const unsubscribeTeachers = onSnapshot(teachersQuery, (snapshot) => {
            setBadges(prev => ({ ...prev, teachers: snapshot.size }));
        });

        // Listen to active exams count
        const examsQuery = query(
            collection(db, 'exams'),
            where('schoolId', '==', userData.schoolId),
            where('status', '==', 'active')
        );
        const unsubscribeExams = onSnapshot(examsQuery, (snapshot) => {
            setBadges(prev => ({ ...prev, exams: snapshot.size }));
        });

        // Listen to results published
        const resultsQuery = query(
            collection(db, 'exams'),
            where('schoolId', '==', userData.schoolId),
            where('resultsPublished', '==', true)
        );
        const unsubscribeResults = onSnapshot(resultsQuery, (snapshot) => {
            const total = snapshot.size;
            setBadges(prev => ({ ...prev, results: total > 0 ? `${total} published` : '0%' }));
        });

        return () => {
            cancelled = true;
            unsubscribeTeachers();
            unsubscribeExams();
            unsubscribeResults();
        };
    }, [userData?.schoolId]);

    const updateBadges = (newBadges) => {
        setBadges(prev => ({ ...prev, ...newBadges }));
    };

    return (
        <BadgeContext.Provider value={{ badges, updateBadges }}>
            {children}
        </BadgeContext.Provider>
    );
}
