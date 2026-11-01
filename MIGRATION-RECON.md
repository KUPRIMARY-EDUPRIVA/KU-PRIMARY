# Firebase → Supabase Migration: Phase 0 Reconnaissance

**Scope:** Read-only inventory of the current application and migration helper. No Firebase data was read, exported, modified, or imported. No application code was migrated.

## Customized source confirmation

The current workspace was selected as the customized application source. It is on `main`; remote `custom` points to the same repository as `origin`, and `custom/main` was fetched. At reconnaissance time, `main...HEAD` had no diff.

```text
$ git log --oneline -10
6980ef9 Update mpesa-stk-push.js
4e58c78 Update SchoolProfile.jsx
220a193 Update mpesa-stk-push.js
4d87d9c Update SchoolProfile.jsx
a582733 Update SchoolProfile.jsx
0c6c9a9 Update SchoolProfile.jsx
a58d7fe Update netlifyApi.js
095da4b Update netlifyApi.js
72697ca Update pdf.js
98e5ad0 Update pdf.js

$ git diff main...HEAD --stat
(empty; HEAD is main)
```

The migration helper is cloned under `.migration/firebase-to-supabase/`; `.migration/` is ignored by the application repository.

## Framework and Firebase configuration

- React 18 / Create React App (`react-scripts`), Capacitor Android client, Netlify Functions, and Firebase Cloud Functions.
- The client SDK is initialized in `src/firebase.js`: Firebase Auth, Firestore, and Storage; `activeDb` and `archiveDb` currently alias the same Firestore instance.
- Client Firebase values are selected from `REACT_APP_FIREBASE_*` variables with source fallbacks. `.env` exists locally and was not read or disclosed. `.env-example` and source fallback configuration do not describe the same Firebase project; reconcile this before cutover.
- Android Firebase configuration is present for the app variants. The workspace has distinct KU and Kiwanja Firebase project configurations; whether each gets a separate Supabase project or both share one is unresolved.
- Root dependencies include `firebase` and `firebase-admin`; Cloud Functions and Netlify Functions also have their own Firebase Admin/Functions dependencies.
- Cloud Functions initialize Admin in `functions/lib/admin.js`. Netlify Functions initialize it in `netlify/functions/_lib/firebaseAdmin.js`.
- The app uses Firebase Storage for school-exit PDF uploads in `services/ExportService.js`.

## Migration helper setup (values intentionally redacted)

The helper README describes single-collection export to a same-named PostgreSQL table, optional JSONB columns, custom hooks for normalized nested data, Firestore ID import, Firebase Auth migration, and a first-login password verification middleware marked **work in progress**.

| File | State observed | Notes |
|---|---|---|
| `firestore/supabase-service.json` | Absent | No usable Supabase connection configuration is present. |
| `firestore/supabase-service-sample.json` | Present | Contains a password-like value; it was not copied into this repository or echoed. Its host is not a Supabase Postgres Session-pooler host, so it does not satisfy the requested Phase 1 connection configuration. |
| `firestore/firebase-service.json` | Present in the clone and tracked by the helper repository | Contains a Firebase Admin private key. The file contents were not displayed or used. Treat as exposed: revoke/rotate the service-account key before any Firebase access. |
| `auth/supabase-service.json` | Absent | Auth migration does not have a separate Supabase connection configuration. |
| `auth/firebase-service.json` | Absent | Auth migration does not have a separate Firebase service file. |

**Security blocker:** Do not run helper scripts with the cloned credentials. Replace the local ignored Firebase service file with a newly generated, rotated key; create the required ignored `supabase-service.json` using the Supabase Dashboard’s Session pooler settings. If the password-like value in the tracked sample is or was valid, rotate the Supabase database password too. No secrets were added to this PR.

`node collections.js` was not run: it accesses the configured Firebase project, is listed under the user's Phase 1, and awaits approval and safe credentials. Thus, the actual live collection list and counts remain unknown; the names below are static code references only.

## Application file inventory

The final column is a proposed mapping, not implemented code. Keep role/tenant semantics in RLS and use server-side transactions for coupled writes.

