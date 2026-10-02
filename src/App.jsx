// src/App.jsx
import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { SyncProvider } from './context/SyncContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SchoolProvider } from './context/SchoolContext';
import { BadgeProvider } from './context/BadgeContext';
import { NotificationProvider } from './context/NotificationContext';
import { FeeProvider } from './context/FeeContext';
import LoadingSpinner from './components/Common/LoadingSpinner';
import ErrorBoundary from './components/Common/ErrorBoundary';

const lazyWithRetry = (importFn) =>
  lazy(async () => {
    try {
      return await importFn();
    } catch (error) {
      const key = `chunk_retry_${importFn.toString()}`;
      const hasRetried = sessionStorage.getItem(key);
      if (!hasRetried) {
        sessionStorage.setItem(key, 'true');
        window.location.reload();
        return new Promise(() => {});
      }
      throw error;
    }
  });

// Lazy load pages
const Login = lazyWithRetry(() => import('./components/Auth/Login'));
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'));
const Students = lazyWithRetry(() => import('./pages/Students'));
const StudentAnalytics = lazyWithRetry(() => import('./pages/StudentAnalytics'));
const Teachers = lazyWithRetry(() => import('./pages/Teachers'));
const Exams = lazyWithRetry(() => import('./pages/Exams'));
const Results = lazyWithRetry(() => import('./pages/Results'));
const Reports = lazyWithRetry(() => import('./pages/Reports'));
const StudentReports = lazyWithRetry(() => import('./pages/StudentReports'));
const Fees = lazyWithRetry(() => import('./pages/Fees'));
const FeeStructure = lazyWithRetry(() => import('./pages/FeeStructure'));
const FeesReports = lazyWithRetry(() => import('./pages/FeesReports'));
const StudentFeeDetail = lazyWithRetry(() => import('./pages/StudentFeeDetail'));
const Subscription = lazyWithRetry(() => import('./pages/Subscription'));
const SchoolProfile = lazyWithRetry(() => import('./pages/SchoolProfile'));
const Settings = lazyWithRetry(() => import('./pages/Settings'));
const Communications = lazyWithRetry(() => import('./pages/Communications'));
const Transport = lazyWithRetry(() => import('./pages/Transportation'));
const Health = lazyWithRetry(() => import('./pages/HealthRecords'));
const Accomodation = lazyWithRetry(() => import('./pages/Boarding'));
const Inventory = lazyWithRetry(() => import('./pages/Inventory'));
const Timetable = lazyWithRetry(() => import('./pages/Timetable'));
const Transfer = lazyWithRetry(() => import('./pages/Transfer'));
const Exit = lazyWithRetry(() => import('./pages/SchoolExit'));
const AuditLogs = lazyWithRetry(() => import('./pages/AuditLogs'));
const Transcripts = lazyWithRetry(() => import('./pages/Transcripts'));
const Attendance = lazyWithRetry(() => import('./pages/Attendance'));


// Teacher pages
const TeacherDashboard = lazyWithRetry(() => import('./pages/Teacher/Dashboard'));
const MyStudents = lazyWithRetry(() => import('./pages/Students'));
const MyResults = lazyWithRetry(() => import('./pages/Results'));
const MyReports = lazyWithRetry(() => import('./pages/Teacher/Reports'));

// Student pages
const StudentDashboard = lazyWithRetry(() => import('./pages/Student/Dashboard'));
const StudentResults = lazyWithRetry(() => import('./pages/Student/Results'));
const StudentFees = lazyWithRetry(() => import('./pages/Student/Fees'));

// Platform Admin pages
const PlatformDashboard = lazyWithRetry(() => import('./pages/PlatformAdmin/Dashboard'));
const Schools = lazyWithRetry(() => import('./pages/PlatformAdmin/Schools'));
const SchoolDetails = lazyWithRetry(() => import('./pages/PlatformAdmin/SchoolDetails'));
const PlatformUsers = lazyWithRetry(() => import('./pages/PlatformAdmin/Users'));
const PlatformSettings = lazyWithRetry(() => import('./pages/PlatformAdmin/Settings'));

/**
 * AuthWrapper — guards a route by auth status and role.
 * Must be used inside AuthProvider.
 */
function AuthWrapper({ children, allowedRoles }) {
    const { currentUser, userRole, loading } = useAuth();

    if (loading) {
        return <LoadingSpinner fullScreen text="Authenticating..." />;
    }

    if (!currentUser) {
        return <Navigate to="/login" replace />;
    }

    if (allowedRoles && allowedRoles.length > 0) {
        if (!userRole) {
            return <LoadingSpinner fullScreen text="Loading user role..." />;
        }

        if (!allowedRoles.includes(userRole)) {
            if (userRole === 'admin' || userRole === 'user' || userRole === 'school_admin') {
                return <Navigate to="/dashboard" replace />;
            }
            if (userRole === 'teacher') {
                return <Navigate to="/mydashboard" replace />;
            }
            if (userRole === 'student') {
                return <Navigate to="/student-dashboard" replace />;
            }
            if (userRole === 'super-admin') {
                return <Navigate to="/platformtower" replace />;
            }
            return <Navigate to="/login" replace />;
        }
    }

    return children;
}

/**
 * AppRoutes — pulled out so we can wrap it in all providers cleanly.
 */
