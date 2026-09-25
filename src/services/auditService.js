// src/services/auditService.js
import { db } from '../firebase';
import {
  collection,
  addDoc,
  serverTimestamp,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  getDocs,
} from 'firebase/firestore';

/* ============================================================
   Constants
   ============================================================ */

export const AUDIT_ACTIONS = Object.freeze({
  // Auth
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  LOGIN_FAILED: 'LOGIN_FAILED',
  PASSWORD_RESET: 'PASSWORD_RESET',

  // Students
  STUDENT_CREATED: 'STUDENT_CREATED',
  STUDENT_UPDATED: 'STUDENT_UPDATED',
  STUDENT_ARCHIVED: 'STUDENT_ARCHIVED',
  STUDENT_RESTORED: 'STUDENT_RESTORED',
  STUDENT_PROMOTED: 'STUDENT_PROMOTED',
  STUDENTS_IMPORTED: 'STUDENTS_IMPORTED',

  // Teachers
  TEACHER_CREATED: 'TEACHER_CREATED',
  TEACHER_UPDATED: 'TEACHER_UPDATED',
  TEACHER_ARCHIVED: 'TEACHER_ARCHIVED',

  // Results / Scores
  SCORES_SAVED: 'SCORES_SAVED',
  SCORES_PUBLISHED: 'SCORES_PUBLISHED',
  SCORES_IMPORTED: 'SCORES_IMPORTED',
  LEVEL_ENTRY_OPENED: 'LEVEL_ENTRY_OPENED',
  LEVEL_ENTRY_CLOSED: 'LEVEL_ENTRY_CLOSED',

  // Fees / Finance
  FEE_PAYMENT: 'FEE_PAYMENT',
  FEE_INVOICE_CREATED: 'FEE_INVOICE_CREATED',
  FEE_INVOICE_VOIDED: 'FEE_INVOICE_VOIDED',

  // Settings
  SCHOOL_SETTINGS_UPDATED: 'SCHOOL_SETTINGS_UPDATED',
  SUBSCRIPTION_UPDATED: 'SUBSCRIPTION_UPDATED',

  // Generic
  OTHER: 'OTHER',
});

/**
 * Coarse categories used by the UI to give users friendly grouping.
 * Anything not listed falls into `other`.
 */
export const ACTION_CATEGORY = Object.freeze({
  LOGIN: 'auth', LOGOUT: 'auth', LOGIN_FAILED: 'auth', PASSWORD_RESET: 'auth',
  STUDENT_CREATED: 'students', STUDENT_UPDATED: 'students', STUDENT_ARCHIVED: 'students',
  STUDENT_RESTORED: 'students', STUDENT_PROMOTED: 'students', STUDENTS_IMPORTED: 'students',
  TEACHER_CREATED: 'teachers', TEACHER_UPDATED: 'teachers', TEACHER_ARCHIVED: 'teachers',
  SCORES_SAVED: 'results', SCORES_PUBLISHED: 'results', SCORES_IMPORTED: 'results',
  LEVEL_ENTRY_OPENED: 'results', LEVEL_ENTRY_CLOSED: 'results',
  FEE_PAYMENT: 'finance', FEE_INVOICE_CREATED: 'finance', FEE_INVOICE_VOIDED: 'finance',
  SCHOOL_SETTINGS_UPDATED: 'settings', SUBSCRIPTION_UPDATED: 'settings',
  OTHER: 'other',
});

export const categoryForAction = (action) =>
  ACTION_CATEGORY[action] || 'other';

/* ============================================================
   Internal helpers
   ============================================================ */

const MAX_DETAIL_LENGTH = 500;
const MAX_ACTION_LENGTH = 80;

/** Truncate & strip control chars so we never write garbage to Firestore. */
function sanitize(value, maxLen) {
  if (value == null) return '';
  const str = String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
}

/** Best-effort resolution of a display name from whatever user shape we get. */
function resolveDisplayName(user) {
  if (!user) return 'System';
  return (
    user.fullName ||
    [user.firstName, user.lastName].filter(Boolean).join(' ') ||
    user.displayName ||
    user.email ||
    user.uid ||
    'System'
  );
}

/* ============================================================
   Public API
   ============================================================ */

