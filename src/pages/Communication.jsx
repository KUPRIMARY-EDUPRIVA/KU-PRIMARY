// src/pages/Communication.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { db } from '../firebase';
import {
    collection, query, where, getDocs, onSnapshot, doc, getDoc,
    updateDoc, deleteDoc, addDoc, orderBy, serverTimestamp,
    setDoc
} from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { AuditLogService } from '../services/auditService';
import { LEVEL_DISPLAY_NAMES } from '../utils/constants';

// ============================================================
// Constants
// ============================================================
const MESSAGE_TYPES = {
    results: 'Results Notification',
    meeting: 'Meeting Invitation',
    fee_reminder: 'Fee Reminder',
    general: 'General Announcement',
    emergency: 'Emergency Alert',
    custom: 'Custom Message'
};

const MESSAGE_PRIORITY = {
    normal: 'Normal',
    high: 'High',
    urgent: 'Urgent'
};

const DELIVERY_STATUS = {
    pending: 'Pending',
    sent: 'Sent',
    delivered: 'Delivered',
    partial: 'Partial',
    failed: 'Failed'
};

const RECIPIENT_TYPES = {
    all_parents: 'All Parents / Guardians',
    all_students: 'All Students',
    all_teachers: 'All Teachers',
    specific_students: 'Specific Students',
    specific_classes: 'Specific Classes',
    specific_levels: 'Specific Levels',
    specific_teachers: 'Specific Teachers',
    teachers_by_level: 'Teachers by Level',
    teachers_by_subject: 'Teachers by Subject',
    individual: 'Custom Phone Numbers'
};

// Environment where SMS is being sent from
const SEND_ENV = {
    AUTO: 'auto',
    MOBILE: 'mobile',
    DESKTOP: 'desktop'
};

// Two SMS transports:
//   - 'gateway'  → HTTP request to a URL (used on mobile / when a remote
//                  SMS gateway is configured; the old behaviour)
//   - 'modem'    → POST to /api/send-sms-modem, which drives an attached
//                  GSM modem on the server (desktop / office PC)
const SMS_TRANSPORT = {
    GATEWAY: 'gateway',
    MODEM: 'modem'
};

const SMS_PART_LENGTH = 160;
const SMS_BATCH_SIZE = 30; // recipients per server request

// ============================================================
// Environment detection
// ============================================================
function detectEnvironment() {
    if (typeof navigator === 'undefined') return SEND_ENV.DESKTOP;
    const ua = navigator.userAgent || '';
    const isMobileUA = /Android|iPhone|iPad|iPod|Mobile|Windows Phone|BlackBerry|Opera Mini/i.test(ua);
    // iPad on iPadOS reports as Mac. Fallback to touch count.
    const isTouchTablet = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
    if (isMobileUA || isTouchTablet) return SEND_ENV.MOBILE;
    return SEND_ENV.DESKTOP;
}

