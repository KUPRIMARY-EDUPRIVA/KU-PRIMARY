// src/components/Results/ScoreEntryCell.jsx
import React, { useState } from 'react';
import { paperPercentage, computePapersPercentage } from '../../utils/constants';

/**
 * Renders a score entry cell.
 *
 * Props:
 *   studentId
 *   papers         — array of { name, maxScore, weight }, empty for single-paper
 *   value          — current value from pendingInputs[studentId]
 *                    { score, maxScore } | { papers: {...} } | undefined
 *   onChange(newValue)
 *   isReadOnly
 *   currentRecord  — existing stored record (for showing saved state when no pending)
 */
export default function ScoreEntryCell({
  studentId, papers = [], value, onChange, isReadOnly, currentRecord
}) {
  const [expanded, setExpanded] = useState(false);
  const isMulti = Array.isArray(papers) && papers.length > 0;

  const pending = value !== undefined && value !== null;

  // ---------- Multi-paper ----------
  if (isMulti) {
    const paperValues = (pending ? value?.papers : currentRecord?.papers) || {};
    const finalPct = pending
      ? computePapersPercentage(
          Object.entries(paperValues).map(([name, p]) => ({ name, ...p }))
        )
      : currentRecord?.computedPercentage;

    const handlePaperChange = (name, field, val) => {
      const next = { ...paperValues };
      next[name] = { ...(next[name] || {}), [field]: val };
      // ensure max + weight come from config
      const cfg = papers.find(p => p.name === name);
      if (cfg) {
        next[name].max = cfg.maxScore;
        next[name].weight = cfg.weight;
      }
      onChange({ papers: next });
    };

    return (
      <div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            style={{
              padding: '4px 8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--border)',
              background: pending ? 'var(--warning)' : 'white', cursor: 'pointer'
            }}
          >
            <i className={`fas ${expanded ? 'fa-chevron-up' : 'fa-chevron-down'}`}></i>{' '}
            {papers.length} papers
          </button>
          <span style={{
            fontWeight: 700, fontSize: 13,
            color: finalPct == null ? 'var(--gray)' : 'var(--success)'
          }}>
            {finalPct == null ? '—' : `${finalPct}%`}
          </span>
        </div>

        {expanded && (
          <div style={{
            marginTop: 8, padding: 8, background: 'var(--light)',
            borderRadius: 8, display: 'grid', gap: 6
          }}>
            {papers.map((p, i) => {
              const v = paperValues[p.name] || {};
              const pct = paperPercentage({ score: v.score, max: p.maxScore, weight: p.weight });
              return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 36px auto', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 600 }}>
                    {p.name}
                    <span style={{ color: 'var(--gray)', fontWeight: 400, marginLeft: 4 }}>
                      ({p.weight}%)
                    </span>
                  </span>
                  <input
                    type="number"
                    placeholder={`/${p.maxScore}`}
                    min="0"
                    max={p.maxScore}
                    value={v.score ?? ''}
                    readOnly={isReadOnly}
                    onChange={(e) => handlePaperChange(p.name, 'score', e.target.value)}
                    style={{ width: 60, padding: '3px 6px', borderRadius: 4, border: '1px solid var(--border)', fontSize: 12, textAlign: 'center' }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--gray)' }}>/{p.maxScore}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: pct ? 'var(--success)' : 'var(--gray)' }}>
                    {pct ? `${Math.round(pct.raw)}%` : '—'}
                  </span>
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: 'var(--gray)', marginTop: 2 }}>
              Final weighted score: <strong style={{ color: 'var(--primary)' }}>
                {finalPct == null ? '—' : `${finalPct}%`}
              </strong>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---------- Single score ----------
  const cur = pending ? value : (currentRecord ? { score: currentRecord.score, maxScore: currentRecord.maxScore || 100 } : {});
  const rawScore = cur.score ?? '';
  const rawMax = cur.maxScore ?? 100;
  const pct = rawScore !== '' && Number(rawMax) > 0
    ? Math.round((Number(rawScore) / Number(rawMax)) * 100)
    : null;

  const handleScore = (v) => {
    onChange({ score: v, maxScore: rawMax });
  };
  const handleMax = (v) => {
    onChange({ score: rawScore, maxScore: v });
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          type="number"
          min="0"
          max={rawMax}
          placeholder="Score"
          value={rawScore}
          readOnly={isReadOnly}
          onChange={(e) => handleScore(e.target.value)}
          style={{
            width: 60, padding: '5px 8px', textAlign: 'center',
            border: `2px solid ${pending ? 'var(--warning)' : 'var(--border)'}`,
            borderRadius: 6
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--gray)' }}>out of</span>
        <input
          type="number"
          min="1"
          placeholder="100"
          value={rawMax}
          readOnly={isReadOnly}
          onChange={(e) => handleMax(e.target.value)}
          style={{
            width: 52, padding: '5px 6px', textAlign: 'center',
            border: '1px solid var(--border)', borderRadius: 6, fontSize: 12
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: pct != null ? 'var(--success)' : 'var(--gray)', marginTop: 2, fontWeight: 600 }}>
        {pct != null ? `${pct}%` : '—'}
      </div>
    </div>
  );
}
