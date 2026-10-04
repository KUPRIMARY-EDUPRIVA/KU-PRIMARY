// src/components/Results/ScoreHistoryModal.jsx
import React from 'react';
import { getCBCGrade, computeScorePercentage } from '../../utils/constants';

export default function ScoreHistoryModal({ student, scores, context, onClose }) {
    const sorted = React.useMemo(() => {
        return [...(scores || [])].sort((a, b) => {
            const ta = a.recordedAt?.toDate?.()?.getTime?.() || new Date(a.recordedAt || 0).getTime();
            const tb = b.recordedAt?.toDate?.()?.getTime?.() || new Date(b.recordedAt || 0).getTime();
            return tb - ta;
        });
    }, [scores]);

    const avg = sorted.length
        ? Math.round(sorted.reduce((sum, s) => sum + (computeScorePercentage(s) || 0), 0) / sorted.length)
        : 0;

    const overall = getCBCGrade(avg);

    return (
        <div style={overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div style={modal}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 25 }}>
                    <h2 style={{ fontSize: 22, color: 'var(--secondary)' }}>
                        Scores — {student?.firstName || ''} {student?.lastName || ''}
                    </h2>
                    <button onClick={onClose} style={closeBtn} title="Close"><i className="fas fa-times"></i></button>
                </div>

                <div style={{ marginBottom: 15, padding: 12, background: 'var(--light)', borderRadius: 8, fontSize: 13 }}>
                    <div><strong>Class:</strong> {context?.cls || 'N/A'}</div>
                    <div><strong>Subject:</strong> {context?.subject || 'N/A'}</div>
                    <div><strong>Term:</strong> {context?.term || 'N/A'}</div>
                    <div><strong>Average:</strong> {avg > 0 ? `${avg}%` : 'N/A'}</div>
                </div>

                {sorted.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 30, color: 'var(--gray)' }}>
                        <i className="fas fa-info-circle" style={{ fontSize: 24, display: 'block', marginBottom: 10 }} />
                        No scores recorded yet.
                    </div>
                ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                            <tr style={{ background: 'var(--primary)', color: 'white' }}>
                                <th style={th}>Date</th>
                                <th style={th}>Raw</th>
                                <th style={th}>%</th>
                                <th style={th}>CBC</th>
                                <th style={th}>Points</th>
                                <th style={th}>Assessment</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sorted.map((s, i) => {
                                const date = s.recordedAt?.toDate?.() || (s.recordedAt ? new Date(s.recordedAt) : null);
                                const valid = date && !isNaN(date.getTime());
                                const pct = computeScorePercentage(s);
                                const g = getCBCGrade(pct || 0);
                                const isMulti = s.papers && Object.keys(s.papers).length > 0;
                                return (
                                    <tr key={s.id || i} style={{ borderBottom: '1px solid var(--border)' }}>
                                        <td style={td}>{valid ? date.toLocaleDateString() : 'N/A'}</td>
                                        <td style={{ ...td, textAlign: 'center' }}>
                                            {isMulti ? (
                                                <div style={{ fontSize: 11, lineHeight: 1.5 }}>
                                                    {Object.entries(s.papers).map(([name, p]) => (
                                                        <div key={name}>
                                                            {name}: {p.score ?? '—'}/{p.max ?? '—'}
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <span>{s.score}/{s.maxScore || 100}</span>
                                            )}
                                        </td>
                                        <td style={{ ...td, textAlign: 'center', fontWeight: 600 }}>{pct ?? '—'}%</td>
                                        <td style={{ ...td, textAlign: 'center' }}>
                                            <span style={{
                                                display: 'inline-block', padding: '2px 8px', borderRadius: 12,
                                                fontSize: 11, fontWeight: 700,
                                                background: badgeBg(g.level), color: badgeColor(g.level)
                                            }}>
                                                {g.code}
                                            </span>
                                        </td>
                                        <td style={{ ...td, textAlign: 'center', fontWeight: 700 }}>{g.points.toFixed(1)}</td>
                                        <td style={td}>
                                            <span style={{ fontSize: 11, padding: '2px 10px', background: 'var(--light)', borderRadius: 10, textTransform: 'capitalize' }}>
                                                {s.assessmentType || 'N/A'}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}

                {sorted.length > 0 && (
                    <div style={{ marginTop: 20, paddingTop: 15, borderTop: '1px solid var(--border)', fontSize: 13 }}>
                        <div><strong>Total Assessments:</strong> {sorted.length}</div>
                        <div><strong>Average Score:</strong> {avg}%</div>
                        <div><strong>CBC Level:</strong> {overall.label}</div>
                    </div>
                )}
            </div>
        </div>
    );
}

function badgeBg(level) {
    return level === 'EE' ? '#d4edda' : level === 'ME' ? '#d1ecf1' : level === 'AE' ? '#fff3cd' : '#f8d7da';
}
function badgeColor(level) {
    return level === 'EE' ? '#155724' : level === 'ME' ? '#0c5460' : level === 'AE' ? '#856404' : '#721c24';
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 };
const modal = { background: 'white', borderRadius: 16, maxWidth: 900, width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 30 };
const closeBtn = { width: 40, height: 40, border: 'none', borderRadius: '50%', background: 'var(--light)', cursor: 'pointer', fontSize: 18 };
const th = { padding: '10px 12px', textAlign: 'left' };
const td = { padding: '8px 12px' };