| File | Firebase API used | Current purpose | Proposed Supabase equivalent |
|---|---|---|---|
| `src/firebase.js` | Firebase App, Auth, Firestore, Storage initialization | Initializes SDK clients, Auth persistence, Firestore persistence, exports shared instances | One `@supabase/supabase-js` client configured by environment; Storage client where needed |
| `src/components/Auth/Login.jsx` | `firebase/auth`, `firebase/firestore` | Sign-in and account/school lookup | Supabase Auth sign-in; RLS-scoped Postgres reads |
| `src/components/Auth/Verification.jsx` | Firebase Auth email verification | Sends account verification email | Supabase Auth email verification |
| `src/components/Layout/Layout.jsx` | Firebase Auth sign-out | Signs out user | Supabase Auth `signOut` |
| `src/components/Layout/Header.jsx` | Firestore document reads | Reads school profile | Postgres select by school ID |
| `src/components/Layout/MobileNav.jsx` | Firestore document and count queries | Reads school features and student/fee counts | Postgres select/count queries |
| `src/components/Layout/Sidebar.jsx` | Firestore reads/count queries | Reads user, student, teacher and fee counts | RLS-scoped Postgres selects/counts |
| `src/components/Communication/SMSAnalytics.jsx` | Firestore filtered query | Reads SMS queue analytics | Postgres filtered aggregate/select |
| `src/components/WholeSchoolTimetableGenerator.jsx` | Firestore batch writes | Saves generated school timetables | Postgres transaction/upsert |
| `src/context/AuthContext.jsx` | Auth state listener, token claims, sign-out; Firestore reads/writes | Hydrates user/school profile, tracks auth and logout | Supabase session listener/JWT claims; profile tables |
| `src/context/BadgeContext.jsx` | Firestore aggregation counts | Loads school/student/teacher/exam badges | Postgres counts or SQL RPC |
| `src/context/NotificationContext.jsx` | Firestore queries/realtime reads | Reads notifications and related activity data | Postgres select; Realtime channels where needed |
| `src/context/SchoolContext.jsx` | Firestore document reads | Loads school/class configuration | Postgres select |
| `src/context/SyncContext.jsx` | Firestore document writes | Synchronizes queued records/scores | Postgres upsert/transaction |
| `src/pages/Attendance.jsx` | Firestore CRUD/query | Attendance records and reports | Normalized attendance and attendance-entry tables |
| `src/pages/Boarding.jsx` | Firestore CRUD/query | Boarding assignments and related records | RLS-protected Postgres CRUD |
| `src/pages/BulkSMS.jsx` | Firestore query/add/delete | Reads/writes SMS templates and queue | Postgres CRUD; Edge Function for sending |
| `src/pages/Communication.jsx` | Firestore CRUD/realtime | Communications, campaigns and SMS data | Postgres CRUD; Edge Function and optional Realtime |
| `src/pages/Communications.jsx` | Firestore CRUD/query | Communication records and related data | Postgres CRUD; Realtime if currently required |
| `src/pages/Dashboard.jsx` | Firestore queries/counts/listeners | School dashboard data and aggregates | Indexed SQL views/queries or RPC |
| `src/pages/Discipline.jsx` | Firestore CRUD/query | Discipline records | RLS-protected Postgres CRUD |
| `src/pages/Exams.jsx` | Firestore CRUD/query | Exam records | RLS-protected Postgres CRUD |
| `src/pages/Fees.jsx` | Firestore CRUD/query/update | Invoices, balances, transactions and payment UI | Postgres tables and transactional RPC/Edge Functions |
| `src/pages/FeesReports.jsx` | Firestore query/read | Fee and invoice reports | SQL views/aggregates |
| `src/pages/HealthRecords.jsx` | Firestore CRUD/query | Student health records | Restricted RLS-protected tables |
| `src/pages/Inventory.jsx` | Firestore CRUD/query | School inventory | RLS-protected Postgres CRUD |
| `src/pages/PlatformAdmin/Dashboard.jsx` | Firestore reads/aggregates | Platform dashboard | Server-side administrative queries/RPC |
| `src/pages/PlatformAdmin/SchoolDetails.jsx` | Firestore CRUD/query | School and related record administration | Authorized Postgres CRUD/RPC |
| `src/pages/PlatformAdmin/Schools.jsx` | Firestore CRUD; Firebase Auth create/profile/reset | Creates schools and admin users | Postgres CRUD; Supabase Auth admin API and email flows |
| `src/pages/PlatformAdmin/Users.jsx` | Firestore query/update/delete | Lists and manages user profiles | Postgres CRUD with protected admin operations |
| `src/pages/Reports.jsx` | Firestore query/read | Reads report inputs | SQL views/queries/RPC |
| `src/pages/Results.jsx` | Firestore query and writes | Reads/saves/publishes scores and configs | Normalized Postgres CRUD/RPC |
| `src/pages/SchoolExit.jsx` | Firestore reads and `onSnapshot` | Reads/listens to exit records | Postgres select and Realtime channel |
| `src/pages/SchoolProfile.jsx` | Firestore CRUD | Reads/updates school settings and profile | RLS-protected Postgres CRUD |
| `src/pages/Settings.jsx` | Firestore; Firebase Auth profile/password/email/reauth | Updates profile and account credentials | Postgres profile updates; Supabase Auth update/reauth |
| `src/pages/Student/Dashboard.jsx` | Firestore query/read | Reads student-specific dashboard | User-scoped Postgres select |
| `src/pages/Student/Results.jsx` | Firestore query/read | Reads student results | User-scoped Postgres select |
| `src/pages/StudentPromotion.jsx` | Firestore transactions/reads/writes | Applies and rolls back year-end decisions | Transactional Postgres RPC and lifecycle tables |
| `src/pages/StudentReports.jsx` | Firestore query/read | Reads report forms and score data | Postgres queries/views |
| `src/pages/Students.jsx` | Firestore CRUD/query | Student roster and profile management | Postgres CRUD with school/role RLS |
| `src/pages/Subscription.jsx` | Firestore CRUD/query | Reads/updates subscription state | Postgres plus server-side billing integration |
| `src/pages/Teacher/Dashboard.jsx` | Firestore query/read | Reads teacher-scoped dashboard | Role-scoped Postgres select |
| `src/pages/Teacher/Reports.jsx` | Firestore query/read | Reads teacher reports | Postgres queries/views |
| `src/pages/TeacherProfile.jsx` | Firestore CRUD | Reads/updates teacher profile | RLS-protected Postgres CRUD |
| `src/pages/Teachers.jsx` | Firestore CRUD; Firebase Auth password reset | Teacher management and password reset | Postgres CRUD; Supabase Auth reset flow |
| `src/pages/Transcripts.jsx` | Firestore query/read | Reads transcript/result records | Postgres queries/views |
| `src/pages/Transfer.jsx` | Firestore CRUD/query | Reads/writes student transfers | Transactional Postgres lifecycle operation |
| `src/pages/Transportation.jsx` | Firestore CRUD/query | Transport records | RLS-protected Postgres CRUD |
| `src/services/SchoolExitService.js` | Firestore reads/writes/batch/`arrayUnion` | Exit, reversal, status and audit operations | Transaction/RPC and normalized lifecycle events |
| `src/services/admissionNumberService.js` | Firestore query/read | Looks up student admission numbers | Indexed Postgres select |
| `src/services/attendanceService.js` | Firestore CRUD/query/batch | Attendance and roster reads/writes | Attendance parent and child tables; transactions |
| `src/services/auditService.js` | Firestore add/query/order/pagination | Appends and lists audit events | Append-only audit table and paginated select |
| `src/services/feeService.js` | Firestore CRUD/query/batch/transaction/count | Invoices, fee structures, balances and payments | Relational fee tables plus atomic SQL RPC |
| `src/services/firestore.js` | Firestore CRUD/query/batch/`onSnapshot` | Shared student, score, assessment and paper-config operations | Postgres CRUD/upsert; Realtime where required |
| `src/services/mpesaReconciliationService.js` | Firestore query/read | Reads pending/orphan/error payment records | Postgres queries; privileged Edge Function for reconciliation |
| `src/services/reportsService.js` | Firestore document/query/read | Reads report inputs and school data | SQL views/queries/RPC |
| `src/services/studentPromotionService.js` | Firestore transaction and document reads/writes | Applies/rolls back decisions, stores operations and archives | Postgres transaction/RPC; preserve operation/archive IDs |
| `src/services/studentService.js` | Firestore CRUD/query/pagination/batch | Student roster and bulk updates | Postgres CRUD and bulk transactional operations |
| `src/services/studentStatsService.js` | Firestore query/read | Student/teacher statistics | Postgres aggregates/views/RPC |
| `src/services/timetableService.js` | Firestore CRUD/query; dynamic delete | Timetables, events, settings and duty rosters | Postgres schedule and event tables |
| `src/utils/ChatbotActions.js` | Firestore query/count | Reads school/student records for chatbot actions | RLS-aware Postgres queries/RPC behind authorized API |
| `src/utils/firestoreUsageTracker.js` | Firestore get/set | Reads/updates usage document | Postgres upsert |
| `services/ExportService.js` | Firebase Storage upload/download URL | Uploads school-exit PDF exports | Supabase Storage upload/signed URL |
| `services/SchoolExitService.js` | Firestore CRUD/batch/`arrayUnion` | Legacy exit/export/archive/deletion flow | Postgres transactions; Storage for export objects |
| `StudentReports.jsx` | Firestore query/read | Standalone student report reads | Postgres views/queries |
| `generate_sms.js` | Firestore query/read/add | Standalone SMS generation and queue writes | Postgres CRUD; Edge Function for dispatch |
| `generate_sms2.js` | Firestore query/read/add/delete | Reads students, balances, templates/history; writes/deletes SMS templates/queue | Postgres CRUD; Edge Function for dispatch |

