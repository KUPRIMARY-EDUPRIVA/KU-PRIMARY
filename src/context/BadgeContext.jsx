// src/context/BadgeContext.jsx
import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { db } from '../firebase';
import { collection, query, where, getCountFromServer } from 'firebase/firestore';
import { getCachedStudentRoster } from '../services/studentRosterService';
import { getMemory, setMemory } from '../services/cache';

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
        const schoolId = userData?.schoolId;
        if (!schoolId) return;

        let cancelled = false;
        const countFor = async (key, collectionName, constraints) => {
            const cacheKey = `badge-count:${schoolId}:${key}`;
            const cached = getMemory(cacheKey);
            if (cached !== null) return cached;
            const result = (await getCountFromServer(
                query(collection(db, collectionName), ...constraints)
            )).data().count;
            setMemory(cacheKey, result, 5 * 60 * 1000);
            return result;
        };

        (async () => {
            try {
                const cachedStudents = await getCachedStudentRoster(schoolId);
                const [students, teachers, exams, publishedResults] = await Promise.all([
                    cachedStudents
                        ? Promise.resolve(cachedStudents.length)
                        : countFor('students', 'students', [where('schoolId', '==', schoolId)]),
                    countFor('teachers', 'teachers', [where('schoolId', '==', schoolId)]),
                    countFor('exams-active', 'exams', [
                        where('schoolId', '==', schoolId),
                        where('status', '==', 'active'),
                    ]),
                    countFor('results-published', 'exams', [
                        where('schoolId', '==', schoolId),
                        where('resultsPublished', '==', true),
                    ]),
                ]);
                if (!cancelled) {
                    setBadges({
                        students,
                        teachers,
                        exams,
                        results: publishedResults > 0 ? `${publishedResults} published` : '0%',
                    });
                }
            } catch (error) {
                console.error('School badge counts failed:', error);
            }
        })();

        return () => {
            cancelled = true;
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
