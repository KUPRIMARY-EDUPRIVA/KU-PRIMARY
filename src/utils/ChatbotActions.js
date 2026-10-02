// src/components/Common/EduprivaChatbot.jsx
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../context/AuthContext';
import {
    findStudentByAdmissionNumber,
    triggerSTKPush,
    fetchFeeBalance,
    fetchDailyCollections,
    fetchSchoolInfo,
    fetchPerformance,
} from '../../utils/ChatbotActions';

/* ============================================================
   Role helpers
   ============================================================ */

const ADMIN_ROLES = new Set(['admin', 'school_admin', 'super-admin', 'platform_admin', 'user']);

function deriveRole(userData, userRole, currentUser) {
    if (userRole) return userRole;
    if (userData?.role) return userData.role;
    if (currentUser?.email?.includes('admin')) return 'admin';
    return 'user';
}

function firstNameOf(userData, currentUser) {
    const f = userData?.firstName
        || (userData?.fullName || '').split(' ')[0]
        || (currentUser?.displayName || '').split(' ')[0]
        || (currentUser?.email || '').split('@')[0]
        || 'there';
    return f;
}

/* ============================================================
   Keyword intent detection (runs against the whole sentence)
   ============================================================ */

/**
 * Returns true if any of the `patterns` appears as a whole-word-ish
 * match inside the lowercased query. This is deliberately liberal —
 * we strip punctuation and check substring for word stems.
 */
function containsAny(q, patterns) {
    for (const p of patterns) {
        if (q.includes(p)) return true;
    }
    return false;
}

function detectIntent(raw) {
    const q = ` ${String(raw || '').toLowerCase().replace(/[^\w\s/?+-]/g, ' ')} `;

    // Balance / fees
    if (containsAny(q, [' fee balance', ' check balance', ' balance for ', 'fee balance of', 'outstanding', 'how much does', 'how much is', 'arrears', 'owed'])) {
        return 'check_balance';
    }
    if (containsAny(q, ['pay fee', 'pay school fee', 'pay the fee', 'stk push', 'pay fees', 'make payment', 'send money', 'mpesa payment', 'm-pesa payment'])) {
        return 'pay_fee';
    }

    // School info
    if (containsAny(q, ['school name', 'name of the school', 'what is the school called', 'whats the school called', 'name of school'])) {
        return 'school_name';
    }
    if (containsAny(q, ['what classes', 'which classes', 'list classes', 'classes do we have', 'classes offered', 'available classes', 'class list'])) {
        return 'school_classes';
    }
    if (containsAny(q, ['what subjects', 'which subjects', 'list subjects', 'subjects offered', 'subjects do we teach', 'curriculum subjects', 'subject list'])) {
        return 'school_subjects';
    }
    if (containsAny(q, ['how many teachers', 'number of teachers', 'teachers do we have', 'count teachers', 'staff strength'])) {
        return 'school_teachers';
    }
    if (containsAny(q, ['school motto', 'the motto', 'our motto'])) {
        return 'school_motto';
    }
    if (containsAny(q, ['school phone', 'phone number', 'contact us', 'school contact', 'school email', 'school address', 'where is the school', 'school code', 'school website'])) {
        return 'school_contact';
    }
    if (containsAny(q, ['what level', 'which levels', 'levels does', 'levels offered', 'grade levels'])) {
        return 'school_levels';
    }
    if (containsAny(q, ['tell me about the school', 'about the school', 'overview of the school', 'describe the school', 'school overview'])) {
        return 'school_overview';
    }

    // Performance
    if (containsAny(q, ['best student', 'top student', 'highest performer', 'top performer', 'who is the best'])) {
        return 'performance_top';
    }
    if (containsAny(q, ['performance', 'how did we perform', 'how is the class performing', 'results', 'mean score', 'average score', 'class average', 'how are the students doing'])) {
        return 'performance_overview';
    }

    // Reports (admin only)
    if (containsAny(q, ['fee report', 'fee reports', 'daily collection', 'collections today', 'collected today', 'how much did we collect', 'revenue report', 'report today'])) {
        return 'daily_report';
    }

    // Help / greeting
    if (containsAny(q, ['help', 'menu', 'what can you do', 'options'])) return 'help';
    if (/^\s*(hi|hello|hey|good (morning|afternoon|evening)|habari|jambo)\b/.test(q.trim())) return 'greeting';

    // Pricing / support
    if (containsAny(q, ['pricing', 'subscription', 'system cost', 'system fee', 'how much is edupriva', 'cost of the system'])) {
        return 'pricing';
    }
    if (containsAny(q, ['support', 'contact support', 'talk to a human', 'help me with the system', 'engineer', 'whatsapp support'])) {
        return 'support';
    }

    return 'unknown';
}

