// src/pages/fees/Reconciliation.jsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import Layout from '../../components/Layout/Layout';
import LoadingSpinner from '../../components/Common/LoadingSpinner';
import { useSync } from '../../context/SyncContext';
import {
  RECON_TYPES, listAll,
  resolveOrphan, ignoreOrphan, markStuckAsTimeout, dismissError,
} from '../../services/mpesaReconciliationService';
import { SCHOOL_LEVELS } from '../../utils/constants';

const TABS = [
  { id: 'orphan', label: 'Orphan Callbacks', icon: 'fa-unlink',            tone: 'gold' },
  { id: 'error',  label: 'Handler Errors',   icon: 'fa-bug',               tone: 'danger' },
  { id: 'stuck',  label: 'Stuck Pending',    icon: 'fa-hourglass-half',    tone: 'info' },
];

const fmtKES = (n) => `KES ${Number(n || 0).toLocaleString('en-KE')}`;
const fmtDate = (ts) => {
  if (!ts) return '—';
  try {
    if (typeof ts.toDate === 'function') return ts.toDate().toLocaleString();
    return new Date(ts).toLocaleString();
  } catch { return '—'; }
};

export default function MpesaReconciliation() {
  const { userData, userRole, currentUser } = useAuth();
  const { isOnline } = useSync();
  const schoolId = userData?.schoolId;
  const isAdmin = ['admin', 'user', 'school_admin', 'super-admin'].includes(userRole);

  const [activeTab, setActiveTab] = useState('orphan');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState({ orphans: [], errors: [], stuck: [] });
  const [error, setError] = useState('');

  const [resolveTarget, setResolveTarget] = useState(null);
  const [ignoreTarget, setIgnoreTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!isAdmin || !schoolId) { setLoading(false); return; }
    if (silent) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const result = await listAll(schoolId, { max: 300, olderThanMinutes: 15 });
      setData(result);
    } catch (err) {
      console.error('[Reconciliation] load failed:', err);
      setError(err.message || 'Failed to load reconciliation data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAdmin, schoolId]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => ({
    orphan: data.orphans.filter((o) => !o.resolved && !o.ignored).length,
    error:  data.errors.filter((e) => !e.dismissed).length,
    stuck:  data.stuck.length,
  }), [data]);

  if (!isAdmin) {
    return (
      <Layout title="M-Pesa Reconciliation">
        <div className="audit-access-denied">
          <i className="fas fa-lock" aria-hidden="true"></i>
          <h2>Access Denied</h2>
          <p>Only administrators can review M-Pesa reconciliation records.</p>
        </div>
      </Layout>
    );
  }

  if (loading) {
    return (
      <Layout title="M-Pesa Reconciliation">
        <LoadingSpinner fullScreen text="Loading reconciliation data…" />
      </Layout>
    );
  }

  const handleMarkStuckAsTimeout = async (pending) => {
    if (!window.confirm(
      `Mark transaction ${pending.id} as timed out?\n\n` +
      `This will NOT credit the student. It only closes the pending record so it no longer appears as awaiting a callback.`
    )) return;
    setBusy(true);
    try {
      await markStuckAsTimeout({
        pending,
        userId: currentUser?.uid,
        userName: userData?.fullName || '',
      });
      await load({ silent: true });
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDismissError = async (errDoc) => {
    if (!window.confirm('Mark this callback error as reviewed?')) return;
    setBusy(true);
    try {
      await dismissError({
        errorDoc: errDoc,
        userId: currentUser?.uid,
        userName: userData?.fullName || '',
      });
      await load({ silent: true });
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout title="M-Pesa Reconciliation">
      <div className="recon-page">
        <header className="recon-header">
          <div>
            <h1>M-Pesa Reconciliation</h1>
            <p>
              Review payments that couldn't be processed automatically, capture
              orphan callbacks, and sweep transactions that never received a callback.
            </p>
          </div>
          <div className="recon-header-actions">
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => load({ silent: true })}
              disabled={refreshing}
            >
              <i className={`fas fa-sync-alt ${refreshing ? 'fa-spin' : ''}`} aria-hidden="true"></i>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>

        {error && isOnline && (
          <div className="audit-error" role="alert">
            <i className="fas fa-exclamation-circle" aria-hidden="true"></i>
            <span>{error}</span>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => load()}>
              Retry
            </button>
          </div>
        )}

        <nav className="recon-tabs" aria-label="Reconciliation categories">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`recon-tab recon-tab--${t.tone} ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
              aria-current={activeTab === t.id ? 'page' : undefined}
            >
              <i className={`fas ${t.icon}`} aria-hidden="true"></i>
              <span>{t.label}</span>
              <span className="recon-tab-count">{counts[t.id]}</span>
            </button>
          ))}
        </nav>

        {activeTab === 'orphan' && (
          <OrphanPanel
            orphans={data.orphans}
            onResolve={(o) => setResolveTarget(o)}
            onIgnore={(o) => setIgnoreTarget(o)}
            busy={busy}
          />
        )}

        {activeTab === 'error' && (
          <ErrorPanel
            errors={data.errors}
            onDismiss={handleDismissError}
            busy={busy}
          />
        )}

        {activeTab === 'stuck' && (
          <StuckPanel
            stuck={data.stuck}
            onMarkTimeout={handleMarkStuckAsTimeout}
            busy={busy}
          />
        )}

        {resolveTarget && (
          <ResolveOrphanModal
            orphan={resolveTarget}
            schoolId={schoolId}
            userId={currentUser?.uid}
            userName={userData?.fullName || ''}
            onClose={() => setResolveTarget(null)}
            onSaved={() => { setResolveTarget(null); load({ silent: true }); }}
          />
        )}

        {ignoreTarget && (
          <IgnoreOrphanModal
            orphan={ignoreTarget}
            userId={currentUser?.uid}
            userName={userData?.fullName || ''}
            onClose={() => setIgnoreTarget(null)}
            onSaved={() => { setIgnoreTarget(null); load({ silent: true }); }}
          />
        )}
      </div>
    </Layout>
  );
}

/* ============================================================
   Panels
   ============================================================ */

function OrphanPanel({ orphans, onResolve, onIgnore, busy }) {
  const visible = orphans.filter((o) => !o.resolved && !o.ignored);
  const historic = orphans.filter((o) => o.resolved || o.ignored);

  if (!orphans.length) {
    return (
      <div className="recon-empty">
        <i className="fas fa-check-circle" aria-hidden="true"></i>
        <h3>No orphan callbacks</h3>
        <p>Every successful callback has been routed to a student.</p>
      </div>
    );
  }

  return (
    <>
      <div className="recon-table-wrap">
        {visible.length === 0 ? (
          <div className="recon-empty recon-empty--small">
            <i className="fas fa-check" aria-hidden="true"></i>
            <p>All orphan callbacks resolved.</p>
          </div>
        ) : (
          <table className="recon-table">
            <thead>
              <tr>
                <th>Received</th>
                <th>Receipt</th>
                <th>Amount</th>
                <th>Phone</th>
                <th>Reason</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => (
                <tr key={o.id}>
                  <td className="recon-cell-time">{fmtDate(o.receivedAt)}</td>
                  <td>
                    <div className="recon-strong">{o.receiptNumber || '—'}</div>
                    <div className="recon-muted">{o.CheckoutRequestID || o.id}</div>
                  </td>
                  <td className="recon-strong">{fmtKES(o.paidAmount)}</td>
                  <td>{o.paidPhone || '—'}</td>
                  <td className="recon-muted">{o.reason || '—'}</td>
                  <td className="recon-cell-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => onResolve(o)}
                      disabled={busy}
                    >
                      <i className="fas fa-check" aria-hidden="true"></i> Resolve
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => onIgnore(o)}
                      disabled={busy}
                    >
                      <i className="fas fa-ban" aria-hidden="true"></i> Ignore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {historic.length > 0 && (
        <details className="recon-history">
          <summary>{historic.length} previously handled</summary>
          <ul className="recon-history-list">
            {historic.slice(0, 50).map((o) => (
              <li key={o.id}>
                <span className="recon-strong">{o.receiptNumber || o.id}</span>
                <span className="recon-muted"> {fmtKES(o.paidAmount)} · </span>
                <span className={o.resolved ? 'recon-ok' : 'recon-muted'}>
                  {o.resolved ? 'Resolved' : 'Ignored'}
                </span>
                <span className="recon-muted"> · {fmtDate(o.resolvedAt || o.ignoredAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function ErrorPanel({ errors, onDismiss, busy }) {
  const visible = errors.filter((e) => !e.dismissed);
  if (!errors.length) {
    return (
      <div className="recon-empty">
        <i className="fas fa-check-circle" aria-hidden="true"></i>
        <h3>No handler errors</h3>
        <p>The M-Pesa callback handler has not thrown on any recent request.</p>
      </div>
    );
  }

  return (
    <>
      <div className="recon-table-wrap">
        {visible.length === 0 ? (
          <div className="recon-empty recon-empty--small">
            <i className="fas fa-check" aria-hidden="true"></i>
            <p>All handler errors reviewed.</p>
          </div>
        ) : (
          <table className="recon-table">
            <thead>
              <tr>
                <th>Received</th>
                <th>Checkout ID</th>
                <th>Result</th>
                <th>Error</th>
                <th aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.id}>
                  <td className="recon-cell-time">{fmtDate(e.receivedAt)}</td>
                  <td className="recon-muted">{e.checkoutRequestID || '—'}</td>
                  <td>
                    <span className="recon-chip recon-chip--danger">
                      {e.resultCode} {e.resultDesc ? `· ${e.resultDesc}` : ''}
                    </span>
                  </td>
                  <td className="recon-cell-error">
                    <details>
                      <summary>{e.errorMessage || 'Unexpected error'}</summary>
                      <pre>{e.errorStack || '(no stack captured)'}</pre>
                    </details>
                  </td>
                  <td className="recon-cell-actions">
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => onDismiss(e)}
                      disabled={busy}
                    >
                      <i className="fas fa-check" aria-hidden="true"></i> Mark reviewed
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {errors.some((e) => e.dismissed) && (
        <details className="recon-history">
          <summary>{errors.filter((e) => e.dismissed).length} previously reviewed</summary>
          <ul className="recon-history-list">
            {errors.filter((e) => e.dismissed).slice(0, 50).map((e) => (
              <li key={e.id}>
                <span className="recon-muted">{e.checkoutRequestID || e.id}</span>
                <span> · {e.errorMessage}</span>
                <span className="recon-muted"> · reviewed {fmtDate(e.dismissedAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function StuckPanel({ stuck, onMarkTimeout, busy }) {
  if (!stuck.length) {
    return (
      <div className="recon-empty">
        <i className="fas fa-check-circle" aria-hidden="true"></i>
        <h3>No stuck pending transactions</h3>
        <p>Every STK Push has either completed, failed, or been swept within 15 minutes.</p>
      </div>
    );
  }

  return (
    <div className="recon-table-wrap">
      <table className="recon-table">
        <thead>
          <tr>
            <th>Initiated</th>
            <th>Student</th>
            <th>Phone</th>
            <th>Amount</th>
            <th>Status</th>
            <th aria-label="Actions"></th>
          </tr>
        </thead>
        <tbody>
          {stuck.map((p) => (
            <tr key={p.id}>
              <td className="recon-cell-time">{fmtDate(p.createdAt)}</td>
              <td>
                <div className="recon-strong">{p.studentName || '—'}</div>
                <div className="recon-muted">{p.admissionNumber || ''}</div>
              </td>
              <td>{p.phoneNumber || '—'}</td>
              <td className="recon-strong">{fmtKES(p.amount)}</td>
              <td>
                <span className="recon-chip recon-chip--warning">Pending &gt; 15 min</span>
              </td>
              <td className="recon-cell-actions">
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => onMarkTimeout(p)}
                  disabled={busy}
                >
                  <i className="fas fa-hourglass-end" aria-hidden="true"></i> Mark timeout
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ============================================================
   Modals
   ============================================================ */

function ResolveOrphanModal({ orphan, schoolId, userId, userName, onClose, onSaved }) {
  const [studentId, setStudentId] = useState('');
  const [studentName, setStudentName] = useState('');
  const [admissionNumber, setAdmissionNumber] = useState('');
  const [studentClass, setStudentClass] = useState('');
  const [level, setLevel] = useState('');
  const [term, setTerm] = useState('Term 1');
  const [year, setYear] = useState(new Date().getFullYear());
  const [amount, setAmount] = useState(Number(orphan.paidAmount) || 0);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!studentId || !amount || !term || !year) {
      setErr('Student ID, amount, term and year are required.');
      return;
    }
    setSaving(true);
    try {
      await resolveOrphan({
        orphan, schoolId, studentId, studentName, admissionNumber,
        studentClass, level, term, year, amount,
        userId, userName, note,
      });
      onSaved();
    } catch (e) {
      console.error('[ResolveOrphan] failed:', e);
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h2><i className="fas fa-link" aria-hidden="true"></i> Resolve Orphan Callback</h2>
          <button className="modal-close" onClick={onClose}><i className="fas fa-times"></i></button>
        </div>

        <div className="recon-summary">
          <div><span className="recon-muted">Receipt</span><br /><strong>{orphan.receiptNumber || '—'}</strong></div>
          <div><span className="recon-muted">Amount</span><br /><strong>{fmtKES(orphan.paidAmount)}</strong></div>
          <div><span className="recon-muted">Phone</span><br /><strong>{orphan.paidPhone || '—'}</strong></div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="form-group">
              <label>Student ID <span className="required">*</span></label>
              <input
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                placeholder="Firestore students/{id}"
                required
              />
            </div>
            <div className="form-group">
              <label>Student Name</label>
              <input value={studentName} onChange={(e) => setStudentName(e.target.value)} />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Admission No.</label>
              <input value={admissionNumber} onChange={(e) => setAdmissionNumber(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Class</label>
              <input value={studentClass} onChange={(e) => setStudentClass(e.target.value)} />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Level</label>
              <select value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="">— Select —</option>
                {SCHOOL_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Term <span className="required">*</span></label>
              <select value={term} onChange={(e) => setTerm(e.target.value)}>
                <option>Term 1</option>
                <option>Term 2</option>
                <option>Term 3</option>
              </select>
            </div>
            <div className="form-group">
              <label>Year <span className="required">*</span></label>
              <input
                type="number"
                value={year}
                min="2000"
                max={new Date().getFullYear() + 1}
                onChange={(e) => setYear(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="form-group">
            <label>Amount (KES) <span className="required">*</span></label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              required
            />
            <div className="help-text">
              Defaults to what Safaricom confirmed. Adjust only if you're certain.
            </div>
          </div>

          <div className="form-group">
            <label>Reconciliation Note</label>
            <textarea
              rows="2"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why is this being matched manually?"
            />
          </div>

          {err && <div className="audit-error" role="alert"><span>{err}</span></div>}

          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? <><i className="fas fa-spinner fa-spin"></i> Resolving…</> : <><i className="fas fa-check"></i> Confirm Resolution</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function IgnoreOrphanModal({ orphan, userId, userName, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await ignoreOrphan({ orphan, reason, userId, userName });
      onSaved();
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay active" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h2><i className="fas fa-ban" aria-hidden="true"></i> Ignore Orphan Callback</h2>
          <button className="modal-close" onClick={onClose}><i className="fas fa-times"></i></button>
        </div>
        <p className="recon-muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Use this when the callback was a duplicate delivery, a reversal, or clearly not
          a payment that ever reached the school.
        </p>
        <form onSubmit={submit}>
          <div className="form-group">
            <label>Reason</label>
            <textarea
              rows="3"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Safaricom reversed this payment on 15 Apr"
            />
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn-danger" disabled={saving}>
              {saving ? 'Saving…' : 'Ignore Callback'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