## Backend Firebase inventory

| File | Firebase API used | Current purpose | Proposed Supabase equivalent |
|---|---|---|---|
| `functions/lib/admin.js` | Firebase Admin SDK | Initializes Firestore shared by Cloud Functions | Server Supabase client with service role kept server-side |
| `functions/callable/bulkInvoiceCreate.js` | Cloud Functions `onCall`; Firestore batch | Authenticated bulk invoice creation | JWT-validated Edge Function and Postgres transaction |
| `functions/callable/postTransactionHelper.js` | Firestore transaction | Posts fee ledger, updates balances/invoices and audit | Postgres transaction/RPC |
| `functions/reports-rollup.js` | Cloud Functions callable; Admin Firestore | Reads school/score/count data; writes report snapshots | Edge Function and SQL aggregates |
| `functions/schedule-deletion.js` | Scheduled Cloud Function; Admin Firestore | Processes school exit cleanup and deletion schedule | Scheduled Edge Function/cron; preserve existing retention rules |
| `functions/triggers/onFeeTransactionWrite.js` | Firestore write trigger and transaction | Updates invoice summaries and event idempotency | Postgres trigger or atomic application transaction |
| `functions/triggers/onInvoiceWrite.js` | Firestore write trigger and transaction | Maintains invoice summary totals | Postgres trigger or atomic application transaction |
| `netlify/functions/_lib/firebaseAdmin.js` | Firebase Admin SDK | Shared Netlify Admin initialization | Server-only Supabase client |
| `netlify/functions/_lib/chatbotAuth.js` | Admin Auth token verification and Firestore user lookup | Authorizes chatbot function callers and loads role/school context | Supabase Auth `getUser`; RLS-scoped profiles |
| `netlify/functions/attendance-summary.js` | Admin Firestore | Reads attendance for summary | SQL aggregate/Edge Function |
| `netlify/functions/backfill-email-domains.js` | Admin Firestore | Reads/updates school email-domain data | Authorized bulk Postgres update |
| `netlify/functions/callable/bulkFeeEntry.js` | Functions `onCall`; Admin Firestore | Authenticated bulk fee entry and student reads | JWT-validated Edge Function and SQL transaction |
| `netlify/functions/callable/voidTransaction.js` | Functions `onCall`; Admin Firestore | Validates and reverses fee transaction | JWT-validated Edge Function and SQL transaction |
| `netlify/functions/chatbot-performance.js` | Admin Firestore | Reads scores/students for chatbot performance | Postgres queries/RPC behind Edge Function |
| `netlify/functions/chatbot-school-info.js` | Admin Firestore | Reads school information and counts | Postgres query/RPC behind Edge Function |
| `netlify/functions/generate-attendance-pdf.js` | Admin Firestore | Reads attendance/student data to generate PDF | Postgres reads plus server PDF function |
| `netlify/functions/get-student-balance.js` | Admin Firestore | Reads student fee balances | RLS-aware Postgres read/RPC |
| `netlify/functions/http/sendInvoiceReminder.js` | Functions HTTP request/secrets; Admin Firestore | Reads invoice/school/student; updates reminder status | Edge Function, Postgres update and secret storage |
| `netlify/functions/manage-school-admins.js` | Admin Auth and Firestore | User/school admin lifecycle operations and deletion requests | Supabase Auth admin API and Postgres transaction |
| `netlify/functions/mpesa-callback.js` | Admin Firestore transaction/FieldValue | Reconciles callback into ledger, balance, invoice, receipt and audit | Webhook Edge Function and atomic SQL transaction |
| `netlify/functions/mpesa-stk-push.js` | Admin Firestore and batch | Verifies student/invoice/config; creates pending transaction records | Edge Function, server secrets and atomic Postgres writes |
| `netlify/functions/mpesa-timeout-sweep.js` | Scheduled handler; Admin Firestore transaction | Sweeps pending payments and updates ledger/audit | Scheduled Edge Function/cron and SQL transaction |
| `netlify/functions/provision-student-account.js` | Admin Auth and Firestore | Provisions student account and profile | Supabase Auth admin API plus Postgres transaction |
| `netlify/functions/reports-rollup.js` | Admin Firestore | Reads fee transaction aggregates for reports | SQL aggregate/Edge Function |
| `netlify/functions/scheduled/agingReport.js` | Scheduled handler/secrets; Admin Firestore | Reads schools/invoices and writes aging reports | Scheduled Edge Function and Postgres |
| `netlify/functions/scheduled/overdueInvoices.js` | Scheduled handler; Admin Firestore batch | Queries and updates overdue invoices | Scheduled Edge Function and bulk SQL update |
| `netlify/functions/scheduled/sendReminders.js` | Scheduled handler/secrets; Admin Firestore | Reads invoices/schools/students and sends reminders | Scheduled Edge Function, secrets, Postgres |
| `netlify/functions/scheduled/termRollover.js` | Scheduled handler; Admin Firestore batch | Reads school balances and creates invoices | Scheduled Edge Function and SQL transaction |
| `netlify/functions/send-invoice-reminder.js` | Admin Firestore | Reads invoice/school/student and updates reminder timestamp | Edge Function and Postgres |
| `netlify/functions/send-teacher-welcome.js` | Admin Firestore | Reads teacher for welcome-message workflow | Postgres select and email Edge Function |

