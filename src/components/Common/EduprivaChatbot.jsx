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
   Keyword intent detection
   ============================================================ */

function containsAny(q, patterns) {
    for (const p of patterns) {
        if (q.includes(p)) return true;
    }
    return false;
}

function normalise(raw) {
    return ` ${String(raw || '').toLowerCase().replace(/[^\w\s/?+.'-]/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

// Best-effort extraction of a class/grade name from free text.
// Recognises: Grade 7, Grade 8 East, PP1, PP2, Form 3, Form 4 West,
// Grade 10 North, and custom variants like "Grade 3 Hope".
function extractClassFromQuery(raw) {
    const q = String(raw || '');
    // Grade X with optional trailing word
    let m = q.match(/\b(Grade\s*\d+[A-Za-z]?(?:\s+[A-Z][a-z]+)?)/i);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
    // Form X with optional trailing word
    m = q.match(/\b(Form\s*\d+[A-Za-z]?(?:\s+[A-Z][a-z]+)?)/i);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
    // PP1 / PP2
    m = q.match(/\b(PP\s*\d+)\b/i);
    if (m) return m[1].replace(/\s+/g, '').toUpperCase();
    return null;
}

// Best-effort extraction of an admission number. Accepts digits,
// hyphenated, or slash-separated tokens that look like IDs.
function extractAdmissionNumber(raw) {
    const q = String(raw || '');
    // Slash or hyphen patterns first
    let m = q.match(/\b([A-Za-z]{0,4}[-\/]?\d{2,10})\b/);
    if (m && /\d/.test(m[1]) && m[1].length >= 3) return m[1];
    // Fallback: any 3+ digit number that isn't a year
    m = q.match(/\b(\d{3,10})\b/);
    if (m && !/^(19|20)\d{2}$/.test(m[1])) return m[1];
    return null;
}

function detectIntent(raw) {
    const q = normalise(raw);

    // --- Greeting / small talk (checked early) ---
    if (/^\s*(hi|hello|hey|hiya|yo|habari|jambo|mambo|sasa|niaje|good\s+(morning|afternoon|evening|day))\b/.test(q.trim())) {
        return 'greeting';
    }
    if (containsAny(q, [' thank', ' thanks', ' asante', ' cheers', ' nice one', ' great '])) return 'gratitude';
    if (containsAny(q, [' bye ', ' goodbye', ' kwaheri', ' see you', ' later ', ' goodnight'])) return 'goodbye';
    if (containsAny(q, [' who are you', ' what are you', ' what is laban', ' your name', ' about you'])) return 'about_bot';
    if (containsAny(q, [' my role', ' who am i', ' what am i', ' my account'])) return 'my_role';
    if (containsAny(q, [' help ', ' menu', ' what can you do', ' commands', ' options'])) return 'help';

    // --- Fees ---
    if (containsAny(q, [' pay fee', ' pay school fee', ' pay the fee', ' pay fees', ' mpesa', ' m-pesa', ' send money', ' stk push', ' make payment', ' lipa '])) {
        return 'pay_fee';
    }
    if (containsAny(q, [' fee balance', ' check balance', ' balance for ', ' outstanding', ' arrears', ' owed', ' owing', ' how much does', ' how much is '])) {
        // If it also asks about paying, prefer pay_fee (already handled above).
        return 'check_balance';
    }

    // --- School info (specific first, generic last) ---
    if (containsAny(q, [' school name', ' name of the school', ' what is the school called', " what's the school called", ' name of school', ' jina la shule'])) {
        return 'school_name';
    }
    if (containsAny(q, [' motto', ' slogan'])) return 'school_motto';
    if (containsAny(q, [' paybill', ' till number', ' shortcode'])) return 'school_paybill';
    if (containsAny(q, [' what classes', ' which classes', ' list classes', ' classes do we have', ' classes offered', ' available classes', ' class list', ' do we have grade'])) {
        return 'school_classes';
    }
    if (containsAny(q, [' what subjects', ' which subjects', ' list subjects', ' subjects offered', ' subjects do we teach', ' curriculum subjects', ' subject list'])) {
        return 'school_subjects';
    }
    if (containsAny(q, [' how many teachers', ' number of teachers', ' teachers do we have', ' count teachers', ' staff strength', ' how many staff'])) {
        return 'school_teachers';
    }
    if (containsAny(q, [' school phone', ' phone number', ' contact us', ' school contact', ' school email', ' school address', ' where is the school', ' school code', ' school website', ' location of the school'])) {
        return 'school_contact';
    }
    if (containsAny(q, [' what level', ' which levels', ' levels does', ' levels offered', ' grade levels'])) {
        return 'school_levels';
    }
    if (containsAny(q, [' tell me about the school', ' about the school', ' overview of the school', ' describe the school', ' school overview', ' give me an overview'])) {
        return 'school_overview';
    }

    // --- Performance ---
    // Class-specific query must come before the generic "performance" check.
    if (extractClassFromQuery(raw) && containsAny(q, [' performance', ' result', ' how is ', ' how did ', ' how are ', ' mean score', ' average', ' best in', ' top in'])) {
        return 'performance_class';
    }
    if (containsAny(q, [' best student', ' top student', ' highest performer', ' top performer', ' who is the best', ' best in ', ' top in '])) {
        return 'performance_top';
    }
    if (containsAny(q, [' performance', ' how did we perform', ' how is the class performing', ' results', ' mean score', ' average score', ' class average', ' how are the students doing'])) {
        return 'performance_overview';
    }

    // --- Reports (admin) ---
    if (containsAny(q, [' fee report', ' fee reports', ' daily collection', ' collections today', ' collected today', ' how much did we collect', ' revenue report', ' revenue today', ' report today'])) {
        return 'daily_report';
    }

    // --- Business / meta ---
    if (containsAny(q, [' pricing', ' subscription', ' system cost', ' system fee', ' how much is edupriva', ' cost of the system', ' price'])) {
        return 'pricing';
    }
    if (containsAny(q, [' support', ' contact support', ' talk to a human', ' help me with the system', ' engineer', ' whatsapp support', ' talk to someone', ' human being'])) {
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
        text: `Hello ${myFirst}! I'm LABAN, your school assistant. Ask me about school info, fees, performance, or type "help" to see what I can do.`,
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
            pushBot(error.message || `Sorry ${myFirst}, something went wrong. Please try again.`);
        } finally {
            setIsProcessing(false);
        }
    };

    /* ========================================================
       State machine
       ======================================================== */

    const processInput = async (text) => {
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
            const student = await findStudentByAdmissionNumber(admissionNumber, schoolId);
            if (!student) {
                pushBot(`I couldn't find a student with admission number ${admissionNumber}. Please check and try again.`);
                return;
            }
            const studentName = `${student.firstName || ''} ${student.lastName || ''}`.trim()
                || student.fullName || student.name || 'the student';
            setBotState({
                step: 'AWAITING_PAYMENT_CONFIRMATION',
                context: { ...context, admissionNumber, student, studentName },
            });
            pushBot(
                `Please confirm, ${myFirst}:\n\n` +
                `👤 Student: ${studentName}\n` +
                `🆔 Admission: ${admissionNumber}\n` +
                ` Amount: KES ${context.amount}\n\n` +
                `Reply YES to send the STK push or NO to cancel.`
            );
            return;
        }

        if (step === 'AWAITING_PAYMENT_CONFIRMATION') {
            const confirmation = text.trim().toLowerCase();
            if (['yes', 'y', 'confirm', 'ok', 'sawa'].includes(confirmation)) {
                const { phone, amount, student } = botState.context;
                pushBot(`Sending the STK push now, ${myFirst}. Please check your phone...`);
                const res = await triggerSTKPush(phone, amount, student, schoolId);
                pushBot(res.message || (res.success ? 'STK push sent.' : `I couldn't send the STK push, ${myFirst}.`));
                setBotState({ step: 'IDLE', context: {} });
                return;
            }
            if (['no', 'n', 'cancel', 'hapana'].includes(confirmation)) {
                pushBot(`Payment cancelled, ${myFirst}. Type "pay fee" anytime to start again.`);
                setBotState({ step: 'IDLE', context: {} });
                return;
            }
            pushBot(`Please reply YES to confirm or NO to cancel, ${myFirst}.`);
            return;
        }

        if (step === 'AWAITING_ADM_BALANCE') {
            const admissionNumber = text.trim();
            if (!/^[A-Za-z0-9][A-Za-z0-9/-]{0,39}$/.test(admissionNumber)) {
                pushBot(`That admission number looks off, ${myFirst}. Please try again.`);
                return;
            }
            pushBot(`Looking that up for you, ${myFirst}...`);
            const res = await fetchFeeBalance(admissionNumber, schoolId);
            pushBot(res.success
                ? `The fee balance for admission ${admissionNumber} is ${res.balance}.`
                : (res.balance || `I could not find a student with admission number ${admissionNumber}, ${myFirst}.`));
            setBotState({ step: 'IDLE', context: {} });
            return;
        }

        setBotState({ step: 'IDLE', context: {} });
    };

    /* ========================================================
       Intent router
       ======================================================== */

    const routeIntent = async (text) => {
        const intent = detectIntent(text);

        switch (intent) {
            case 'greeting':
                return pushBot(
                    `Hi ${myFirst}! Good to see you. ` +
                    `Ask me about school info ("What classes do we have?"), fees ("Pay fee", "Check balance"), ` +
                    `or performance ("Best student", "How is Grade 7 doing?").`
                );

            case 'gratitude':
                return pushBot(`You're welcome, ${myFirst}. Anything else I can help with?`);

            case 'goodbye':
                return pushBot(`Goodbye, ${myFirst}. Come back anytime you need me.`);

            case 'about_bot':
                return pushBot(
                    `I'm LABAN — EduPriva's AI assistant for ${userData?.schoolName || 'your school'}. ` +
                    `I can look up school facts, check fee balances, initiate M-Pesa payments, and summarise performance. ` +
                    `Type "help" for the full menu.`
                );

            case 'my_role':
                return pushBot(
                    `You're signed in as **${role}**${isAdmin ? ' — full admin access' : isTeacher ? ' — teacher access' : ''}. ` +
                    `Ask me what you'd like to do and I'll tailor the answer to your role.`
                );

            case 'help':
                return pushBot(helpMenu({ myFirst, isAdmin, isTeacher }));

            case 'pay_fee':
                setBotState({ step: 'AWAITING_PHONE', context: {} });
                return pushBot(`Sure ${myFirst}, let's pay some school fees. Please enter the M-Pesa phone number (e.g. 0712345678):`);

            case 'check_balance': {
                const adm = extractAdmissionNumber(text);
                if (adm) {
                    pushBot(`Looking up admission ${adm} for you, ${myFirst}...`);
                    const res = await fetchFeeBalance(adm, schoolId);
                    return pushBot(res.success
                        ? `Admission ${adm} has an outstanding balance of ${res.balance}.`
                        : (res.balance || `I couldn't find a student with admission number ${adm}, ${myFirst}.`));
                }
                setBotState({ step: 'AWAITING_ADM_BALANCE', context: {} });
                return pushBot(`Happy to check that, ${myFirst}. Please enter the student's admission number:`);
            }

            case 'school_name': {
                const res = await fetchSchoolInfo('overview');
                const name = res?.data?.school?.name || res?.data?.school?.schoolName;
                return pushBot(name
                    ? `The school is **${name}**${userData?.schoolMotto ? ` — motto: "${userData.schoolMotto}"` : ''}.`
                    : `I couldn't fetch the school name right now, ${myFirst}. Please try again in a moment.`);
            }

            case 'school_motto': {
                const res = await fetchSchoolInfo('overview');
                const motto = res?.data?.school?.motto;
                return pushBot(motto
                    ? `The school motto is "${motto}".`
                    : `There is no motto set for this school yet, ${myFirst}. You can add one under School Profile.`);
            }

            case 'school_paybill': {
                const res = await fetchSchoolInfo('contact');
                const paybill = res?.data?.school?.paybillNumber;
                return pushBot(paybill
                    ? `The school's M-Pesa paybill is **${paybill}**. Parents can pay fees directly to it.`
                    : `No paybill is configured yet, ${myFirst}.`);
            }

            case 'school_classes': {
                const res = await fetchSchoolInfo('classes');
                return pushBot(res.summary || `I couldn't fetch the classes right now, ${myFirst}.`);
            }

            case 'school_subjects': {
                const res = await fetchSchoolInfo('subjects');
                return pushBot(res.summary || `I couldn't fetch the subjects right now, ${myFirst}.`);
            }

            case 'school_teachers': {
                const res = await fetchSchoolInfo('teachers');
                return pushBot(res.summary || `I couldn't fetch the teacher count right now.`);
            }

            case 'school_contact': {
                const res = await fetchSchoolInfo('contact');
                return pushBot(res.summary || `No contact details on file, ${myFirst}.`);
            }

            case 'school_levels': {
                const res = await fetchSchoolInfo('levels');
                return pushBot(res.summary || `I could not fetch the levels right now.`);
            }

            case 'school_overview': {
                const res = await fetchSchoolInfo('overview');
                return pushBot(res.summary || `${myFirst}, I couldn't fetch an overview right now.`);
            }

            case 'performance_top': {
                // Optionally scoped to a class if the user mentioned one.
                const cls = extractClassFromQuery(text);
                const res = await fetchPerformance({ scope: 'top', class: cls || undefined });
                return pushBot(res.summary || `I couldn't fetch the top students right now, ${myFirst}.`);
            }

            case 'performance_class': {
                const cls = extractClassFromQuery(text);
                if (!cls) {
                    // Shouldn't happen — detectIntent requires a class — but
                    // fall back gracefully.
                    const res = await fetchPerformance({ scope: 'school' });
                    return pushBot(res.summary || `I couldn't fetch performance data right now.`);
                }
                const res = await fetchPerformance({ scope: 'class', class: cls });
                return pushBot(res.summary || `I couldn't fetch performance for ${cls} right now, ${myFirst}.`);
            }

            case 'performance_overview': {
                const res = await fetchPerformance({ scope: 'school' });
                return pushBot(res.summary || `I couldn't fetch performance data right now, ${myFirst}.`);
            }

            case 'daily_report': {
                if (!isAdmin) {
                    return pushBot(`Sorry ${myFirst}, daily collection reports are only available to administrators.`);
                }
                const res = await fetchDailyCollections(schoolId);
                if (!res.success) return pushBot(`I could not fetch the report right now, ${myFirst}.`);
                return pushBot(`Here's today's fee report, ${myFirst}:\n• Today: ${res.today}\n• This week: ${res.week}`);
            }

            case 'pricing':
                return pushBot(
                    `EduPriva subscription plans, ${myFirst}:\n` +
                    `• KES 65,000 — customised enterprise deployment\n` +
                    `• KES 12,500 per term — standard schools\n\n` +
                    `Say "contact support" if you'd like a tailored quote.`
                );

            case 'support':
                return pushBot(
                    `No problem ${myFirst}. Tap the WhatsApp button below and Engineer Nickson will help you directly.`,
                    'whatsapp'
                );

            default:
                return pushBot(fallbackMessage({ myFirst, text }));
        }
    };

    /* ========================================================
       Render
       ======================================================== */

    return (
        <div className="chatbot-widget" style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999, fontFamily: 'system-ui, sans-serif' }}>
            {!isOpen && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                        onClick={() => setIsOpen(true)}
                        style={{
                            background: '#1a237e', color: 'white', border: 'none', borderRadius: 50,
                            padding: '12px 20px', boxShadow: '0 8px 25px rgba(26, 35, 126, 0.35)',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                            fontWeight: 700, fontSize: 14, transition: 'all 0.3s ease',
                        }}
                        title="Chat with LABAN"
                    >
                        <img src="/Logo.png" alt="EduPriva" style={{ width: 28, height: 28, objectFit: 'contain' }} />
                        ASSISTANT LABAN
                    </button>
                    <button
                        onClick={onClose}
                        aria-label="Hide assistant"
                        title="Hide assistant"
                        style={{
                            width: 30, height: 30, border: 'none', borderRadius: '50%',
                            background: 'white', color: '#1a237e',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.2)', cursor: 'pointer',
                        }}
                    >
                        <i className="fas fa-times"></i>
                    </button>
                </div>
            )}

            {isOpen && (
                <div style={{
                    width: 'min(400px, calc(100vw - 24px))',
                    height: 'min(560px, calc(100dvh - 100px))',
                    background: 'white', borderRadius: 16,
                    boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
                    display: 'flex', flexDirection: 'column',
                    overflow: 'hidden', border: '1px solid #e2e8f0',
                }}>
                    <div style={{
                        background: '#1a237e', color: 'white', padding: '14px 18px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                            <img src="/Logo.png" alt="EduPriva" style={{ width: 32, height: 32, objectFit: 'contain' }} />
                            <div>
                                <div style={{ fontWeight: 700, fontSize: 15 }}>LABAN Assistant</div>
                                <div style={{ fontSize: 11, color: '#cbd5e1' }}>
                                    Online · {isAdmin ? 'Administrator' : isTeacher ? 'Teacher' : 'Staff'}
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={() => setIsOpen(false)}
                            style={{ background: 'transparent', border: 'none', color: 'white', fontSize: 18, cursor: 'pointer', padding: 4 }}
                        >
                            <i className="fas fa-times"></i>
                        </button>
                        <button
                            onClick={onClose}
                            aria-label="Hide assistant"
                            title="Hide assistant"
                            style={{ background: 'transparent', border: 'none', color: 'white', fontSize: 16, cursor: 'pointer', padding: 4 }}
                        >
                            <i className="fas fa-eye-slash"></i>
                        </button>
                    </div>

                    <div style={{
                        flex: 1, padding: 16, overflowY: 'auto', background: '#f8fafc',
                        display: 'flex', flexDirection: 'column', gap: 12,
                    }}>
                        {messages.map((m, idx) => (
                            <div key={idx} style={{
                                alignSelf: m.sender === 'user' ? 'flex-end' : 'flex-start',
                                maxWidth: '85%',
                                background: m.sender === 'user' ? '#1a237e' : 'white',
                                color: m.sender === 'user' ? 'white' : '#1e293b',
                                padding: '10px 14px',
                                borderRadius: m.sender === 'user' ? '14px 14px 0 14px' : '14px 14px 14px 0',
                                fontSize: 13,
                                boxShadow: '0 2px 5px rgba(0,0,0,0.05)',
                                border: m.sender === 'bot' ? '1px solid #e2e8f0' : 'none',
                                whiteSpace: 'pre-line',
                            }}>
                                <div>{m.text}</div>
                                {m.action === 'whatsapp' && (
                                    <div style={{ marginTop: 10 }}>
                                        <a
                                            href="https://wa.me/254114963959?text=Hello%20Engineer%20Nickson,%20I%20need%20support%20with%20Edupriva%20System."
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{
                                                display: 'inline-flex', alignItems: 'center', gap: 6,
                                                background: '#25D366', color: 'white', padding: '6px 12px',
                                                borderRadius: 6, textDecoration: 'none', fontWeight: 600, fontSize: 12,
                                            }}
                                        >
                                            <i className="fab fa-whatsapp"></i> Chat on WhatsApp (+254114963959)
                                        </a>
                                    </div>
                                )}
                                <div style={{
                                    fontSize: 10,
                                    color: m.sender === 'user' ? '#cbd5e1' : '#94a3b8',
                                    textAlign: 'right', marginTop: 4,
                                }}>
                                    {m.time}
                                </div>
                            </div>
                        ))}
                        <div ref={messagesEndRef} />
                    </div>

                    <form onSubmit={handleSend} style={{
                        padding: 12, background: 'white', borderTop: '1px solid #e2e8f0',
                        display: 'flex', gap: 8,
                    }}>
                        <input
                            type="text"
                            inputMode={
                                botState.step === 'AWAITING_PHONE' ? 'tel'
                                : botState.step === 'AWAITING_AMOUNT' ? 'numeric'
                                : 'text'
                            }
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder={
                                isProcessing ? 'Please wait...'
                                : botState.step === 'AWAITING_PHONE' ? `${myFirst}, enter phone number…`
                                : botState.step === 'AWAITING_AMOUNT' ? `${myFirst}, enter amount (KES)…`
                                : botState.step === 'AWAITING_ADM' ? 'Enter admission number…'
                                : botState.step === 'AWAITING_ADM_BALANCE' ? 'Enter admission number…'
                                : botState.step === 'AWAITING_PAYMENT_CONFIRMATION' ? 'Reply YES or NO…'
                                : `Ask me anything, ${myFirst}…`
                            }
                            disabled={isProcessing}
                            style={{
                                flex: 1, padding: '8px 12px', borderRadius: 8,
                                border: '1px solid #cbd5e1', fontSize: 13, outline: 'none',
                            }}
                        />
                        <button
                            type="submit"
                            disabled={isProcessing}
                            style={{
                                background: '#1a237e', color: 'white', border: 'none',
                                borderRadius: 8, padding: '8px 14px', cursor: isProcessing ? 'wait' : 'pointer',
                                fontWeight: 600,
                            }}
                        >
                            <i className="fas fa-paper-plane"></i>
                        </button>
                    </form>
                </div>
            )}
        </div>
    );
}

