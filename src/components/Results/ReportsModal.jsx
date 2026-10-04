// src/components/Results/ReportsModal.jsx
import React from 'react';
import { getCBCGrade, computeScorePercentage } from '../../utils/constants';

export default function ReportModal({ student, scores, meta, onClose, onDownloadPDF }) {
    const subjects = meta.subjects || [];

    // Group scores by subject → assessment type
    const subjectMap = {};
    subjects.forEach(sub => {
        subjectMap[sub] = { 'Assessment 1': null, 'Assessment 2': null, 'Assessment 3': null };
    });

    scores.forEach(sc => {
        if (sc.subject && subjectMap[sc.subject]) {
            const asm = sc.assessmentType || 'Assessment 1';
            subjectMap[sc.subject][asm] = sc; // keep the whole record for paper detail
        }
    });

    let totalMarks = 0, count = 0;
    const computedSubjects = subjects.map(sub => {
        const recs = ['Assessment 1', 'Assessment 2', 'Assessment 3']
            .map(a => subjectMap[sub][a])
            .filter(Boolean);
        const pcts = recs.map(r => computeScorePercentage(r)).filter(v => v != null);
        const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;
        if (avg !== null) { totalMarks += avg; count++; }
        return {
            subject: sub,
            a1: subjectMap[sub]['Assessment 1'],
            a2: subjectMap[sub]['Assessment 2'],
            a3: subjectMap[sub]['Assessment 3'],
            average: avg,
            grade: avg !== null ? getCBCGrade(avg) : { code: '-', label: 'Not Assessed' }
        };
    });

    const overallAvg = count ? Math.round(totalMarks / count) : 0;
    const overallGrade = getCBCGrade(overallAvg);

    const renderScoreCell = (rec) => {
        if (!rec) return '-';
        const pct = computeScorePercentage(rec);
        if (rec.papers && Object.keys(rec.papers).length > 0) {
            return (
                <div style={{ fontSize: 11, lineHeight: 1.4, textAlign: 'left' }}>
                    {Object.entries(rec.papers).map(([name, p]) => (
                        <div key={name}>
                            <strong>{name}:</strong> {p.score ?? '—'}/{p.max ?? '—'}
                        </div>
                    ))}
                    <div style={{ color: 'var(--primary)', fontWeight: 700, marginTop: 2 }}>
                        = {pct}%
                    </div>
                </div>
            );
        }
        return (
            <div style={{ textAlign: 'center' }}>
                <div>{rec.score}/{rec.maxScore || 100}</div>
                <div style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 700 }}>{pct}%</div>
            </div>
        );
    };

    return (
        <div style={overlay}>
            <div style={{ ...modal, maxWidth: 800 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20, alignItems: 'center' }}>
                    <div>
                        <h2 style={{ margin: 0, color: 'var(--primary)' }}>{meta.schoolName || 'EDUPRIVA'}</h2>
                        <p style={{ fontSize: '13px', color: 'var(--gray)', margin: '2px 0 0 0' }}>{meta.schoolMotto}</p>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button onClick={onDownloadPDF} style={{ ...btn, background: '#e74c3c' }}>
                            <i className="fas fa-file-pdf"></i> Download PDF
                        </button>
                        <button onClick={onClose} style={btn}><i className="fas fa-times"></i> Close</button>
                    </div>
                </div>

                <div style={{ background: 'var(--light)', padding: '15px', borderRadius: '10px', marginBottom: '20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '14px' }}>
                    <div><strong>Student Name:</strong> {student.firstName} {student.lastName}</div>
                    <div><strong>Admission No:</strong> {student.admissionNumber || student.studentId || 'N/A'}</div>
                    <div><strong>Class / Level:</strong> {meta.cls} ({meta.level})</div>
                    <div><strong>Term:</strong> {meta.term}</div>
                </div>

                <div style={{ overflowX: 'auto', marginBottom: '20px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                            <tr style={{ background: 'var(--primary)', color: 'white' }}>
                                <th style={th}>Subject</th>
                                <th style={{ ...th, textAlign: 'center' }}>Assessment 1</th>
                                <th style={{ ...th, textAlign: 'center' }}>Assessment 2</th>
                                <th style={{ ...th, textAlign: 'center' }}>Assessment 3</th>
                                <th style={{ ...th, textAlign: 'center' }}>Average</th>
                                <th style={{ ...th, textAlign: 'center' }}>Grade</th>
                            </tr>
                        </thead>
                        <tbody>
                            {computedSubjects.map((item, idx) => (
                                <tr key={idx} style={{ borderBottom: '1px solid var(--border)' }}>
                                    <td style={td}>{item.subject}</td>
                                    <td style={{ ...td, textAlign: 'center' }}>{renderScoreCell(item.a1)}</td>
                                    <td style={{ ...td, textAlign: 'center' }}>{renderScoreCell(item.a2)}</td>
                                    <td style={{ ...td, textAlign: 'center' }}>{renderScoreCell(item.a3)}</td>
                                    <td style={{ ...td, textAlign: 'center', fontWeight: 'bold' }}>{item.average !== null ? `${item.average}%` : '-'}</td>
                                    <td style={{ ...td, textAlign: 'center', fontWeight: 'bold', color: 'var(--primary)' }}>{item.grade.code}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div style={{ background: '#f8f9fa', padding: '15px', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <span style={{ fontSize: '15px', fontWeight: '600' }}>Overall Average: </span>
                        <span style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--primary)' }}>{overallAvg}%</span>
                    </div>
                    <div>
                        <span style={{ fontSize: '15px', fontWeight: '600' }}>Overall Grade: </span>
                        <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#27ae60' }}>{overallGrade.code} ({overallGrade.label})</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 };
const modal = { background: 'white', borderRadius: 16, maxWidth: 800, width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 30 };
const btn = { padding: '10px 18px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' };
const th = { padding: '10px 12px', textAlign: 'left' };
const td = { padding: '10px 12px' };
