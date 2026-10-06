import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { db } from '../firebase';
import { collection, query, where, getDocs, addDoc, serverTimestamp, orderBy, limit, deleteDoc, doc, getDoc } from 'firebase/firestore';
import Layout from '../components/Layout/Layout';
import SMSAnalytics from '../components/Communication/SMSAnalytics';
import LoadingSpinner from '../components/Common/LoadingSpinner';

import { showAppNotice } from '../utils/appNotice';
export default function BulkSMS() {
    const { currentUser, userData } = useAuth();

    // Data State
    const [students, setStudents] = useState([]);
    const [feeBalances, setFeeBalances] = useState({});
    const [templates, setTemplates] = useState([]);
    const [schoolInfo, setSchoolInfo] = useState({ name: '', phone: '' });
    const [loading, setLoading] = useState(true);
    const [history, setHistory] = useState([]);
    
    // SMS State
    const [messageTemplate, setMessageTemplate] = useState('');
    const [simSlot, setSimSlot] = useState('SIM 1');
    const [sending, setSending] = useState(false);
    const [activeTab, setActiveTab] = useState('compose');
    const [showHistoryModal, setShowHistoryModal] = useState(false);
    
    // Template Management State
    const [newTemplateName, setNewTemplateName] = useState('');
    const [selectedTemplateId, setSelectedTemplateId] = useState('');
    const [isSavingTemplate, setIsSavingTemplate] = useState(false);
    
    // Filters
    const [searchTerm, setSearchTerm] = useState('');
    const [levelFilter, setLevelFilter] = useState('');
    const [classFilter, setClassFilter] = useState('');
    const [balanceFilter, setBalanceFilter] = useState(''); // 'all', 'with_balance'
    
    // Selection
    const [selectedStudentIds, setSelectedStudentIds] = useState(new Set());
    
    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            try {
                const schoolId = userData?.schoolId || 'default_school';
                
                // Fetch School Info
                const schoolDoc = await getDoc(doc(db, 'schools', schoolId));
                if (schoolDoc.exists()) {
                    setSchoolInfo({
                        name: schoolDoc.data().name || 'Our School',
                        phone: schoolDoc.data().phone || ''
                    });
                }
                
                // Fetch Students
                const stuQuery = query(collection(db, 'students'), where('schoolId', '==', schoolId));
                const stuSnap = await getDocs(stuQuery);
                const loadedStudents = [];
                stuSnap.forEach(doc => {
                    const data = doc.data();
                    if (data.status !== 'archived') {
                        loadedStudents.push({ id: doc.id, ...data });
                    }
                });
                setStudents(loadedStudents);
                
                // Fetch Fee Balances
                const balQuery = query(collection(db, 'feeBalances'), where('schoolId', '==', schoolId));
                const balSnap = await getDocs(balQuery);
                const loadedBalances = {};
                balSnap.forEach(doc => {
                    loadedBalances[doc.data().studentId] = doc.data();
                });
                setFeeBalances(loadedBalances);
                
                // Fetch Templates
                await loadTemplates(schoolId);
                
                // Fetch History
                loadHistory(schoolId);
                
            } catch (err) {
                console.error("Error loading sms data", err);
            } finally {
                setLoading(false);
            }
        };
        if (userData?.schoolId) {
            loadData();
        }
    }, [userData]);
    
    const loadTemplates = async (schoolId) => {
        try {
            const tplQuery = query(collection(db, 'sms_templates'), where('schoolId', '==', schoolId), orderBy('name'));
            const tplSnap = await getDocs(tplQuery);
            const loadedTemplates = [];
            tplSnap.forEach(doc => {
                loadedTemplates.push({ id: doc.id, ...doc.data() });
            });
            setTemplates(loadedTemplates);
        } catch(err) {
            console.error("Failed to load templates", err);
        }
    };
    
    const loadHistory = async (schoolId) => {
        try {
            const histQuery = query(collection(db, 'sms_queue'), where('schoolId', '==', schoolId), orderBy('createdAt', 'desc'), limit(15));
            const histSnap = await getDocs(histQuery);
            const loadedHistory = [];
            histSnap.forEach(doc => {
                loadedHistory.push({ id: doc.id, ...doc.data() });
            });
            setHistory(loadedHistory);
        } catch(err) {
            console.error("Failed to load history", err);
        }
    };
    
    const showNotification = (text, type = 'info') => {
        showAppNotice(text, type);
    };

    // Computed filtered students
    const filteredStudents = useMemo(() => {
        return students.filter(s => {
            const name = `${s.firstName} ${s.lastName}`.toLowerCase();
            const term = searchTerm.toLowerCase();
            const searchMatch = name.includes(term) || (s.admissionNumber || '').toLowerCase().includes(term);
            const levelMatch = levelFilter ? s.level === levelFilter : true;
            const classMatch = classFilter ? s.class === classFilter : true;
            
            let balanceMatch = true;
            if (balanceFilter === 'with_balance') {
                const bal = feeBalances[s.id]?.balance || 0;
                balanceMatch = bal > 0;
            }
            
            return searchMatch && levelMatch && classMatch && balanceMatch;
        });
    }, [students, searchTerm, levelFilter, classFilter, balanceFilter, feeBalances]);

    // Derived unique levels & classes
    const uniqueLevels = useMemo(() => [...new Set(students.map(s => s.level).filter(Boolean))], [students]);
    const uniqueClasses = useMemo(() => [...new Set(students.map(s => s.class).filter(Boolean))], [students]);

    // Handle Checkboxes
    const handleSelectAll = (e) => {
        if (e.target.checked) {
            setSelectedStudentIds(new Set(filteredStudents.map(s => s.id)));
        } else {
            setSelectedStudentIds(new Set());
        }
    };

    const handleSelectOne = (id) => {
        const newSet = new Set(selectedStudentIds);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        setSelectedStudentIds(newSet);
    };

    // Insert Tag
    const insertTag = (tag) => {
        setMessageTemplate(prev => prev + tag);
    };
    
    const getFooter = () => {
        let footer = `\n\n--\n${schoolInfo.name}`;
        if (schoolInfo.phone) footer += `\n${schoolInfo.phone}`;
        return footer;
    };
    
    const parseTemplate = (template, student) => {
        let msg = template;
        msg = msg.replace(/\[Student Name\]/gi, `${student.firstName} ${student.lastName}`);
        msg = msg.replace(/\[Admission Number\]/gi, student.admissionNumber || 'N/A');
        msg = msg.replace(/\[Parent Name\]/gi, student.parentName || 'Parent');
        const bal = feeBalances[student.id]?.balance || 0;
        msg = msg.replace(/\[Fee Balance\]/gi, bal.toString());
        return msg + getFooter();
    };

    // Template Operations
    const handleSaveTemplate = async () => {
        if (!newTemplateName.trim() || !messageTemplate.trim()) {
            showNotification('Provide a template name and message content to save.', 'error');
            return;
        }
        
        setIsSavingTemplate(true);
        try {
            const schoolId = userData?.schoolId || 'default_school';
            await addDoc(collection(db, 'sms_templates'), {
                schoolId,
                name: newTemplateName.trim(),
                content: messageTemplate.trim(),
                createdAt: serverTimestamp(),
                createdBy: currentUser?.uid,
                createdByName: userData?.fullName || userData?.firstName || 'System'
            });
            showNotification('Template saved successfully.', 'success');
            setNewTemplateName('');
            await loadTemplates(schoolId);
        } catch (err) {
            console.error("Failed to save template", err);
            showNotification('Failed to save template.', 'error');
        } finally {
            setIsSavingTemplate(false);
        }
    };
    
    const handleDeleteTemplate = async (templateId) => {
        if (!window.confirm('Are you sure you want to delete this template?')) return;
        try {
            await deleteDoc(doc(db, 'sms_templates', templateId));
            showNotification('Template deleted.', 'success');
            setSelectedTemplateId('');
            setTemplates(prev => prev.filter(t => t.id !== templateId));
        } catch (err) {
            console.error("Failed to delete template", err);
            showNotification('Failed to delete template.', 'error');
        }
    };
    
    const handleTemplateSelect = (e) => {
        const tId = e.target.value;
        setSelectedTemplateId(tId);
        if (tId) {
            const selected = templates.find(t => t.id === tId);
            if (selected) {
                setMessageTemplate(selected.content);
            }
        } else {
            setMessageTemplate('');
        }
    };

    const handleSend = async () => {
        if (selectedStudentIds.size === 0) {
            showNotification('Please select at least one student', 'error');
            return;
        }
        if (!messageTemplate.trim()) {
            showNotification('Please enter a message template', 'error');
            return;
        }

        setSending(true);
        try {
            const schoolId = userData?.schoolId || 'default_school';
            
            // Build individual messages
            const messages = [];
            filteredStudents.forEach(s => {
                if (selectedStudentIds.has(s.id) && s.phoneNumber) {
                    messages.push({
                        studentId: s.id,
                        phone: s.phoneNumber,
                        text: parseTemplate(messageTemplate, s),
                        status: 'pending'
                    });
                }
            });
            
            if (messages.length === 0) {
                showNotification('None of the selected students have a phone number.', 'warning');
                setSending(false);
                return;
            }

            // Create batch in sms_queue
            await addDoc(collection(db, 'sms_queue'), {
                schoolId,
                simSlot: simSlot,
                status: 'pending',
                totalMessages: messages.length,
                messages: messages, // Using an array for the APK to process
                createdAt: serverTimestamp(),
                sentBy: currentUser?.uid,
                sentByName: userData?.fullName || userData?.firstName || 'System',
                template: messageTemplate
            });

            showNotification(`Queued ${messages.length} messages for sending!`, 'success');
            setMessageTemplate('');
            setSelectedStudentIds(new Set());
            loadHistory(schoolId);
        } catch (err) {
            console.error("Failed to send sms", err);
            showNotification('Failed to send SMS: ' + err.message, 'error');
        } finally {
            setSending(false);
        }
    };

    if (loading) {
        return <Layout><LoadingSpinner fullScreen text="Loading Communication Module..." /></Layout>;
    }

    return (
        <Layout>
            <div className="module-header">
                <div>
                    <h1>Communication Center</h1>
                    <p>Manage SMS templates and send personalized messages via local APK.</p>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                    <button className="btn btn-outline" onClick={() => setShowHistoryModal(true)}>
                        <i className="fas fa-history"></i> Queue History
                    </button>
                </div>
            </div>
            
            <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '24px' }}>
                
                {/* Compose Section */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    <div className="card" style={{ padding: '24px' }}>
                        <h2 style={{ marginBottom: '20px', borderBottom: '1px solid #eee', paddingBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <i className="fas fa-pen-nib" style={{ color: 'var(--primary)' }}></i> Compose Message
                        </h2>
                        
                        <div style={{ display: 'flex', gap: '15px', marginBottom: '20px' }}>
                            <div style={{ flex: 1 }}>
                                <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Load Saved Template</label>
                                <div style={{ display: 'flex', gap: '10px' }}>
                                    <select className="form-control" value={selectedTemplateId} onChange={handleTemplateSelect} style={{ flex: 1 }}>
                                        <option value="">-- Start from scratch --</option>
                                        {templates.map(t => (
                                            <option key={t.id} value={t.id}>{t.name}</option>
                                        ))}
                                    </select>
                                    {selectedTemplateId && (
                                        <button className="btn btn-outline btn-danger" onClick={() => handleDeleteTemplate(selectedTemplateId)} title="Delete Template">
                                            <i className="fas fa-trash"></i>
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div style={{ width: '120px' }}>
                                <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Send via SIM</label>
                                <select className="form-control" value={simSlot} onChange={(e) => setSimSlot(e.target.value)}>
                                    <option value="SIM 1">SIM 1</option>
                                    <option value="SIM 2">SIM 2</option>
                                </select>
                            </div>
                        </div>

                        <div style={{ marginBottom: '15px' }}>
                            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600' }}>Message Body</label>
                            <textarea 
                                className="form-control"
                                rows="6"
                                placeholder="Type your message here..."
                                value={messageTemplate}
                                onChange={(e) => setMessageTemplate(e.target.value)}
                                style={{ width: '100%', padding: '14px', borderRadius: '8px', border: '1px solid #ddd', resize: 'vertical', fontSize: '15px', lineHeight: '1.5' }}
                            ></textarea>
                            
                            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap', background: '#f8f9fa', padding: '10px', borderRadius: '6px' }}>
                                <span style={{ fontSize: '13px', color: '#666', marginRight: '10px', alignSelf: 'center', fontWeight: '500' }}>Insert Variables:</span>
                                <button className="btn btn-sm btn-outline" style={{ background: 'white' }} onClick={() => insertTag('[Student Name]')}>[Student Name]</button>
                                <button className="btn btn-sm btn-outline" style={{ background: 'white' }} onClick={() => insertTag('[Admission Number]')}>[Admission Number]</button>
                                <button className="btn btn-sm btn-outline" style={{ background: 'white' }} onClick={() => insertTag('[Parent Name]')}>[Parent Name]</button>
                                <button className="btn btn-sm btn-outline" style={{ background: 'white' }} onClick={() => insertTag('[Fee Balance]')}>[Fee Balance]</button>
                            </div>
                        </div>
                        
                        <div style={{ background: '#eef2f5', padding: '15px', borderRadius: '8px', marginBottom: '20px', borderLeft: '4px solid var(--primary)' }}>
                            <div style={{ fontSize: '12px', color: '#666', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px', fontWeight: '600' }}>Message Preview</div>
                            <p style={{ margin: 0, color: '#333', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
                                {selectedStudentIds.size > 0 ? 
                                    parseTemplate(messageTemplate || '...', students.find(s => selectedStudentIds.has(s.id))) 
                                    : 'Select at least one recipient to see a live preview.'
                                }
                            </p>
                        </div>
                        
                        {/* Save Template Section */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '15px', background: '#fdfdfd', border: '1px dashed #ccc', borderRadius: '8px', marginBottom: '20px' }}>
                            <div style={{ flex: 1 }}>
                                <input 
                                    type="text" 
                                    className="form-control" 
                                    placeholder="Template Name (e.g., Fee Reminder)" 
                                    value={newTemplateName}
                                    onChange={(e) => setNewTemplateName(e.target.value)}
                                />
                            </div>
                            <button 
                                className="btn btn-outline" 
                                onClick={handleSaveTemplate}
                                disabled={isSavingTemplate || !newTemplateName.trim() || !messageTemplate.trim()}
                            >
                                <i className="fas fa-save"></i> Save as Template
                            </button>
                        </div>

                        <button 
                            className="btn btn-primary" 
                            onClick={handleSend} 
                            disabled={sending || selectedStudentIds.size === 0 || !messageTemplate.trim()}
                            style={{ width: '100%', padding: '14px', fontSize: '16px', fontWeight: '600', display: 'flex', justifyContent: 'center', gap: '10px', alignItems: 'center' }}
                        >
                            {sending ? <><i className="fas fa-spinner fa-spin"></i> Queuing...</> : <><i className="fas fa-paper-plane"></i> `Queue ${selectedStudentIds.size} Messages to ${simSlot}`</>}
                        </button>
                    </div>
                </div>

                {/* Recipients Section */}
                <div className="card" style={{ padding: '24px', display: 'flex', flexDirection: 'column' }}>
                    <h2 style={{ marginBottom: '20px', borderBottom: '1px solid #eee', paddingBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <i className="fas fa-users" style={{ color: 'var(--primary)' }}></i> Target Audience
                    </h2>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
                        <div className="search-box">
                            <i className="fas fa-search"></i>
                            <input 
                                type="text" 
                                className="form-control" 
                                placeholder="Search by name or admission..." 
                                value={searchTerm} 
                                onChange={(e) => setSearchTerm(e.target.value)}
                                style={{ paddingLeft: '35px' }}
                            />
                        </div>
                        <select className="form-control" value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
                            <option value="">All Levels</option>
                            {uniqueLevels.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
                        </select>
                        <select className="form-control" value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
                            <option value="">All Classes</option>
                            {uniqueClasses.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select className="form-control" value={balanceFilter} onChange={(e) => setBalanceFilter(e.target.value)}>
                            <option value="">All Fee Statuses</option>
                            <option value="with_balance">Students with Fee Balances</option>
                        </select>
                    </div>

                    <div style={{ background: '#f5f7fa', padding: '12px', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', marginBottom: '10px', alignItems: 'center', border: '1px solid #e2e8f0' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', margin: 0, fontWeight: '600', color: '#333' }}>
                            <input 
                                type="checkbox" 
                                checked={filteredStudents.length > 0 && selectedStudentIds.size === filteredStudents.length}
                                onChange={handleSelectAll}
                                style={{ width: '16px', height: '16px' }}
                            />
                            Select All ({filteredStudents.length})
                        </label>
                        <span style={{ fontSize: '13px', color: '#666' }}>{selectedStudentIds.size} selected</span>
                    </div>

                    <div style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: '6px', overflowY: 'auto', background: 'white' }}>
                        {filteredStudents.length === 0 ? (
                            <div style={{ padding: '30px', textAlign: 'center', color: '#888' }}>
                                <i className="fas fa-user-slash" style={{ fontSize: '24px', marginBottom: '10px', color: '#ccc' }}></i>
                                <div>No students match filters.</div>
                            </div>
                        ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <tbody>
                                    {filteredStudents.map(student => (
                                        <tr key={student.id} style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: selectedStudentIds.has(student.id) ? '#f8fafc' : 'transparent' }} onClick={() => handleSelectOne(student.id)}>
                                            <td style={{ padding: '12px 10px', width: '40px', textAlign: 'center' }}>
                                                <input 
                                                    type="checkbox" 
                                                    checked={selectedStudentIds.has(student.id)}
                                                    onChange={() => {}} // Handled by tr onClick
                                                    style={{ width: '16px', height: '16px', pointerEvents: 'none' }}
                                                />
                                            </td>
                                            <td style={{ padding: '12px 10px' }}>
                                                <div style={{ fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>{student.firstName} {student.lastName}</div>
                                                <div style={{ display: 'flex', gap: '10px', fontSize: '12px', color: '#64748b' }}>
                                                    <span title="Phone Number"><i className="fas fa-phone-alt" style={{ fontSize: '10px', marginRight: '4px' }}></i>{student.phoneNumber || 'N/A'}</span>
                                                    <span title="Fee Balance" style={{ color: (feeBalances[student.id]?.balance || 0) > 0 ? '#ef4444' : '#10b981' }}>
                                                        <i className="fas fa-wallet" style={{ fontSize: '10px', marginRight: '4px' }}></i>
                                                        KES {feeBalances[student.id]?.balance || 0}
                                                    </span>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </div>
            </div>

            {showHistoryModal && (
                <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && setShowHistoryModal(false)}>
                    <div className="modal" style={{ maxWidth: '900px', width: '95%' }}>
                        <div className="modal-header">
                            <h2><i className="fas fa-history" style={{ marginRight: '10px', color: 'var(--primary)' }}></i> Message Queue History</h2>
                            <button className="modal-close" onClick={() => setShowHistoryModal(false)}><i className="fas fa-times"></i></button>
                        </div>
                        <div style={{ padding: '20px', maxHeight: '70vh', overflowY: 'auto' }}>
                            {history.length === 0 ? (
                                <div style={{ padding: '40px', textAlign: 'center', color: '#888' }}>
                                    <i className="fas fa-inbox" style={{ fontSize: '48px', color: '#e2e8f0', marginBottom: '15px' }}></i>
                                    <p>No message history found.</p>
                                </div>
                            ) : (
                                <table className="data-table">
                                    <thead>
                                        <tr style={{ background: '#f8fafc' }}>
                                            <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>Date</th>
                                            <th style={{ padding: '12px', textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>Message Template</th>
                                            <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #e2e8f0' }}>Recipients</th>
                                            <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #e2e8f0' }}>SIM</th>
                                            <th style={{ padding: '12px', textAlign: 'center', borderBottom: '2px solid #e2e8f0' }}>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {history.map(h => (
                                            <tr key={h.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                                <td style={{ padding: '12px', color: '#475569', fontSize: '14px' }}>
                                                    <div style={{ fontWeight: '500' }}>{h.createdAt ? new Date(h.createdAt.seconds * 1000).toLocaleDateString() : 'Today'}</div>
                                                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>{h.createdAt ? new Date(h.createdAt.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Just now'}</div>
                                                </td>
                                                <td style={{ padding: '12px', color: '#334155', fontSize: '14px', maxWidth: '300px' }}>
                                                    <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.template}</div>
                                                </td>
                                                <td style={{ padding: '12px', textAlign: 'center', fontWeight: '600', color: '#0f172a' }}>{h.totalMessages}</td>
                                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                                    <span style={{ background: '#e2e8f0', padding: '4px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: '600', color: '#475569' }}>
                                                        {h.simSlot || 'SIM 1'}
                                                    </span>
                                                </td>
                                                <td style={{ padding: '12px', textAlign: 'center' }}>
                                                    <span className={`status-badge ${h.status === 'completed' ? 'paid' : (h.status === 'processing' ? 'partial' : 'unpaid')}`}>
                                                        {h.status?.toUpperCase() || 'PENDING'}
                                                    </span>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
