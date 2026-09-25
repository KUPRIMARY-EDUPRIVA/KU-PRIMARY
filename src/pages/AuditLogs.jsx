// src/pages/AuditLogs.jsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Layout from '../components/Layout/Layout';
import LoadingSpinner from '../components/Common/LoadingSpinner';
import {
  AuditLogService,
  formatAuditTimestamp,
  categoryForAction,
} from '../services/auditService';

/* ============================================================
   Constants
   ============================================================ */

const PAGE_SIZE = 25;

const CATEGORY_OPTIONS = [
  { value: '',         label: 'All Categories' },
  { value: 'auth',     label: 'Authentication' },
  { value: 'students', label: 'Students' },
  { value: 'teachers', label: 'Teachers' },
  { value: 'results',  label: 'Results' },
  { value: 'finance',  label: 'Finance' },
  { value: 'settings', label: 'Settings' },
  { value: 'other',    label: 'Other' },
];

const DATE_RANGE_OPTIONS = [
  { value: '',    label: 'All Time' },
  { value: '1',   label: 'Last 24 hours' },
  { value: '7',   label: 'Last 7 days' },
  { value: '30',  label: 'Last 30 days' },
  { value: '90',  label: 'Last 90 days' },
];

const ADMIN_ROLES = new Set(['admin', 'user', 'school_admin', 'super-admin']);

/* ============================================================
   Helpers
   ============================================================ */

const millisOf = (ts) => {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : 0;
};

