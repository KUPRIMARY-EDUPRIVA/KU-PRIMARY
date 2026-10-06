// src/components/Fees/StudentPicker.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { searchStudentsLive } from '../../services/feeService';

/**
 * Live student search picker.
 * Props:
 *   schoolId      - required
 *   value         - selected student object | null
 *   onChange      - (student | null) => void
 *   level, cls    - optional server-side filters
 *   placeholder   - input placeholder
 *   autoFocus     - boolean
 */
export default function StudentPicker({
    schoolId,
    value,
    onChange,
    level,
    cls,
    admissionFirst = false,
    placeholder = 'Search admission number, or enter 2+ letters of a name...',
    autoFocus = false
}) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [searchError, setSearchError] = useState('');
    const [highlight, setHighlight] = useState(0);
    const wrapRef = useRef(null);
    const debounceRef = useRef(null);

    // Close on outside click
    useEffect(() => {
        const onDocClick = (e) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, []);

    // Debounced server search
    useEffect(() => {
        if (!schoolId) return;
        if (query.trim().length < 2) {
            setResults([]);
            setSearchError('');
            setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setSearchError('');
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            try {
                const r = await searchStudentsLive(schoolId, query, {
                    level, cls, limit: 15, admissionFirst,
                });
                if (cancelled) return;
                setResults(r);
                setHighlight(0);
                setOpen(true);
            } catch (error) {
                if (cancelled) return;
                console.error('Student picker search failed:', error);
                setResults([]);
                setSearchError(error.message || 'Student search failed.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(debounceRef.current);
        };
    }, [query, schoolId, level, cls, admissionFirst]);

    const selectStudent = useCallback((student) => {
        onChange(student);
        setQuery('');
        setResults([]);
        setOpen(false);
    }, [onChange]);

    const clearSelection = () => {
        onChange(null);
        setQuery('');
        setResults([]);
    };

    const onKeyDown = (e) => {
        if (!open || results.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight(h => Math.min(h + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight(h => Math.max(h - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            selectStudent(results[highlight]);
        } else if (e.key === 'Escape') {
            setOpen(false);
        }
    };

    const displayName = (s) =>
        `${s.firstName || ''} ${s.lastName || ''}`.trim() || s.fullName || s.name || 'Unnamed';

    // Selected state
    if (value) {
        return (
            <div style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 12px', border: '2px solid var(--primary)',
                borderRadius: '8px', background: '#eef2ff'
            }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, color: 'var(--secondary)' }}>
                        {displayName(value)}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--gray)' }}>
                        Adm: {value.admissionNumber || value.studentId || 'N/A'} • {value.class || 'N/A'}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={clearSelection}
                    style={{
                        background: 'transparent', border: 'none',
                        color: 'var(--danger)', cursor: 'pointer', fontSize: '16px'
                    }}
                    title="Clear selection"
                >
                    <i className="fas fa-times-circle"></i>
                </button>
            </div>
        );
    }

    // Search state
    return (
        <div ref={wrapRef} style={{ position: 'relative' }}>
            <input
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
                onFocus={() => { if (results.length) setOpen(true); }}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                autoFocus={autoFocus}
                style={{
                    width: '100%', padding: '10px 15px',
                    border: '2px solid var(--border)', borderRadius: '8px',
                    fontSize: '14px'
                }}
            />
            {loading && (
                <div style={{
                    position: 'absolute', right: '12px', top: '50%',
                    transform: 'translateY(-50%)', color: 'var(--gray)'
                }}>
                    <i className="fas fa-spinner fa-spin"></i>
                </div>
            )}
            {open && query.trim().length >= 2 && (
                <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                    background: 'white', border: '1px solid var(--border)',
                    borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                    zIndex: 1000, maxHeight: '320px', overflowY: 'auto'
                }}>
                    {results.length === 0 && !loading && (
                        <div style={{ padding: '14px', color: 'var(--gray)', fontSize: '13px', textAlign: 'center' }}>
                            {searchError || `No students found for "${query}"`}
                        </div>
                    )}
                    {results.map((s, idx) => (
                        <div
                            key={s.id}
                            onMouseDown={(e) => { e.preventDefault(); selectStudent(s); }}
                            onMouseEnter={() => setHighlight(idx)}
                            style={{
                                padding: '10px 14px', cursor: 'pointer',
                                background: idx === highlight ? 'var(--light)' : 'white',
                                borderBottom: idx < results.length - 1 ? '1px solid var(--border)' : 'none'
                            }}
                        >
                            <div style={{ fontWeight: 600, color: 'var(--secondary)', fontSize: '14px' }}>
                                {displayName(s)}
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--gray)', marginTop: '2px' }}>
                                Adm: {s.admissionNumber || s.studentId || 'N/A'} • {s.class || 'N/A'}
                                {s.level ? ` • ${s.level}` : ''}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