// ============================================================
// Component
// ============================================================
export default function Communication() {
    const navigate = useNavigate();
    const { currentUser, userData, userRole } = useAuth();
    const { isOnline, saveToIndexedDB, getFromIndexedDB, addToSyncQueue } = useSync();

    // ---------- UI state ----------
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('compose');
    const [showModal, setShowModal] = useState(false);
    const [modalType, setModalType] = useState('');
    const [selectedMessage, setSelectedMessage] = useState(null);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deleteItem, setDeleteItem] = useState(null);

    // ---------- Data ----------
    const [students, setStudents] = useState([]);
    const [teachers, setTeachers] = useState([]);
    const [messages, setMessages] = useState([]);
    const [templates, setTemplates] = useState([]);
    const [gatewayStatus, setGatewayStatus] = useState('disconnected');
    const [phoneBalance, setPhoneBalance] = useState(0);
    const [smsCount, setSmsCount] = useState(0);
    const [sending, setSending] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, ok: 0, failed: 0 });

    // ---------- Modem status (for desktop) ----------
    const [modemStatus, setModemStatus] = useState({
        available: false,
        port: '',
        signal: 0,
        checked: false
    });

    // ---------- Filters ----------
    const [searchTerm, setSearchTerm] = useState('');
    const [filterType, setFilterType] = useState('');
    const [filterStatus, setFilterStatus] = useState('');
    const [filterDate, setFilterDate] = useState('');

    // ---------- Environment + transport ----------
    const [sendEnv, setSendEnv] = useState(SEND_ENV.AUTO); // user override
    const detectedEnv = useRef(detectEnvironment());
    const effectiveEnv = sendEnv === SEND_ENV.AUTO ? detectedEnv.current : sendEnv;

    // Pick transport: desktop → modem, mobile → gateway.
    // If user manually chose an env, respect it.
    const transport =
        effectiveEnv === SEND_ENV.DESKTOP ? SMS_TRANSPORT.MODEM : SMS_TRANSPORT.GATEWAY;

    // ---------- Forms ----------
    const [messageForm, setMessageForm] = useState({
        type: 'general',
        priority: 'normal',
        recipientType: 'all_parents',
        subject: '',
        message: '',
        scheduledDate: '',
        scheduledTime: '',
        attachResults: false,
        attachFeeStatement: false,
        selectedClass: '',
        selectedLevel: '',
        selectedSubject: '',
        studentIds: [],
        teacherIds: [],
        customNumbers: ''
    });

    const [templateForm, setTemplateForm] = useState({
        name: '',
        type: 'general',
        subject: '',
        message: ''
    });

    const [gatewayForm, setGatewayForm] = useState({
        apiUrl: '',
        apiKey: '',
        deviceId: '',
        phoneNumber: '',
        defaultSender: '',
        enabled: true
    });

    // ---------- Stats ----------
    const [stats, setStats] = useState({
        totalSent: 0,
        totalDelivered: 0,
        totalFailed: 0,
        pendingMessages: 0,
        sentToday: 0
    });

    // ---------- Refs ----------
    const unsubscribeRef = useRef(null);

    // ============================================================
    // Role
    // ============================================================
    const isAdmin = userRole === 'admin' || userRole === 'user' || userRole === 'school_admin' || userRole === 'super-admin';
    const isSuperAdmin = userRole === 'super-admin';

    // ============================================================
    // Bootstrap
    // ============================================================
    useEffect(() => {
        if (currentUser && userData) {
            loadData();
            loadGatewayStatus();
            if (detectedEnv.current === SEND_ENV.DESKTOP) {
                checkModemStatus();
            }
        }
        return () => {
            if (unsubscribeRef.current) unsubscribeRef.current();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUser, userData, isOnline]);

    const loadData = async () => {
        setLoading(true);
        try {
            const schoolId = userData?.schoolId || 'default_school';
            const [studentsData, teachersData, messagesData, templatesData] = await Promise.all([
                loadCollection('students', schoolId),
                loadCollection('teachers', schoolId),
                loadCollection('communications', schoolId),
                loadCollection('message_templates', schoolId)
            ]);
            setStudents(studentsData);
            setTeachers(teachersData);
            setMessages(messagesData);
            setTemplates(templatesData);
            calculateStats(messagesData);
            setLoading(false);
            if (isOnline) setupRealtimeListeners(schoolId);
        } catch (error) {
            console.error('Error loading communication data:', error);
            showNotification('Failed to load data', 'error');
            setLoading(false);
        }
    };

    const loadCollection = async (collectionName, schoolId) => {
        try {
            const cached = await getFromIndexedDB(`comm_${collectionName}`);
            if (cached && cached.length > 0) return cached;
            if (isOnline) {
                const q = query(
                    collection(db, collectionName),
                    where('schoolId', '==', schoolId),
                    orderBy('createdAt', 'desc')
                );
                const snapshot = await getDocs(q);
                const data = [];
                snapshot.forEach(d => data.push({ id: d.id, ...d.data() }));
                await saveToIndexedDB(`comm_${collectionName}`, data);
                return data;
            }
            return [];
        } catch (error) {
            console.error(`Error loading ${collectionName}:`, error);
            return [];
        }
    };

    const setupRealtimeListeners = (schoolId) => {
        const collections = ['communications', 'message_templates'];
        collections.forEach(collectionName => {
            const q = query(
                collection(db, collectionName),
                where('schoolId', '==', schoolId),
                orderBy('createdAt', 'desc')
            );
            const unsubscribe = onSnapshot(q, async (snapshot) => {
                const data = [];
                snapshot.forEach(d => data.push({ id: d.id, ...d.data() }));
                if (collectionName === 'communications') {
                    setMessages(data);
                    calculateStats(data);
                } else if (collectionName === 'message_templates') {
                    setTemplates(data);
                }
                await saveToIndexedDB(`comm_${collectionName}`, data);
            }, (error) => {
                console.error(`Listener error for ${collectionName}:`, error);
            });
            if (!unsubscribeRef.current) unsubscribeRef.current = unsubscribe;
        });
    };

    const loadGatewayStatus = async () => {
        try {
            const schoolId = userData?.schoolId || 'default_school';
            const gatewayDoc = await getDoc(doc(db, 'sms_gateway', schoolId));
            if (gatewayDoc.exists()) {
                const data = gatewayDoc.data();
                setGatewayStatus(data.status || 'disconnected');
                setPhoneBalance(data.balance || 0);
                setGatewayForm({
                    apiUrl: data.apiUrl || '',
                    apiKey: data.apiKey || '',
                    deviceId: data.deviceId || '',
                    phoneNumber: data.phoneNumber || '',
                    defaultSender: data.defaultSender || '',
                    enabled: data.enabled !== false
                });
            }
        } catch (error) {
            console.error('Error loading gateway status:', error);
        }
    };

    // ---------- Modem status check (desktop only) ----------
    const checkModemStatus = async () => {
        try {
            const res = await fetch('/api/send-sms-modem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'status' })
            });
            const data = await res.json();
            setModemStatus({
                available: !!data.connected,
                port: data.port || '',
                signal: data.signal || 0,
                checked: true
            });
        } catch (e) {
            setModemStatus({ available: false, port: '', signal: 0, checked: true });
        }
    };

    const calculateStats = (messagesData) => {
        const totalSent = messagesData.filter(m => m.status === 'sent' || m.status === 'delivered').length;
        const totalDelivered = messagesData.filter(m => m.status === 'delivered').length;
        const totalFailed = messagesData.filter(m => m.status === 'failed').length;
        const pendingMessages = messagesData.filter(m => m.status === 'pending').length;
        const today = new Date().toISOString().split('T')[0];
        const sentToday = messagesData.filter(m =>
            (m.status === 'sent' || m.status === 'delivered') &&
            m.sentAt?.toDate?.()?.toISOString().split('T')[0] === today
        ).length;
        setStats({ totalSent, totalDelivered, totalFailed, pendingMessages, sentToday });
    };

    // ============================================================
    // Recipient resolution
    // ============================================================

    const normalisePhone = (raw) => {
        if (!raw) return '';
        const digits = String(raw).replace(/\D/g, '');
        if (!digits) return '';
        if (digits.startsWith('254')) return digits;
        if (digits.startsWith('0')) return '254' + digits.slice(1);
        if (digits.length === 9) return '254' + digits;
        return digits;
    };

    /** Teacher phone numbers: `phone` on the teachers/{id} doc (see Teachers.jsx). */
    const getTeacherPhone = (t) => {
        return normalisePhone(t?.phone || t?.phoneNumber || '');
    };

    /** Student/parent phone numbers: parentPhone, guardianPhone, phone. */
    const getStudentParentPhones = (s) => {
        return [s?.parentPhone, s?.guardianPhone, s?.phone]
            .map(normalisePhone)
            .filter(Boolean);
    };

    const resolveRecipients = () => {
        const recipients = new Set();

        switch (messageForm.recipientType) {
            case 'all_students': {
                students.forEach(s => {
                    const p = normalisePhone(s.phone);
                    if (p) recipients.add(p);
                });
                break;
            }
            case 'all_parents': {
                students.forEach(s => {
                    getStudentParentPhones(s).forEach(p => recipients.add(p));
                });
                break;
            }
            case 'all_teachers': {
                teachers.forEach(t => {
                    const p = getTeacherPhone(t);
                    if (p) recipients.add(p);
                });
                break;
            }
            case 'specific_students': {
                students
                    .filter(s => messageForm.studentIds.includes(s.id))
                    .forEach(s => getStudentParentPhones(s).forEach(p => recipients.add(p)));
                break;
            }
            case 'specific_classes': {
                students
                    .filter(s => s.class === messageForm.selectedClass)
                    .forEach(s => getStudentParentPhones(s).forEach(p => recipients.add(p)));
                break;
            }
            case 'specific_levels': {
                students
                    .filter(s => s.level === messageForm.selectedLevel)
                    .forEach(s => getStudentParentPhones(s).forEach(p => recipients.add(p)));
                break;
            }
            case 'specific_teachers': {
                teachers
                    .filter(t => messageForm.teacherIds.includes(t.id))
                    .forEach(t => {
                        const p = getTeacherPhone(t);
                        if (p) recipients.add(p);
                    });
                break;
            }
            case 'teachers_by_level': {
                teachers.forEach(t => {
                    const levels = Array.isArray(t.levels) ? t.levels : (t.level ? [t.level] : []);
                    if (levels.includes(messageForm.selectedLevel)) {
                        const p = getTeacherPhone(t);
                        if (p) recipients.add(p);
                    }
                });
                break;
            }
            case 'teachers_by_subject': {
                teachers.forEach(t => {
                    const subs = Array.isArray(t.subjects)
                        ? t.subjects
                        : (typeof t.subjects === 'string'
                            ? t.subjects.split(',').map(x => x.trim())
                            : []);
                    if (subs.includes(messageForm.selectedSubject)) {
                        const p = getTeacherPhone(t);
                        if (p) recipients.add(p);
                    }
                });
                break;
            }
            case 'individual': {
                if (messageForm.customNumbers) {
                    messageForm.customNumbers
                        .split(/[\s,;]+/)
                        .map(normalisePhone)
                        .filter(Boolean)
                        .forEach(p => recipients.add(p));
                }
                break;
            }
            default:
                break;
        }

        return [...recipients];
    };

    // ============================================================
    // Send pipeline
    // ============================================================

    /**
     * Send a single batch to the modem endpoint.
     * Returns { sent, failed, results }.
     */
    const sendBatchViaModem = async (numbers, message, subject) => {
        const res = await fetch('/api/send-sms-modem', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'send',
                numbers,
                message,
                subject,
                schoolId: userData?.schoolId || '',
                sender: gatewayForm.defaultSender || ''
            })
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Modem endpoint ${res.status}: ${text || 'unknown'}`);
        }
        return res.json();
    };

    /**
     * Send a single batch via the configured HTTP SMS gateway
     * (the previous mobile-first behaviour).
     */
    const sendBatchViaGateway = async (numbers, message, subject) => {
        const endpoint = gatewayForm.apiUrl || '/.netlify/functions/send-sms';
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(gatewayForm.apiKey ? { Authorization: `Bearer ${gatewayForm.apiKey}` } : {})
            },
            body: JSON.stringify({
                numbers,
                phoneNumber: numbers[0],
                message,
                subject,
                deviceId: gatewayForm.deviceId,
                sender: gatewayForm.defaultSender,
                priority: 'normal'
            })
        });
        const result = await res.json().catch(() => ({ success: false }));
        return result;
    };

    const sendBulkSMS = async (numbers, message, subject, type) => {
        setSending(true);
        setProgress({ current: 0, total: numbers.length, ok: 0, failed: 0 });

        const usingModem = transport === SMS_TRANSPORT.MODEM;
        const results = [];
        let successCount = 0;
        let failCount = 0;
        const messageId = `msg_${Date.now()}`;

        // If modem is not reachable, do not proceed.
        if (usingModem && !modemStatus.available) {
            setSending(false);
            throw new Error(
                'Modem not detected. Connect a GSM modem / USB dongle and refresh the modem status.'
            );
        }

        const batches = [];
        for (let i = 0; i < numbers.length; i += SMS_BATCH_SIZE) {
            batches.push(numbers.slice(i, i + SMS_BATCH_SIZE));
        }

        for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            try {
                let batchResult;
                if (usingModem) {
                    batchResult = await sendBatchViaModem(batch, message, subject);
                } else {
                    batchResult = await sendBatchViaGateway(batch, message, subject);
                }

                // Normalise: accept { results: [...] } or { sent, failed } or { success }
                const perRecipient = Array.isArray(batchResult?.results)
                    ? batchResult.results
                    : null;

                if (perRecipient) {
                    perRecipient.forEach(r => {
                        if (r.success) { successCount++; results.push({ number: r.number || r.phoneNumber, success: true }); }
                        else { failCount++; results.push({ number: r.number || r.phoneNumber, success: false, error: r.error }); }
                    });
                } else {
                    // Treat the whole batch as one result.
                    const ok = batchResult?.success !== false && (batchResult?.sent ?? batch.length) > 0;
                    if (ok) {
                        successCount += batch.length;
                        batch.forEach(n => results.push({ number: n, success: true }));
                    } else {
                        failCount += batch.length;
                        batch.forEach(n => results.push({ number: n, success: false, error: batchResult?.error }));
                    }
                }
            } catch (err) {
                failCount += batch.length;
                batch.forEach(n => results.push({ number: n, success: false, error: err.message }));
            }

            setProgress(prev => ({
                ...prev,
                current: Math.min(prev.current + batch.length, numbers.length),
                ok: successCount,
                failed: failCount
            }));

            // Modem USB sticks throttle hard; small gap between batches.
            if (bi < batches.length - 1) {
                await new Promise(r => setTimeout(r, usingModem ? 1500 : 800));
            }
        }

        await saveMessageRecord({
            subject, message, type,
            recipients: numbers.length,
            sent: successCount,
            failed: failCount,
            results,
            messageId,
            transport: usingModem ? 'modem' : 'gateway',
            environment: effectiveEnv
        });

        setSending(false);
        return { success: successCount, failed: failCount, total: numbers.length };
    };

    const saveMessageRecord = async (data) => {
        try {
            const record = {
                ...data,
                schoolId: userData?.schoolId || 'default_school',
                sentBy: currentUser?.uid,
                sentByName: userData?.fullName || userData?.firstName || 'System',
                sentAt: serverTimestamp(),
                status: data.failed > 0 ? (data.sent > 0 ? 'partial' : 'failed') : 'sent',
                createdAt: new Date().toISOString()
            };
            if (isOnline) {
                await addDoc(collection(db, 'communications'), record);
            } else {
                await addToSyncQueue('communications', 'add', record);
                const updated = [record, ...messages];
                setMessages(updated);
                await saveToIndexedDB('comm_communications', updated);
            }
            showNotification(
                `Message sent to ${data.sent} recipient${data.sent === 1 ? '' : 's'}${data.failed > 0 ? `, ${data.failed} failed` : ''}`,
                data.failed > 0 ? 'warning' : 'success'
            );
        } catch (error) {
            console.error('Error saving message record:', error);
        }
    };

    // ============================================================
    // Compose: submit handler
    // ============================================================

    const handleSendMessage = async () => {
        if (!messageForm.subject.trim()) {
            showNotification('Please enter a subject', 'warning');
            return;
        }
        if (!messageForm.message.trim()) {
            showNotification('Please enter a message', 'warning');
            return;
        }

        const recipients = resolveRecipients();
        if (recipients.length === 0) {
            showNotification('No recipients with valid phone numbers were found', 'warning');
            return;
        }

        // Transport readiness guards
        if (transport === SMS_TRANSPORT.MODEM && !modemStatus.available) {
            showNotification(
                'Modem not detected. Connect a GSM modem and refresh the modem status.',
                'error'
            );
            return;
        }
        if (transport === SMS_TRANSPORT.GATEWAY && gatewayStatus !== 'connected') {
            showNotification('SMS gateway is not connected. Check your configuration.', 'error');
            return;
        }

        let finalMessage = messageForm.message;
        if (messageForm.attachResults) finalMessage += '\n\n📊 Results attached. Check your email for details.';
        if (messageForm.attachFeeStatement) finalMessage += '\n💰 Fee statement attached. Please check your email.';

        const confirmSend = window.confirm(
            `Send via ${transport === SMS_TRANSPORT.MODEM ? 'attached MODEM' : 'SMS gateway'}?\n\n` +
            `Recipients: ${recipients.length}\n` +
            `Subject: ${messageForm.subject}\n\n` +
            `Message preview:\n${finalMessage.substring(0, 140)}${finalMessage.length > 140 ? '…' : ''}`
        );
        if (!confirmSend) return;

        try {
            const result = await sendBulkSMS(
                recipients,
                finalMessage,
                messageForm.subject,
                messageForm.type
            );

            // Audit
            try {
                await AuditLogService.logAction(
                    userData?.schoolId,
                    {
                        uid: currentUser?.uid,
                        fullName: userData?.fullName,
                        email: currentUser?.email,
                        role: userRole
                    },
                    'SMS_BULK_SENT',
                    {
                        entityId: `bulk-${Date.now()}`,
                        message: `Sent ${result.success} SMS via ${transport}. Failed: ${result.failed}.`,
                        recipients: recipients.length,
                        transport,
                        environment: effectiveEnv
                    }
                );
            } catch (e) { /* audit is best-effort */ }

            if (result.success > 0) {
                resetComposeForm();
            }
        } catch (error) {
            console.error('sendBulkSMS failed:', error);
            showNotification('Sending failed: ' + error.message, 'error');
        }
    };

    const resetComposeForm = () => {
        setMessageForm({
            type: 'general',
            priority: 'normal',
            recipientType: 'all_parents',
            subject: '',
            message: '',
            scheduledDate: '',
            scheduledTime: '',
            attachResults: false,
            attachFeeStatement: false,
            selectedClass: '',
            selectedLevel: '',
            selectedSubject: '',
            studentIds: [],
            teacherIds: [],
            customNumbers: ''
        });
        setSmsCount(0);
    };

    // ============================================================
    // Templates
    // ============================================================
    const handleSaveTemplate = async () => {
        if (!templateForm.name.trim() || !templateForm.message.trim()) {
            showNotification('Please fill in template name and message', 'warning');
            return;
        }
        try {
            const data = {
                ...templateForm,
                schoolId: userData?.schoolId || 'default_school',
                createdBy: currentUser?.uid,
                createdAt: new Date().toISOString()
            };
            if (isOnline) {
                await addDoc(collection(db, 'message_templates'), data);
            } else {
                await addToSyncQueue('message_templates', 'add', data);
                const updated = [data, ...templates];
                setTemplates(updated);
                await saveToIndexedDB('comm_message_templates', updated);
            }
            showNotification('Template saved successfully!', 'success');
            setShowModal(false);
            setTemplateForm({ name: '', type: 'general', subject: '', message: '' });
        } catch (error) {
            console.error('Error saving template:', error);
            showNotification('Failed to save template', 'error');
        }
    };

    const applyTemplate = (template) => {
        setMessageForm(prev => ({
            ...prev,
            subject: template.subject || prev.subject,
            message: template.message || prev.message,
            type: template.type || prev.type
        }));
        showNotification('Template applied!', 'success');
    };

    // ============================================================
    // Helpers for selects
    // ============================================================
    const getUniqueClasses = () => {
        const set = new Set();
        students.forEach(s => { if (s.class) set.add(s.class); });
        return [...set].sort();
    };
    const getUniqueLevels = () => {
        const set = new Set();
        students.forEach(s => { if (s.level) set.add(s.level); });
        teachers.forEach(t => {
            (Array.isArray(t.levels) ? t.levels : (t.level ? [t.level] : []))
                .forEach(l => l && set.add(l));
        });
        return [...set].sort();
    };
    const getUniqueSubjects = () => {
        const set = new Set();
        teachers.forEach(t => {
            const subs = Array.isArray(t.subjects)
                ? t.subjects
                : (typeof t.subjects === 'string'
                    ? t.subjects.split(',').map(x => x.trim())
                    : []);
            subs.filter(Boolean).forEach(s => set.add(s));
        });
        return [...set].sort();
    };

    const liveRecipientCount = () => resolveRecipients().length;

    // ============================================================
    // Tabs
    // ============================================================
    const getTabs = () => {
        const tabs = [
            { id: 'compose', label: 'Compose', icon: 'fa-pen' },
            { id: 'history', label: 'Message History', icon: 'fa-history' },
            { id: 'templates', label: 'Templates', icon: 'fa-file-alt' }
        ];
        if (isAdmin || isSuperAdmin) {
            tabs.push({ id: 'gateway', label: 'Gateway / Modem', icon: 'fa-cog' });
        }
        return tabs;
    };

    // ============================================================
    // Notification
    // ============================================================
    const showNotification = useCallback((message, type = 'info') => {
        const colors = { success: '#27ae60', error: '#e74c3c', warning: '#f39c12', info: '#3498db' };
        const icons = { success: 'check-circle', error: 'exclamation-circle', warning: 'exclamation-triangle', info: 'info-circle' };
        const el = document.createElement('div');
        el.className = 'custom-notification';
        el.style.backgroundColor = colors[type] || colors.info;
        el.innerHTML = `<i class="fas fa-${icons[type] || 'info-circle'}"></i><span>${message}</span>`;
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => el.parentNode && el.parentNode.removeChild(el), 300);
        }, 4000);
    }, []);

    // ============================================================
    // Renders
    // ============================================================

    const renderMessageHistory = () => (
        <div className="history-section">
            <div className="section-header"><h2>Message History</h2></div>

            <div className="filters-section">
                <input type="text" className="search-input" placeholder="Search messages..."
                    value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                <select className="filter-select" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                    <option value="">All Types</option>
                    {Object.entries(MESSAGE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <select className="filter-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                    <option value="">All Status</option>
                    {Object.entries(DELIVERY_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input type="date" className="filter-select" value={filterDate} onChange={(e) => setFilterDate(e.target.value)} />
            </div>

            <div className="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Subject</th>
                            <th>Type</th>
                            <th>Transport</th>
                            <th>Recipients</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {messages.filter(m => {
                            const matchSearch = (m.subject || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                                (m.message || '').toLowerCase().includes(searchTerm.toLowerCase());
                            const matchType = !filterType || m.type === filterType;
                            const matchStatus = !filterStatus || m.status === filterStatus;
                            const matchDate = !filterDate || m.sentAt?.toDate?.()?.toISOString().split('T')[0] === filterDate;
                            return matchSearch && matchType && matchStatus && matchDate;
                        }).map(message => (
                            <tr key={message.id}>
                                <td>{message.sentAt?.toDate?.()?.toLocaleDateString() || 'N/A'}</td>
                                <td>{message.subject || 'N/A'}</td>
                                <td>{MESSAGE_TYPES[message.type] || message.type}</td>
                                <td>
                                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: '#eef2ff', color: '#3730a3', fontWeight: 600 }}>
                                        {(message.transport || 'gateway').toUpperCase()}
                                    </span>
                                </td>
                                <td>{message.recipients || 0}</td>
                                <td>
                                    <span className={`status-badge ${message.status}`}>
                                        {DELIVERY_STATUS[message.status] || message.status}
                                    </span>
                                </td>
                                <td>
                                    <button className="btn btn-primary btn-sm" onClick={() => {
                                        setSelectedMessage(message); setModalType('view'); setShowModal(true);
                                    }}>
                                        <i className="fas fa-eye"></i>
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {messages.length === 0 && (
                            <tr><td colSpan="7">
                                <div className="empty-state">
                                    <i className="fas fa-envelope"></i>
                                    <p>No messages sent yet</p>
                                </div>
                            </td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );

    const renderTemplates = () => (
        <div className="templates-section">
            <div className="section-header">
                <h2>Message Templates</h2>
                <button className="btn btn-primary" onClick={() => {
                    setModalType('template');
                    setTemplateForm({ name: '', type: 'general', subject: '', message: '' });
                    setShowModal(true);
                }}>
                    <i className="fas fa-plus"></i> Add Template
                </button>
            </div>
            <div className="templates-grid">
                {templates.map(template => (
                    <div key={template.id} className="template-card">
                        <div className="template-header">
                            <h3>{template.name}</h3>
                            <span className="template-type">{MESSAGE_TYPES[template.type] || template.type}</span>
                        </div>
                        <div className="template-details">
                            <p><strong>Subject:</strong> {template.subject || 'N/A'}</p>
                            <p><strong>Message:</strong> {template.message?.substring(0, 100)}...</p>
                        </div>
                        <div className="template-actions">
                            <button className="btn btn-success btn-sm" onClick={() => applyTemplate(template)}>
                                <i className="fas fa-paste"></i> Apply
                            </button>
                            <button className="btn btn-danger btn-sm" onClick={() => {
                                setDeleteItem(template); setShowDeleteModal(true);
                            }}>
                                <i className="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                ))}
                {templates.length === 0 && (
                    <div className="empty-state" style={{ gridColumn: '1 / -1' }}>
                        <i className="fas fa-file-alt"></i>
                        <p>No templates created yet</p>
                    </div>
                )}
            </div>
        </div>
    );

    const renderGatewaySettings = () => (
        <div className="gateway-section">
            <div className="section-header"><h2>Gateway & Modem Settings</h2></div>

            {/* Live status row: gateway + modem */}
            <div className="gateway-status">
                <div className="status-card">
                    <div className="status-indicator">
                        <span className={`status-dot ${gatewayStatus}`}></span>
                        <span className="status-text">
                            HTTP Gateway: {gatewayStatus === 'connected' ? 'Connected' : 'Disconnected'}
                        </span>
                    </div>
                    <div className="status-detail">Balance: {phoneBalance} SMS</div>
                </div>
                <div className="status-card" style={{ marginTop: 12 }}>
                    <div className="status-indicator">
                        <span className={`status-dot ${modemStatus.available ? 'connected' : 'disconnected'}`}></span>
                        <span className="status-text">
                            USB / GSM Modem: {modemStatus.available ? `Connected (${modemStatus.port || 'port ok'})` : 'Not detected'}
                        </span>
                    </div>
                    <div className="status-detail">
                        {modemStatus.available && modemStatus.signal ? `Signal: ${modemStatus.signal}%` : '—'}
                        <button className="btn btn-outline btn-sm" style={{ marginLeft: 12 }}
                            onClick={checkModemStatus}>
                            <i className="fas fa-sync"></i> Refresh
                        </button>
                    </div>
                </div>
            </div>

            <div className="settings-form">
                <h3 style={{ fontSize: 15, marginBottom: 12, color: 'var(--secondary)' }}>
                    <i className="fas fa-phone"></i> Send Environment
                </h3>
                <div className="form-group">
                    <label>Transport preference</label>
                    <select
                        value={sendEnv}
                        onChange={(e) => setSendEnv(e.target.value)}
                    >
                        <option value={SEND_ENV.AUTO}>
                            Auto (mobile → SIM via gateway; desktop → USB / GSM modem)
                        </option>
                        <option value={SEND_ENV.MOBILE}>Force mobile (SIM / HTTP gateway)</option>
                        <option value={SEND_ENV.DESKTOP}>Force desktop (USB / GSM modem)</option>
                    </select>
                    <div className="help-text">
                        Detected environment: <strong>{detectedEnv.current}</strong>. Currently using:{' '}
                        <strong>{transport === SMS_TRANSPORT.MODEM ? 'MODEM' : 'GATEWAY'}</strong>.
                    </div>
                </div>

                <h3 style={{ fontSize: 15, margin: '24px 0 12px', color: 'var(--secondary)' }}>
                    <i className="fas fa-globe"></i> HTTP SMS Gateway
                </h3>
                <div className="form-group">
                    <label>API URL</label>
                    <input type="text" value={gatewayForm.apiUrl}
                        onChange={(e) => setGatewayForm({ ...gatewayForm, apiUrl: e.target.value })}
                        placeholder="http://your-gateway-ip:8080/api/sms" />
                    <div className="help-text">Leave blank to use the built-in /api/send-sms function</div>
                </div>
                <div className="form-group">
                    <label>API Key</label>
                    <input type="text" value={gatewayForm.apiKey}
                        onChange={(e) => setGatewayForm({ ...gatewayForm, apiKey: e.target.value })}
                        placeholder="Your API key" />
                </div>
                <div className="form-row">
                    <div className="form-group">
                        <label>Device ID</label>
                        <input type="text" value={gatewayForm.deviceId}
                            onChange={(e) => setGatewayForm({ ...gatewayForm, deviceId: e.target.value })} />
                    </div>
                    <div className="form-group">
                        <label>Phone Number</label>
                        <input type="text" value={gatewayForm.phoneNumber}
                            onChange={(e) => setGatewayForm({ ...gatewayForm, phoneNumber: e.target.value })} />
                    </div>
                </div>
                <div className="form-group">
                    <label>Default Sender Name</label>
                    <input type="text" value={gatewayForm.defaultSender}
                        onChange={(e) => setGatewayForm({ ...gatewayForm, defaultSender: e.target.value })}
                        placeholder="Your school name" />
                </div>
                <div className="form-group">
                    <label className="checkbox-label">
                        <input type="checkbox" checked={gatewayForm.enabled}
                            onChange={(e) => setGatewayForm({ ...gatewayForm, enabled: e.target.checked })} />
                        Enable HTTP Gateway
                    </label>
                </div>

                <button className="btn btn-primary" onClick={async () => {
                    try {
                        const data = {
                            ...gatewayForm,
                            sendEnv,
                            schoolId: userData?.schoolId || 'default_school',
                            updatedAt: new Date().toISOString()
                        };
                        await setDoc(
                            doc(db, 'sms_gateway', userData?.schoolId || 'default_school'),
                            data,
                            { merge: true }
                        );
                        showNotification('Settings saved!', 'success');
                        loadGatewayStatus();
                    } catch (error) {
                        console.error('Error saving gateway settings:', error);
                        showNotification('Failed to save settings', 'error');
                    }
                }}>
                    <i className="fas fa-save"></i> Save Settings
                </button>

                <h3 style={{ fontSize: 15, margin: '28px 0 12px', color: 'var(--secondary)' }}>
                    <i className="fas fa-plug"></i> USB / GSM Modem (Server-side)
                </h3>
                <div className="help-text" style={{ lineHeight: 1.6 }}>
                    The modem is driven by the serverless function <code>/api/send-sms-modem</code>.
                    It expects an environment variable <code>SMS_MODEM_PORT</code> (e.g.{' '}
                    <code>/dev/ttyUSB0</code> on Linux or <code>COM3</code> on Windows) to be set on
                    the Netlify site, plus a library such as <code>serialport</code> + a
                    modem-specific driver installed as a dependency.
                    <br /><br />
                    When a request comes in with <code>action: 'status'</code>, the function should
                    return <code>{'{ connected: true, port, signal }'}</code>.
                    When <code>action: 'send'</code>, it should accept <code>{'{ numbers: [...], message }'}</code>{' '}
                    and return <code>{'{ results: [{ number, success, error? }] }'}</code>.
                </div>
            </div>
        </div>
    );

    if (loading) return <LoadingSpinner fullScreen text="Loading communication data..." />;

    const recipientCount = liveRecipientCount();

    return (
        <Layout title="Communication">
            <style>{`
                .communication-container { padding: 0; }
                .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 20px; margin-bottom: 30px; }
                .stat-card { background: white; border-radius: 12px; padding: 20px; box-shadow: var(--shadow); transition: all 0.3s; }
                .stat-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); }
                .stat-card .stat-label { font-size: 13px; color: var(--gray); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
                .stat-card .stat-value { font-size: 28px; font-weight: 700; color: var(--secondary); margin-top: 5px; }
                .stat-card .stat-sub { font-size: 12px; color: var(--gray); margin-top: 5px; }
                .tabs-container { display: flex; gap: 5px; margin-bottom: 25px; background: white; padding: 5px; border-radius: 12px; box-shadow: var(--shadow); overflow-x: auto; flex-wrap: wrap; }
                .tab-btn { padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; transition: all 0.3s; background: transparent; color: var(--gray); white-space: nowrap; display: flex; align-items: center; gap: 8px; }
                .tab-btn:hover { background: var(--light); color: var(--secondary); }
                .tab-btn.active { background: var(--primary); color: white; }
                .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
                .section-header h2 { font-size: 18px; font-weight: 700; color: var(--secondary); }
                .filters-section { background: white; border-radius: 12px; padding: 15px; box-shadow: var(--shadow); margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 15px; align-items: center; }
                .search-input { flex: 1; min-width: 200px; padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; background: white; color: var(--secondary); }
                .filter-select { padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; background: white; cursor: pointer; min-width: 150px; color: var(--secondary); }
                .btn { padding: 10px 20px; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.3s; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
                .btn-primary { background: var(--primary); color: white; }
                .btn-success { background: var(--success); color: white; }
                .btn-danger { background: var(--danger); color: white; }
                .btn-outline { background: transparent; border: 2px solid var(--border); color: var(--secondary); }
                .btn-outline:hover { border-color: var(--primary); color: var(--primary); }
                .btn-sm { padding: 6px 12px; font-size: 12px; }
                .compose-section { background: white; border-radius: 12px; padding: 25px; box-shadow: var(--shadow); }
                .compose-section .form-group { margin-bottom: 20px; }
                .compose-section .form-group label { display: block; font-size: 14px; font-weight: 600; color: var(--secondary); margin-bottom: 5px; }
                .compose-section .form-group label .required { color: var(--danger); }
                .compose-section .form-group input, .compose-section .form-group select, .compose-section .form-group textarea { width: 100%; padding: 10px 15px; border: 2px solid var(--border); border-radius: 8px; font-size: 14px; background: white; color: var(--secondary); }
                .compose-section .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                .checkbox-group { display: flex; gap: 20px; flex-wrap: wrap; }
                .checkbox-group label { display: flex; align-items: center; gap: 8px; font-weight: 400; }
                .checkbox-group input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
                .recipient-counter { padding: 10px 15px; background: var(--light); border-radius: 8px; font-size: 14px; color: var(--secondary); }
                .recipient-counter strong { color: var(--primary); }
                .env-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
                .env-badge.modem { background: #dbeafe; color: #1e40af; }
                .env-badge.gateway { background: #dcfce7; color: #166534; }
                .student-select-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; max-height: 320px; overflow-y: auto; padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
                .student-select-item { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: 6px; cursor: pointer; transition: all 0.3s; }
                .student-select-item:hover { background: var(--light); }
                .student-select-item input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
                .progress-container { margin: 15px 0; padding: 15px; background: var(--light); border-radius: 8px; }
                .progress-bar { width: 100%; height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; }
                .progress-bar .progress-fill { height: 100%; background: var(--success); border-radius: 4px; transition: width 0.3s; }
                .progress-text { display: flex; justify-content: space-between; font-size: 13px; color: var(--gray); margin-top: 5px; }
                .table-container { background: white; border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
                table { width: 100%; border-collapse: collapse; }
                thead { background: var(--light); }
                th { padding: 12px 20px; text-align: left; font-size: 12px; font-weight: 600; color: var(--gray); text-transform: uppercase; letter-spacing: 0.5px; }
                td { padding: 12px 20px; border-bottom: 1px solid var(--border); font-size: 14px; }
                tr:hover { background: var(--light); }
                .status-badge { padding: 3px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
                .status-badge.sent, .status-badge.delivered { background: #d4edda; color: #155724; }
                .status-badge.pending { background: #fff3cd; color: #856404; }
                .status-badge.failed { background: #f8d7da; color: #721c24; }
                .status-badge.partial { background: #fff3cd; color: #856404; }
                .templates-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
                .template-card { background: white; border-radius: 12px; padding: 20px; box-shadow: var(--shadow); }
                .template-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
                .template-header h3 { font-size: 16px; font-weight: 600; color: var(--secondary); margin: 0; }
                .template-type { padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; background: var(--light); color: var(--gray); }
                .template-details { font-size: 13px; color: var(--gray); margin-bottom: 15px; }
                .template-actions { display: flex; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
                .gateway-status { background: white; border-radius: 12px; padding: 20px; box-shadow: var(--shadow); margin-bottom: 20px; }
                .status-card { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; }
                .status-indicator { display: flex; align-items: center; gap: 12px; }
                .status-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
                .status-dot.connected { background: #27ae60; }
                .status-dot.disconnected { background: #e74c3c; }
                .status-dot.connecting { background: #f39c12; }
                .status-text { font-weight: 600; color: var(--secondary); }
                .status-detail { font-size: 14px; color: var(--gray); display: flex; align-items: center; }
                .settings-form { background: white; border-radius: 12px; padding: 25px; box-shadow: var(--shadow); }
                .checkbox-label { display: flex; align-items: center; gap: 10px; cursor: pointer; }
                .checkbox-label input { width: 18px; height: 18px; cursor: pointer; }
                .empty-state { text-align: center; padding: 40px 20px; color: var(--gray); }
                .empty-state i { font-size: 48px; color: var(--border); margin-bottom: 15px; }
                .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); z-index: 1000; display: none; align-items: center; justify-content: center; padding: 20px; }
                .modal-overlay.active { display: flex; }
                .modal { background: white; border-radius: 16px; max-width: 700px; width: 100%; max-height: 90vh; overflow-y: auto; padding: 30px; }
                .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; }
                .modal-header h2 { font-size: 22px; color: var(--secondary); }
                .modal-close { width: 40px; height: 40px; border: none; border-radius: 50%; background: var(--light); cursor: pointer; font-size: 18px; }
                .modal-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 25px; padding-top: 20px; border-top: 1px solid var(--border); }
                .help-text { font-size: 12px; color: var(--gray); margin-top: 5px; }
                @media (max-width: 768px) {
                    .stats-grid { grid-template-columns: repeat(2, 1fr); }
                    .compose-section .form-row { grid-template-columns: 1fr; }
                    .filters-section { flex-direction: column; align-items: stretch; }
                    .search-input, .filter-select { width: 100%; }
                    .templates-grid { grid-template-columns: 1fr; }
                    .status-card { flex-direction: column; align-items: flex-start; }
                }
                @media (max-width: 480px) {
                    .stats-grid { grid-template-columns: 1fr; }
                    .checkbox-group { flex-direction: column; }
                }
                @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
                @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
                .custom-notification { position: fixed; top: 20px; right: 20px; padding: 15px 20px; border-radius: 8px; box-shadow: 0 5px 15px rgba(0,0,0,0.2); z-index: 10000; display: flex; align-items: center; gap: 10px; animation: slideIn 0.3s ease; max-width: 400px; color: white; font-family: 'Poppins', sans-serif; }
            `}</style>

            <div className="communication-container">
                {/* Stats */}
                <div className="stats-grid">
                    <div className="stat-card">
                        <div className="stat-label">Total Sent</div>
                        <div className="stat-value">{stats.totalSent}</div>
                        <div className="stat-sub">{stats.sentToday} Today</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Delivered</div>
                        <div className="stat-value" style={{ color: '#27ae60' }}>{stats.totalDelivered}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Failed</div>
                        <div className="stat-value" style={{ color: '#e74c3c' }}>{stats.totalFailed}</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-label">Pending</div>
                        <div className="stat-value" style={{ color: '#f39c12' }}>{stats.pendingMessages}</div>
                    </div>
                </div>

                {/* Tabs */}
                <div className="tabs-container">
                    {getTabs().map(tab => (
                        <button key={tab.id}
                            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}>
                            <i className={`fas ${tab.icon}`}></i>{tab.label}
                        </button>
                    ))}
                </div>

                {/* Compose Tab */}
                {activeTab === 'compose' && (
                    <div className="compose-section">
                        <div className="section-header">
                            <h2>Compose Message</h2>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span className={`env-badge ${transport === SMS_TRANSPORT.MODEM ? 'modem' : 'gateway'}`}>
                                    <i className="fas fa-${transport === SMS_TRANSPORT.MODEM ? 'plug' : 'mobile-alt'}"></i>
                                    {transport === SMS_TRANSPORT.MODEM ? 'Sending via USB / GSM Modem' : 'Sending via SMS Gateway (SIM)'}
                                </span>
                                <div className="recipient-counter">
                                    <i className="fas fa-users"></i> Recipients: <strong>{recipientCount}</strong>
                                </div>
                            </div>
                        </div>

                        <div className="form-row">
                            <div className="form-group">
                                <label>Message Type <span className="required">*</span></label>
                                <select value={messageForm.type}
                                    onChange={(e) => setMessageForm({ ...messageForm, type: e.target.value })}>
                                    {Object.entries(MESSAGE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Priority</label>
                                <select value={messageForm.priority}
                                    onChange={(e) => setMessageForm({ ...messageForm, priority: e.target.value })}>
                                    {Object.entries(MESSAGE_PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </select>
                            </div>
                        </div>

                        {/* Recipient type */}
                        <div className="form-group">
                            <label>Recipient Type <span className="required">*</span></label>
                            <select value={messageForm.recipientType}
                                onChange={(e) => {
                                    const type = e.target.value;
                                    setMessageForm({
                                        ...messageForm,
                                        recipientType: type,
                                        studentIds: [],
                                        teacherIds: [],
                                        selectedClass: '',
                                        selectedLevel: '',
                                        selectedSubject: ''
                                    });
                                }}>
                                <optgroup label="Parents & Students">
                                    <option value="all_parents">All Parents / Guardians</option>
                                    <option value="all_students">All Students</option>
                                    <option value="specific_students">Specific Students</option>
                                    <option value="specific_classes">Specific Classes</option>
                                    <option value="specific_levels">Specific Levels</option>
                                </optgroup>
                                <optgroup label="Teachers">
                                    <option value="all_teachers">All Teachers</option>
                                    <option value="specific_teachers">Specific Teachers</option>
                                    <option value="teachers_by_level">Teachers by Level</option>
                                    <option value="teachers_by_subject">Teachers by Subject</option>
                                </optgroup>
                                <optgroup label="Custom">
                                    <option value="individual">Custom Phone Numbers</option>
                                </optgroup>
                            </select>
                        </div>

                        {/* Specific students picker */}
                        {messageForm.recipientType === 'specific_students' && (
                            <div className="form-group">
                                <label>Select Students</label>
                                <div className="student-select-grid">
                                    {students.map(s => (
                                        <label key={s.id} className="student-select-item">
                                            <input type="checkbox"
                                                checked={messageForm.studentIds.includes(s.id)}
                                                onChange={(e) => {
                                                    if (e.target.checked) {
                                                        setMessageForm({ ...messageForm, studentIds: [...messageForm.studentIds, s.id] });
                                                    } else {
                                                        setMessageForm({ ...messageForm, studentIds: messageForm.studentIds.filter(id => id !== s.id) });
                                                    }
                                                }} />
                                            {s.firstName} {s.lastName} — {s.class || 'N/A'}
                                        </label>
                                    ))}
                                </div>
                                <div className="help-text">Selected: {messageForm.studentIds.length} student(s)</div>
                            </div>
                        )}

                        {/* Specific teachers picker */}
                        {messageForm.recipientType === 'specific_teachers' && (
                            <div className="form-group">
                                <label>Select Teachers</label>
                                <div className="student-select-grid">
                                    {teachers.map(t => {
                                        const phone = getTeacherPhone(t);
                                        const missing = !phone;
                                        return (
                                            <label key={t.id} className="student-select-item" style={{ opacity: missing ? 0.5 : 1 }}>
                                                <input type="checkbox"
                                                    disabled={missing}
                                                    checked={messageForm.teacherIds.includes(t.id)}
                                                    onChange={(e) => {
                                                        if (e.target.checked) {
                                                            setMessageForm({ ...messageForm, teacherIds: [...messageForm.teacherIds, t.id] });
                                                        } else {
                                                            setMessageForm({ ...messageForm, teacherIds: messageForm.teacherIds.filter(id => id !== t.id) });
                                                        }
                                                    }} />
                                                {t.firstName} {t.lastName}
                                                {missing ? ' — (no phone)' : ` — ${phone}`}
                                            </label>
                                        );
                                    })}
                                </div>
                                <div className="help-text">
                                    Selected: {messageForm.teacherIds.length} teacher(s). Teachers without a phone
                                    number on their profile can't be selected.
                                </div>
                            </div>
                        )}

                        {/* Class picker */}
                        {messageForm.recipientType === 'specific_classes' && (
                            <div className="form-group">
                                <label>Select Class</label>
                                <select value={messageForm.selectedClass}
                                    onChange={(e) => setMessageForm({ ...messageForm, selectedClass: e.target.value })}>
                                    <option value="">Select Class</option>
                                    {getUniqueClasses().map(cls => <option key={cls} value={cls}>{cls}</option>)}
                                </select>
                            </div>
                        )}

                        {/* Level picker for students OR teachers */}
                        {(messageForm.recipientType === 'specific_levels' ||
                            messageForm.recipientType === 'teachers_by_level') && (
                            <div className="form-group">
                                <label>Select Level</label>
                                <select value={messageForm.selectedLevel}
                                    onChange={(e) => setMessageForm({ ...messageForm, selectedLevel: e.target.value })}>
                                    <option value="">Select Level</option>
                                    {getUniqueLevels().map(level => (
                                        <option key={level} value={level}>
                                            {LEVEL_DISPLAY_NAMES[level] || level}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Subject picker for teachers */}
                        {messageForm.recipientType === 'teachers_by_subject' && (
                            <div className="form-group">
                                <label>Select Subject</label>
                                <select value={messageForm.selectedSubject}
                                    onChange={(e) => setMessageForm({ ...messageForm, selectedSubject: e.target.value })}>
                                    <option value="">Select Subject</option>
                                    {getUniqueSubjects().map(sub => <option key={sub} value={sub}>{sub}</option>)}
                                </select>
                            </div>
                        )}

                        {/* Custom numbers */}
                        {messageForm.recipientType === 'individual' && (
                            <div className="form-group">
                                <label>Phone Numbers (comma / space separated)</label>
                                <textarea rows="3"
                                    value={messageForm.customNumbers}
                                    onChange={(e) => setMessageForm({ ...messageForm, customNumbers: e.target.value })}
                                    placeholder="0712345678, 0723456789, +254733123456" />
                                <div className="help-text">Numbers are normalised to +254 format automatically.</div>
                            </div>
                        )}

                        <div className="form-group">
                            <label>Subject <span className="required">*</span></label>
                            <input type="text" value={messageForm.subject}
                                onChange={(e) => setMessageForm({ ...messageForm, subject: e.target.value })}
                                placeholder="Message subject" />
                        </div>

                        <div className="form-group">
                            <label>Message <span className="required">*</span></label>
                            <textarea rows="6" value={messageForm.message}
                                onChange={(e) => {
                                    const text = e.target.value;
                                    setMessageForm({ ...messageForm, message: text });
                                    setSmsCount(Math.ceil(text.length / SMS_PART_LENGTH));
                                }}
                                placeholder="Type your message here..." />
                            <div style={{ fontSize: '12px', color: 'var(--gray)', marginTop: '5px' }}>
                                {messageForm.message.length} characters • {smsCount} SMS part(s)
                            </div>
                        </div>

                        <div className="form-group">
                            <label>Attachments</label>
                            <div className="checkbox-group">
                                <label>
                                    <input type="checkbox" checked={messageForm.attachResults}
                                        onChange={(e) => setMessageForm({ ...messageForm, attachResults: e.target.checked })} />
                                    Attach Results
                                </label>
                                <label>
                                    <input type="checkbox" checked={messageForm.attachFeeStatement}
                                        onChange={(e) => setMessageForm({ ...messageForm, attachFeeStatement: e.target.checked })} />
                                    Attach Fee Statement
                                </label>
                            </div>
                        </div>

                        <div className="form-row">
                            <div className="form-group">
                                <label>Schedule Date</label>
                                <input type="date" value={messageForm.scheduledDate}
                                    onChange={(e) => setMessageForm({ ...messageForm, scheduledDate: e.target.value })} />
                            </div>
                            <div className="form-group">
                                <label>Schedule Time</label>
                                <input type="time" value={messageForm.scheduledTime}
                                    onChange={(e) => setMessageForm({ ...messageForm, scheduledTime: e.target.value })} />
                            </div>
                        </div>

                        {sending && (
                            <div className="progress-container">
                                <div className="progress-bar">
                                    <div className="progress-fill"
                                        style={{ width: `${(progress.current / Math.max(progress.total, 1)) * 100}%` }} />
                                </div>
                                <div className="progress-text">
                                    <span>
                                        Sending… {progress.current} of {progress.total}
                                        {progress.ok > 0 && ` • ✓ ${progress.ok}`}
                                        {progress.failed > 0 && ` • ✗ ${progress.failed}`}
                                    </span>
                                    <span>{Math.round((progress.current / Math.max(progress.total, 1)) * 100)}%</span>
                                </div>
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '20px' }}>
                            <button className="btn btn-success" onClick={handleSendMessage}
                                disabled={sending || recipientCount === 0 ||
                                    (transport === SMS_TRANSPORT.MODEM && !modemStatus.available) ||
                                    (transport === SMS_TRANSPORT.GATEWAY && gatewayStatus !== 'connected')}>
                                {sending ? (
                                    <><i className="fas fa-spinner fa-spin"></i> Sending…</>
                                ) : (
                                    <><i className="fas fa-paper-plane"></i> Send {recipientCount > 0 ? `(${recipientCount})` : ''}</>
                                )}
                            </button>
                            <button className="btn btn-outline" onClick={resetComposeForm}>
                                <i className="fas fa-undo"></i> Reset
                            </button>
                        </div>

                        {/* Transport readiness warnings */}
                        {transport === SMS_TRANSPORT.MODEM && !modemStatus.available && (
                            <div style={{ marginTop: 15, padding: '12px 16px', background: '#fef3c7', borderRadius: 8, border: '1px solid #fcd34d', color: '#92400e' }}>
                                <i className="fas fa-plug"></i>
                                <span style={{ marginLeft: 8 }}>
                                    No USB / GSM modem detected on this machine. Connect the modem and
                                    <button className="btn btn-outline btn-sm" style={{ marginLeft: 8 }} onClick={checkModemStatus}>
                                        <i className="fas fa-sync"></i> Refresh
                                    </button>
                                </span>
                            </div>
                        )}
                        {transport === SMS_TRANSPORT.GATEWAY && gatewayStatus !== 'connected' && (
                            <div style={{ marginTop: 15, padding: '12px 16px', background: '#fff3cd', borderRadius: 8, border: '1px solid #ffc107', color: '#856404' }}>
                                <i className="fas fa-exclamation-triangle"></i>
                                <span style={{ marginLeft: 8 }}>SMS gateway is not connected. Check the Gateway / Modem settings.</span>
                            </div>
                        )}
                    </div>
                )}

                {/* History */}
                {activeTab === 'history' && renderMessageHistory()}

                {/* Templates */}
                {activeTab === 'templates' && renderTemplates()}

                {/* Gateway / Modem */}
                {activeTab === 'gateway' && (isAdmin || isSuperAdmin) && renderGatewaySettings()}
            </div>

            {/* Template modal */}
            {showModal && modalType === 'template' && (
                <div className="modal-overlay active" onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
                    <div className="modal">
                        <div className="modal-header">
                            <h2>Save Template</h2>
                            <button className="modal-close" onClick={() => setShowModal(false)}><i className="fas fa-times"></i></button>
                        </div>
                        <form onSubmit={(e) => { e.preventDefault(); handleSaveTemplate(); }}>
                            <div className="form-group">
                                <label>Template Name <span className="required">*</span></label>
                                <input type="text" value={templateForm.name}
                                    onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })} required />
                            </div>
                            <div className="form-group">
                                <label>Type</label>
                                <select value={templateForm.type}
                                    onChange={(e) => setTemplateForm({ ...templateForm, type: e.target.value })}>
                                    {Object.entries(MESSAGE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Subject</label>
                                <input type="text" value={templateForm.subject}
                                    onChange={(e) => setTemplateForm({ ...templateForm, subject: e.target.value })} />
                            </div>
                            <div className="form-group">
                                <label>Message <span className="required">*</span></label>
                                <textarea rows="6" value={templateForm.message}
                                    onChange={(e) => setTemplateForm({ ...templateForm, message: e.target.value })} required />
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary">Save Template</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* View message modal */}
            {showModal && modalType === 'view' && selectedMessage && (
                <div className="modal-overlay active" onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
                    <div className="modal">
                        <div className="modal-header">
                            <h2>Message Details</h2>
                            <button className="modal-close" onClick={() => setShowModal(false)}><i className="fas fa-times"></i></button>
                        </div>
                        <div style={{ padding: '10px 0' }}>
                            <div><strong>Subject:</strong> {selectedMessage.subject || 'N/A'}</div>
                            <div style={{ marginTop: 10 }}><strong>Type:</strong> {MESSAGE_TYPES[selectedMessage.type] || selectedMessage.type}</div>
                            <div style={{ marginTop: 10 }}><strong>Transport:</strong> {(selectedMessage.transport || 'gateway').toUpperCase()}</div>
                            <div style={{ marginTop: 10 }}><strong>Recipients:</strong> {selectedMessage.recipients || 0}</div>
                            <div style={{ marginTop: 10 }}><strong>Status:</strong> {DELIVERY_STATUS[selectedMessage.status] || selectedMessage.status}</div>
                            <div style={{ marginTop: 10 }}><strong>Sent At:</strong> {selectedMessage.sentAt?.toDate?.()?.toLocaleString() || 'N/A'}</div>
                            {selectedMessage.message && (
                                <div style={{ marginTop: 10 }}>
                                    <strong>Message:</strong>
                                    <div style={{ marginTop: 5, padding: 10, background: 'var(--light)', borderRadius: 8, whiteSpace: 'pre-wrap' }}>
                                        {selectedMessage.message}
                                    </div>
                                </div>
                            )}
                            <div style={{ marginTop: 10 }}>
                                <strong>Delivery:</strong>
                                <div style={{ marginTop: 5, padding: 10, background: 'var(--light)', borderRadius: 8 }}>
                                    <div>Sent: {selectedMessage.sent || 0}</div>
                                    <div style={{ color: '#e74c3c' }}>Failed: {selectedMessage.failed || 0}</div>
                                </div>
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-outline" onClick={() => setShowModal(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete modal */}
            {showDeleteModal && deleteItem && (
                <div className="modal-overlay active" onClick={(e) => { if (e.target === e.currentTarget) setShowDeleteModal(false); }}>
                    <div className="modal" style={{ maxWidth: 450 }}>
                        <div className="modal-header">
                            <h2>Confirm Delete</h2>
                            <button className="modal-close" onClick={() => setShowDeleteModal(false)}><i className="fas fa-times"></i></button>
                        </div>
                        <div style={{ padding: '20px 0' }}>
                            <p style={{ marginBottom: 20 }}>Delete this template?</p>
                            <div className="modal-footer">
                                <button className="btn btn-outline" onClick={() => setShowDeleteModal(false)}>Cancel</button>
                                <button className="btn btn-danger" onClick={async () => {
                                    try {
                                        if (isOnline) {
                                            await deleteDoc(doc(db, 'message_templates', deleteItem.id));
                                        } else {
                                            await addToSyncQueue('message_templates', 'delete', { id: deleteItem.id });
                                        }
                                        const updated = templates.filter(t => t.id !== deleteItem.id);
                                        setTemplates(updated);
                                        await saveToIndexedDB('comm_message_templates', updated);
                                        showNotification('Template deleted successfully!', 'success');
                                        setShowDeleteModal(false);
                                        setDeleteItem(null);
                                    } catch (error) {
                                        console.error('Error deleting template:', error);
                                        showNotification('Failed to delete template', 'error');
                                    }
                                }}>
                                    <i className="fas fa-trash"></i> Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
