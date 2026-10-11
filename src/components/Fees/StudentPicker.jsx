// src/components/Fees/StudentPicker.jsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSync } from '../../context/SyncContext';
import { loadAllStudents } from '../../services/studentService';
import { normalizeAdmissionNumber } from '../../services/admissionNumberService';

/**
 * Offline-first student search picker backed by the Students page roster.
 * Props:
 *   schoolId      - required
 *   value         - selected student object | null
 *   onChange      - (student | null) => void
 * level, cls    - optional local filters
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
    const { isOnline, getFromIndexedDB, saveToIndexedDB } = useSync();
    const [query, setQuery] = useState('');
    const [roster, setRoster] = useState([]);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [searchError, setSearchError] = useState('');
    const [highlight, setHighlight] = useState(0);
    const wrapRef = useRef(null);

    // Close on outside click
    useEffect(() => {
        const onDocClick = (e) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => document.removeEventListener('mousedown', onDocClick);
    }, []);

    const loadRoster = useCallback(async (forceRefresh = false) => {
        if (!schoolId) return;
        setLoading(true);
        setSearchError('');
        try {
            const cacheKey = `students_${schoolId}`;
            const cached = await getFromIndexedDB(cacheKey);
            if (Array.isArray(cached)) {
                setRoster(cached.filter((student) => !student.isDeleted));
                if (!forceRefresh || !isOnline) return;
            }
            if (!isOnline) {
                if (!Array.isArray(cached)) setSearchError('Student list is not available offline yet. Open Students while online to cache the roster.');
                return;
            }
            const students = await loadAllStudents(schoolId);
            const activeStudents = students.filter((student) => !student.isDeleted);
            setRoster(activeStudents);
            await saveToIndexedDB(cacheKey, students);
        } catch (error) {
            console.error('Student roster load failed:', error);
            setSearchError(error.message || 'Student list could not be loaded.');
        } finally {
            setLoading(false);
        }
    }, [schoolId, getFromIndexedDB, saveToIndexedDB, isOnline]);

    useEffect(() => {
        loadRoster();
    }, [loadRoster]);

    const results = useMemo(() => {
        const term = query.trim().toLowerCase();
        if (term.length < 2) return [];
        const normalizedTerm = normalizeAdmissionNumber(term).toLowerCase();
        const matched = roster.filter((student) => {
            if (level && student.level !== level) return false;
            if (cls && student.class !== cls) return false;
            const admission = normalizeAdmissionNumber(
                student.admissionNumber || student.studentId || ''
            ).toLowerCase();
            const name = [
                student.firstName,
                student.lastName,
                student.fullName,
                student.name
            ].filter(Boolean).join(' ').toLowerCase();
            return admission.startsWith(normalizedTerm)
                || admission.startsWith(term)
                || name.includes(term);
        });
        if (admissionFirst) {
            matched.sort((a, b) => {
                const aAdmission = normalizeAdmissionNumber(a.admissionNumber || a.studentId || '').toLowerCase();
                const bAdmission = normalizeAdmissionNumber(b.admissionNumber || b.studentId || '').toLowerCase();
                return Number(bAdmission.startsWith(normalizedTerm)) - Number(aAdmission.startsWith(normalizedTerm));
            });
        }
        return matched.slice(0, 15);
    }, [query, roster, level, cls, admissionFirst]);

    useEffect(() => {
        if (query.trim().length >= 2) {
            setHighlight(0);
            setOpen(true);
        }
    }, [query]);

    const selectStudent = useCallback((student) => {
        onChange(student);
        setQuery('');
        setOpen(false);
    }, [onChange]);

    const clearSelection = () => {
        onChange(null);
        setQuery('');
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
                onFocus={() => { if (query.trim().length >= 2) setOpen(true); }}
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
                            {searchError || (roster.length ? `No students found for "${query}"` : 'No cached student roster found.')}
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
            <button
                type="button"
                onClick={() => loadRoster(true)}
                disabled={!isOnline || loading}
                style={{
                    marginTop: 6, padding: 0, border: 0, background: 'transparent',
                    color: 'var(--primary)', fontSize: 12, cursor: isOnline ? 'pointer' : 'not-allowed'
                }}
            >
                {loading ? 'Loading student list…' : 'Refresh student list'}
            </button>
        </div>
    );
}