const humanAction = (action) =>
  String(action || '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const downloadCSV = (filename, rows) => {
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/* ============================================================
   Page
   ============================================================ */

export default function AuditLogs() {
  const { userData, userRole } = useAuth();

  const isAdmin = ADMIN_ROLES.has(userRole) || ADMIN_ROLES.has(userData?.role);
  const schoolId = userData?.schoolId;

  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [dateRange, setDateRange] = useState('');

  // Pagination
  const [page, setPage] = useState(1);

  /* ---------------- Data load ---------------- */

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!isAdmin || !schoolId) {
      setLoading(false);
      return;
    }
    if (silent) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const items = await AuditLogService.listAllForSchool(schoolId, 500);
      setLogs(items);
    } catch (err) {
      console.error('[AuditLogs] load failed:', err);
      setError(err?.message || 'Failed to load audit logs');
      setLogs([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAdmin, schoolId]);

  useEffect(() => {
    load();
  }, [load]);

  /* ---------------- Derived ---------------- */

  const uniqueActions = useMemo(() => {
    const set = new Set(logs.map((l) => l.action).filter(Boolean));
    return [...set].sort();
  }, [logs]);

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const cutoff = dateRange
      ? Date.now() - Number(dateRange) * 24 * 60 * 60 * 1000
      : 0;

    return logs.filter((log) => {
      if (cutoff && millisOf(log.timestamp) < cutoff) return false;
      if (actionFilter && log.action !== actionFilter) return false;
      if (categoryFilter && categoryForAction(log.action) !== categoryFilter) return false;
      if (term) {
        const hay = [
          log.userName, log.userEmail, log.userRole,
          log.action, log.details, log.entityId,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [logs, searchTerm, actionFilter, categoryFilter, dateRange]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  // Reset page whenever the filter set changes
  useEffect(() => {
    setPage(1);
  }, [searchTerm, actionFilter, categoryFilter, dateRange]);

  /* ---------------- Actions ---------------- */

  const clearFilters = () => {
    setSearchTerm('');
    setActionFilter('');
    setCategoryFilter('');
    setDateRange('');
  };

  const exportFiltered = () => {
    if (filtered.length === 0) return;
    const header = ['Timestamp', 'User', 'Email', 'Role', 'Action', 'Details'];
    const rows = filtered.map((log) => [
      formatAuditTimestamp(log.timestamp),
      log.userName || '',
      log.userEmail || '',
      log.userRole || '',
      log.action || '',
      log.details || '',
    ]);
    const today = new Date().toISOString().slice(0, 10);
    downloadCSV(`audit_logs_${today}.csv`, [header, ...rows]);
  };

  /* ---------------- Guards ---------------- */

  if (!isAdmin) {
    return (
      <Layout title="Audit Logs">
        <div className="audit-access-denied">
          <i className="fas fa-lock" aria-hidden="true"></i>
          <h2>Access Denied</h2>
          <p>Audit logs are only accessible to school administrators.</p>
        </div>
      </Layout>
    );
  }

  if (loading) {
    return (
      <Layout title="Audit Logs">
        <LoadingSpinner fullScreen text="Loading audit logs…" />
      </Layout>
    );
  }

  /* ---------------- Render ---------------- */

  return (
    <Layout title="Audit Logs">
      <div className="audit-page">
        {/* ---------- Header ---------- */}
        <header className="audit-header">
          <div className="audit-header-text">
            <h1>System Audit Logs</h1>
            <p>
              Track user activities, security events, and administrative actions across the platform.
            </p>
          </div>
          <div className="audit-header-actions">
            <button
              type="button"
              className="btn btn-outline"
              onClick={exportFiltered}
              disabled={filtered.length === 0}
            >
              <i className="fas fa-download" aria-hidden="true"></i>
              Export CSV
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => load({ silent: true })}
              disabled={refreshing}
            >
              <i
                className={`fas fa-sync-alt ${refreshing ? 'fa-spin' : ''}`}
                aria-hidden="true"
              ></i>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>

        {/* ---------- Stat strip ---------- */}
        <div className="audit-stats" role="group" aria-label="Audit summary">
          <div className="audit-stat">
            <span className="audit-stat-label">Total</span>
            <span className="audit-stat-value">{logs.length}</span>
          </div>
          <div className="audit-stat">
            <span className="audit-stat-label">Showing</span>
            <span className="audit-stat-value">{filtered.length}</span>
          </div>
          <div className="audit-stat">
            <span className="audit-stat-label">Unique actions</span>
            <span className="audit-stat-value">{uniqueActions.length}</span>
          </div>
        </div>

        {/* ---------- Filters ---------- */}
        <div className="audit-filters">
          <div className="audit-search">
            <i className="fas fa-search" aria-hidden="true"></i>
            <input
              type="search"
              placeholder="Search by user, email, action, or details…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              aria-label="Search audit logs"
            />
          </div>

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            aria-label="Filter by category"
          >
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            aria-label="Filter by action"
          >
            <option value="">All Actions</option>
            {uniqueActions.map((act) => (
              <option key={act} value={act}>{humanAction(act)}</option>
            ))}
          </select>

          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            aria-label="Filter by date range"
          >
            {DATE_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {(searchTerm || actionFilter || categoryFilter || dateRange) && (
            <button
              type="button"
              className="btn btn-outline"
              onClick={clearFilters}
            >
              <i className="fas fa-times" aria-hidden="true"></i>
              Clear
            </button>
          )}
        </div>

        {/* ---------- Error ---------- */}
        {error && (
          <div className="audit-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{error}</span>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => load()}>
              Retry
            </button>
          </div>
        )}

        {/* ---------- Table ---------- */}
        <div className="audit-table-wrap">
          {pageItems.length === 0 ? (
            <div className="audit-empty">
              <i className="fas fa-clipboard-list" aria-hidden="true"></i>
              <h3>No audit logs found</h3>
              <p>
                {logs.length === 0
                  ? 'Activities will appear here as actions are performed in the system.'
                  : 'No entries match the current filters.'}
              </p>
              {logs.length > 0 && (
                <button type="button" className="btn btn-outline" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Desktop / tablet table */}
              <div className="audit-table-scroll">
                <table className="audit-table">
                  <thead>
                    <tr>
                      <th scope="col">Timestamp</th>
                      <th scope="col">User</th>
                      <th scope="col">Role</th>
                      <th scope="col">Action</th>
                      <th scope="col">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((log) => {
                      const category = categoryForAction(log.action);
                      return (
                        <tr key={log.id}>
                          <td className="audit-cell-time">
                            {formatAuditTimestamp(log.timestamp)}
                          </td>
                          <td className="audit-cell-user">
                            <div className="audit-user-name">
                              {log.userName || 'System User'}
                            </div>
                            {log.userEmail && (
                              <div className="audit-user-email">{log.userEmail}</div>
                            )}
                          </td>
                          <td>
                            <span className={`audit-role audit-role--${log.userRole || 'admin'}`}>
                              {log.userRole || 'admin'}
                            </span>
                          </td>
                          <td>
                            <span className={`audit-action audit-action--${category}`}>
                              {humanAction(log.action)}
                            </span>
                          </td>
                          <td className="audit-cell-details">
                            {log.details || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile card list */}
              <ul className="audit-card-list">
                {pageItems.map((log) => {
                  const category = categoryForAction(log.action);
                  return (
                    <li key={log.id} className="audit-card">
                      <div className="audit-card-top">
                        <span className={`audit-action audit-action--${category}`}>
                          {humanAction(log.action)}
                        </span>
                        <span className="audit-card-time">
                          {formatAuditTimestamp(log.timestamp)}
                        </span>
                      </div>
                      <div className="audit-card-user">
                        <strong>{log.userName || 'System User'}</strong>
                        {log.userEmail && <span>{log.userEmail}</span>}
                      </div>
                      {log.details && (
                        <div className="audit-card-details">{log.details}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {/* ---------- Pagination ---------- */}
        {filtered.length > PAGE_SIZE && (
          <div className="audit-pagination">
            <div className="audit-pagination-info">
              Showing{' '}
              <strong>
                {(page - 1) * PAGE_SIZE + 1}–
                {Math.min(page * PAGE_SIZE, filtered.length)}
              </strong>{' '}
              of <strong>{filtered.length}</strong>
            </div>
            <div className="audit-pagination-btns">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                aria-label="Previous page"
              >
                <i className="fas fa-chevron-left" aria-hidden="true"></i>
              </button>
              <span className="audit-pagination-current">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                aria-label="Next page"
              >
                <i className="fas fa-chevron-right" aria-hidden="true"></i>
              </button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
