// src/pages/Dashboard.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { db } from '../firebase';
import { getCachedStudentRoster } from '../services/studentRosterService';
import { isSchoolAdminRole, normalizeRole } from '../utils/roles';
import {
    collection, query, where, getDocs, onSnapshot, doc, orderBy, limit, getDoc,
    getCountFromServer
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { getMemory, setMemory } from '../services/cache';
import { fetchNetlifyFunction } from '../services/netlifyApi';
import {
    listAttendanceRecords,
    startOfMonth as attStartOfMonth,
    todayISO as attTodayISO,
} from '../services/attendanceService';

import { showAppNotice } from '../utils/appNotice';

// CBC grading helper (inline — mirrors utils/constants.getCBCGrade)
const getCBCGrade = (score) => {
    const s = Number(score);
    if (!Number.isFinite(s)) return { code: '—', points: 0 };
    if (s >= 80) return { code: 'A', points: 12 };
    if (s >= 75) return { code: 'A-', points: 11 };
    if (s >= 70) return { code: 'B+', points: 10 };
    if (s >= 65) return { code: 'B', points: 9 };
    if (s >= 60) return { code: 'B-', points: 8 };
    if (s >= 55) return { code: 'C+', points: 7 };
    if (s >= 50) return { code: 'C', points: 6 };
    if (s >= 45) return { code: 'C-', points: 5 };
    if (s >= 40) return { code: 'D+', points: 4 };
    if (s >= 35) return { code: 'D', points: 3 };
    if (s >= 30) return { code: 'D-', points: 2 };
    return { code: 'E', points: 1 };
};

// Utility function to format time
const formatTimeAgo = (date) => {
    if (!date) return 'Just now';
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' minutes ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' hours ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' days ago';
    return date.toLocaleDateString();
};

// Level display constants
const LEVEL_DISPLAY_NAMES = {
    'pre-primary': 'Pre-Primary',
    'lower-primary': 'Lower Primary',
    'upper-primary': 'Upper Primary',
    'junior-school': 'Junior School',
    'senior-school': 'Senior School'
};

const getLevelDisplayName = (level) => LEVEL_DISPLAY_NAMES[level] || level || 'N/A';
const dashboardCountRequests = new Map();

async function getDashboardCount(cacheKey, countQuery) {
    const cached = getMemory(cacheKey);
    if (cached !== null && cached !== undefined) return cached;
    if (dashboardCountRequests.has(cacheKey)) return dashboardCountRequests.get(cacheKey);

    const request = getCountFromServer(countQuery)
        .then((snapshot) => snapshot.data().count)
        .then((count) => {
            setMemory(cacheKey, count, 10 * 60 * 1000);
            return count;
        });
    dashboardCountRequests.set(cacheKey, request);
    try {
        return await request;
    } finally {
        if (dashboardCountRequests.get(cacheKey) === request) dashboardCountRequests.delete(cacheKey);
    }
}

// ============================================
// MOTIVATIONAL MESSAGES
// ============================================
const getCurrentTerm = () => {
    const month = new Date().getMonth();
    if (month >= 0 && month <= 3) return { term: 1, name: 'Term 1', startMonth: 'January', endMonth: 'April' };
    if (month >= 4 && month <= 7) return { term: 2, name: 'Term 2', startMonth: 'May', endMonth: 'August' };
    if (month >= 8 && month <= 10) return { term: 3, name: 'Term 3', startMonth: 'September', endMonth: 'November' };
    return { term: 0, name: 'Holiday', startMonth: 'December', endMonth: 'December' };
};

const isHoliday = () => {
    const month = new Date().getMonth();
    const day = new Date().getDate();
    if (month === 11) return true;
    if (month === 3 && day >= 15) return true;
    if (month === 7 && day >= 15) return true;
    if (month === 10 && day >= 15) return true;
    return false;
};

const getTimeGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    if (hour >= 17 && hour < 21) return 'Good evening';
    return 'Good night';
};

const getMotivationalMessage = (userRole, schoolData) => {
    const hour = new Date().getHours();
    const currentTerm = getCurrentTerm();
    const holiday = isHoliday();
    const greeting = getTimeGreeting();
    const schoolName = schoolData?.name || schoolData?.schoolName || 'your school';

    if (hour >= 5 && hour < 12) {
        if (holiday) {
            return [
                ` Good morning! Enjoy your holiday break. Take this time to rest and recharge.`,
                ` Rise and shine! School is on holiday. Enjoy your well-deserved break.`,
                ` Good morning! While school is on holiday, you can use this time to prepare for the upcoming term.`,
                ` Rise and shine! The holidays are a perfect time to relax, read, and plan ahead.`
            ][Math.floor(Math.random() * 4)];
        }
        if (currentTerm.term === 1) {
            return [
                ` ${greeting}! A new academic year begins. Welcome to ${currentTerm.name}! Let's make it a great year at ${schoolName}.`,
                ` ${greeting}! The start of ${currentTerm.name} brings new opportunities. Stay focused and dedicated.`,
                ` ${greeting}! Welcome back to school! ${currentTerm.name} is a time for fresh starts and new goals.`,
                ` ${greeting}! As we begin ${currentTerm.name}, remember that every day is a chance to learn something new.`
            ][Math.floor(Math.random() * 4)];
        }
        if (currentTerm.term === 2) {
            return [
                ` ${greeting}! Welcome to ${currentTerm.name}! Keep pushing forward and giving your best.`,
                ` ${greeting}! ${currentTerm.name} is here! Stay motivated and keep striving for excellence.`,
                ` ${greeting}! We're in ${currentTerm.name}! Keep up the great work at ${schoolName}.`,
                ` ${greeting}! ${currentTerm.name} is in full swing. Stay focused on your goals.`
            ][Math.floor(Math.random() * 4)];
        }
        if (currentTerm.term === 3) {
            return [
                ` ${greeting}! Welcome to ${currentTerm.name}! This is the final stretch. Finish strong!`,
                ` ${greeting}! ${currentTerm.name} is here! Give it your all as we wrap up the academic year.`,
                ` ${greeting}! The final term is here! Stay focused and finish the year strong.`,
                ` ${greeting}! ${currentTerm.name} - the home stretch! Make every day count.`
            ][Math.floor(Math.random() * 4)];
        }
        return [
            ` ${greeting}! Have a blessed day at ${schoolName}. Make the most of every opportunity.`,
            ` ${greeting}! Each day is a gift. Use it wisely at ${schoolName}.`
        ][Math.floor(Math.random() * 2)];
    }

    if (hour >= 12 && hour < 17) {
        if (holiday) {
            return [
                ` Good afternoon! Enjoy your holiday. Take time to relax and have fun.`,
                ` Good afternoon! The holidays are a great time to spend with family and friends.`,
                ` Good afternoon! Make the most of your holiday break. You've earned it!`
            ][Math.floor(Math.random() * 3)];
        }
        if (currentTerm.term === 1) {
            return [
                ` Good afternoon! ${currentTerm.name} is off to a great start. Keep the momentum going at ${schoolName}.`,
                ` Good afternoon! New term, new energy. Keep pushing forward at ${schoolName}.`,
                ` Good afternoon! The first term is a time for fresh starts. Make it count.`
            ][Math.floor(Math.random() * 3)];
        }
        if (currentTerm.term === 2) {
            return [
                ` Good afternoon! ${currentTerm.name} is in progress. Stay committed to your goals.`,
                ` Good afternoon! Keep up the good work this ${currentTerm.name}.`,
                ` Good afternoon! ${currentTerm.name} - the journey continues. Stay determined.`
            ][Math.floor(Math.random() * 3)];
        }
        if (currentTerm.term === 3) {
            return [
                ` Good afternoon! ${currentTerm.name} - finish strong! The end is in sight.`,
                ` Good afternoon! Final term push - give it everything you've got.`,
                ` Good afternoon! ${currentTerm.name} is the final chapter. Make it your best.`
            ][Math.floor(Math.random() * 3)];
        }
        return [
            ` Good afternoon! Keep shining bright at ${schoolName}.`,
            ` Good afternoon! Your dedication is making a difference.`
        ][Math.floor(Math.random() * 2)];
    }

    if (hour >= 17 && hour < 21) {
        if (holiday) {
            return [
                ` Good evening! Enjoy your holiday evening. Rest and recharge for the days ahead.`,
                ` Good evening! The holidays are a time for rest and reflection.`,
                ` Good evening! Spend quality time with loved ones during this holiday season.`
            ][Math.floor(Math.random() * 3)];
        }
        if (currentTerm.term === 1) {
            return [
                ` Good evening! What a great start to ${currentTerm.name}. Keep up the momentum.`,
                ` Good evening! ${currentTerm.name} is underway. Keep striving for excellence.`,
                ` Good evening! Your efforts this ${currentTerm.name} will shape the year ahead.`
            ][Math.floor(Math.random() * 3)];
        }
        if (currentTerm.term === 2) {
            return [
                ` Good evening! ${currentTerm.name} is in full swing. Stay focused and determined.`,
                ` Good evening! Keep up the great work this ${currentTerm.name}.`,
                ` Good evening! Your consistency in ${currentTerm.name} will lead to success.`
            ][Math.floor(Math.random() * 3)];
        }
        if (currentTerm.term === 3) {
            return [
                ` Good evening! ${currentTerm.name} - the final stretch. Finish strong!`,
                ` Good evening! Your efforts in ${currentTerm.name} will define this academic year.`,
                ` Good evening! The end is near. Give it your all in ${currentTerm.name}.`
            ][Math.floor(Math.random() * 3)];
        }
        return [
            ` Good evening! Reflect on the day and prepare for tomorrow at ${schoolName}.`,
            ` Good evening! Your hard work is making a difference.`
        ][Math.floor(Math.random() * 2)];
    }

    return [
        ` Good night! Rest well and prepare for a new day at ${schoolName}.`,
        ` Good night! A good night's rest leads to a successful tomorrow.`,
        ` Good night! Get some rest. Tomorrow is a new opportunity.`
    ][Math.floor(Math.random() * 3)];
};