No client `httpsCallable` invocation was found. Confirm whether callable handlers are deployed/used, and how, before replacing their routes. Netlify Functions and Cloud Functions must be migrated as business workflows, not simply as a Firestore API substitution.

## Static collection references (not a live Firestore inventory)

Observed collection names include:

`schools`, `users`, `user_roles`, `students`, `teachers`, `activities`, `_usage_stats`, `attendance`, `student_scores`, `exams`, `exam_submissions`, `assessment_configs`, `paper_configs`, `subject_paper_configs`, `level_permissions`, `school_timetables`, `timetable_settings`, `timetable_events`, `assignments`, `term_locks`, `class_summaries`, `archived_students`, `student_archives`, `student_promotion_operations`, `student_transfers`, `transfer_packages`, `school_exits`, `school_archives`, `fee_invoices`, `feeBalances`, `fee_structures`, `fee_transactions`, `student_balances`, `invoices`, `receipts`, `fee_audit_log`, `invoice_summaries`, `fee_summary_events`, `mpesa_pending_transactions`, `mpesa_orphan_callbacks`, `mpesa_callback_errors`, `aging_reports`, `communications`, `notifications`, `sms_queue`, `sms_history`, `sms_templates`, `message_templates`, `sms_gateway`, `discipline_records`, `health_records`, `allergies`, `immunizations`, `prescriptions`, `medical_staff`, `buses`, `drivers`, `routes`, `transport_payments`, `fuel_records`, `dorm_assignments`, `dorm_inventory`, `dorm_maintenance`, `dorm_patrons`, `dorm_rules`, `dormitories`, `school_inventory`, `inventory_logs`, `maintenance`, `duty_rosters`, `audit_logs`, and `school_admin_deletion_requests`.

