// src/pages/FeeStructure.jsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSchool } from '../context/SchoolContext';
import { useFee } from '../context/FeeContext';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import { downloadFeeStructurePDF } from '../services/pdf';
import './FeeStructure.css';
import {
    SCHOOL_LEVELS,
    LEVEL_CLASSES,
    LEVEL_DISPLAY_NAMES,
    getClassOptions,
    getLevelDisplayName
} from '../utils/constants';
import { requireSchoolId, getFeeStructures, upsertFeeStructure, deleteFeeStructure, getFeeStructure } from '../services/feeService';

import { showAppNotice } from '../utils/appNotice';
const FEE_CATEGORIES = [
    { id: 'Tuition', label: 'Tuition & Academic', icon: 'fa-graduation-cap', defaultOptional: false },
    { id: 'Meals', label: 'Meals / Lunch Program', icon: 'fa-utensils', defaultOptional: true },
    { id: 'Transport', label: 'Transport / Bus', icon: 'fa-bus', defaultOptional: true },
    { id: 'Boarding', label: 'Boarding & Hostel', icon: 'fa-bed', defaultOptional: true },
    { id: 'Activity', label: 'Sports & Activities', icon: 'fa-futbol', defaultOptional: false },
    { id: 'Exam', label: 'Exams & Assessment', icon: 'fa-file-alt', defaultOptional: false },
    { id: 'Uniform', label: 'Uniform & Materials', icon: 'fa-tshirt', defaultOptional: true },
    { id: 'ICT', label: 'ICT & Computer Lab', icon: 'fa-laptop', defaultOptional: false },
    { id: 'Development', label: 'PTA & Development', icon: 'fa-landmark', defaultOptional: false },
    { id: 'Other', label: 'Other / Miscellaneous', icon: 'fa-tag', defaultOptional: false }
];

const TERMS = ['Term 1', 'Term 2', 'Term 3', 'Full Year'];