function AppRoutes() {
    return (
        <Suspense fallback={<LoadingSpinner fullScreen text="Loading..." />}>
            <Routes>
                {/* Public */}
                <Route path="/login" element={<Login />} />

                {/* Admin routes */}
                <Route path="/" element={<AuthWrapper><Dashboard /></AuthWrapper>} />
                <Route path="/dashboard" element={<AuthWrapper><Dashboard /></AuthWrapper>} />
                <Route path="/transport" element={<AuthWrapper><Transport /></AuthWrapper>} />
                <Route path="/transfer" element={<AuthWrapper><Transfer /></AuthWrapper>} />
                <Route path="/health" element={<AuthWrapper><Health /></AuthWrapper>} />
                <Route path="/accomodation" element={<AuthWrapper><Accomodation /></AuthWrapper>} />
                <Route path="/students" element={<AuthWrapper><Students /></AuthWrapper>} />
                <Route path="/student-analytics" element={<AuthWrapper><StudentAnalytics /></AuthWrapper>} />
                <Route path="/communications" element={
                    <AuthWrapper allowedRoles={['admin', 'user', 'school_admin']}><Communications /></AuthWrapper>
                } />
                <Route path="/sms" element={<Navigate to="/communications" replace />} />
                <Route path="/teachers" element={<AuthWrapper><Teachers /></AuthWrapper>} />
                <Route path="/exams" element={<AuthWrapper><Exams /></AuthWrapper>} />
                <Route path="/results" element={<AuthWrapper><Results /></AuthWrapper>} />
                <Route path="/reports" element={<AuthWrapper><Reports /></AuthWrapper>} />
                <Route path="/studentreports" element={<AuthWrapper><StudentReports /></AuthWrapper>} />
                <Route path="/fees" element={<AuthWrapper><Fees /></AuthWrapper>} />
                <Route path="/fee-structure" element={<AuthWrapper><FeeStructure /></AuthWrapper>} />
                <Route path="/fee-reports" element={<AuthWrapper><FeesReports /></AuthWrapper>} />
                <Route path="/student-fees/:studentId" element={<AuthWrapper><StudentFeeDetail /></AuthWrapper>} />
                <Route path="/subscription" element={<AuthWrapper><Subscription /></AuthWrapper>} />
                <Route path="/inventory" element={<AuthWrapper><Inventory /></AuthWrapper>} />
                <Route path="/school-profile" element={<AuthWrapper><SchoolProfile /></AuthWrapper>} />
                <Route path="/audit-logs" element={<AuthWrapper><AuditLogs /></AuthWrapper>} />
                <Route path="/transcripts" element={<AuthWrapper><Transcripts /></AuthWrapper>} />
                <Route path="/timetable" element={<AuthWrapper><Timetable /></AuthWrapper>} />
                <Route path="/settings" element={<AuthWrapper><Settings /></AuthWrapper>} />

                {/* Teacher routes */}
                <Route path="/mydashboard" element={
                    <AuthWrapper allowedRoles={['teacher']}><TeacherDashboard /></AuthWrapper>
                } />
                <Route path="/my-students" element={
                    <AuthWrapper allowedRoles={['teacher']}><MyStudents /></AuthWrapper>
                } />
                <Route path="/my-results" element={
                    <AuthWrapper allowedRoles={['teacher']}><MyResults /></AuthWrapper>
                } />
                <Route path="/myreports" element={
                    <AuthWrapper allowedRoles={['teacher']}><MyReports /></AuthWrapper>
                } />
               <Route path="/attendance" element={
                    <AuthWrapper allowedRoles={['teacher']}><Attendance /></AuthWrapper>
                } />

                {/* Student routes */}
                <Route path="/student-dashboard" element={
                    <AuthWrapper allowedRoles={['student']}><StudentDashboard /></AuthWrapper>
                } />
                <Route path="/student-results" element={
                    <AuthWrapper allowedRoles={['student']}><StudentResults /></AuthWrapper>
                } />
                <Route path="/student-fees" element={
                    <AuthWrapper allowedRoles={['student']}><StudentFees /></AuthWrapper>
                } />

                {/* Platform admin */}
                <Route path="/platformtower" element={
                    <AuthWrapper allowedRoles={['super-admin']}><PlatformDashboard /></AuthWrapper>
                } />
                <Route path="/platform-admin/schools" element={
                    <AuthWrapper allowedRoles={['super-admin']}><Schools /></AuthWrapper>
                } />
                <Route path="/platform-admin/schools/:schoolId" element={
                    <AuthWrapper allowedRoles={['super-admin']}><SchoolDetails /></AuthWrapper>
                } />
                <Route path="/platform-admin/users" element={
                    <AuthWrapper allowedRoles={['super-admin']}><PlatformUsers /></AuthWrapper>
                } />
                <Route path="/platform-admin/settings" element={
                    <AuthWrapper allowedRoles={['super-admin']}><PlatformSettings /></AuthWrapper>
                } />
                <Route path="/platform-admin/exit" element={
                    <AuthWrapper allowedRoles={['super-admin']}><Exit /></AuthWrapper>
                } />

                {/* Fallback */}
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
        </Suspense>
    );
}

function App() {
    return (
        <ErrorBoundary>
            {/* 1. SyncProvider must be outermost — AuthProvider calls useSync() */}
            <SyncProvider>
                {/* 2. AuthProvider exposes user/role/schoolId for everything below */}
                <AuthProvider>
                    {/* 3. SchoolProvider reads useAuth().userData.schoolId */}
                    <SchoolProvider>
                        {/* 4. BadgeProvider — verify it uses useAuth or useSync */}
                        <BadgeProvider>
                            {/* 5. NotificationProvider — same */}
                            <NotificationProvider>
                                {/* 6. FeeProvider reads useAuth + useSync */}
                                <FeeProvider>
                                    <AppRoutes />
                                </FeeProvider>
                            </NotificationProvider>
                        </BadgeProvider>
                    </SchoolProvider>
                </AuthProvider>
            </SyncProvider>
        </ErrorBoundary>
    );
}

export default App;
