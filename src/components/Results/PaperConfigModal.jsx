// src/components/Results/PaperConfigModal.jsx
import React, { useState } from 'react';
import { validatePaperConfig } from '../../utils/constants';

/**
 * Configure multi-paper subjects.
 *
 * The `showBranchesOnReport` toggle controls whether the individual papers
 * (branches) are printed on the report form as indented sub-rows under the
 * subject. Only the subject total is ever graded.
 */
export default function PaperConfigModal({
    subject,
    level,
    initialPapers = [],
    initialShowBranchesOnReport = false,
    onSave,
    onClose,
}) {
    const [papers, setPapers] = useState(
        initialPapers.length > 0 ? initialPapers.map(p => ({ ...p })) : []
    );
    const [showBranchesOnReport, setShowBranchesOnReport] = useState(
        !!initialShowBranchesOnReport
    );

    const addPaper = () => {
        setPapers(prev => [...prev, { name: `Paper ${prev.length + 1}`, maxScore: 100, weight: 0 }]);
    };

    const updatePaper = (i, field, value) => {
        setPapers(prev => {
            const next = [...prev];
            next[i] = { ...next[i], [field]: value };
            return next;
        });
    };

    const removePaper = (i) => {
        setPapers(prev => prev.filter((_, idx) => idx !== i));
    };

    const totalWeight = papers.reduce((s, p) => s + (Number(p.weight) || 0), 0);
    const { valid, errors } = validatePaperConfig(papers);

    return (
        <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div style={modal}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
                    <h2 style={{ fontSize: 20, color: 'var(--secondary)' }}>
                        Papers — {subject} ({level})
                    </h2>
                    <button onClick={onClose} style={closeBtn}><i className="fas fa-times"></i></button>
                </div>

                <p style={{ fontSize: 13, color: 'var(--gray)', marginBottom: 16 }}>
                    Leave empty for a single-paper subject. Add one row per paper; weights must sum to <strong>100%</strong>.
                </p>

                {/* Report display toggle */}
                <label style={toggleRowStyle}>
                    <input
                        type="checkbox"
                        checked={showBranchesOnReport}
                        onChange={(e) => setShowBranchesOnReport(e.target.checked)}
                        style={{ width: 18, height: 18, accentColor: 'var(--primary)' }}
                    />
                    <span>
                        <strong>Show branches on report form</strong>
                        <span style={toggleSubStyle}>
                            When enabled, each paper appears as an indented sub-row under
                            the subject on the printed report form, followed by the
                            subject total. Only the subject total is graded.
                        </span>
                    </span>
                </label>

                {papers.length > 0 && (
                    <div style={{ display: 'grid', gap: 8 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 36px', gap: 8, fontSize: 11, fontWeight: 700, color: 'var(--gray)' }}>
                            <span>Paper Name</span>
                            <span>Max Score</span>
                            <span>Weight (%)</span>
                            <span></span>
                        </div>
                        {papers.map((p, i) => (
                            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 36px', gap: 8, alignItems: 'center' }}>
                                <input
                                    value={p.name || ''}
                                    onChange={(e) => updatePaper(i, 'name', e.target.value)}
                                    placeholder={`Paper ${i + 1}`}
                                    style={inputStyle}
                                />
                                <input
                                    type="number"
                                    min="1"
                                    value={p.maxScore ?? ''}
                                    onChange={(e) => updatePaper(i, 'maxScore', e.target.value)}
                                    style={inputStyle}
                                />
                                <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    value={p.weight ?? ''}
                                    onChange={(e) => updatePaper(i, 'weight', e.target.value)}
                                    style={inputStyle}
                                />
                                <button onClick={() => removePaper(i)} style={{ ...closeBtn, width: 32, height: 32, fontSize: 14 }}>
                                    <i className="fas fa-trash"></i>
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button onClick={addPaper} style={addBtn}>
                        <i className="fas fa-plus"></i> Add Paper
                    </button>
                    <span style={{ fontSize: 13, fontWeight: 600, color: Math.abs(totalWeight - 100) < 0.01 ? 'var(--success)' : 'var(--danger)' }}>
                        Total weight: {totalWeight}%
                    </span>
                </div>

                {!valid && errors.length > 0 && (
                    <div style={{ marginTop: 12, padding: 10, background: '#fee2e2', color: '#991b1b', borderRadius: 8, fontSize: 12 }}>
                        {errors.map((e, i) => <div key={i}>• {e}</div>)}
                    </div>
                )}

                <div style={modalFooter}>
                    <button onClick={onClose} style={cancelBtn}>Cancel</button>
                    <button
                        onClick={() => onSave({
                            papers,
                            showBranchesOnReport: !!showBranchesOnReport,
                        })}
                        disabled={!valid}
                        style={{ ...saveBtn, opacity: valid ? 1 : 0.5, cursor: valid ? 'pointer' : 'not-allowed' }}
                    >
                        <i className="fas fa-save"></i> Save Paper Config
                    </button>
                </div>
            </div>
        </div>
    );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 };
const modal = { background: 'white', borderRadius: 16, maxWidth: 640, width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 26 };
const closeBtn = { width: 40, height: 40, border: 'none', borderRadius: '50%', background: 'var(--light)', cursor: 'pointer', fontSize: 18 };
const inputStyle = { padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, width: '100%' };
const addBtn = { padding: '8px 14px', background: '#eef2ff', color: '#3730a3', border: '1px solid #c7d2fe', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const modalFooter = { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' };
const cancelBtn = { padding: '10px 18px', background: 'transparent', border: '2px solid var(--border)', borderRadius: 8, fontWeight: 600, cursor: 'pointer', color: 'var(--secondary)' };
const saveBtn = { padding: '10px 18px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: 8, fontWeight: 600 };
const toggleRowStyle = {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: 12, background: '#f8fafc',
    border: '1px solid var(--border)', borderRadius: 10,
    cursor: 'pointer', fontWeight: 600, color: 'var(--secondary)',
    marginBottom: 16,
};
const toggleSubStyle = {
    display: 'block', fontSize: 12, fontWeight: 400,
    color: 'var(--gray)', marginTop: 3, lineHeight: 1.5,
};