/* ============================================================
   Helpers
   ============================================================ */

function nowTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function helpMenu({ myFirst, isAdmin, isTeacher }) {
    const lines = [`Here's what I can help with, ${myFirst}:`, ''];

    lines.push('Fees');
    lines.push('• "Pay fee" — M-Pesa STK push to a parent');
    lines.push('• "Check fee balance" — balance for a student');
    lines.push('• "Balance for ADM-0042" — skips the admission prompt');

    lines.push('');
    lines.push('School');
    lines.push('• "What is the school name?"');
    lines.push('• "What classes do we have?"');
    lines.push('• "What subjects are offered?"');
    lines.push('• "How many teachers?"');
    lines.push('• "School contact"');
    lines.push('• "School motto"');
    lines.push('• "Paybill number"');
    lines.push('• "What levels does the school run?"');

    lines.push('');
    lines.push('Performance');
    lines.push('• "Best student"');
    lines.push('• "Top students in Grade 7"');
    lines.push('• "How is Grade 7 doing?"');
    lines.push('• "Performance this term"');

    if (isAdmin) {
        lines.push('');
        lines.push('Admin');
        lines.push('• "Daily collection report"');
        lines.push('• "Fee report"');
    }

    lines.push('');
    lines.push('Other');
    lines.push('• "Who are you?"');
    lines.push('• "What is my role?"');
    lines.push('• "Pricing"');
    lines.push('• "Contact support"');

    if (isTeacher) {
        lines.push('');
        lines.push('As a teacher you can view school info, pay fees, check balances, and see performance. Contact the admin for anything else.');
    }

    return lines.join('\n');
}

// Rich fallback that makes a guess at what the user wanted and offers
// a couple of concrete next steps — instead of a generic apology.
function fallbackMessage({ myFirst, text }) {
    const cls = extractClassFromQuery(text);
    const adm = extractAdmissionNumber(text);

    const guesses = [];
    if (cls) {
        guesses.push(`• "How is ${cls} doing?" — performance for that class`);
        guesses.push(`• "Top students in ${cls}"`);
    }
    if (adm) {
        guesses.push(`• "Balance for ${adm}" — fee balance lookup`);
    }

    const base =
        `Sorry ${myFirst}, I didn't quite catch that. Try one of these:\n` +
        `• "What classes do we have?"\n` +
        `• "How many teachers?"\n` +
        `• "Pay fee"\n` +
        `• "Best student"\n` +
        `• "Check fee balance"\n` +
        `Or type "help" for the full menu.`;

    if (guesses.length === 0) return base;

    return (
        `Sorry ${myFirst}, I didn't quite catch that. ` +
        `I noticed something in your message though — did you mean one of these?\n` +
        guesses.join('\n') +
        `\n\nOr type "help" for the full menu.`
    );
}
