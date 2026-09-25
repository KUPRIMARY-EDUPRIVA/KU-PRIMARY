// src/components/Common/EduprivaChatbot.jsx
import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { triggerSTKPush, fetchFeeBalance, fetchDailyCollections } from '../../utils/ChatbotActions';

export default function EduprivaChatbot() {
    const { currentUser, userData } = useAuth();
    const schoolId = userData?.schoolId;
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState([
        {
            sender: 'bot',
            text: 'Hello! I am LABAN, your intelligent system guide. How can I help you today?',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
    ]);
    const [input, setInput] = useState('');
    const [botState, setBotState] = useState({ step: 'IDLE', context: {} });
    const messagesEndRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        if (isOpen) scrollToBottom();
    }, [messages, isOpen]);

    const isAdmin = userData?.role === 'admin' || userData?.role === 'platform_admin' || currentUser?.email?.includes('admin');

    const handleSend = async (e) => {
        e.preventDefault();
        const text = input.trim();
        if (!text) return;

        setMessages(prev => [...prev, {
            sender: 'user',
            text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
        setInput('');

        await processInput(text);
    };

    const processInput = async (text) => {
        const q = text.toLowerCase();
        let reply = { text: '' };

        // Handle State Machine
        if (botState.step === 'AWAITING_PHONE') {
            setBotState({ step: 'AWAITING_AMOUNT', context: { ...botState.context, phone: text } });
            reply.text = 'Please enter the amount to pay:';
        } else if (botState.step === 'AWAITING_AMOUNT') {
            setBotState({ step: 'AWAITING_ADM', context: { ...botState.context, amount: text } });
            reply.text = 'Please enter the student admission number:';
        } else if (botState.step === 'AWAITING_ADM') {
            const { phone, amount } = botState.context;
            const res = await triggerSTKPush(phone, amount, text, schoolId);
            reply.text = res.message;
            setBotState({ step: 'IDLE', context: {} });
        } else if (botState.step === 'AWAITING_ADM_BALANCE') {
            const res = await fetchFeeBalance(text, schoolId);
            reply.text = `The fee balance for Adm No ${text} is ${res.balance}.`;
            setBotState({ step: 'IDLE', context: {} });
        } else {
            // Keyword Router
            reply = await routeKeyword(q);
        }

        setMessages(prev => [...prev, {
            sender: 'bot',
            text: reply.text,
            action: reply.action,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }]);
    };

    const routeKeyword = async (q) => {
        // --- 1. Help Menu ---
        if (q.includes('help') || q.includes('menu') || q.includes('hi') || q.includes('hello')) {
            return {
                text: 'Hi! I am LABAN, your system guide. Here is what I can do:\n\n' +
                      '💰 Payments: "Pay fee", "Check fee balance"\n' +
                      '📋 Reports: "Fee reports" (Admins only)\n' +
                      'ℹ️ System: "Pricing", "System help"\n' +
                      '👤 Staff/Student: "List students"\n\n' +
                      'How can I assist you right now?'
            };
        }

        // --- 2. Payment Flow ---
        if (q.includes('pay fee') || q.includes('pay school fees') || q.includes('stk push')) {
            setBotState({ step: 'AWAITING_PHONE', context: {} });
            return { text: 'I can help you pay school fees via M-Pesa. Please enter the phone number (e.g., 0712...) for the STK push:' };
        }
        
        // --- 3. Balance Flow ---
        if (q.includes('fee balance') || q.includes('check balance')) {
            setBotState({ step: 'AWAITING_ADM_BALANCE', context: {} });
            return { text: 'Please enter the student admission number to check the fee balance:' };
        }

        // --- 4. Admin Reports ---
        if ((q.includes('collected') || q.includes('report') || q.includes('fee reports')) && isAdmin) {
            const res = await fetchDailyCollections(schoolId);
            return { text: `System Fees Report:\n• Today: ${res.today}\n• This Week: ${res.week}` };
        }

        // --- 5. System/Pricing Info ---
        if (q.includes('pricing') || q.includes('system fee') || q.includes('cost')) {
            return { text: 'Edupriva System Subscription: KES 65,000 for customized enterprise systems, or KES 12,500 per term for standard schools.' };
        }

        // --- 6. General Information ---
        if (q.includes('students') || q.includes('list students')) {
            return { text: 'You can manage students directly from the "Students" module in the sidebar. I cannot list them all here directly yet.' };
        }

        // --- 7. Fallback ---
        return { text: 'I am not sure I understand. Please type "help" to see what I can do for you!' };
    };

    return (
        <div style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 9999, fontFamily: 'system-ui, sans-serif' }}>
            {!isOpen && (
                <button
                    onClick={() => setIsOpen(true)}
                    style={{
                        background: '#1a237e',
                        color: 'white',
                        border: 'none',
                        borderRadius: '50px',
                        padding: '12px 20px',
                        boxShadow: '0 8px 25px rgba(26, 35, 126, 0.35)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        fontWeight: '700',
                        fontSize: '14px',
                        transition: 'all 0.3s ease'
                    }}
                    title="Chat with LABAN"
                >
                    <img src="/logo.png" alt="Logo" style={{ width: '28px', height: '28px', borderRadius: '50%' }} />
                    ASSISTANT LABAN
                </button>
            )}

            {isOpen && (
                <div style={{
                    width: '360px',
                    height: '500px',
                    background: 'white',
                    borderRadius: '16px',
                    boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    border: '1px solid #e2e8f0'
                }}>
                    {/* Chat Header */}
                    <div style={{
                        background: '#1a237e',
                        color: 'white',
                        padding: '14px 18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
                            <img src="/logo.png" alt="Logo" style={{ width: '32px', height: '32px', borderRadius: '50%' }} />
                            <div>
                                <div style={{ fontWeight: '700', fontSize: '15px' }}>LABAN Assistant</div>
                                <div style={{ fontSize: '11px', color: '#cbd5e1' }}>Online | System Guide</div>
                            </div>
                        </div>
                        <button
                            onClick={() => setIsOpen(false)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'white',
                                fontSize: '18px',
                                cursor: 'pointer',
                                padding: '4px'
                            }}
                        >
                            <i className="fas fa-times"></i>
                        </button>
                    </div>

                    {/* Chat Body */}
                    <div style={{
                        flex: 1,
                        padding: '16px',
                        overflowY: 'auto',
                        background: '#f8fafc',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px'
                    }}>
                        {messages.map((m, idx) => (
                            <div key={idx} style={{
                                alignSelf: m.sender === 'user' ? 'flex-end' : 'flex-start',
                                maxWidth: '85%',
                                background: m.sender === 'user' ? '#1a237e' : 'white',
                                color: m.sender === 'user' ? 'white' : '#1e293b',
                                padding: '10px 14px',
                                borderRadius: m.sender === 'user' ? '14px 14px 0 14px' : '14px 14px 14px 0',
                                fontSize: '13px',
                                boxShadow: '0 2px 5px rgba(0,0,0,0.05)',
                                border: m.sender === 'bot' ? '1px solid #e2e8f0' : 'none',
                                whiteSpace: 'pre-line'
                            }}>
                                <div>{m.text}</div>
                                {m.action === 'whatsapp' && (
                                    <div style={{ marginTop: '10px' }}>
                                        <a
                                            href="https://wa.me/254114963959?text=Hello%20Engineer%20Nickson,%20I%20need%20support%20with%20Edupriva%20System."
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                background: '#25D366',
                                                color: 'white',
                                                padding: '6px 12px',
                                                borderRadius: '6px',
                                                textDecoration: 'none',
                                                fontWeight: '600',
                                                fontSize: '12px'
                                            }}
                                        >
                                            <i className="fab fa-whatsapp"></i> Chat on WhatsApp (+254114963959)
                                        </a>
                                    </div>
                                )}
                                <div style={{
                                    fontSize: '10px',
                                    color: m.sender === 'user' ? '#cbd5e1' : '#94a3b8',
                                    textAlign: 'right',
                                    marginTop: '4px'
                                }}>
                                    {m.time}
                                </div>
                            </div>
                        ))}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Chat Input */}
                    <form onSubmit={handleSend} style={{
                        padding: '12px',
                        background: 'white',
                        borderTop: '1px solid #e2e8f0',
                        display: 'flex',
                        gap: '8px'
                    }}>
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Type a message or question..."
                            style={{
                                flex: 1,
                                padding: '8px 12px',
                                borderRadius: '8px',
                                border: '1px solid #cbd5e1',
                                fontSize: '13px',
                                outline: 'none'
                            }}
                        />
                        <button
                            type="submit"
                            style={{
                                background: '#1a237e',
                                color: 'white',
                                border: 'none',
                                borderRadius: '8px',
                                padding: '8px 14px',
                                cursor: 'pointer',
                                fontWeight: '600'
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