Some collections are dynamically named or nested under documents. The deletion scheduler also references legacy `fee_invoices` and `fee_payments`; they must not be conflated with `invoices`/`fee_transactions`. Confirm the live collection list in approved Phase 1 before schema or data changes.

## Nested fields and relational schema proposal

Current query filters generally address top-level fields (`schoolId`, `studentId`, `level`, `class`, `term`, `year`, `status`, dates). The exception found is `student_transfers.schools[]`, queried with Firestore `array-contains`. No independently queried nested map field was found in the inspected paths.

| Firestore shape | Relational proposal |
|---|---|
| All collection document identities | `firestore_id TEXT PRIMARY KEY`, preserving IDs verbatim; source IDs and school/student IDs remain text until verified. Add foreign keys only where references are proven; avoid cascades that could erase history. |
| `attendance.entries[]`, embedded counts | `attendance_records` parent plus `attendance_entries(attendance_id FK, ordinal, student_id, status, note, raw_entry JSONB)`. Preserve array order and original attendance ID. |
| `students.history[]` | `student_history_entries(student_id FK, ordinal, event_type, academic_year, from/to level/class, occurred_at, raw_entry JSONB)`. Keep source order and full original student payload during transition. |
| `student_promotion_operations` request/before/after snapshots and `student_archives.studentSnapshot` | Parent operation/archive tables with original Firestore IDs and student FKs; preserve request and snapshots in JSONB, keep archive snapshots immutable. Normalize only confirmed query fields. |
| `invoices.items[]`, `payments[]` | `invoices`; `invoice_items(invoice_id FK, ordinal, normalized known fields, raw_item JSONB)`. The populated payment element shape is not yet verified: retain `payments` JSONB until inspected, then add `invoice_payments` with ordinal/FK. |
| `fee_structures.items[]` | `fee_structures` plus `fee_structure_items(structure_id FK, ordinal, amount, optional, raw_item JSONB)`. Confirm more item fields before normalization. |
| `student_scores.papers{}` and paper config `papers[]` | `student_scores`; child `student_score_papers(score_id FK, paper_key, score, max_score, weight)`; `paper_configs` plus `paper_config_papers(config_id FK, ordinal, name, max_score, weight)`. Keep original JSONB during transition. |
| `school_timetables.schedule` and duty roster/settings objects | `school_timetables` with parent Firestore ID and indexed school/level/class/term/year; optionally `timetable_slots(timetable_id FK, day, period_id, slot_jsonb)` after full shape review. Keep settings and duty roster JSONB until query needs are known. |
| `timetable_events.classes[]`, `days[]`, `periodIds[]` | `timetable_events` plus ordered child tables (`event_classes`, `event_days`, `event_periods`) with ordinal and parent FK. |
| `student_transfers.schools[]`, transfer history | `student_transfers` plus `student_transfer_schools(transfer_id FK, ordinal, school_id)` to support the observed array query. Keep history as ordered JSONB until its element schema is verified. |
| Teacher `assignments[]`, legacy `subjects[]`; audit `meta` map | Candidate normalized `teacher_assignments` and ordered assignment-class rows if query/report use confirms. Keep legacy subjects and audit `meta` JSONB unless independently queried. |
| School settings/features, exit schedule/export package, callback payloads | Keep nested configuration, immutable export payloads and webhook metadata as JSONB where not independently queried; use explicit indexed columns for verified filter/sort fields. |