const getTermStatusDisplay = () => {
    const currentTerm = getCurrentTerm();
    const holiday = isHoliday();
    if (holiday) return ' School is on Holiday';
    return `📚 ${currentTerm.name}`;
};

// ============================================
// COMPONENT
// ============================================
export default function Dashboard() {
    const navigate = useNavigate();
    const { currentUser, userData, userRole } = useAuth();
    const isSchoolAdmin = isSchoolAdminRole(userRole || userData?.role)
        && normalizeRole(userRole || userData?.role) !== 'super-admin';
    const {
        isOnline,
        saveToIndexedDB,
        getFromIndexedDB
    } = useSync();

    // ---- Stats ----
    const [stats, setStats] = useState({
        totalStudents: 0,
        totalTeachers: 0,
        activeExams: 0,
        pendingSubmissions: 0,
        resultsPublished: '0%',
        subscriptionStatus: 'inactive',
        storageUsage: '0 MB',
        lastSync: 'Just now'
    });
    const [statsLoading, setStatsLoading] = useState(true);
    const [activities, setActivities] = useState([]);
    const [notifications, setNotifications] = useState([]);
    const [notificationBadge, setNotificationBadge] = useState(0);
    const [schoolData, setSchoolData] = useState(null);
    const [usingCachedData, setUsingCachedData] = useState(false);
    const [motivationalMessage, setMotivationalMessage] = useState('');
    const [termStatus, setTermStatus] = useState('');

    // ---- Role-specific ----
    const [teacherData, setTeacherData] = useState(null);
    const [studentData, setStudentData] = useState(null);
    const [myExams, setMyExams] = useState([]);
    const [myScores, setMyScores] = useState([]);
    const [upcomingExams, setUpcomingExams] = useState([]);
    const [recentResults, setRecentResults] = useState([]);

    // ---- NEW: Student dashboard metrics ----
    const [attendanceStats, setAttendanceStats] = useState(null);   // { rate, present, absent, late, excused, sessions, marks }
    const [attendanceLoading, setAttendanceLoading] = useState(false);
    const [averageScore, setAverageScore] = useState(null);
    const [averageScoreGrade, setAverageScoreGrade] = useState(null);
    const [feeBalance, setFeeBalance] = useState(null);
    const [feeBalanceLoading, setFeeBalanceLoading] = useState(false);

    // ---- Refs ----
    const statsTimeout = useRef(null);
    const realtimeListeners = useRef([]);

    // ==================================================
    // BOOTSTRAP
    // ==================================================
    useEffect(() => {
        if (currentUser && userData) {
            loadSchoolData();
            loadRoleSpecificData();
            loadDashboardData();
            setupRealtimeListeners();
            updateMotivationalMessage();
        }

        return () => {
            realtimeListeners.current.forEach(unsubscribe => {
                try { unsubscribe(); } catch (e) { console.warn('Error unsubscribing:', e); }
            });
            if (statsTimeout.current) clearTimeout(statsTimeout.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser, userData, isOnline, userRole]);

    useEffect(() => {
        if (schoolData) updateMotivationalMessage();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [schoolData, userRole]);

    const updateMotivationalMessage = () => {
        const message = getMotivationalMessage(userRole, schoolData);
        setMotivationalMessage(message);
        setTermStatus(getTermStatusDisplay());
    };

    const showNotification = useCallback((message, type = 'info') => {
        showAppNotice(message, type);
    }, []);

    // ==================================================
    // ROLE-SPECIFIC LOADERS
    // ==================================================
    const loadRoleSpecificData = async () => {
        const schoolId = userData?.schoolId;
        if (!schoolId) return;

        try {
            if (userRole === 'teacher') {
                await loadTeacherData(schoolId);
            } else if (userRole === 'student') {
                await loadStudentData(schoolId);
            }
        } catch (error) {
            console.error('Error loading role-specific data:', error);
        }
    };

    // ---- Teacher ----
    const loadTeacherData = async (schoolId) => {
        try {
            let teacher = null;
            const cachedTeachers = await getFromIndexedDB('teachers');
            if (cachedTeachers) {
                teacher = cachedTeachers.find(t =>
                    t.email === currentUser?.email && t.schoolId === schoolId
                );
            }
            if (isOnline) {
                const q = query(
                    collection(db, 'teachers'),
                    where('email', '==', currentUser?.email),
                    where('schoolId', '==', schoolId)
                );
                const snapshot = await getDocs(q);
                if (!snapshot.empty) {
                    const docData = snapshot.docs[0];
                    teacher = { id: docData.id, ...docData.data() };
                    const allTeachers = cachedTeachers || [];
                    const index = allTeachers.findIndex(t => t.email === currentUser?.email);
                    if (index >= 0) allTeachers[index] = teacher;
                    else allTeachers.push(teacher);
                    await saveToIndexedDB('teachers', allTeachers);
                }
            }
            if (teacher) {
                setTeacherData(teacher);
                await loadTeacherExams(schoolId, teacher);
            }
        } catch (error) {
            console.error('Error loading teacher data:', error);
        }
    };

    const loadTeacherExams = async (schoolId, teacher) => {
        try {
            const teacherClasses = teacher.classes || [];
            const teacherLevels = teacher.level ? [teacher.level] : (teacher.levels || []);
            if (teacherClasses.length === 0 && teacherLevels.length === 0) return;

            let examQuery;
            if (teacherClasses.length > 0) {
                examQuery = query(
                    collection(db, 'exams'),
                    where('schoolId', '==', schoolId),
                    where('class', 'in', teacherClasses.slice(0, 10))
                );
            } else {
                examQuery = query(
                    collection(db, 'exams'),
                    where('schoolId', '==', schoolId),
                    where('level', 'in', teacherLevels.slice(0, 10))
                );
            }

            const snapshot = await getDocs(examQuery);
            const exams = snapshot.docs.map(d => ({
                id: d.id,
                ...d.data(),
                startDate: d.data().startDate?.toDate?.() || new Date(),
                endDate: d.data().endDate?.toDate?.() || new Date()
            }));
            setMyExams(exams);

            const submissionPromises = exams.map(exam =>
                getDocs(query(
                    collection(db, 'exam_submissions'),
                    where('examId', '==', exam.id),
                    where('schoolId', '==', schoolId)
                ))
            );
            const submissionResults = await Promise.all(submissionPromises);
            const submissions = submissionResults.flatMap(s =>
                s.docs.map(d => ({ id: d.id, ...d.data() }))
            );

            const pendingSubmissions = submissions.filter(s => s.status === 'pending').length;
            const totalSubmissions = submissions.length;
            const gradedSubmissions = submissions.filter(s => s.status === 'graded' || s.status === 'published').length;

            setStats(prev => ({
                ...prev,
                pendingSubmissions,
                resultsPublished: totalSubmissions > 0
                    ? `${Math.round((gradedSubmissions / totalSubmissions) * 100)}%`
                    : '0%'
            }));

            await saveToIndexedDB('exam_submissions', submissions);
        } catch (error) {
            console.error('Error loading teacher exams:', error);
        }
    };

    // ---- Student ----
    const loadStudentData = async (schoolId) => {
        try {
            let student = null;
            const cachedStudents = await getFromIndexedDB('students');
            if (cachedStudents) {
                student = cachedStudents.find(s =>
                    s.email === currentUser?.email && s.schoolId === schoolId
                );
            }

            if (isOnline) {
                const q = query(
                    collection(db, 'students'),
                    where('email', '==', currentUser?.email),
                    where('schoolId', '==', schoolId)
                );
                const snapshot = await getDocs(q);
                if (!snapshot.empty) {
                    const docData = snapshot.docs[0];
                    student = { id: docData.id, ...docData.data() };
                    const allStudents = cachedStudents || [];
                    const index = allStudents.findIndex(s => s.email === currentUser?.email);
                    if (index >= 0) allStudents[index] = student;
                    else allStudents.push(student);
                    await saveToIndexedDB('students', allStudents);
                }
            }

            if (student) {
                setStudentData(student);
                await loadStudentExamsAndScores(schoolId, student);

                // Load new metrics in parallel
                await Promise.all([
                    loadStudentAttendanceStats(schoolId, student),
                    loadStudentAverageScore(schoolId, student),
                    loadStudentFeeBalance(schoolId, student),
                ]);
            }
        } catch (error) {
            console.error('Error loading student data:', error);
        }
    };

    const loadStudentExamsAndScores = async (schoolId, student) => {
        try {
            const studentClass = student.class;
            const studentLevel = student.level;
            if (!studentClass && !studentLevel) return;

            let examQuery;
            if (studentClass) {
                examQuery = query(
                    collection(db, 'exams'),
                    where('schoolId', '==', schoolId),
                    where('class', '==', studentClass)
                );
            } else if (studentLevel) {
                examQuery = query(
                    collection(db, 'exams'),
                    where('schoolId', '==', schoolId),
                    where('level', '==', studentLevel)
                );
            }

            const examSnapshot = await getDocs(examQuery);
            const exams = examSnapshot.docs.map(d => ({
                id: d.id,
                ...d.data(),
                startDate: d.data().startDate?.toDate?.() || new Date(),
                endDate: d.data().endDate?.toDate?.() || new Date()
            }));

            const now = new Date();
            const upcoming = exams.filter(e => new Date(e.startDate) > now);
            setUpcomingExams(upcoming);

            const scoresQuery = query(
                collection(db, 'student_scores'),
                where('schoolId', '==', schoolId),
                where('studentId', '==', student.id || student.studentId)
            );
            const scoresSnapshot = await getDocs(scoresQuery);
            const scores = scoresSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            setMyScores(scores);

            const recent = scores.filter(s => s.status === 'published' || s.status === 'graded');
            setRecentResults(recent.slice(0, 5));

            const completedExams = exams.filter(e => new Date(e.endDate) < now);
            const gradedCount = scores.filter(s => s.score !== undefined && s.score !== null).length;

            setStats(prev => ({
                ...prev,
                activeExams: upcoming.length,
                resultsPublished: completedExams.length > 0
                    ? `${Math.round((gradedCount / completedExams.length) * 100)}%`
                    : '0%'
            }));

            await saveToIndexedDB('student_exams', exams);
            await saveToIndexedDB('student_scores', scores);
        } catch (error) {
            console.error('Error loading student exams and scores:', error);
        }
    };

    // ---- NEW: Student attendance stats (current term) ----
    const loadStudentAttendanceStats = async (schoolId, student) => {
        setAttendanceLoading(true);
        try {
            const termStart = schoolData?.termStart || attStartOfMonth();
            const toDate = attTodayISO();

            const records = await listAttendanceRecords({
                schoolId,
                cls: student.class,
                fromDate: termStart,
                toDate,
                max: 500,
            });

            const totals = { sessions: 0, present: 0, absent: 0, late: 0, excused: 0, marks: 0 };
            (records || []).forEach((rec) => {
                totals.sessions += 1;
                const entries = Array.isArray(rec.entries) ? rec.entries : [];
                const mine = entries.find((e) => e.studentId === student.id);
                if (!mine) return;
                totals.marks += 1;
                const s = mine.status || 'present';
                if (totals[s] !== undefined) totals[s] += 1;
            });

            const rate = totals.marks
                ? Math.round(((totals.present + totals.late) / totals.marks) * 100)
                : 0;

            setAttendanceStats({ ...totals, rate });
        } catch (e) {
            console.warn('Attendance stats load failed:', e);
            setAttendanceStats(null);
        } finally {
            setAttendanceLoading(false);
        }
    };

    // ---- NEW: Student average score ----
    const loadStudentAverageScore = async (schoolId, student) => {
        try {
            const scoresSnap = await getDocs(query(
                collection(db, 'student_scores'),
                where('schoolId', '==', schoolId),
                where('studentId', '==', student.id)
            ));
            if (scoresSnap.empty) {
                setAverageScore(null);
                setAverageScoreGrade(null);
                return;
            }

            const scores = scoresSnap.docs.map((d) => d.data());
            const published = scores.filter(s => s.status === 'published' || s.status === 'graded');
            const pool = published.length ? published : scores;
            if (pool.length === 0) {
                setAverageScore(null);
                setAverageScoreGrade(null);
                return;
            }

            // Use the most-recent assessment type across all scores so we don't
            // mix 'Assessment 1' with 'End-Term', etc.
            const latestType = pool[0].assessmentType || 'Assessment 1';
            const sameType = pool.filter(s => (s.assessmentType || 'Assessment 1') === latestType);

            const values = sameType
                .map(s => (s.computedPercentage != null ? Number(s.computedPercentage) : Number(s.score)))
                .filter(v => Number.isFinite(v));

            if (values.length === 0) {
                setAverageScore(null);
                setAverageScoreGrade(null);
                return;
            }

            const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
            setAverageScore(avg);
            setAverageScoreGrade(getCBCGrade(avg));
        } catch (e) {
            console.warn('Average score load failed:', e);
            setAverageScore(null);
            setAverageScoreGrade(null);
        }
    };

    // ---- NEW: Student fee balance via Netlify function ----
    const loadStudentFeeBalance = async (schoolId, student) => {
        setFeeBalanceLoading(true);
        try {
            const res = await fetchNetlifyFunction('get-student-balance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    schoolId,
                    admissionNumber: student.admissionNumber || student.studentId || '',
                }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setFeeBalance(Number(data.balance) || 0);
        } catch (e) {
            console.warn('Fee balance load failed:', e);
            setFeeBalance(null);
        } finally {
            setFeeBalanceLoading(false);
        }
    };

    // ==================================================
    // SCHOOL DATA
    // ==================================================
    const loadSchoolData = async () => {
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) return;

            let schoolData = await getFromIndexedDB('school_data', schoolId);

            if (schoolData) {
                setSchoolData(schoolData);
                setStats(prev => ({
                    ...prev,
                    subscriptionStatus: schoolData.subscriptionStatus || 'inactive'
                }));
            }

            if (isOnline) {
                const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
                if (schoolDoc.exists()) {
                    const data = schoolDoc.data();
                    setSchoolData(data);
                    setStats(prev => ({
                        ...prev,
                        subscriptionStatus: data.subscriptionStatus || 'inactive'
                    }));
                    await saveToIndexedDB('school_data', { id: schoolId, ...data });
                }
            }
        } catch (error) {
            console.error('Error loading school data:', error);
        }
    };

    // ==================================================
    // DASHBOARD STATS
    // ==================================================
    const updateBadges = () => {
        const badgeData = {
            students: stats.totalStudents,
            teachers: stats.totalTeachers,
            exams: stats.activeExams,
            results: stats.resultsPublished
        };
        window.dispatchEvent(new CustomEvent('badgeUpdate', { detail: badgeData }));
        window.dispatchEvent(new CustomEvent('statsUpdate', { detail: stats }));
    };

    const loadDashboardData = async () => {
        setStatsLoading(true);
        try {
            const schoolId = userData?.schoolId;
            if (!schoolId) {
                await loadCachedStats();
                setStatsLoading(false);
                return;
            }

            const cachedStats = await getFromIndexedDB('stats_cache', 'dashboard_stats');
            if (cachedStats) {
                setStats(cachedStats);
                setUsingCachedData(true);
                updateBadges();
            }

            if (isOnline) {
                const statsData = await calculateDashboardStats(schoolId);
                setStats(statsData);
                setUsingCachedData(false);
                updateBadges();

                await saveToIndexedDB('stats_cache', {
                    id: 'dashboard_stats',
                    type: 'dashboard_stats',
                    ...statsData,
                    lastUpdated: new Date().toISOString()
                });
            }

            await loadRecentActivities(schoolId);
            await loadNotifications(schoolId);
        } catch (error) {
            console.error('Error loading dashboard data:', error);
            await loadCachedStats();
        } finally {
            setStatsLoading(false);
        }
    };

    const calculateDashboardStats = async (schoolId) => {
        try {
            const subscriptionStatus = schoolData?.subscriptionStatus || 'inactive';

            if (isSchoolAdmin) {
                const [
                    studentsCount,
                    teachersCount,
                    activeExamsCount,
                    pendingSubmissionsCount,
                    resultsPublished,
                    storageUsed
                ] = await Promise.all([
                    getCollectionCount('students', schoolId),
                    getCollectionCount('teachers', schoolId),
                    getActiveExamsCount(schoolId),
                    getPendingSubmissionsCount(schoolId),
                    getResultsPublishedPercentage(schoolId),
                    getStorageUsage(schoolId)
                ]);

                return {
                    totalStudents: studentsCount,
                    totalTeachers: teachersCount,
                    activeExams: activeExamsCount,
                    pendingSubmissions: pendingSubmissionsCount,
                    resultsPublished,
                    subscriptionStatus,
                    storageUsage: storageUsed,
                    lastSync: new Date().toISOString()
                };
            }

            return {
                ...stats,
                subscriptionStatus,
                lastSync: new Date().toISOString()
            };
        } catch (error) {
            console.error('Error calculating stats:', error);
            return getDefaultStats();
        }
    };

    const getDefaultStats = () => ({
        totalStudents: 0,
        totalTeachers: 0,
        activeExams: 0,
        pendingSubmissions: 0,
        resultsPublished: '0%',
        subscriptionStatus: 'inactive',
        storageUsage: '0 MB',
        lastSync: 'Never'
    });

    const getCollectionCount = async (collectionName, schoolId) => {
        try {
            if (collectionName === 'students') {
                const cached = await getCachedStudentRoster(schoolId);
                if (cached) return cached.length;
                return getDashboardCount(
                    `dashboard-count:${schoolId}:students`,
                    query(collection(db, 'students'), where('schoolId', '==', schoolId))
                );
            }
            const q = query(collection(db, collectionName), where('schoolId', '==', schoolId));
            return getDashboardCount(`dashboard-count:${schoolId}:${collectionName}`, q);
        } catch (error) {
            console.error(`Error getting ${collectionName} count:`, error);
            const cached = await getFromIndexedDB(collectionName);
            return cached ? cached.filter(item => item.schoolId === schoolId).length : 0;
        }
    };

    const getActiveExamsCount = async (schoolId) => {
        try {
            const today = new Date();
            const q = query(
                collection(db, 'exams'),
                where('schoolId', '==', schoolId),
                where('status', '==', 'active'),
                where('endDate', '>=', today)
            );
            return await getDashboardCount(`dashboard-count:${schoolId}:active-exams`, q);
        } catch (error) {
            console.error('Error getting active exams:', error);
            return 0;
        }
    };

    const getPendingSubmissionsCount = async (schoolId) => {
        try {
            const q = query(
                collection(db, 'exam_submissions'),
                where('schoolId', '==', schoolId),
                where('status', '==', 'pending')
            );
            return await getDashboardCount(`dashboard-count:${schoolId}:pending-submissions`, q);
        } catch (error) {
            console.error('Error getting pending submissions:', error);
            return 0;
        }
    };

    const getResultsPublishedPercentage = async (schoolId) => {
        try {
            const [publishedCount, totalCount] = await Promise.all([
                getDashboardCount(
                    `dashboard-count:${schoolId}:published-exams`,
                    query(collection(db, 'exams'), where('schoolId', '==', schoolId), where('resultsPublished', '==', true))
                ),
                getDashboardCount(
                    `dashboard-count:${schoolId}:exams`,
                    query(collection(db, 'exams'), where('schoolId', '==', schoolId))
                )
            ]);
            return totalCount > 0 ? `${Math.round((publishedCount / totalCount) * 100)}%` : '0%';
        } catch (error) {
            console.error('Error getting results published:', error);
            return '0%';
        }
    };

    const getStorageUsage = async (schoolId) => {
        try {
            const cachedStudents = await getCachedStudentRoster(schoolId);
            const [studentCount, teacherCount, examCount, scoreCount] = await Promise.all([
                cachedStudents
                    ? Promise.resolve(cachedStudents.length)
                    : getDashboardCount(
                        `dashboard-count:${schoolId}:students`,
                        query(collection(db, 'students'), where('schoolId', '==', schoolId))
                    ),
                getDashboardCount(
                    `dashboard-count:${schoolId}:teachers`,
                    query(collection(db, 'teachers'), where('schoolId', '==', schoolId))
                ),
                getDashboardCount(
                    `dashboard-count:${schoolId}:exams`,
                    query(collection(db, 'exams'), where('schoolId', '==', schoolId))
                ),
                getDashboardCount(
                    `dashboard-count:${schoolId}:scores`,
                    query(collection(db, 'student_scores'), where('schoolId', '==', schoolId))
                )
            ]);

            const totalDocs = studentCount + teacherCount + examCount + scoreCount;
            const estimatedMB = Math.max(1, Math.round((totalDocs * 0.2) + 2));
            return estimatedMB >= 1024
                ? `${(estimatedMB / 1024).toFixed(1)} GB`
                : `${estimatedMB} MB`;
        } catch (error) {
            console.error('Error calculating storage usage:', error);
            const cachedStats = await getFromIndexedDB('stats_cache', 'dashboard_stats');
            if (cachedStats && cachedStats.storageUsage) return cachedStats.storageUsage;
            return '0 MB';
        }
    };

    const loadCachedStats = async () => {
        try {
            const cachedStats = await getFromIndexedDB('stats_cache', 'dashboard_stats');
            if (cachedStats) {
                setStats(cachedStats);
                setUsingCachedData(true);
                updateBadges();
                showNotification('Using cached data - limited functionality', 'warning');
            } else {
                const defaultStats = getDefaultStats();
                setStats(defaultStats);
                setUsingCachedData(true);
                updateBadges();
            }
        } catch (error) {
            console.error('Error loading cached stats:', error);
            const defaultStats = getDefaultStats();
            setStats(defaultStats);
            setUsingCachedData(true);
            updateBadges();
        }
    };

    // ==================================================
    // NOTIFICATIONS / ACTIVITIES
    // ==================================================
    const updateNotificationCount = (count) => {
        setNotificationBadge(count);
        window.dispatchEvent(new CustomEvent('notificationUpdate', {
            detail: { count, notifications }
        }));
    };

    const loadRecentActivities = async (schoolId) => {
        try {
            const cachedActivities = await getFromIndexedDB('activities');
            if (cachedActivities && cachedActivities.length > 0) {
                setActivities(cachedActivities.slice(0, 5));
            }

            if (isOnline) {
                const q = query(
                    collection(db, 'activities'),
                    where('schoolId', '==', schoolId),
                    orderBy('timestamp', 'desc'),
                    limit(5)
                );
                const snapshot = await getDocs(q);
                const activitiesData = snapshot.docs.map(d => ({
                    id: d.id,
                    ...d.data(),
                    timestamp: d.data().timestamp?.toDate?.() || new Date()
                }));
                setActivities(activitiesData);
                await saveToIndexedDB('activities', activitiesData);
            }
        } catch (error) {
            console.error('Error loading activities:', error);
        }
    };

    const loadNotifications = async (schoolId) => {
        try {
            const cachedNotifications = await getFromIndexedDB('notifications');
            if (cachedNotifications && cachedNotifications.length > 0) {
                const unread = cachedNotifications.filter(n => !n.read);
                setNotifications(cachedNotifications);
                updateNotificationCount(unread.length);
            }

            if (isOnline) {
                const q = query(
                    collection(db, 'notifications'),
                    where('schoolId', '==', schoolId),
                    where('read', '==', false),
                    orderBy('createdAt', 'desc'),
                    limit(10)
                );
                const snapshot = await getDocs(q);
                const notificationsData = snapshot.docs.map(d => ({
                    id: d.id,
                    ...d.data(),
                    createdAt: d.data().createdAt?.toDate?.() || new Date(),
                    time: formatTimeAgo(d.data().createdAt?.toDate?.() || new Date())
                }));
                setNotifications(notificationsData);
                updateNotificationCount(notificationsData.length);
                await saveToIndexedDB('notifications', notificationsData);
            }
        } catch (error) {
            console.error('Error loading notifications:', error);
        }
    };

    // ==================================================
    // REALTIME LISTENERS
    // ==================================================
    const setupRealtimeListeners = () => {
        const schoolId = userData?.schoolId;
        if (!schoolId || !isOnline) return;

        realtimeListeners.current.forEach(unsubscribe => {
            try { unsubscribe(); } catch (e) { console.warn('Error unsubscribing:', e); }
        });
        realtimeListeners.current = [];

        if (isSchoolAdmin) {
            const teachersListener = onSnapshot(
                query(collection(db, 'teachers'), where('schoolId', '==', schoolId)),
                async (snapshot) => {
                    const count = snapshot.size;
                    setStats(prev => ({ ...prev, totalTeachers: count }));
                    updateBadges();
                    const teachersData = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                    await saveToIndexedDB('teachers', teachersData);
                },
                (error) => console.error('Teachers listener error:', error)
            );
            realtimeListeners.current.push(() => teachersListener());
        }

        const activitiesListener = onSnapshot(
            query(collection(db, 'activities'), where('schoolId', '==', schoolId), orderBy('timestamp', 'desc'), limit(5)),
            async (snapshot) => {
                const activitiesData = snapshot.docs.map(d => ({
                    id: d.id,
                    ...d.data(),
                    timestamp: d.data().timestamp?.toDate?.() || new Date()
                }));
                setActivities(activitiesData);
                await saveToIndexedDB('activities', activitiesData);
            },
            (error) => console.error('Activities listener error:', error)
        );
        realtimeListeners.current.push(() => activitiesListener());

        const notificationsListener = onSnapshot(
            query(collection(db, 'notifications'), where('schoolId', '==', schoolId), where('read', '==', false), orderBy('createdAt', 'desc'), limit(10)),
            async (snapshot) => {
                const notificationsData = snapshot.docs.map(d => ({
                    id: d.id,
                    ...d.data(),
                    createdAt: d.data().createdAt?.toDate?.() || new Date(),
                    time: formatTimeAgo(d.data().createdAt?.toDate?.() || new Date())
                }));
                setNotifications(notificationsData);
                updateNotificationCount(notificationsData.length);
                await saveToIndexedDB('notifications', notificationsData);
            },
            (error) => console.error('Notifications listener error:', error)
        );
        realtimeListeners.current.push(() => notificationsListener());

        if (userRole === 'teacher' && teacherData) {
            const teacherClasses = teacherData.classes || [];
            const teacherLevels = teacherData.level ? [teacherData.level] : (teacherData.levels || []);

            if (teacherClasses.length > 0 || teacherLevels.length > 0) {
                const submissionsListener = onSnapshot(
                    query(collection(db, 'exam_submissions'), where('schoolId', '==', schoolId), where('status', '==', 'pending')),
                    (snapshot) => {
                        const pendingSubs = snapshot.docs.filter(d => {
                            const data = d.data();
                            return teacherClasses.includes(data.class) || teacherLevels.includes(data.level);
                        });
                        setStats(prev => ({ ...prev, pendingSubmissions: pendingSubs.length }));
                    },
                    (error) => console.error('Submissions listener error:', error)
                );
                realtimeListeners.current.push(() => submissionsListener());
            }
        }

        if (userRole === 'student' && studentData) {
            const scoresListener = onSnapshot(
                query(
                    collection(db, 'student_scores'),
                    where('schoolId', '==', schoolId),
                    where('studentId', '==', studentData.id || studentData.studentId)
                ),
                async (snapshot) => {
                    const scores = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                    setMyScores(scores);
                    const published = scores.filter(s => s.status === 'published' || s.status === 'graded');
                    setRecentResults(published.slice(0, 5));

                    // Recompute average from the live set
                    const pool = published.length ? published : scores;
                    if (pool.length > 0) {
                        const latestType = pool[0].assessmentType || 'Assessment 1';
                        const sameType = pool.filter(s => (s.assessmentType || 'Assessment 1') === latestType);
                        const values = sameType
                            .map(s => (s.computedPercentage != null ? Number(s.computedPercentage) : Number(s.score)))
                            .filter(v => Number.isFinite(v));
                        if (values.length > 0) {
                            const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
                            setAverageScore(avg);
                            setAverageScoreGrade(getCBCGrade(avg));
                        }
                    }

                    await saveToIndexedDB('student_scores', scores);
                },
                (error) => console.error('Scores listener error:', error)
            );
            realtimeListeners.current.push(() => scoresListener());

            // Live attendance updates for this student's class
            const attendanceListener = onSnapshot(
                query(
                    collection(db, 'attendance'),
                    where('schoolId', '==', schoolId),
                    where('class', '==', studentData.class || '')
                ),
                () => {
                    // Re-fetch aggregated stats to keep the math consistent
                    loadStudentAttendanceStats(schoolId, studentData).catch(() => {});
                },
                (error) => console.error('Attendance listener error:', error)
            );
            realtimeListeners.current.push(() => attendanceListener());
        }
    };

    // ==================================================
    // QUICK ACTIONS
    // ==================================================
    const handleQuickAction = (action) => {
        const actions = {
            'add-student': () => navigate('/students?action=add'),
            'create-exam': () => navigate('/exams?action=create'),
            'generate-report': () => navigate('/reports?action=generate'),
            'print-records': () => window.print(),
            'assign-teacher': () => navigate('/teachers?action=assign'),
            'view-exams': () => navigate('/exams'),
            'view-results': () => navigate('/results'),
            'view-scores': () => navigate('/scores'),
            'take-exam': () => navigate('/exams/take'),
            'my-classes': () => navigate('/classes')
        };
        if (actions[action]) actions[action]();
    };

    const handleFilterActivities = () => {
        showNotification('Filter functionality coming soon!', 'info');
    };

    const handleExportActivities = async () => {
        if (activities.length === 0) {
            showNotification('No activities to export', 'warning');
            return;
        }
        try {
            const csv = convertToCSV(activities);
            downloadCSV(csv, `activities_${new Date().toISOString().slice(0, 10)}.csv`);
            showNotification('Activities exported successfully', 'success');
        } catch (error) {
            console.error('Error exporting activities:', error);
            showNotification('Failed to export activities', 'error');
        }
    };

    const convertToCSV = (data) => {
        const headers = ['Description', 'Type', 'Time'];
        const rows = data.map(item => [
            `"${item.description || ''}"`,
            item.type || '',
            formatTimeAgo(item.timestamp || new Date())
        ]);
        return [headers, ...rows].map(row => row.join(',')).join('\n');
    };

    const downloadCSV = (content, filename) => {
        const blob = new Blob([content], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        window.URL.revokeObjectURL(url);
    };

    // ==================================================
    // RENDER: STATS GRID
    // ==================================================
    const renderStatsGrid = () => {
        if (isSchoolAdmin) {
            return (
                <>
                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Total Students</div>
                            <div className="stat-icon students"><i className="fas fa-user-graduate"></i></div>
                        </div>
                        <div className="stat-value">{stats.totalStudents}</div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-active"></span>
                                <span>Enrolled</span>
                            </div>
                            <button className="stat-more" onClick={() => navigate('/students')}>View All</button>
                        </div>
                    </div>

                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Total Teachers</div>
                            <div className="stat-icon teachers"><i className="fas fa-chalkboard-teacher"></i></div>
                        </div>
                        <div className="stat-value">{stats.totalTeachers}</div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-active"></span>
                                <span>On staff</span>
                            </div>
                            <button className="stat-more" onClick={() => navigate('/teachers')}>Manage</button>
                        </div>
                    </div>

                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Active Exams</div>
                            <div className="stat-icon exams"><i className="fas fa-file-alt"></i></div>
                        </div>
                        <div className="stat-value">{stats.activeExams}</div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-warning"></span>
                                <span>In progress</span>
                            </div>
                            <button className="stat-more" onClick={() => navigate('/exams')}>Schedule</button>
                        </div>
                    </div>

                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Pending Submissions</div>
                            <div className="stat-icon submissions"><i className="fas fa-tasks"></i></div>
                        </div>
                        <div className="stat-value">{stats.pendingSubmissions}</div>
                        <div className="stat-footer">
                            <div className="stat-change positive">
                                <i className="fas fa-arrow-up"></i>
                                <span>To grade</span>
                            </div>
                            <button className="stat-more" onClick={() => navigate('/exams')}>Review</button>
                        </div>
                    </div>

                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Results Published</div>
                            <div className="stat-icon results"><i className="fas fa-chart-line"></i></div>
                        </div>
                        <div className="stat-value">{stats.resultsPublished}</div>
                        <div className="stat-footer">
                            <button className="stat-more" onClick={() => navigate('/results')}>Publish</button>
                        </div>
                    </div>

                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Storage Usage</div>
                            <div className="stat-icon storage"><i className="fas fa-database"></i></div>
                        </div>
                        <div className="stat-value">{stats.storageUsage}</div>
                        <div className="stat-footer">
                            <button className="stat-more" onClick={() => navigate('/school-profile')}>Manage</button>
                        </div>
                    </div>
                </>
            );
        }

        if (userRole === 'teacher') {
            return (
                <>
                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">My Classes</div>
                            <div className="stat-icon classes"><i className="fas fa-chalkboard"></i></div>
                        </div>
                        <div className="stat-value">{teacherData?.classes?.length || 0}</div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-active"></span>
                                <span>Assigned</span>
                            </div>
                            <button className="stat-more" onClick={() => handleQuickAction('my-classes')}>View</button>
                        </div>
                    </div>

                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">My Exams</div>
                            <div className="stat-icon exams"><i className="fas fa-file-alt"></i></div>
                        </div>
                        <div className="stat-value">{myExams.length}</div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-warning"></span>
                                <span>Scheduled</span>
                            </div>
                            <button className="stat-more" onClick={() => handleQuickAction('view-exams')}>View</button>
                        </div>
                    </div>

                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Pending Submissions</div>
                            <div className="stat-icon submissions"><i className="fas fa-tasks"></i></div>
                        </div>
                        <div className="stat-value">{stats.pendingSubmissions}</div>
                        <div className="stat-footer">
                            <div className="stat-change positive">
                                <i className="fas fa-arrow-up"></i>
                                <span>To Grade</span>
                            </div>
                            <button className="stat-more" onClick={() => navigate('/exams')}>Grade</button>
                        </div>
                    </div>

                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Grading Progress</div>
                            <div className="stat-icon results"><i className="fas fa-chart-line"></i></div>
                        </div>
                        <div className="stat-value">{stats.resultsPublished}</div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-info"></span>
                                <span>Completed</span>
                            </div>
                            <button className="stat-more" onClick={() => navigate('/results')}>Details</button>
                        </div>
                    </div>
                </>
            );
        }

        if (userRole === 'student') {
            const att = attendanceStats;
            const fmtCurrency = (v) => v == null ? '—' : `KSh ${Number(v).toLocaleString()}`;

            return (
                <>
                    {/* Current class */}
                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">My Class</div>
                            <div className="stat-icon class"><i className="fas fa-users"></i></div>
                        </div>
                        <div className="stat-value" style={{ fontSize: '20px' }}>
                            {studentData?.class || 'N/A'}
                        </div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-active"></span>
                                <span>{getLevelDisplayName(studentData?.level)}</span>
                            </div>
                        </div>
                    </div>

                    {/* Attendance */}
                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Attendance</div>
                            <div className="stat-icon submissions"><i className="fas fa-clipboard-check"></i></div>
                        </div>
                        <div className="stat-value" style={{
                            color: att == null ? 'var(--gray)'
                                : att.rate >= 90 ? 'var(--success)'
                                : att.rate >= 75 ? 'var(--warning)'
                                : 'var(--danger)'
                        }}>
                            {attendanceLoading ? '…' : att == null ? '—' : `${att.rate}%`}
                        </div>
                        <div className="stat-footer" style={{ flexWrap: 'wrap', gap: 6 }}>
                            {att ? (
                                <>
                                    <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600 }}>P {att.present}</span>
                                    <span style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 600 }}>A {att.absent}</span>
                                    <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>L {att.late}</span>
                                    <span style={{ fontSize: 11, color: 'var(--info)', fontWeight: 600 }}>E {att.excused}</span>
                                </>
                            ) : (
                                <span style={{ fontSize: 11, color: 'var(--gray)' }}>
                                    {attendanceLoading ? 'Loading…' : 'No data yet'}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Average score */}
                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Average Score</div>
                            <div className="stat-icon results"><i className="fas fa-chart-line"></i></div>
                        </div>
                        <div className="stat-value" style={{
                            color: averageScore == null ? 'var(--gray)'
                                : averageScore >= 75 ? 'var(--success)'
                                : averageScore >= 50 ? 'var(--warning)'
                                : 'var(--danger)'
                        }}>
                            {averageScore == null ? '—' : `${averageScore}%`}
                        </div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-info"></span>
                                <span>{averageScoreGrade ? `Grade ${averageScoreGrade.code}` : 'Not scored yet'}</span>
                            </div>
                            <button className="stat-more" onClick={() => handleQuickAction('view-results')}>View</button>
                        </div>
                    </div>

                    {/* Fee balance */}
                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Fee Balance</div>
                            <div className="stat-icon exams"><i className="fas fa-file-invoice-dollar"></i></div>
                        </div>
                        <div className="stat-value" style={{
                            fontSize: '20px',
                            color: feeBalance == null ? 'var(--gray)'
                                : feeBalance > 0 ? 'var(--danger)'
                                : 'var(--success)'
                        }}>
                            {feeBalanceLoading ? '…' : fmtCurrency(feeBalance)}
                        </div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className={`status-dot ${feeBalance == null ? 'status-warning' : feeBalance > 0 ? 'status-warning' : 'status-active'}`}></span>
                                <span>{feeBalance == null ? 'Unavailable' : feeBalance > 0 ? 'Outstanding' : 'Cleared'}</span>
                            </div>
                        </div>
                    </div>

                    {/* Upcoming exams */}
                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">Upcoming Exams</div>
                            <div className="stat-icon exams"><i className="fas fa-calendar-alt"></i></div>
                        </div>
                        <div className="stat-value">{upcomingExams.length}</div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-warning"></span>
                                <span>Scheduled</span>
                            </div>
                            <button className="stat-more" onClick={() => handleQuickAction('take-exam')}>View</button>
                        </div>
                    </div>

                    {/* My results */}
                    <div className="stat-card">
                        <div className="stat-header">
                            <div className="stat-title">My Results</div>
                            <div className="stat-icon results"><i className="fas fa-award"></i></div>
                        </div>
                        <div className="stat-value">{recentResults.length}</div>
                        <div className="stat-footer">
                            <div className="status-indicator">
                                <span className="status-dot status-info"></span>
                                <span>Published</span>
                            </div>
                            <button className="stat-more" onClick={() => handleQuickAction('view-results')}>View</button>
                        </div>
                    </div>
                </>
            );
        }

        return null;
    };

    // ==================================================
    // RENDER: QUICK ACTIONS
    // ==================================================
    const renderQuickActions = () => {
        if (isSchoolAdmin) {
            return (
                <>
                    <div className="quick-action-card" onClick={() => handleQuickAction('add-student')}>
                        <div className="quick-action-icon"><i className="fas fa-user-plus"></i></div>
                        <h3 className="quick-action-title">Add Student</h3>
                        <p className="quick-action-desc">Register new student</p>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('create-exam')}>
                        <div className="quick-action-icon"><i className="fas fa-file-medical"></i></div>
                        <h3 className="quick-action-title">Create Exam</h3>
                        <p className="quick-action-desc">Schedule new exam</p>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('generate-report')}>
                        <div className="quick-action-icon"><i className="fas fa-chart-bar"></i></div>
                        <h3 className="quick-action-title">Generate Report</h3>
                        <p className="quick-action-desc">Create performance report</p>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('assign-teacher')}>
                        <div className="quick-action-icon"><i className="fas fa-user-tie"></i></div>
                        <h3 className="quick-action-title">Assign Teacher</h3>
                        <p className="quick-action-desc">Assign to class/subject</p>
                    </div>
                </>
            );
        }

        if (userRole === 'teacher') {
            return (
                <>
                    <div className="quick-action-card" onClick={() => handleQuickAction('view-exams')}>
                        <div className="quick-action-icon"><i className="fas fa-file-alt"></i></div>
                        <h3 className="quick-action-title">View Exams</h3>
                        <p className="quick-action-desc">See all your exams</p>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('generate-report')}>
                        <div className="quick-action-icon"><i className="fas fa-chart-bar"></i></div>
                        <h3 className="quick-action-title">Generate Report</h3>
                        <p className="quick-action-desc">Create class performance report</p>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('my-classes')}>
                        <div className="quick-action-icon"><i className="fas fa-chalkboard"></i></div>
                        <h3 className="quick-action-title">My Classes</h3>
                        <p className="quick-action-desc">View assigned classes</p>
                    </div>
                    <div className="quick-action-card" onClick={() => navigate('/students')}>
                        <div className="quick-action-icon"><i className="fas fa-user-graduate"></i></div>
                        <h3 className="quick-action-title">My Students</h3>
                        <p className="quick-action-desc">View students in my classes</p>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('print-records')}>
                        <div className="quick-action-icon"><i className="fas fa-print"></i></div>
                        <h3 className="quick-action-title">Print Records</h3>
                        <p className="quick-action-desc">Print class records</p>
                    </div>
                </>
            );
        }

        if (userRole === 'student') {
            return (
                <>
                    <div className="quick-action-card" onClick={() => handleQuickAction('take-exam')}>
                        <div className="quick-action-icon"><i className="fas fa-pencil-alt"></i></div>
                        <h3 className="quick-action-title">Take Exam</h3>
                        <p className="quick-action-desc">Start an online exam</p>
                    </div>
                    <div className="quick-action-card" onClick={() => handleQuickAction('view-results')}>
                        <div className="quick-action-icon"><i className="fas fa-chart-line"></i></div>
                        <h3 className="quick-action-title">My Results</h3>
                        <p className="quick-action-desc">View exam results</p>
                    </div>
                    <div className="quick-action-card" onClick={() => navigate('/scores')}>
                        <div className="quick-action-icon"><i className="fas fa-tasks"></i></div>
                        <h3 className="quick-action-title">My Scores</h3>
                        <p className="quick-action-desc">View all scores</p>
                    </div>
                    <div className="quick-action-card" onClick={() => navigate('/exams')}>
                        <div className="quick-action-icon"><i className="fas fa-calendar-alt"></i></div>
                        <h3 className="quick-action-title">Exam Schedule</h3>
                        <p className="quick-action-desc">View upcoming exams</p>
                    </div>
                    <div className="quick-action-card" onClick={() => navigate('/profile')}>
                        <div className="quick-action-icon"><i className="fas fa-user"></i></div>
                        <h3 className="quick-action-title">My Profile</h3>
                        <p className="quick-action-desc">View and update profile</p>
                    </div>
                </>
            );
        }

        return null;
    };

    // ==================================================
    // RENDER: WELCOME
    // ==================================================
    const renderWelcomeMessage = () => {
        const firstName = userData?.fullName?.split(' ')[0] || userData?.firstName?.split(' ')[0] || 'User';

        const hour = new Date().getHours();
        let emoji = '';
        if (hour >= 5 && hour < 12) emoji = '';
        else if (hour >= 12 && hour < 17) emoji = '';
        else if (hour >= 17 && hour < 21) emoji = '';
        else emoji = '';

        if (isSchoolAdmin) {
            return (
                <div className="welcome-content">
                    <h1>{emoji} Welcome back, <span>{firstName}</span>!</h1>
                    <p style={{ fontSize: '15px', opacity: '0.95', maxWidth: '600px' }}>{motivationalMessage}</p>
                    <p style={{ fontSize: '13px', opacity: '0.8', marginTop: '8px' }}>{termStatus}</p>
                </div>
            );
        }

        if (userRole === 'teacher') {
            return (
                <div className="welcome-content">
                    <h1>{emoji} Welcome back, <span>Mr/Ms {firstName}</span>!</h1>
                    <p style={{ fontSize: '15px', opacity: '0.95', maxWidth: '600px' }}>{motivationalMessage}</p>
                    {teacherData?.classes && teacherData.classes.length > 0 && (
                        <p style={{ fontSize: '14px', opacity: '0.8', marginTop: '8px' }}>
                            Assigned to: {teacherData.classes.join(', ')}
                        </p>
                    )}
                    <p style={{ fontSize: '13px', opacity: '0.8', marginTop: '4px' }}>{termStatus}</p>
                </div>
            );
        }

        if (userRole === 'student') {
            return (
                <div className="welcome-content">
                    <h1>{emoji} Welcome back, <span>{firstName}</span>!</h1>
                    <p style={{ fontSize: '15px', opacity: '0.95', maxWidth: '600px' }}>{motivationalMessage}</p>
                    {studentData?.class && (
                        <p style={{ fontSize: '14px', opacity: '0.8', marginTop: '8px' }}>
                            Class: {studentData.class} • {getLevelDisplayName(studentData?.level)}
                        </p>
                    )}
                    <p style={{ fontSize: '13px', opacity: '0.8', marginTop: '4px' }}>{termStatus}</p>
                </div>
            );
        }

        return (
            <div className="welcome-content">
                <h1>{emoji} Welcome back, <span>{firstName}</span>!</h1>
                <p style={{ fontSize: '15px', opacity: '0.95', maxWidth: '600px' }}>{motivationalMessage}</p>
                <p style={{ fontSize: '13px', opacity: '0.8', marginTop: '8px' }}>{termStatus}</p>
            </div>
        );
    };

    const renderWelcomeActions = () => {
        if (isSchoolAdmin) {
            return (
                <>
                    <button className="btn btn-primary" onClick={() => navigate('/students?action=add')}>
                        <i className="fas fa-plus"></i> Add New Student
                    </button>
                    <button className="btn btn-outline" onClick={() => navigate('/reports')}>
                        <i className="fas fa-chart-line"></i> View Analytics
                    </button>
                </>
            );
        }
        if (userRole === 'teacher') {
            return (
                <>
                    <button className="btn btn-primary" onClick={() => navigate('/exams')}>
                        <i className="fas fa-file-alt"></i> View Exams
                    </button>
                    <button className="btn btn-outline" onClick={() => navigate('/students')}>
                        <i className="fas fa-user-graduate"></i> My Students
                    </button>
                </>
            );
        }
        if (userRole === 'student') {
            return (
                <>
                    <button className="btn btn-primary" onClick={() => navigate('/exams/take')}>
                        <i className="fas fa-pencil-alt"></i> Take Exam
                    </button>
                    <button className="btn btn-outline" onClick={() => navigate('/results')}>
                        <i className="fas fa-chart-line"></i> View Results
                    </button>
                </>
            );
        }
        return null;
    };

    // ==================================================
    // RENDER: ACTIVITY
    // ==================================================
    const renderRecentActivity = () => {
        if (isSchoolAdmin) {
            return (
                <section className="recent-activity">
                    <div className="section-header">
                        <h2 className="section-title">Recent Activity</h2>
                        <div className="section-actions">
                            <button className="btn btn-outline btn-sm" onClick={handleFilterActivities}>
                                <i className="fas fa-filter"></i> Filter
                            </button>
                            <button className="btn btn-primary btn-sm" onClick={handleExportActivities}>
                                <i className="fas fa-download"></i> Export
                            </button>
                        </div>
                    </div>
                    <ul className="activity-list">
                        {activities.length === 0 ? (
                            <li className="activity-item">
                                <div className="activity-content" style={{ width: '100%', textAlign: 'center', color: 'var(--gray)' }}>
                                    No recent activities
                                </div>
                            </li>
                        ) : (
                            activities.map(activity => {
                                const iconMap = {
                                    'student_enrolled': 'user-plus',
                                    'exam_published': 'file-upload',
                                    'teacher_added': 'chalkboard-teacher',
                                    'payment_received': 'credit-card',
                                    'sync_completed': 'sync-alt',
                                    'result_published': 'chart-line',
                                    'backup_completed': 'database',
                                    'student_added': 'user-plus',
                                    'exam_created': 'file-upload',
                                    'teacher_invited': 'chalkboard-teacher',
                                    'subscription_renewed': 'credit-card',
                                    'login': 'sign-in-alt',
                                    'logout': 'sign-out-alt'
                                };
                                const icon = iconMap[activity.type] || 'info-circle';
                                return (
                                    <li key={activity.id} className="activity-item">
                                        <div className="activity-icon">
                                            <i className={`fas fa-${icon}`}></i>
                                        </div>
                                        <div className="activity-content">
                                            <div className="activity-text">{activity.description || 'Activity'}</div>
                                            <div className="activity-time">{formatTimeAgo(activity.timestamp || new Date())}</div>
                                        </div>
                                    </li>
                                );
                            })
                        )}
                    </ul>
                </section>
            );
        }

        return (
            <section className="recent-activity">
                <div className="section-header">
                    <h2 className="section-title">Recent Activity</h2>
                </div>
                <ul className="activity-list">
                    {activities.length === 0 ? (
                        <li className="activity-item">
                            <div className="activity-content" style={{ width: '100%', textAlign: 'center', color: 'var(--gray)' }}>
                                No recent activities
                            </div>
                        </li>
                    ) : (
                        activities.slice(0, 5).map(activity => (
                            <li key={activity.id} className="activity-item">
                                <div className="activity-icon">
                                    <i className={`fas fa-${activity.type === 'exam_published' ? 'file-upload' : activity.type === 'result_published' ? 'chart-line' : 'info-circle'}`}></i>
                                </div>
                                <div className="activity-content">
                                    <div className="activity-text">{activity.description || 'Activity'}</div>
                                    <div className="activity-time">{formatTimeAgo(activity.timestamp || new Date())}</div>
                                </div>
                            </li>
                        ))
                    )}
                </ul>
            </section>
        );
    };

    // ==================================================
    // RENDER: STUDENT CONTENT
    // ==================================================
    const renderStudentContent = () => {
        if (userRole !== 'student') return null;

        return (
            <div className="student-content-grid">
                <section className="upcoming-exams" style={{ gridColumn: '1 / 2' }}>
                    <div className="section-header">
                        <h2 className="section-title">Upcoming Exams</h2>
                        <button className="btn btn-primary btn-sm" onClick={() => navigate('/exams/take')}>
                            View All →
                        </button>
                    </div>
                    <div className="exam-list">
                        {upcomingExams.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '30px', color: 'var(--gray)' }}>
                                <i className="fas fa-calendar-check" style={{ fontSize: '24px', display: 'block', marginBottom: '10px' }}></i>
                                No upcoming exams scheduled
                            </div>
                        ) : (
                            upcomingExams.slice(0, 5).map(exam => (
                                <div key={exam.id} className="exam-item" style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    padding: '12px 15px',
                                    borderBottom: '1px solid var(--border)'
                                }}>
                                    <div>
                                        <div style={{ fontWeight: '600', color: 'var(--secondary)' }}>{exam.title || exam.name}</div>
                                        <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                                            {exam.subject || 'General'} • {exam.class || 'All Classes'}
                                        </div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                                            {exam.startDate ? new Date(exam.startDate).toLocaleDateString() : 'TBD'}
                                        </div>
                                        {exam.status === 'active' && (
                                            <span className="status-badge active" style={{ fontSize: '10px' }}>Ready</span>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </section>

                <section className="recent-results" style={{ gridColumn: '2 / 3' }}>
                    <div className="section-header">
                        <h2 className="section-title">Recent Results</h2>
                        <button className="btn btn-primary btn-sm" onClick={() => navigate('/results')}>
                            View All →
                        </button>
                    </div>
                    <div className="result-list">
                        {recentResults.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '30px', color: 'var(--gray)' }}>
                                <i className="fas fa-chart-line" style={{ fontSize: '24px', display: 'block', marginBottom: '10px' }}></i>
                                No results published yet
                            </div>
                        ) : (
                            recentResults.slice(0, 5).map(result => (
                                <div key={result.id} className="result-item" style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    padding: '12px 15px',
                                    borderBottom: '1px solid var(--border)'
                                }}>
                                    <div>
                                        <div style={{ fontWeight: '600', color: 'var(--secondary)' }}>
                                            {result.examTitle || result.examName || result.subject || 'Exam'}
                                        </div>
                                        <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                                            Score: <strong>{result.score !== undefined && result.score !== null ? result.score : 'N/A'}</strong>
                                            {result.maxScore && ` / ${result.maxScore}`}
                                            {result.grade && ` • Grade: ${result.grade}`}
                                        </div>
                                    </div>
                                    <div style={{
                                        fontSize: '14px',
                                        fontWeight: '700',
                                        color: result.score && result.score >= 70 ? 'var(--success)' :
                                            result.score && result.score >= 50 ? 'var(--warning)' : 'var(--danger)'
                                    }}>
                                        {result.score !== undefined && result.score !== null
                                            ? `${Math.round((result.score / (result.maxScore || 100)) * 100)}%`
                                            : 'N/A'}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </div>
        );
    };

    // ==================================================
    // RENDER: TEACHER CONTENT
    // ==================================================
    const renderTeacherContent = () => {
        if (userRole !== 'teacher') return null;

        return (
            <div className="teacher-content-grid">
                <section className="my-exams" style={{ gridColumn: '1 / 2' }}>
                    <div className="section-header">
                        <h2 className="section-title">My Exams</h2>
                        <button className="btn btn-primary btn-sm" onClick={() => navigate('/exams')}>
                            View All →
                        </button>
                    </div>
                    <div className="exam-list">
                        {myExams.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '30px', color: 'var(--gray)' }}>
                                <i className="fas fa-file-alt" style={{ fontSize: '24px', display: 'block', marginBottom: '10px' }}></i>
                                No exams assigned to your classes
                            </div>
                        ) : (
                            myExams.slice(0, 5).map(exam => (
                                <div key={exam.id} className="exam-item" style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    padding: '12px 15px',
                                    borderBottom: '1px solid var(--border)'
                                }}>
                                    <div>
                                        <div style={{ fontWeight: '600', color: 'var(--secondary)' }}>{exam.title || exam.name}</div>
                                        <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                                            {exam.class || 'All Classes'} • {exam.subject || 'General'}
                                        </div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                                            {exam.status === 'active' ? '🟢 Active' :
                                                exam.status === 'pending' ? '🟡 Pending' : '⚪ Completed'}
                                        </div>
                                        <button
                                            className="btn btn-sm btn-primary"
                                            style={{ marginTop: '4px', padding: '4px 12px', fontSize: '11px' }}
                                            onClick={() => navigate(`/exams/${exam.id}/submissions`)}
                                        >
                                            View Submissions
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </section>

                <section className="pending-grading" style={{ gridColumn: '2 / 3' }}>
                    <div className="section-header">
                        <h2 className="section-title">Pending Grading</h2>
                        <span className="badge" style={{
                            background: 'var(--danger)',
                            color: 'white',
                            padding: '2px 12px',
                            borderRadius: '12px',
                            fontSize: '12px'
                        }}>
                            {stats.pendingSubmissions || 0}
                        </span>
                    </div>
                    <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--gray)' }}>
                        {stats.pendingSubmissions > 0 ? (
                            <>
                                <i className="fas fa-tasks" style={{ fontSize: '36px', display: 'block', marginBottom: '15px', color: 'var(--warning)' }}></i>
                                <p style={{ fontSize: '16px', fontWeight: '500', color: 'var(--secondary)' }}>
                                    {stats.pendingSubmissions} submission{stats.pendingSubmissions > 1 ? 's' : ''} pending review
                                </p>
                                <button className="btn btn-primary" style={{ marginTop: '15px' }} onClick={() => navigate('/exams')}>
                                    Go to Grading
                                </button>
                            </>
                        ) : (
                            <>
                                <i className="fas fa-check-circle" style={{ fontSize: '36px', display: 'block', marginBottom: '15px', color: 'var(--success)' }}></i>
                                <p>All caught up! No pending submissions to grade.</p>
                            </>
                        )}
                    </div>
                </section>
            </div>
        );
    };

    // ==================================================
    // RENDER
    // ==================================================
    if (statsLoading) {
        return <LoadingSpinner fullScreen text="Loading dashboard..." />;
    }

    return (
        <Layout>
            {usingCachedData && isOnline && (
                <div style={{
                    background: '#d1ecf1',
                    color: '#0c5460',
                    padding: '8px 16px',
                    borderRadius: '8px',
                    marginBottom: '20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    fontSize: '13px',
                    border: '1px solid #bee5eb'
                }}>
                    <i className="fas fa-database"></i>
                    <span>Showing cached data. Syncing in background...</span>
                </div>
            )}

            <section className="welcome-banner">
                {renderWelcomeMessage()}
                <div className="welcome-actions">
                    {renderWelcomeActions()}
                </div>
            </section>

            <section className="stats-grid" id="statsGrid">
                {renderStatsGrid()}
            </section>

            {userRole === 'student' && renderStudentContent()}
            {userRole === 'teacher' && renderTeacherContent()}

            {renderRecentActivity()}

            <section className="mt-30">
                <h2 className="section-title mb-20">
                    {isSchoolAdmin ? 'Quick Actions' :
                        userRole === 'teacher' ? 'Teaching Tools' :
                            'Student Tools'}
                </h2>
                <div className="quick-actions-grid">
                    {renderQuickActions()}
                </div>
            </section>

            <style>{`
                .student-content-grid,
                .teacher-content-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 25px;
                    margin-top: 30px;
                }

                .student-content-grid section,
                .teacher-content-grid section {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    box-shadow: var(--shadow);
                }

                .section-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 15px;
                }

                .section-title {
                    font-size: 18px;
                    font-weight: 600;
                    color: var(--secondary);
                    margin: 0;
                }

                .btn-sm {
                    padding: 6px 14px;
                    font-size: 12px;
                }

                .mt-30 { margin-top: 30px; }
                .mb-20 { margin-bottom: 20px; }

                .quick-actions-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 15px;
                }

                .quick-action-card {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    text-align: center;
                    cursor: pointer;
                    transition: all 0.3s;
                    box-shadow: var(--shadow);
                    border: 1px solid var(--border);
                }

                .quick-action-card:hover {
                    transform: translateY(-4px);
                    box-shadow: var(--shadow-lg);
                    border-color: var(--primary);
                }

                .quick-action-icon {
                    width: 50px;
                    height: 50px;
                    border-radius: 50%;
                    background: var(--light);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0 auto 12px;
                    font-size: 20px;
                    color: var(--primary);
                }

                .quick-action-title {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--secondary);
                    margin: 0 0 4px 0;
                }

                .quick-action-desc {
                    font-size: 12px;
                    color: var(--gray);
                    margin: 0;
                }

                @media (max-width: 768px) {
                    .student-content-grid,
                    .teacher-content-grid {
                        grid-template-columns: 1fr;
                    }

                    .quick-actions-grid {
                        grid-template-columns: repeat(2, 1fr);
                    }
                }

                @media (max-width: 480px) {
                    .quick-actions-grid {
                        grid-template-columns: 1fr;
                    }
                }
            `}</style>
        </Layout>
    );
}