/* ============================================================
   Component
   ============================================================ */

export default function EduprivaChatbot({ onClose }) {
    const { currentUser, userData, userRole } = useAuth();
    const schoolId = userData?.schoolId;

    const role = deriveRole(userData, userRole, currentUser);
    const isAdmin = ADMIN_ROLES.has(role);
    const isTeacher = role === 'teacher';
    const myFirst = firstNameOf(userData, currentUser);

    const [isOpen, setIsOpen] = useState(false);
    const [input, setInput] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [botState, setBotState] = useState({ step: 'IDLE', context: {} });
    const messagesEndRef = useRef(null);

    const greeting = useMemo(() => ({
        sender: 'bot',
        text: `Hello ${myFirst}! I'm LABAN, your school assistant. Ask me anything — school info, fees, performance, or type "help" to see what I can do.`,
        time: nowTime(),
    }), [myFirst]);

    const [messages, setMessages] = useState([greeting]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };
    useEffect(() => { if (isOpen) scrollToBottom(); }, [messages, isOpen]);

    const pushBot = useCallback((text, action) => {
        setMessages((prev) => [...prev, {
            sender: 'bot',
            text,
            action,
            time: nowTime(),
        }]);
    }, []);

    const pushUser = useCallback((text) => {
        setMessages((prev) => [...prev, {
            sender: 'user',
            text,
            time: nowTime(),
        }]);
    }, []);

    const handleSend = async (e) => {
        e.preventDefault();
        const text = input.trim();
        if (!text || isProcessing) return;

        pushUser(text);
        setInput('');
        setIsProcessing(true);

        try {
            await processInput(text);
        } catch (error) {
            pushBot(error.message || 'Sorry, something went wrong. Please try again.');
        } finally {
            setIsProcessing(false);
        }
    };

    /* ========================================================
       State machine
       ======================================================== */

    const processInput = async (text) => {
        // If a state is active, handle it first.
        if (botState.step !== 'IDLE') {
            await handleStateInput(text);
            return;
        }
        await routeIntent(text);
    };

    const handleStateInput = async (text) => {
        const { step, context } = botState;

        if (step === 'AWAITING_PHONE') {
            const phone = text.replace(/[\s-]/g, '');
            if (!/^(?:(?:\+?254)|0)?[17]\d{8}$/.test(phone)) {
                pushBot(`That doesn't look like a valid Kenyan mobile number, ${myFirst}. Try again — e.g. 0712345678.`);
                return;
            }
            setBotState({ step: 'AWAITING_AMOUNT', context: { ...context, phone } });
            pushBot(`Got it, ${myFirst}. Now enter the amount to pay in KES (a whole number greater than 10):`);
            return;
        }

        if (step === 'AWAITING_AMOUNT') {
            const amount = Number(text);
            if (!/^\d+$/.test(text) || !Number.isSafeInteger(amount) || amount <= 10) {
                pushBot(`Please enter a whole number greater than KES 10, ${myFirst}.`);
                return;
            }
            setBotState({ step: 'AWAITING_ADM', context: { ...context, amount } });
            pushBot(`Great. What is the student's admission number?`);
            return;
        }

        if (step === 'AWAITING_ADM') {
            const admissionNumber = text.trim();
            if (!/^[A-Za-z0-9][A-Za-z0-9/-]{0,39}$/.test(admissionNumber)) {
                pushBot(`That admission number doesn't look right, ${myFirst}. Use letters, digits, hyphen, or slash.`);
                return;
            }
            const student = await findStudentByAdmission