## Questions that block later phases

1. The workspace has separate KU and Kiwanja Firebase projects/configs. Should they migrate to **one** Supabase project with strict school/tenant isolation, or to separate Supabase projects?
2. Which Supabase project is the destination? The helper currently has no valid Session-pooler `supabase-service.json`.
3. Confirm which callable handlers are actually used/deployed; no app `httpsCallable` caller was found.
4. Confirm whether `paper_configs` and `subject_paper_configs` are parallel active stores or legacy aliases.
5. Confirm authoritative relationships where code stores `studentId` (document ID versus a student identifier), dangling references, and retention requirements for archives.
6. Confirm invoice payment, transfer history, roster, and schedule object shapes before final child-table decisions.
7. Reconcile `fee_invoices`, `feeBalances`, `invoices`, `student_balances`, `fee_transactions`, and legacy `fee_payments`; they are distinct code paths.
8. The Firebase-to-Supabase helper describes password migration middleware as work in progress. Phase 3 must be reviewed and security-tested rather than assuming it preserves first-login password migration safely.

## Phase 0 completion / next gate

- Complete: workspace and helper repository inspected; static inventory and normalization proposal recorded.
- Complete: `.migration/` added to the application `.gitignore`; helper clone and credentials remain outside version control.
- Not run: live `node collections.js`, data export/import, auth export/import, schema changes, or app changes.
- Before Phase 1: rotate the tracked Firebase Admin service-account key and any live password found in the helper's tracked sample; populate safe local ignored configs; answer the destination-project question; explicitly approve Phase 1.