export default function FeeStructure() {
    const { userData } = useAuth();
    const { getLevelClasses } = useSchool();
    const { students, createBulkInvoices, refreshData } = useFee();

    // Configuration target: 'level' or 'class'
    const [targetType, setTargetType] = useState('level');
    const [selectedLevel, setSelectedLevel] = useState('lower-primary');
    const [selectedClass, setSelectedClass] = useState('Grade 1');
    const [selectedTerm, setSelectedTerm] = useState('Term 1');
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

    // Line items for the active structure
    const [items, setItems] = useState([
        { description: 'Tuition Fee', category: 'Tuition', amount: 15000, optional: false }
    ]);

    // All structures for the current school and year
    const [savedStructures, setSavedStructures] = useState([]);
    const [loadingStructures, setLoadingStructures] = useState(false);
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState({ message: '', type: '' });

    // Invoicing modal from structure
    const [showInvoiceModal, setShowInvoiceModal] = useState(false);
    const [structureToInvoice, setStructureToInvoice] = useState(null);
    const [invoiceDueDate, setInvoiceDueDate] = useState(
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    );
    const [includeOptionalInInvoicing, setIncludeOptionalInInvoicing] = useState(false);
    const [isGeneratingInvoices, setIsGeneratingInvoices] = useState(false);
    const [singleScheduleForPDF, setSingleScheduleForPDF] = useState(null);
    const [exportingPDF, setExportingPDF] = useState(false);

    // Dynamic classes based on school constants + any custom student classes
    const availableClasses = useMemo(() => {
        const set = new Set();
        if (selectedLevel) {
            const list = getLevelClasses ? getLevelClasses(selectedLevel) : (LEVEL_CLASSES[selectedLevel] || []);
            list.forEach(c => set.add(c));
        } else {
            const levels = ['pre-primary', 'lower-primary', 'upper-primary', 'junior-school', 'senior-school'];
            levels.forEach(l => {
                const list = getLevelClasses ? getLevelClasses(l) : (LEVEL_CLASSES[l] || []);
                list.forEach(c => set.add(c));
            });
        }
        students.forEach(s => {
            if (s.class && (!selectedLevel || s.level === selectedLevel)) {
                set.add(s.class);
            }
        });
        return [...set].sort();
    }, [selectedLevel, students, getLevelClasses]);

    const targetKey = targetType === 'level' ? selectedLevel : selectedClass;
    const targetTitle = targetType === 'level'
        ? (LEVEL_DISPLAY_NAMES[selectedLevel] || selectedLevel)
        : selectedClass;

    const showNotification = (message, type = 'info') => {
        showAppNotice(message, type);
    };

    // Load saved structures for this school & year
    const loadSavedStructures = useCallback(async () => {
        try {
            const schoolId = requireSchoolId(userData);
            setLoadingStructures(true);
            const list = await getFeeStructures(schoolId, { year: selectedYear });
            setSavedStructures(list);
        } catch (err) {
            console.warn('loadSavedStructures error:', err.message);
        } finally {
            setLoadingStructures(false);
        }
    }, [userData, selectedYear]);

    useEffect(() => {
        loadSavedStructures();
    }, [loadSavedStructures]);

    // Load structure when target or term changes
    useEffect(() => {
        if (!targetKey) return;
        (async () => {
            try {
                const schoolId = requireSchoolId(userData);
                const s = await getFeeStructure(schoolId, targetKey, selectedYear, selectedTerm);
                if (s?.items?.length) {
                    setItems(s.items);
                } else {
                    // Default template for a new structure
                    setItems([
                        { description: 'Tuition Fee', category: 'Tuition', amount: 0, optional: false }
                    ]);
                }
            } catch (err) {
                console.warn('getFeeStructure error:', err.message);
            }
        })();
    }, [targetKey, selectedYear, selectedTerm, userData]);

    // Fast-add category preset
    const handleAddPreset = (category) => {
        setItems(prev => [
            ...prev,
            {
                description: `${category.label}`,
                category: category.id,
                amount: 0,
                optional: category.defaultOptional
            }
        ]);
    };

    const handleDownloadPDF = async () => {
        setExportingPDF(true);
        try {
            const result = await downloadFeeStructurePDF(savedStructures, userData, selectedYear);
            setFeedback({ type: 'success', message: `Fee schedules saved${result?.filename ? ` as ${result.filename}` : ' to Downloads/EduPriva'}.` });
        } catch (error) {
            console.error('Fee schedule PDF export failed:', error);
            setFeedback({ type: 'error', message: `Fee schedule export failed: ${error.message}` });
        } finally {
            setExportingPDF(false);
        }
    };

    const handleDownloadSingleSchedulePDF = async (schedule) => {
        setExportingPDF(true);
        try {
            const result = await downloadFeeStructurePDF(schedule, userData, selectedYear);
            setFeedback({ type: 'success', message: `Fee schedule saved${result?.filename ? ` as ${result.filename}` : ' to Downloads/EduPriva'}.` });
        } catch (error) {
            console.error('Fee schedule PDF export failed:', error);
            setFeedback({ type: 'error', message: `Fee schedule export failed: ${error.message}` });
        } finally {
            setExportingPDF(false);
        }
    };

    const handleAddItem = () => {
        setItems(prev => [
            ...prev,
            { description: '', category: 'Tuition', amount: 0, optional: false }
        ]);
    };

    const handleUpdateItem = (index, field, value) => {
        setItems(prev => prev.map((item, idx) => idx === index ? { ...item, [field]: value } : item));
    };

    const handleRemoveItem = (index) => {
        if (items.length <= 1) {
            setItems([{ description: '', category: 'Tuition', amount: 0, optional: false }]);
            return;
        }
        setItems(prev => prev.filter((_, idx) => idx !== index));
    };

    // Calculations
    const mandatoryTotal = useMemo(() => {
        return items.filter(i => !i.optional).reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
    }, [items]);

    const optionalTotal = useMemo(() => {
        return items.filter(i => i.optional).reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
    }, [items]);

    const grandTotal = mandatoryTotal + optionalTotal;

    // Save Fee Structure
    const handleSave = async () => {
        const validItems = items.filter(i => i.description.trim() && Number(i.amount) > 0);
        if (validItems.length === 0) {
            showNotification('Please add at least one fee item with an amount greater than 0', 'warning');
            return;
        }

        setSaving(true);
        try {
            const schoolId = requireSchoolId(userData);
            await upsertFeeStructure(schoolId, targetKey, selectedYear, {
                targetType,
                level: targetType === 'level' ? selectedLevel : null,
                className: targetType === 'class' ? selectedClass : null,
                name: targetTitle,
                term: selectedTerm,
                items: validItems
            }, {
                updatedBy: userData?.uid,
                updatedByName: userData?.fullName || userData?.firstName || 'System'
            }, selectedTerm);

            showNotification(`Fee structure for ${targetTitle} (${selectedTerm} ${selectedYear}) saved successfully!`, 'success');
            await loadSavedStructures();
            if (refreshData) refreshData();
        } catch (err) {
            showNotification(`Failed to save: ${err.message}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    // Delete a structure
    const handleDeleteStructure = async (id, title) => {
        if (!window.confirm(`Are you sure you want to delete the fee schedule for ${title}?`)) return;
        try {
            const schoolId = requireSchoolId(userData);
            await deleteFeeStructure(schoolId, id);
            showNotification('Fee structure deleted', 'info');
            await loadSavedStructures();
        } catch (err) {
            showNotification(`Failed to delete: ${err.message}`, 'error');
        }
    };

    // Duplicate structure to another term
    const handleCopyToTerm = async (structure, targetTerm) => {
        try {
            const schoolId = requireSchoolId(userData);
            await upsertFeeStructure(schoolId, structure.targetKey, structure.year, {
                ...structure,
                term: targetTerm
            }, {
                updatedBy: userData?.uid,
                updatedByName: userData?.fullName || userData?.firstName || 'System'
            }, targetTerm);
            showNotification(`Copied to ${targetTerm}!`, 'success');
            await loadSavedStructures();
        } catch (err) {
            showNotification(`Copy failed: ${err.message}`, 'error');
        }
    };

    // Eligible students for invoicing
    const eligibleStudents = useMemo(() => {
        if (!structureToInvoice) return [];
        return students.filter(s => {
            if (structureToInvoice.targetType === 'level') {
                return s.level === structureToInvoice.targetKey;
            }
            return s.class === structureToInvoice.targetKey;
        });
    }, [structureToInvoice, students]);

    // Trigger Bulk Invoicing from Structure
    const handleExecuteInvoicing = async () => {
        if (!structureToInvoice || eligibleStudents.length === 0) return;
        setIsGeneratingInvoices(true);

        try {
            const activeItems = (structureToInvoice.items || []).filter(
                i => !i.optional || includeOptionalInInvoicing
            );
            const subtotal = activeItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);

            const entries = eligibleStudents.map((student, idx) => ({
                studentId: student.id,
                studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
                studentClass: student.class || '',
                studentLevel: student.level || '',
                admissionNumber: student.admissionNumber || student.studentId || '',
                items: activeItems.map(i => ({ description: i.description, amount: Number(i.amount) || 0 })),
                subtotal,
                tax: 0,
                discount: 0,
                total: subtotal,
                term: structureToInvoice.term === 'all' ? selectedTerm : structureToInvoice.term,
                academicYear: String(structureToInvoice.year),
                dueDate: invoiceDueDate,
                notes: `Auto-generated from ${structureToInvoice.name || structureToInvoice.targetKey} Fee Schedule`,
                suffix: `struct_${Date.now()}_${idx}`
            }));

            const res = await createBulkInvoices(entries, {
                term: structureToInvoice.term === 'all' ? selectedTerm : structureToInvoice.term,
                year: structureToInvoice.year,
                createdBy: userData?.uid,
                createdByName: userData?.fullName || 'System'
            });

            if (res.errors?.length) {
                showNotification(`Created ${res.count} invoices; ${res.errors.length} batch(es) failed. ${res.errors[0].error}`, 'warning');
            } else {
                showNotification(`Created ${res.count} invoices. Outstanding balances have been updated.`, 'success');
            }
            setShowInvoiceModal(false);
            setStructureToInvoice(null);
        } catch (err) {
            showNotification(`Failed to generate invoices: ${err.message}`, 'error');
        } finally {
            setIsGeneratingInvoices(false);
        }
    };

    return (
        <Layout title="Fee Structure & Schedules">
            <div className="fee-structure-page" style={{ maxWidth: 1200, margin: '0 auto', paddingBottom: 60 }}>
                {/* Header Card */}
                <div style={{
                    background: '#fff',
                    borderRadius: 14,
                    padding: '24px 28px',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
                    marginBottom: 24,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 16
                }}>
                    <div>
                        <h2 style={{ margin: 0, color: '#1a237e', fontSize: 24, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
                            <i className="fas fa-file-invoice-dollar" style={{ color: 'var(--primary, #f39c12)' }}></i>
                            School Fee Structure & Schedules
                        </h2>
                        <p style={{ margin: '6px 0 0', color: '#666', fontSize: 14 }}>
                            Configure term fees by curriculum level or specific grade/class with category breakdowns and automatic student invoicing.
                        </p>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <button
                            type="button"
                            onClick={handleDownloadPDF}
                            disabled={exportingPDF || savedStructures.length === 0}
                            style={{
                                background: '#1a237e',
                                color: '#fff',
                                border: 'none',
                                padding: '9px 16px',
                                borderRadius: 8,
                                fontWeight: 600,
                                fontSize: 14,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 8,
                                cursor: 'pointer',
                                boxShadow: '0 2px 6px rgba(26, 35, 126, 0.2)'
                            }}
                        >
                            <i className={`fas ${exportingPDF ? 'fa-spinner fa-spin' : 'fa-file-pdf'}`}></i> {exportingPDF ? 'Exporting…' : 'Export Fee Structure PDF'}
                        </button>
                        <span style={{ fontWeight: 600, color: '#444', fontSize: 14 }}>Academic Year:</span>
                        <input
                            type="number"
                            value={selectedYear}
                            onChange={e => setSelectedYear(Number(e.target.value))}
                            style={{
                                width: 90,
                                padding: '8px 12px',
                                border: '1px solid #dcdfe6',
                                borderRadius: 8,
                                fontWeight: 700,
                                color: '#1a237e',
                                fontSize: 15
                            }}
                        />
                    </div>
                </div>

                {feedback.message && (
                    <div role={feedback.type === 'error' ? 'alert' : 'status'} style={{
                        padding: '14px 20px',
                        borderRadius: 10,
                        marginBottom: 20,
                        fontWeight: 600,
                        fontSize: 14,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        backgroundColor: feedback.type === 'success' ? '#e8f8f5' : feedback.type === 'error' ? '#fdeded' : '#fef9e7',
                        color: feedback.type === 'success' ? '#27ae60' : feedback.type === 'error' ? '#c0392b' : '#d35400',
                        border: `1px solid ${feedback.type === 'success' ? '#a3e4d7' : feedback.type === 'error' ? '#f5b7b1' : '#f9e79f'}`
                    }}>
                        <i className={`fas ${feedback.type === 'success' ? 'fa-check-circle' : feedback.type === 'error' ? 'fa-times-circle' : 'fa-exclamation-triangle'}`}></i>
                        {feedback.message}
                        <button type="button" aria-label="Dismiss message" onClick={() => setFeedback({ message: '', type: '' })} style={{ marginLeft: 'auto' }}>×</button>
                    </div>
                )}

                {/* Editor Container */}
                <div className="fee-structure-editor" style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(320px, 1fr) 340px',
                    gap: 24,
                    alignItems: 'start'
                }}>
                    {/* Main Form Box */}
                    <div className="fee-structure-form" style={{
                        background: '#fff',
                        borderRadius: 14,
                        padding: 24,
                        boxShadow: '0 2px 10px rgba(0,0,0,0.06)'
                    }}>
                        {/* Selector Controls */}
                        <div style={{
                            display: 'flex',
                            gap: 16,
                            flexWrap: 'wrap',
                            paddingBottom: 20,
                            borderBottom: '1px solid #edf2f7',
                            marginBottom: 20
                        }}>
                            {/* Target Type Toggle */}
                            <div style={{ flex: '1 1 200px' }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', marginBottom: 6 }}>
                                    Structure Applied To
                                </label>
                                <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 8, padding: 3 }}>
                                    <button
                                        type="button"
                                        onClick={() => setTargetType('level')}
                                        style={{
                                            flex: 1,
                                            padding: '8px 12px',
                                            border: 'none',
                                            borderRadius: 6,
                                            fontSize: 13,
                                            fontWeight: targetType === 'level' ? 700 : 500,
                                            background: targetType === 'level' ? '#fff' : 'transparent',
                                            color: targetType === 'level' ? '#1a237e' : '#64748b',
                                            boxShadow: targetType === 'level' ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
                                            cursor: 'pointer'
                                        }}
                                    >
                                        <i className="fas fa-layer-group" style={{ marginRight: 6 }}></i>
                                        By School Level
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setTargetType('class')}
                                        style={{
                                            flex: 1,
                                            padding: '8px 12px',
                                            border: 'none',
                                            borderRadius: 6,
                                            fontSize: 13,
                                            fontWeight: targetType === 'class' ? 700 : 500,
                                            background: targetType === 'class' ? '#fff' : 'transparent',
                                            color: targetType === 'class' ? '#1a237e' : '#64748b',
                                            boxShadow: targetType === 'class' ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
                                            cursor: 'pointer'
                                        }}
                                    >
                                        <i className="fas fa-chalkboard" style={{ marginRight: 6 }}></i>
                                        By Specific Class
                                    </button>
                                </div>
                            </div>

                            {/* Level or Class Selector */}
                            <div style={{ flex: '1 1 200px' }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', marginBottom: 6 }}>
                                    {targetType === 'level' ? 'Select Level' : 'Select Class'}
                                </label>
                                {targetType === 'level' ? (
                                    <select
                                        value={selectedLevel}
                                        onChange={e => setSelectedLevel(e.target.value)}
                                        style={{
                                            width: '100%',
                                            padding: '10px 12px',
                                            borderRadius: 8,
                                            border: '1px solid #cbd5e1',
                                            fontWeight: 600,
                                            color: '#1e293b'
                                        }}
                                    >
                                        {SCHOOL_LEVELS.map(lvl => (
                                            <option key={lvl.value} value={lvl.value}>
                                                {lvl.label} ({LEVEL_CLASSES[lvl.value]?.join(', ') || 'Classes'})
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <select
                                        value={selectedClass}
                                        onChange={e => setSelectedClass(e.target.value)}
                                        style={{
                                            width: '100%',
                                            padding: '10px 12px',
                                            borderRadius: 8,
                                            border: '1px solid #cbd5e1',
                                            fontWeight: 600,
                                            color: '#1e293b'
                                        }}
                                    >
                                        {availableClasses.map(cls => (
                                            <option key={cls} value={cls}>{cls}</option>
                                        ))}
                                    </select>
                                )}
                            </div>

                            {/* Term Selector */}
                            <div style={{ flex: '0 1 150px' }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', marginBottom: 6 }}>
                                    Academic Term
                                </label>
                                <select
                                    value={selectedTerm}
                                    onChange={e => setSelectedTerm(e.target.value)}
                                    style={{
                                        width: '100%',
                                        padding: '10px 12px',
                                        borderRadius: 8,
                                        border: '1px solid #cbd5e1',
                                        fontWeight: 600,
                                        color: '#1e293b'
                                    }}
                                >
                                    {TERMS.map(t => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        {/* Fast Presets */}
                        <div style={{ marginBottom: 20 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: 8 }}>
                                Quick Add Fee Categories
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                {FEE_CATEGORIES.map(cat => (
                                    <button
                                        key={cat.id}
                                        type="button"
                                        onClick={() => handleAddPreset(cat)}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            padding: '6px 12px',
                                            borderRadius: 20,
                                            border: '1px solid #e2e8f0',
                                            background: '#f8fafc',
                                            color: '#334155',
                                            fontSize: 12,
                                            fontWeight: 600,
                                            cursor: 'pointer',
                                            transition: 'all 0.15s'
                                        }}
                                        onMouseOver={e => e.currentTarget.style.borderColor = '#1a237e'}
                                        onMouseOut={e => e.currentTarget.style.borderColor = '#e2e8f0'}
                                    >
                                        <i className={`fas ${cat.icon}`} style={{ color: '#f39c12' }}></i>
                                        + {cat.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Fee Item Rows */}
                        <div style={{ marginBottom: 20 }}>
                            <div className="fee-items-heading" style={{
                                display: 'grid',
                                gridTemplateColumns: 'minmax(180px, 2fr) 140px 140px 90px 40px',
                                gap: 10,
                                padding: '8px 12px',
                                background: '#f8fafc',
                                borderRadius: 8,
                                fontSize: 12,
                                fontWeight: 700,
                                color: '#64748b',
                                textTransform: 'uppercase',
                                marginBottom: 10
                            }}>
                                <div>Description</div>
                                <div>Category</div>
                                <div>Amount (KES)</div>
                                <div style={{ textAlign: 'center' }}>Optional?</div>
                                <div></div>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                {items.map((item, idx) => (
                                    <div
                                        key={idx}
                                        className="fee-item-row"
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'minmax(180px, 2fr) 140px 140px 90px 40px',
                                            gap: 10,
                                            alignItems: 'center',
                                            padding: '10px 12px',
                                            background: item.optional ? '#fffaf0' : '#ffffff',
                                            border: `1px solid ${item.optional ? '#feebc8' : '#e2e8f0'}`,
                                            borderRadius: 8
                                        }}
                                    >
                                        <input
                                            type="text"
                                            placeholder="e.g. Term 1 Tuition Fee"
                                            value={item.description}
                                            onChange={e => handleUpdateItem(idx, 'description', e.target.value)}
                                            style={{
                                                padding: '8px 12px',
                                                border: '1px solid #cbd5e1',
                                                borderRadius: 6,
                                                fontSize: 14,
                                                fontWeight: 500
                                            }}
                                        />

                                        <select
                                            value={item.category || 'Tuition'}
                                            onChange={e => handleUpdateItem(idx, 'category', e.target.value)}
                                            style={{
                                                padding: '8px 10px',
                                                border: '1px solid #cbd5e1',
                                                borderRadius: 6,
                                                fontSize: 13,
                                                background: '#fff'
                                            }}
                                        >
                                            {FEE_CATEGORIES.map(c => (
                                                <option key={c.id} value={c.id}>{c.id}</option>
                                            ))}
                                        </select>

                                        <input
                                            type="number"
                                            min="0"
                                            step="50"
                                            placeholder="0.00"
                                            value={item.amount}
                                            onChange={e => handleUpdateItem(idx, 'amount', e.target.value)}
                                            style={{
                                                padding: '8px 12px',
                                                border: '1px solid #cbd5e1',
                                                borderRadius: 6,
                                                fontSize: 14,
                                                fontWeight: 700,
                                                color: '#1a237e',
                                                textAlign: 'right'
                                            }}
                                        />

                                        <div style={{ textAlign: 'center' }}>
                                            <input
                                                type="checkbox"
                                                id={`opt_${idx}`}
                                                checked={Boolean(item.optional)}
                                                onChange={e => handleUpdateItem(idx, 'optional', e.target.checked)}
                                                style={{ width: 18, height: 18, cursor: 'pointer' }}
                                            />
                                        </div>

                                        <button
                                            type="button"
                                            onClick={() => handleRemoveItem(idx)}
                                            title="Delete item"
                                            style={{
                                                background: '#fee2e2',
                                                color: '#ef4444',
                                                border: 'none',
                                                width: 34,
                                                height: 34,
                                                borderRadius: 6,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            <i className="fas fa-trash-alt" style={{ fontSize: 13 }}></i>
                                        </button>
                                    </div>
                                ))}
                            </div>

                            <button
                                type="button"
                                onClick={handleAddItem}
                                style={{
                                    marginTop: 14,
                                    padding: '10px 18px',
                                    border: '1px dashed #cbd5e1',
                                    borderRadius: 8,
                                    background: '#f8fafc',
                                    color: '#1a237e',
                                    fontWeight: 600,
                                    fontSize: 13,
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 8
                                }}
                            >
                                <i className="fas fa-plus"></i> Add Another Fee Line Item
                            </button>
                        </div>

                        {/* Actions bar */}
                        <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            borderTop: '1px solid #edf2f7',
                            paddingTop: 18,
                            flexWrap: 'wrap',
                            gap: 16
                        }}>
                            <div>
                                <span style={{ fontSize: 13, color: '#64748b' }}>Target: </span>
                                <strong style={{ color: '#1a237e' }}>{targetTitle} ({selectedTerm} {selectedYear})</strong>
                            </div>

                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={saving}
                                style={{
                                    padding: '12px 28px',
                                    background: 'var(--primary, #f39c12)',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: 8,
                                    fontWeight: 700,
                                    fontSize: 15,
                                    cursor: saving ? 'not-allowed' : 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    boxShadow: '0 3px 8px rgba(243, 156, 18, 0.3)'
                                }}
                            >
                                {saving ? (
                                    <>
                                        <i className="fas fa-spinner fa-spin"></i> Saving...
                                    </>
                                ) : (
                                    <>
                                        <i className="fas fa-save"></i> Save Fee Schedule
                                    </>
                                )}
                            </button>
                        </div>
                    </div>

                    {/* Right Summary Sidebar */}
                    <div className="fee-structure-sidebar" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                        {/* Summary Widget */}
                        <div style={{
                            background: '#1a237e',
                            color: '#fff',
                            borderRadius: 14,
                            padding: 24,
                            boxShadow: '0 4px 14px rgba(26, 35, 126, 0.25)'
                        }}>
                            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: '#e0e7ff', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                Fee Schedule Summary
                            </h3>

                            <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.15)' }}>
                                <div style={{ fontSize: 12, color: '#c7d2fe', marginBottom: 4 }}>Mandatory Fees (All Students)</div>
                                <div style={{ fontSize: 24, fontWeight: 800 }}>
                                    KES {mandatoryTotal.toLocaleString()}
                                </div>
                            </div>

                            <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid rgba(255,255,255,0.15)' }}>
                                <div style={{ fontSize: 12, color: '#fed7aa', marginBottom: 4 }}>Optional / Extra Programs</div>
                                <div style={{ fontSize: 20, fontWeight: 700, color: '#fef3c7' }}>
                                    KES {optionalTotal.toLocaleString()}
                                </div>
                            </div>

                            <div>
                                <div style={{ fontSize: 12, color: '#e0e7ff', marginBottom: 4 }}>Total Package Cost</div>
                                <div style={{ fontSize: 28, fontWeight: 900, color: '#38bdf8' }}>
                                    KES {grandTotal.toLocaleString()}
                                </div>
                            </div>
                        </div>

                        {/* Enrolled Students Quick Info */}
                        <div style={{
                            background: '#fff',
                            borderRadius: 14,
                            padding: 20,
                            boxShadow: '0 2px 10px rgba(0,0,0,0.06)'
                        }}>
                            <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#1e293b' }}>
                                <i className="fas fa-users" style={{ color: 'var(--primary, #f39c12)', marginRight: 8 }}></i>
                                Enrolled Students in Scope
                            </h4>
                            <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                                Students who match <strong>{targetTitle}</strong>:
                            </div>
                            <div style={{
                                fontSize: 26,
                                fontWeight: 800,
                                color: '#1a237e',
                                marginBottom: 14
                            }}>
                                {students.filter(s => targetType === 'level' ? s.level === selectedLevel : s.class === selectedClass).length} Students
                            </div>

                            <button
                                type="button"
                                onClick={() => {
                                    const mockStruct = {
                                        targetType,
                                        targetKey,
                                        name: targetTitle,
                                        term: selectedTerm,
                                        year: selectedYear,
                                        items
                                    };
                                    setStructureToInvoice(mockStruct);
                                    setShowInvoiceModal(true);
                                }}
                                style={{
                                    width: '100%',
                                    padding: '11px',
                                    background: '#047857',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: 8,
                                    fontWeight: 700,
                                    fontSize: 13,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: 8
                                }}
                            >
                                <i className="fas fa-paper-plane"></i>
                                Generate Invoices for Students
                            </button>
                        </div>
                    </div>
                </div>

                {/* All Configured Schedules Matrix */}
                <div style={{
                    marginTop: 36,
                    background: '#fff',
                    borderRadius: 14,
                    padding: 24,
                    boxShadow: '0 2px 10px rgba(0,0,0,0.06)'
                }}>
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 18,
                        flexWrap: 'wrap',
                        gap: 12
                    }}>
                        <div>
                            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1e293b' }}>
                                Configured Fee Structures ({selectedYear})
                            </h3>
                            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
                                All active fee schedules across levels and classes for the school.
                            </p>
                        </div>

                        <button
                            type="button"
                            onClick={loadSavedStructures}
                            style={{
                                padding: '8px 16px',
                                border: '1px solid #cbd5e1',
                                background: '#f8fafc',
                                borderRadius: 8,
                                fontSize: 13,
                                fontWeight: 600,
                                color: '#1a237e',
                                cursor: 'pointer'
                            }}
                        >
                            <i className="fas fa-sync-alt" style={{ marginRight: 6 }}></i> Refresh Schedules
                        </button>
                    </div>

                    {loadingStructures ? (
                        <div style={{ textAlign: 'center', padding: 40 }}><LoadingSpinner /></div>
                    ) : savedStructures.length === 0 ? (
                        <div style={{
                            textAlign: 'center',
                            padding: '40px 20px',
                            background: '#f8fafc',
                            borderRadius: 10,
                            color: '#64748b'
                        }}>
                            <i className="fas fa-file-invoice" style={{ fontSize: 32, marginBottom: 10, color: '#cbd5e1' }}></i>
                            <div>No fee structures configured for {selectedYear} yet.</div>
                            <div style={{ fontSize: 12, marginTop: 4 }}>Select a level or class above and click "Save Fee Schedule".</div>
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                                <thead>
                                    <tr style={{ background: '#f1f5f9', color: '#475569', textAlign: 'left' }}>
                                        <th style={{ padding: '12px 14px', borderRadius: '8px 0 0 8px' }}>Target</th>
                                        <th style={{ padding: '12px 14px' }}>Type</th>
                                        <th style={{ padding: '12px 14px' }}>Term</th>
                                        <th style={{ padding: '12px 14px' }}>Mandatory</th>
                                        <th style={{ padding: '12px 14px' }}>Optional</th>
                                        <th style={{ padding: '12px 14px' }}>Total Amount</th>
                                        <th style={{ padding: '12px 14px', textAlign: 'right', borderRadius: '0 8px 8px 0' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {savedStructures.map(s => {
                                        const title = s.name || (s.targetType === 'level' ? LEVEL_DISPLAY_NAMES[s.targetKey] || s.targetKey : s.targetKey);
                                        const mand = s.mandatoryAmount || (s.items || []).filter(i => !i.optional).reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
                                        const opt = s.optionalAmount || (s.items || []).filter(i => i.optional).reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
                                        const tot = s.totalAmount || (mand + opt);

                                        return (
                                            <tr key={s.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                                <td style={{ padding: '14px 14px', fontWeight: 700, color: '#1a237e' }}>
                                                    {title}
                                                </td>
                                                <td style={{ padding: '14px 14px' }}>
                                                    <span style={{
                                                        padding: '3px 8px',
                                                        borderRadius: 6,
                                                        fontSize: 11,
                                                        fontWeight: 700,
                                                        textTransform: 'uppercase',
                                                        background: s.targetType === 'level' ? '#e0e7ff' : '#ecfdf5',
                                                        color: s.targetType === 'level' ? '#3730a3' : '#065f46'
                                                    }}>
                                                        {s.targetType || 'level'}
                                                    </span>
                                                </td>
                                                <td style={{ padding: '14px 14px', fontWeight: 600 }}>
                                                    {s.term || 'All Terms'}
                                                </td>
                                                <td style={{ padding: '14px 14px', color: '#166534', fontWeight: 600 }}>
                                                    KES {mand.toLocaleString()}
                                                </td>
                                                <td style={{ padding: '14px 14px', color: '#854d0e' }}>
                                                    KES {opt.toLocaleString()}
                                                </td>
                                                <td style={{ padding: '14px 14px', fontWeight: 800, color: '#0f172a' }}>
                                                    KES {tot.toLocaleString()}
                                                </td>
                                                <td style={{ padding: '14px 14px', textAlign: 'right' }}>
                                                    <div style={{ display: 'inline-flex', gap: 6 }}>
                                                        <button
                                                            type="button"
                                                            title="Generate Invoices for Enrolled Students"
                                                            onClick={() => {
                                                                setStructureToInvoice(s);
                                                                setShowInvoiceModal(true);
                                                            }}
                                                            style={{
                                                                padding: '6px 10px',
                                                                borderRadius: 6,
                                                                border: 'none',
                                                                background: '#ecfdf5',
                                                                color: '#059669',
                                                                fontSize: 12,
                                                                fontWeight: 700,
                                                                cursor: 'pointer'
                                                            }}
                                                        >
                                                            <i className="fas fa-file-invoice" style={{ marginRight: 4 }}></i>
                                                            Invoice
                                                        </button>

                                                        <button
                                                            type="button"
                                                            title="Export Schedule to PDF"
                                                            onClick={() => handleDownloadSingleSchedulePDF(s)}
                                                            style={{
                                                                padding: '6px 10px',
                                                                borderRadius: 6,
                                                                border: 'none',
                                                                background: '#e0e7ff',
                                                                color: '#3730a3',
                                                                fontSize: 12,
                                                                fontWeight: 700,
                                                                cursor: 'pointer'
                                                            }}
                                                        >
                                                            <i className="fas fa-file-pdf" style={{ marginRight: 4 }}></i>
                                                            PDF
                                                        </button>

                                                        <button
                                                            type="button"
                                                            title="Edit this structure"
                                                            onClick={() => {
                                                                setTargetType(s.targetType || 'level');
                                                                if (s.targetType === 'class') setSelectedClass(s.targetKey);
                                                                else setSelectedLevel(s.targetKey);
                                                                if (s.term && s.term !== 'all') setSelectedTerm(s.term);
                                                                if (s.items) setItems(s.items);
                                                                window.scrollTo({ top: 0, behavior: 'smooth' });
                                                            }}
                                                            style={{
                                                                padding: '6px 10px',
                                                                borderRadius: 6,
                                                                border: '1px solid #cbd5e1',
                                                                background: '#fff',
                                                                color: '#334155',
                                                                fontSize: 12,
                                                                cursor: 'pointer'
                                                            }}
                                                        >
                                                            <i className="fas fa-edit"></i>
                                                        </button>

                                                        <button
                                                            type="button"
                                                            title="Delete"
                                                            onClick={() => handleDeleteStructure(s.id, title)}
                                                            style={{
                                                                padding: '6px 10px',
                                                                borderRadius: 6,
                                                                border: 'none',
                                                                background: '#fee2e2',
                                                                color: '#dc2626',
                                                                fontSize: 12,
                                                                cursor: 'pointer'
                                                            }}
                                                        >
                                                            <i className="fas fa-trash"></i>
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Bulk Invoice Modal from Structure */}
                {showInvoiceModal && structureToInvoice && (
                    <div style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        background: 'rgba(0,0,0,0.5)',
                        zIndex: 9999,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 16
                    }}>
                        <div style={{
                            background: '#fff',
                            borderRadius: 14,
                            maxWidth: 540,
                            width: '100%',
                            padding: 24,
                            boxShadow: '0 10px 30px rgba(0,0,0,0.2)'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                <h3 style={{ margin: 0, color: '#1a237e', fontSize: 18, fontWeight: 700 }}>
                                    <i className="fas fa-file-invoice-dollar" style={{ color: '#f39c12', marginRight: 8 }}></i>
                                    Generate Invoices from Fee Schedule
                                </h3>
                                <button
                                    type="button"
                                    onClick={() => setShowInvoiceModal(false)}
                                    style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#94a3b8' }}
                                >
                                    &times;
                                </button>
                            </div>

                            <p style={{ color: '#475569', fontSize: 14, margin: '0 0 16px' }}>
                                This will generate formal school fee invoices for all active students matching <strong>{structureToInvoice.name || structureToInvoice.targetKey}</strong>.
                            </p>

                            <div style={{
                                background: '#f8fafc',
                                borderRadius: 10,
                                padding: 14,
                                marginBottom: 18,
                                border: '1px solid #e2e8f0'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                                    <span style={{ color: '#64748b', fontSize: 13 }}>Target Group:</span>
                                    <strong style={{ color: '#1a237e' }}>{structureToInvoice.name || structureToInvoice.targetKey}</strong>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                                    <span style={{ color: '#64748b', fontSize: 13 }}>Academic Term:</span>
                                    <strong>{structureToInvoice.term || selectedTerm} ({structureToInvoice.year || selectedYear})</strong>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                                    <span style={{ color: '#64748b', fontSize: 13 }}>Matching Students:</span>
                                    <strong style={{ color: '#059669' }}>{eligibleStudents.length} Students</strong>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: '#64748b', fontSize: 13 }}>Items Included:</span>
                                    <strong>{(structureToInvoice.items || []).length} Line Items</strong>
                                </div>
                            </div>

                            <div style={{ marginBottom: 16 }}>
                                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 }}>
                                    Invoice Due Date
                                </label>
                                <input
                                    type="date"
                                    value={invoiceDueDate}
                                    onChange={e => setInvoiceDueDate(e.target.value)}
                                    style={{
                                        width: '100%',
                                        padding: '10px 12px',
                                        borderRadius: 8,
                                        border: '1px solid #cbd5e1',
                                        fontSize: 14
                                    }}
                                />
                            </div>

                            <div style={{ marginBottom: 20 }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: '#334155' }}>
                                    <input
                                        type="checkbox"
                                        checked={includeOptionalInInvoicing}
                                        onChange={e => setIncludeOptionalInInvoicing(e.target.checked)}
                                        style={{ width: 18, height: 18 }}
                                    />
                                    Include Optional / Extra Items (Meals, Transport, etc.) on these invoices
                                </label>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                                <button
                                    type="button"
                                    onClick={() => setShowInvoiceModal(false)}
                                    style={{
                                        padding: '10px 18px',
                                        borderRadius: 8,
                                        border: '1px solid #cbd5e1',
                                        background: '#fff',
                                        color: '#475569',
                                        fontWeight: 600,
                                        cursor: 'pointer'
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={handleExecuteInvoicing}
                                    disabled={isGeneratingInvoices || eligibleStudents.length === 0}
                                    style={{
                                        padding: '10px 24px',
                                        borderRadius: 8,
                                        border: 'none',
                                        background: eligibleStudents.length === 0 ? '#94a3b8' : '#059669',
                                        color: '#fff',
                                        fontWeight: 700,
                                        cursor: eligibleStudents.length === 0 || isGeneratingInvoices ? 'not-allowed' : 'pointer',
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 8
                                    }}
                                >
                                    {isGeneratingInvoices ? (
                                        <>
                                            <i className="fas fa-spinner fa-spin"></i> Generating...
                                        </>
                                    ) : (
                                        <>
                                            <i className="fas fa-check"></i> Generate {eligibleStudents.length} Invoices
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

            </div>
        </Layout>
    );
}
