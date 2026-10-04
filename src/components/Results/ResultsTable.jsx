// src/components/Results/ResultsTable.jsx
import React, { useMemo } from 'react';
import { getCBCGrade } from '../../utils/constants';
import ScoreEntryCell from './ScoreEntryCell';

export default function ResultsTable({
    students, pendingInputs, setPendingInputs, isReadOnly,
    currentPage, setCurrentPage, pageSize,
    onSaveAll, saving, onPublish, onViewScores, onGenerateReport, onDownloadPDF,
    paperConfig = []   // NEW
}) {
    const sorted = useMemo(
        () => [...students].sort((a, b) => (b.average || 0) - (a.average || 0)),
        [students]
    );

    const pageData = useMemo(() => {
        const start = (currentPage - 1) * pageSize;
        return sorted.slice(start, start + pageSize);
    }, [sorted, currentPage, pageSize]);

    const totalPages = Math.ceil(sorted.length / pageSize);

    if (students.length === 0) {
        return <div style={{ textAlign: 'center', padding: 60, color: '#95a5a6' }}>No students.</div>;
    }

    return (
        <div style={{ background: 'white', borderRadius: 12, boxShadow: '0 4px 6px rgba(0,0,0,0.07)' }}>
            <div style={{ display: 'flex', gap: 10, padding: 15, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <button
                    onClick={onSaveAll}
                    disabled={saving || isReadOnly || Object.keys(pendingInputs).length === 0}
                    style={{ padding: '10px 20px', background: 'var(--success)', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}
                >
                    <i className="fas fa-save"></i> {saving ? 'Saving...' : `Save All (${Object.keys(pendingInputs).length})`}
                </button>
            </div>

            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ background: 'var(--primary)', color: 'white' }}>
                            <th style={{ padding: '12px 15px', textAlign: 'left' }}>#</th>
                            <th style={{ padding: '12px 15px', textAlign: 'left' }}>Student</th>
                            <th style={{ padding: '12px 15px' }}>Adm No</th>
                            <th style={{ padding: '12px 15px' }}>Score</th>
                            <th style={{ padding: '12px 15px' }}>Grade</th>
                            <th style={{ padding: '12px 15px' }}>Points</th>
                            <th style={{ padding: '12px 15px' }}>Status</th>
                            <th style={{ padding: '12px 15px' }}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {pageData.map((s, i) => {
                            const rank = (currentPage - 1) * pageSize + i + 1;
                            const grade = getCBCGrade(s.average || 0);
                            const pending = pendingInputs[s.id] !== undefined;
                            return (
                                <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                    <td style={{ padding: '10px 15px' }}>#{rank}</td>
                                    <td style={{ padding: '10px 15px' }}>{s.firstName} {s.lastName}</td>
                                    <td style={{ padding: '10px 15px' }}>{s.admissionNumber || s.studentId || 'N/A'}</td>
                                    <td style={{ padding: '10px 15px' }}>
                                        <ScoreEntryCell
                                            studentId={s.id}
                                            papers={paperConfig}
                                            value={pending ? pendingInputs[s.id] : undefined}
                                            currentRecord={s.currentRecord}
                                            isReadOnly={isReadOnly}
                                            onChange={(v) => setPendingInputs(prev => ({ ...prev, [s.id]: v }))}
                                        />
                                        <div style={{ fontSize: 10, color: 'var(--gray)' }}>
                                            Avg: {s.average ?? 'N/A'}%
                                        </div>
                                    </td>
                                    <td style={{ padding: '10px 15px' }}>{grade.code}</td>
                                    <td style={{ padding: '10px 15px' }}>{grade.points.toFixed(1)}</td>
                                    <td style={{ padding: '10px 15px' }}>{s.status}</td>
                                    <td style={{ padding: '10px 15px', display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                        <button onClick={() => onViewScores(s)} title="History" style={btn('#3498db')}><i className="fas fa-history"></i></button>
                                        <button onClick={() => onGenerateReport(s)} title="Report" style={btn('var(--primary)')}><i className="fas fa-file-alt"></i></button>
                                        <button onClick={() => onDownloadPDF(s)} title="PDF" style={btn('#e74c3c')}><i className="fas fa-file-pdf"></i></button>
                                        {s.status === 'pending' && s.average !== null && !isReadOnly && (
                                            <button onClick={() => onPublish(s.id)} title="Publish" style={btn('var(--warning)')}><i className="fas fa-check"></i></button>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', padding: 15, borderTop: '1px solid var(--border)' }}>
                <div>Showing {Math.min((currentPage - 1) * pageSize + 1, sorted.length)}-{Math.min(currentPage * pageSize, sorted.length)} of {sorted.length}</div>
                <div style={{ display: 'flex', gap: 5 }}>
                    <button disabled={currentPage === 1} onClick={() => setCurrentPage(currentPage - 1)}>Prev</button>
                    <span>{currentPage} / {totalPages}</span>
                    <button disabled={currentPage >= totalPages} onClick={() => setCurrentPage(currentPage + 1)}>Next</button>
                </div>
            </div>
        </div>
    );
}

const btn = (bg) => ({
    background: bg, color: 'white', border: 'none',
    borderRadius: 6, padding: '5px 10px', cursor: 'pointer'
});