export const AuditLogService = {
  /**
   * Write an audit entry. Never throws — auditing must not break the
   * user's main flow. Failures are logged to the console.
   *
   * Two call signatures are supported so legacy call sites keep working:
   *
   *   1) AuditLogService.logAction(userId, action, entityId, details)
   *   2) AuditLogService.logAction(schoolId, user, action, details)   // legacy
   *
   * Detection is by the shape of the 2nd argument (object vs string).
   */
  async logAction(a, b, c, d = {}) {
    let schoolId, user, action, entityId, details;

    if (typeof b === 'object' && b !== null) {
      // Legacy signature: (schoolId, user, action, details)
      schoolId = a;
      user = b;
      action = c;
      details = typeof d === 'string' ? { message: d } : (d || {});
      entityId = details?.entityId || '';
    } else {
      // New signature: (userId, action, entityId, details)
      user = { uid: a };
      action = b;
      entityId = c;
      details = d || {};
      schoolId = details?.schoolId || user?.schoolId || 'global';
    }

    const payload = {
      schoolId: schoolId || 'global',
      userId: user?.uid || 'system',
      userName: sanitize(resolveDisplayName(user), 120),
      userEmail: sanitize(user?.email || '', 160),
      userRole: sanitize(user?.role || 'admin', 40),
      action: sanitize(action || AUDIT_ACTIONS.OTHER, MAX_ACTION_LENGTH),
      entityId: sanitize(entityId || '', 120),
      details: sanitize(
        typeof details === 'string' ? details : (details?.message || details?.details || ''),
        MAX_DETAIL_LENGTH
      ),
      // Keep the structured blob too — filters/reports may want it later.
      meta: typeof details === 'object' && details !== null
        ? Object.fromEntries(
            Object.entries(details)
              .filter(([k]) => !['message', 'details', 'entityId', 'schoolId'].includes(k))
              .slice(0, 12)
          )
        : {},
      timestamp: serverTimestamp(),
    };

    try {
      await addDoc(collection(db, 'audit_logs'), payload);
      return true;
    } catch (error) {
      // Don't throw — the caller's primary action already succeeded.
      console.error('[AuditLogService] failed to write log:', {
        action: payload.action,
        error,
      });
      return false;
    }
  },

  /**
   * Fetch the most recent audit logs for a school.
   *
   * Uses orderBy(timestamp desc) + limit. If the composite index
   * (schoolId ASC, timestamp DESC) isn't deployed yet, Firestore
   * throws FAILED_PRECONDITION / "index" — we transparently fall back
   * to an unordered query and sort client-side.
   *
   * @param {string} schoolId
   * @param {{ pageSize?: number, cursor?: any }} [opts]
   * @returns {Promise<{ items: object[], nextCursor: any, hasMore: boolean }>}
   */
  async listForSchool(schoolId, opts = {}) {
    const pageSize = Math.min(Math.max(opts.pageSize || 100, 1), 500);
    if (!schoolId) return { items: [], nextCursor: null, hasMore: false };

    const base = [where('schoolId', '==', schoolId)];

    try {
      const q = query(
        collection(db, 'audit_logs'),
        ...base,
        orderBy('timestamp', 'desc'),
        ...(opts.cursor ? [startAfter(opts.cursor)] : []),
        limit(pageSize + 1)
      );
      const snap = await getDocs(q);
      const docs = snap.docs;
      const hasMore = docs.length > pageSize;
      const items = docs.slice(0, pageSize).map((doc) => ({ id: doc.id, ...doc.data() }));
      const nextCursor = hasMore ? docs[pageSize - 1] : null;
      return { items, nextCursor, hasMore };
    } catch (err) {
      const needsIndex =
        err?.code === 'failed-precondition' ||
        /index/i.test(err?.message || '');
      if (!needsIndex) throw err;

      console.warn('[AuditLogService] composite index missing; falling back to unordered fetch.');
      const q = query(
        collection(db, 'audit_logs'),
        ...base,
        limit(pageSize)
      );
      const snap = await getDocs(q);
      const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      items.sort((a, b) => millisOf(b.timestamp) - millisOf(a.timestamp));
      return { items, nextCursor: null, hasMore: false };
    }
  },

  /**
   * Convenience: fetch every log for a school up to a hard cap (default 500).
   * Returns a flat array sorted desc by timestamp. Used by the page for
   * in-memory filtering (search, category) which we can't do server-side
   * without a search index.
   */
  async listAllForSchool(schoolId, cap = 500) {
    const all = [];
    let cursor = null;
    let safety = 0;
    while (all.length < cap && safety < 10) {
      // eslint-disable-next-line no-await-in-loop
      const { items, nextCursor, hasMore } = await this.listForSchool(schoolId, {
        pageSize: Math.min(200, cap - all.length),
        cursor,
      });
      all.push(...items);
      if (!hasMore || !nextCursor) break;
      cursor = nextCursor;
      safety += 1;
    }
    return all.slice(0, cap);
  },
};

/* ============================================================
   Misc
   ============================================================ */

function millisOf(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : 0;
}

/** Format a Firestore timestamp (or anything date-ish) for display. */
export function formatAuditTimestamp(ts) {
  if (!ts) return '—';
  try {
    if (typeof ts.toDate === 'function') return ts.toDate().toLocaleString();
    if (ts instanceof Date) return ts.toLocaleString();
    const d = new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
  } catch {
    return '—';
  }
}

/**
 * Backwards-compatible named export. Old code doing
 *   import { logAuditAction } from '../pages/AuditLogs';
 * can be updated to
 *   import { logAuditAction } from '../services/auditService';
 * with no other change.
 */
export const logAuditAction = (schoolId, user, action, details) =>
  AuditLogService.logAction(schoolId, user, action, details);
