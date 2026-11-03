# Phase 4 — app-layer migration review

**Status: active-flow inventory complete; app cutover remains blocked.** The
user confirmed the current app is functioning and some Firebase callsites are
dead code. Accordingly, the Phase 4 scope is limited to flows reachable from
the shipped router/shared providers; likely dead routes/helpers remain
untouched unless runtime evidence proves they are used. The user approved a
source-scoped Auth prerequisite; that additive schema change is applied and
verified. The user also approved the fail-closed schema for 38 active-flow
relations, followed by a reviewed RLS step for a 27-relation subset. The
policies and authenticated grants are applied and verified; the other 11
relations remain denied. No application data path or Firebase configuration
has been switched.

## Approved scope and remaining gates

The approved planning scope is **active app flows only** and a **dedicated
source-scoped Netlify provisioning function**. Static references that appear
unreachable are not migration requirements and will not be deleted as part
of this work.

The approved read-only count profile is complete. It found no live documents
in any of the 53 additional collection names in either Firebase project, so
there are no live nested shapes to export or import for those collections.
The database count check was sanity-checked against the existing `students`
counts (KU 1,971; Kiwanja 730), which match the Phase 2 source snapshots.
Schema details for future records must therefore come from app payload
constructors and remain conservative where those constructors do not
establish field or ID semantics.

The remaining gates are: (1) resolve the documented identity, provisioning,
and rule ambiguities; (2) review Phase 2 imported-table RLS separately; and
(3) migrate and test app flows, offline queueing, and source-scoped account
provisioning. No Phase 2 table grants were changed and no application flow
has been partially switched.

The typed schema registry and default-deny RLS plan is in
`MIGRATION-PHASE-4-SCHEMA-PROPOSAL.md`; the policy/grant matrix is in
`MIGRATION-PHASE-4-RLS-PLAN.md`. The typed schema for 38 relations is applied.
The approved 27-relation policy scope has 60 policies, authenticated grants,
and immutable-key triggers. The other 11 remain default-denied.

Follow-up tracing found transfer requests are initially written without a
single `schoolId` or verified student ID; they carry both school IDs in
`schools[]`, then fill verification/release/admission fields through later
workflow steps. The applied schema currently over-constrains those columns.
A forward-only, empty-table-guarded correction in
`migration/phase-4/transfer-contract-correction.sql` was applied and verified.
The transfer relation remains empty and policy-free. Transfer access remains
denied until the cross-school authorization model is resolved.

## Completed Phase 4 Auth prerequisite

The user approved replacing global uniqueness on
`firebase_migration_auth_user_map` with per-source uniqueness and adding a
source-scoped platform-admin membership relation. The additive,
transaction-bounded script `migration/phase-4/auth-source-scope.sql` was
applied after checking that no within-source email or Auth-ID collisions
would violate the new constraints. It drops only the two old global indexes,
creates `(source_project, auth_user_id)` and
`(source_project, lower(email))` unique indexes, and adds
`firebase_migration_platform_admin_memberships` with RLS enabled, self-read
only for authenticated users, and server-only insert/delete grants.

Post-apply verification found 62 Auth mappings and 54 tenant memberships
(unchanged), zero rows in both the former global-admin table and the new
source-scoped admin table, authenticated SELECT but no INSERT on the new
relation, and only the self-read policy. No memberships or admin assignments
were backfilled. The source-pinned legacy password migration now refuses to
change the password when the mapped Auth identity has any mapping in another
source, and marks completion by exact source plus Firebase UID. This prevents
one source's legacy credential from overwriting a password already shared
across sources.

The separately approved `migration/phase-4/active-app-schema.sql` created 38
empty typed relations, including nine source-scoped child foreign keys. The
approved `migration/phase-4/active-app-rls.sql` then applied 60 policies to
27 relations, authenticated grants on those 27 only, and immutable-key
triggers on all 27. The remaining 11 relations have no client grants or
policies. `node migration/phase-4/verify-active-app-rls.js` verified all 38
relations have RLS enabled, all remain empty, no `anon`/`service_role` table
access exists, six invoice checks and the control version are present, and
the role-scoped helper allows a real same-school membership but rejects an
unrelated school. The Auth baseline remains 62 mappings and 54 tenant
memberships. No collection data was imported.

These schema steps do not implement duplicate-account linking,
provisioning, policy broadening, or Auth/app cutover. Future linking must
require a verified Supabase email and proof of the second source's legacy
password, then set the user's explicitly chosen shared password; client email
matching alone is insufficient.

## App Firestore collection → Phase 2 mapping

The Phase 2 schema stores each imported source document in
`public.firebase_migration_<collection>.document`; its typed tenant and source
keys are `school_id` and `source_project`. Child data has the mappings in
`MIGRATION-PHASE-2-REVIEW.md` and `migration/phase-2/schema-spec.js`. The
project uses source-scoped records (`ku` or `kiwanja`); app queries and writes
must preserve that scope.

| App collection(s) | Phase 2 relation | Current client access / result |
|---|---|---|
| `attendance` | `firebase_migration_attendance`; entries/counts in `attendance_entries` / `attendance_counts` | School-member CRUD is granted by the approved Phase 2 policy. Individual attendance screens also read `schools` and `students`, which remain denied. |
| `paper_configs` | `firebase_migration_paper_configs`; items in `paper_config_items` | Member select and admin writes are granted. |
| `subject_paper_configs` | `firebase_migration_subject_paper_configs`; items in `subject_paper_config_items` | Member CRUD is granted. |
| `user_roles` | `firebase_migration_user_roles`; assignments/scopes in `user_role_assignments`, `user_role_scopes`, and `user_role_assignment_classes` | Member select and admin writes are granted. |
| `level_permissions` | `firebase_migration_level_permissions` | Active settings flow; school-member reads and trusted school-admin writes are granted by the explicit Phase 2 exception. |
| `audit_logs` | `firebase_migration_audit_logs` | Imported, but no client grant/policy. |
| `exams` | `firebase_migration_exams` | Imported, but no client grant/policy. |
| `fee_audit_log`, `fee_structures`, `fee_transactions` | `firebase_migration_fee_audit_log`, `firebase_migration_fee_structures`, `firebase_migration_fee_transactions`; fee items in `fee_structure_items` | Imported, but no client grant/policy. |
| `mpesa_pending_transactions` | `firebase_migration_mpesa_pending_transactions` | Imported, but no client grant/policy. |
| `school_timetables`, `timetable_settings` | `firebase_migration_school_timetables`, `firebase_migration_timetable_settings`; slots/periods in `school_timetable_slots` / `timetable_setting_periods` | Imported, but no client grant/policy. |
| `schools` | `firebase_migration_schools`; configuration children include `school_custom_classes`, `school_subject_options`, `school_class_teachers` | Imported, but no client grant/policy. Branding and tenant discovery cannot be moved to these relations yet. |
| `student_balances`, `student_scores` | `firebase_migration_student_balances`, `firebase_migration_student_scores`; score papers in `student_score_papers` | Imported, but no client grant/policy. |
| `students` | `firebase_migration_students`; history in `student_history_entries` | Imported, but no client grant/policy. |
| `teachers`, `users` | `firebase_migration_teachers`, `firebase_migration_users`; assignment/scope children are in the Phase 2 schema | Imported, but no client grant/policy. Profile reads/writes are therefore blocked. |
| `assessment_configs`, `class_summaries` | No Phase 2 relation | `assessment_configs` is active and not exported/imported. `class_summaries` is a likely dead uncalled helper. |
| `fee_invoices`, `feeBalances`, `invoices`, `invoice_summaries`, `term_locks` | No exact Phase 2 relation | Active: `fee_invoices`, `invoices`, `invoice_summaries`, and `term_locks`. `feeBalances` is referenced only by unmounted `BulkSMS.jsx`. Do not assume similarly named invoice/balance collections are aliases. |
| `archived_students`, `student_archives`, `student_promotion_operations` | No Phase 2 relation | Not exported/imported. |
| `sms_templates`, `sms_queue`, `sms_gateway`, `sms_history` | No Phase 2 relation | Active: `sms_templates`, `sms_gateway`, `sms_history`. `sms_queue` is referenced only by unmounted `BulkSMS.jsx`; it is not assumed to be either `sms_jobs` or `sms_outbox`. |
| `communications`, `message_templates`, `notifications`, `activities`, `exam_submissions` | No Phase 2 relation | Active: `notifications`, `activities`, `exam_submissions`. `communications` and `message_templates` are referenced only by the unmounted legacy `Communication.jsx`. |
| `discipline_records` | No Phase 2 relation | Not exported/imported. |
| `allergies`, `health_records`, `immunizations`, `medical_inventory`, `medical_staff`, `prescriptions` | No Phase 2 relation | Active Health Records route; source shape profile found no historical rows. The Firestore rules have no explicit match for `medical_inventory`. |
| `inventory_logs`, `school_inventory` | No Phase 2 relation | Not exported/imported. |
| `school_exits` | No Phase 2 relation | Not exported/imported; includes realtime subscriptions. |
| `student_transfers`, `transfer_packages` | No Phase 2 relation | Not exported/imported. |
| `visits` | No Phase 2 relation | Active Health Records route; source shape profile found no historical rows. Preserve the collection as distinct until its domain fields are confirmed. |
| `dorm_assignments`, `dorm_inventory`, `dorm_maintenance`, `dorm_patrons`, `dorm_rules`, `dormitories` | No Phase 2 relation | Not exported/imported. |
| `assignments`, `buses`, `drivers`, `fuel_records`, `maintenance`, `routes`, `transport_payments` | No Phase 2 relation | Not exported/imported. `assignments` is not assumed to mean teacher/user assignment child rows. |
| `report_latest`, `report_snapshots`, `duty_rosters`, `timetable_events`, `mpesa_callback_errors`, `mpesa_orphan_callbacks`, `receipts`, `_usage_stats` | No Phase 2 relation | Active: `duty_rosters`, `timetable_events`, `_usage_stats`. Report/reconciliation names are referenced only by uncalled services or an unregistered page. `_usage_stats` and payment collections also have server-side callers, outside app cutover scope. |

This inventory comes from statically named Firestore `collection()`/`doc()`
references under `src/` and literal collection lists passed to generic
collection loaders. The static set contains 72 names (19 Phase 2 parent
relations and 53 without a Phase 2 parent), but this is not the migration
scope: route/caller tracing identified 10 likely dead names and 43 additional
names reachable from shipped routes or shared components. Collections passed
indirectly through generic loaders are attributed to their callers. A
reachable feature may still be conditionally mounted by role, and its
collection still needs role-specific RLS; a table-name match is not
authorization.

### Active-flow scope and likely dead references

The following 43 additional collections have reachable app flows according
to the router/shared-component trace and remain candidates for reviewed
schema/policy work: `_usage_stats`, `activities`, `allergies`,
`archived_students`, `assessment_configs`, `assignments`, `buses`,
`discipline_records`, `dorm_assignments`, `dorm_inventory`,
`dorm_maintenance`, `dorm_patrons`, `dorm_rules`, `dormitories`, `drivers`,
`duty_rosters`, `exam_submissions`, `fee_invoices`, `fuel_records`,
`health_records`, `immunizations`, `inventory_logs`, `invoice_summaries`,
`invoices`, `maintenance`, `medical_inventory`, `medical_staff`,
`notifications`, `prescriptions`, `routes`, `school_exits`, `school_inventory`,
`sms_gateway`, `sms_history`, `sms_templates`, `student_archives`,
`student_promotion_operations`, `student_transfers`, `term_locks`,
`timetable_events`, `transfer_packages`, `transport_payments`, and `visits`.

The active-flow trace found these client contracts (fields described as
"form spread" remain subject to the actual form definitions, not assumed
column lists):

| Reachable flow | Observed app contract and evidence |
|---|---|
| `assessment_configs` | Tenant/level/class/subject-filtered reads; merge writes use school, level, class, subject, assessment type, term, deadline, creator, timestamps, and active flag. The document ID is a normalized tuple of the scope fields. `src/services/firestore.js:68-92`, `src/utils/scoreId.js:30-35`. |
| Health records (`health_records`, `prescriptions`, `allergies`, `immunizations`, `medical_staff`) | School-filtered reads and realtime listeners. `health_records` form fields: student ID (required), visit date/type, symptoms, diagnosis, treatment, severity/status, temperature, blood pressure, weight/height, notes, referral fields and follow-up date; adds student name/class, tenant and timestamps. Numeric-looking measurements remain strings. `prescriptions`: required student, medication, dosage and frequency; optional record/route/duration/type/prescriber/date/notes. `allergies`: required student, allergen and severity; optional type/reaction/diagnosis date/notes. `immunizations`: required student, vaccine, dose and date; optional next-due/administered-by/batch/notes. `medical_staff`: required name/email/phone/role; optional qualification/license/status/notes. Each adds tenant/timestamps; form IDs are not validated against relational targets. `src/pages/HealthRecords.jsx:121-184,420-610,1235-1839`. |
| Health reads (`visits`, `medical_inventory`) | School-filtered reads/listeners only; no write found in the routed page. `src/pages/HealthRecords.jsx:237-336`. |
| Transportation (`buses`, `routes`, `drivers`, `assignments`, `transport_payments`, `maintenance`, `fuel_records`) | School-filtered reads/listeners. Required fields: buses (registration/model/capacity); routes (name/start/end/distance/fee); drivers (name/email/phone/license/expiry); assignments (student/route/bus/status); payments (student/route/amount); maintenance (bus/type/description); fuel (bus/amount/cost). Optional fields include each form's status, dates, notes, stops/days, pickup/dropoff and payment reference fields. Builders add tenant/timestamps; only payment amount, maintenance cost, fuel amount and cost are parsed as numbers. Other numeric-looking input values remain strings. Updates spread form plus timestamp; delete uses Firestore document ID. ID reference semantics are not validated. `src/pages/Transportation.jsx:89-168,416-609,1500-2260`. |
| Boarding (`dormitories`, `dorm_assignments`, `dorm_patrons`, `dorm_maintenance`, `dorm_rules`, `dorm_inventory`) | Required fields: dormitory (name/code/gender/capacity); assignment (student/dorm); patron (teacher/dorm); maintenance (dorm/type/description/priority); rule (dorm/title/description); inventory (dorm/item/quantity). Optional fields include occupancy/status/location, room/bed/date, role/date, maintenance status/cost, rule priority/category, and inventory condition/check date. Create adds tenant/timestamps; capacity, inventory quantity, and maintenance cost are converted to integer/integer/number; assignments denormalize student name/class and adjust dorm occupancy/status; patrons denormalize teacher/dorm names. ID references are used as document IDs but are not validated against source records. Updates spread form plus timestamp; deletes use document IDs, with a local guard against deleting occupied dormitories. `src/pages/Boarding.jsx:104-168,393-835,1634-2253`. |
| `discipline_records` | Tenant query, capped at 2,000, then sorted by incident date. Create uses generated ID and explicit student/document reference, denormalized identity, incident/category/severity/summary/action/follow-up, status/parent notification, recorder and timestamp fields. Updates change notification/status fields; no delete found. `src/pages/Discipline.jsx:58-80,132-230`. |
| Inventory (`school_inventory`, `inventory_logs`) | Inventory reads are school-filtered. `school_inventory` create/update has explicit tenant, name/category/SKU, quantity/minimum, price, condition/status/location/assignee/notes and timestamps; quantity adjustments update quantity/time; delete uses document ID. `inventory_logs` has no Firestore write in the routed page (logs are local only). `src/pages/Inventory.jsx:88-99,175-300`. |
| `archived_students` | Create copies selected student details plus `fullSnapshot`, reason, archive time and actor; list filters tenant, sorts by archive time, and restore updates the student then deletes the archive. One separate `setDoc` writer needs review with the main create path. `src/pages/Students.jsx:712-848,1125-…`. |
| Promotion (`student_promotion_operations`, `student_archives`) | Both use deterministic SHA-256 IDs over school/student/year. Operation stores request, before/after snapshots, `changedFields[]`, actor/action/status/timestamps; archive stores a full student snapshot and reason/actor/time. Student history entries have type/decision/year/academic year/date/from-level/from-class, with target/destination/reason/notes depending on action. Rollback updates operation/archive status and timestamps rather than deleting the archive. `src/pages/StudentPromotion.jsx:62-77`, `src/services/studentPromotionService.js:29-36,76-145,268-…`. |
| Transfers (`student_transfers`, `transfer_packages`, `notifications`) | Transfer listener uses `schools array-contains schoolId`; another lookup filters releasing/receiving school IDs and admission number. Transfer stores school IDs/names, stages/status, reason/notes, actor/timestamps and `history[]` entries (`stage`, `status`, `timestamp`, `note`, `user`). Package ID equals transfer ID and stores student document ID/object plus `scores[]` (score document ID and score fields). Admission creates a new student document and copies scores using the new student document ID, target/source school IDs, transfer ID and time, then deletes the package. Transfer notifications include school, type/title/message and transfer ID. `src/pages/Transfer.jsx:124-140,340-425,500-655,608-690,870-1005,1040-1205`. |
| `invoices` | Deterministic scoped ID from school/student/term/year plus optional suffix. Payload includes student identity, item list (description/amount/quantity/unit price), subtotal/tax/discount/total, paid/balance, term/year/due/status/notes, an empty `payments: []`, tenant, creator and timestamps. No invoice-payment append writer was found. The invoice form's `studentIds[]` is only a UI selection list; batch submit creates one invoice per selected student and does not persist that array. Batch writes also update deterministic student balances; cancellation reconciles balances. Queries are tenant-filtered, optionally by term/year/status/student, and paginated. `src/pages/Fees.jsx:867-933`, `src/services/feeService.js:23-28,834-960`. |
| `term_locks`, `invoice_summaries` | Point reads use a deterministic school/term/year ID. Term-lock writes include tenant, term/year, lock flag, actor and time. `invoice_summaries` is only read; the returned object has no observed field access or client writer. `src/services/feeService.js:1052-1105`, `src/context/FeeContext.jsx:392-400`. |
| `fee_invoices` | Read-only tenant/status query in mounted navigation/platform-admin views; consumers use count only. No invoice fields, ordering, or write found. `src/components/Layout/Sidebar.jsx:145-175`, `src/pages/PlatformAdmin/SchoolDetails.jsx:160-184`. |
| `activities`, `exam_submissions` | Dashboard reads/realtime: activities filter tenant/order timestamp/limit 5; pending submissions filter tenant/status and teacher dashboard additionally filters class/level client-side. No reachable client write found. `src/pages/Dashboard.jsx:1040-1088`, `src/pages/Teacher/Dashboard.jsx:122-…`. |
| `notifications` | Dashboard realtime read filters tenant/unread, orders newest and limits 10. Transfer flow also creates notification records. Recipient identity is not checked by the current Firestore rules. `src/pages/Dashboard.jsx:1055-1070`, `src/pages/Transfer.jsx:…`. |
| `sms_history`, `sms_templates`, `sms_gateway` | Mounted Communications reads history/templates by school and gateway by document ID equal to school ID. Gateway fields consumed by the client are `status`, `apiUrl`, `apiKey`, `deviceId`, and `defaultSender`; `apiKey` must remain server-only in Supabase, so the client call must be replaced with a trusted function before cutover. History write has actor/transport/recipient-kind/message/count/status/`outcomes[]` fields. Template reads consume `name`, `category`, `audience`, and `body` or `content`; mounted Communications has no template write, while writes are in unmounted legacy/BulkSMS pages. `src/pages/Communications.jsx:230-247,288-300,780-830`, `src/pages/BulkSMS.jsx:194-216`. |
| `school_exits` | Routed service writes generated-ID exit audit rows with student/teacher identity, reason/date/notes/destination, actor and timestamp; lists filter by school then sort/slice locally. A separate routed page listens to status-bearing exit documents whose relation to the audit payload is not established. `src/services/SchoolExitService.js:60-205`, `src/pages/SchoolExit.jsx:20-55`. |
| Timetable (`duty_rosters`, `timetable_events`) | Duty roster point read/write uses deterministic school/term/year ID and a map keyed by weekday then duty-area ID; each generated assignment contains teacher ID/initials/full name and area ID/label/start/end. Events filter by tenant/term/year; write merges title/description/location/color/days/period IDs/level/classes/teacher name/initials plus tenant/actor/time; ID is supplied or derived from school/title/time. Normalize roster entries and event `days[]`, `periodIds[]`, and `classes[]` into typed children. `src/services/timetableService.js:318-343,402-442,981-1021`, `src/pages/Timetable.jsx:650-690`. |
| `_usage_stats` | Platform-admin dashboard reads fixed `daily_usage` and `storage` documents and updates dynamic dotted operation/date counters. This is system telemetry, not tenant CRUD; keep writes server-only unless separately reviewed. `src/pages/PlatformAdmin/Dashboard.jsx:80-100,235-350`. |

Across routed features, offline writes are queued through generic
`addToSyncQueue(collection, operation, payload)` calls. That establishes
neither a stable Postgres document-ID mapping nor nested-child replay
semantics; do not point the queue at Supabase until each active collection
has an explicit, tested serializer. Realtime listeners also need to preserve
the current cache invalidation behavior.

These 10 statically referenced names are likely dead/unreachable in the
shipped app and are excluded from Phase 4 migration scope: `communications`
and `message_templates` are referenced only by the legacy unmounted
`Communication.jsx`; `feeBalances` and `sms_queue` only by unmounted
`BulkSMS.jsx`; `class_summaries` by an uncalled helper; `report_latest` and
`report_snapshots` by an uncalled reports service; and
`mpesa_callback_errors`, `mpesa_orphan_callbacks`, and `receipts` by the
unregistered M-Pesa reconciliation page/service. `subject_paper_configs` is
already imported in Phase 2 and its helper has no active caller. `sms_jobs`
and `sms_outbox` are also imported but have no direct app callsite. We will
not port or delete these references based solely on static evidence; if they
are required by a deployed deep link, external caller, or an unobserved
role-specific route, that must be established before excluding them.

### Read-only live-source count profile

Firestore aggregation counts were run for each of the 53 additional
app-referenced collection names in both source projects. All 106
source/collection combinations returned zero documents. The Admin SDK's
read-only `students` count matched the existing Phase 2 snapshots (KU 1,971;
Kiwanja 730), and `listCollections()` returned the expected 16 KU and 18
Kiwanja root collections. No document bodies or IDs were read or exported,
and no profile artifact containing source records was created. Therefore the
additional collections have no historical rows to import in either source;
their proposed tables would support future app writes only.

## Pre-cutover RLS policy plan for imported app tables

The existing Phase 2 RLS is fail-closed and intentionally grants the app
access to only the seven previously approved collection groups. This plan
does not apply DDL or widen those grants. Before any app cutover, each
app-referenced imported parent and child relation below needs its complete
reviewed role policy and authenticated SQL grants. Every tenant predicate
must bind both `source_project` and `school_id` to a trusted
`firebase_migration_user_tenant_memberships` row for `auth.uid()`; no policy
may trust a caller-supplied tenant/source. `firebase_migration_platform_admins`
is currently empty and its membership must be populated only through a
trusted process before any platform override can work. All row-specific
checks must use typed columns (not JSON path expressions as an authorization
substitute).

### Imported roots and the required rule translation

| Parent table | Firestore rule intent to preserve | App policy status / caveats |
|---|---|---|
| `firebase_migration_audit_logs` | Read by same-school roles `admin`, `user`, `school_admin`, `principal`, `finance`, `headteacher`, `deputy-headteacher`, or verified platform admins. Create is append-only for signed-in same-school users (or platform admins) with a school ID. No update/delete. | No Phase 2 client policy. Require INSERT validation, immutable rows, and platform-admin source scoping. |
| `firebase_migration_attendance` | Firestore rules have no collection match, so production rules deny all client access. | Preserve the separate, explicit Phase 2 approval for school-member CRUD, not the more restrictive Firestore default. Child relations listed below inherit that approved scope. |
| `firebase_migration_exams` | Any signed-in school member reads; school teachers write (the existing helper includes school-admin roles). | No Phase 2 client policy. Require tenant read and teacher/admin create/update/delete. |
| `firebase_migration_fee_audit_log` | Fee managers (admins, user/school_admin, principal, finance/accountant, headteacher, deputy-headteacher, or platform admin) read and append. No update/delete. | No Phase 2 client policy. Preserve immutable audit history. |
| `firebase_migration_fee_structures` | School members read; fee managers create/update/delete. | No Phase 2 client policy. The Firestore write rule checks `incoming().schoolId` even on update/delete; clarify intended old-row tenant behavior before translating to SQL `USING`/`WITH CHECK`. |
| `firebase_migration_fee_transactions` | Fee managers or the matching student read. Fee managers append valid idempotent rows (`id == idempotencyKey`, valid amount/type/status, initial `voided=false`); only one constrained transition from not-voided to voided is allowed; never delete. | No Phase 2 client policy. Student ownership must resolve through a verified Auth/profile mapping; do not compare a Firebase UID directly to `auth.uid()` without that mapping. Enforce immutable transaction fields and idempotency in a reviewed RPC/constraint. |
| `firebase_migration_level_permissions` | No Firestore collection match (default deny). | Preserve the explicit Phase 2 exception: same-school member read, trusted school `admin` write only. Do not silently extend writes to all `isSchoolAdmin` roles. |
| `firebase_migration_mpesa_pending_transactions` | Fee managers read; same-school student reads only the row whose `studentId` or `studentUid` matches their authenticated identity. No client writes. | No Phase 2 client policy. Server/payment callbacks only for writes. Confirm how source Firebase UID fields map to Supabase Auth UUIDs. |
| `firebase_migration_paper_configs` | No Firestore collection match (default deny). | Preserve the explicit Phase 2 exception: same-school member read and trusted school `admin` write only. |
| `firebase_migration_school_timetables` | Same-school member read; student-lifecycle managers create/update; no delete. | No Phase 2 client policy. Manager roles are admin, user, school_admin/school-admin, principal, headteacher, deputy-headteacher, plus verified platform admins. |
| `firebase_migration_schools` | Tenant member `get`; only platform admin may list/create/delete. Same-school profile managers (`admin`, `headteacher`, or platform admin) update, but may not alter `adminRoleCounts` or `adminRoleCountsInitialized`. | No Phase 2 client policy. Public email-domain discovery in signup queries schools before sign-in, and `Transfer.jsx` searches schools by name as a list query; current Firestore rules deny anonymous discovery and non-platform-admin listing. Decide on a narrowly reviewed discovery endpoint/flow or remove those calls. Do not grant anon SELECT or broad authenticated listing. |
| `firebase_migration_student_balances` | Communications headteachers, fee managers, or the matching same-school student read; fee managers create/update; no delete. | No Phase 2 client policy. Student identity mapping and whether client writes should be replaced by a trusted fee service require confirmation. |
| `firebase_migration_student_scores` | Communications headteachers, school teachers, or matching same-school student read. School teachers create/update; school admins delete. | No Phase 2 client policy. Teacher class/subject/assigned-class scoping is not encoded by the current predicate for score writes; see unresolved policy decision below. |
| `firebase_migration_students` | Communications headteachers, fee managers, school admins, teachers in a token-assigned class, or matching student self-read. School admins create valid records, update valid records without changing school/admission number, and delete. | No Phase 2 client policy. `studentId` is used as an Auth UID in rules while also being a business identifier in app code; this identity is ambiguous and must be resolved from exports/callers before enabling student-self access. Teacher class access needs a trusted assignment source. |
| `firebase_migration_subject_paper_configs` | No Firestore collection match (default deny). | Preserve the explicit Phase 2 exception: same-school member CRUD. |
| `firebase_migration_teachers` | School admins or the matching teacher read a document. Same-school list predicate is `isSchoolAdmin(...) || isUser(request.auth.uid)`; the latter is true for every signed-in caller, so this currently means any signed-in school member can list same-school teacher rows. School admins create/delete; a teacher can update only phone, updatedAt, subjects, classes without changing school. | No Phase 2 client policy. The broad list predicate appears accidental but is production rule behavior; obtain a decision whether to preserve it exactly or tighten before cutover. |
| `firebase_migration_timetable_settings` | Same-school member read; student-lifecycle managers create/update; no delete. | No Phase 2 client policy. Same role set as school timetables. |
| `firebase_migration_user_roles` | No Firestore collection match (default deny). | Preserve the explicit Phase 2 exception: same-school member read and trusted school `admin` write only. |
| `firebase_migration_users` | Get self, platform admin, or same-school admin. List platform admin or same-school admin. Self-create is limited to role `user`, `student`, or `parent`, own UID, and no school; platform creation cannot assign a managed role. Platform/admin updates must keep role fixed; school updates must also keep school fixed; self updates are limited to `fullName`, `phone`, `lastLogin`, `updatedAt`. Platform delete is permitted only for a non-managed role. | No Phase 2 client policy. The profile's `firestore_id`/document `uid` is the Firebase UID, not necessarily the Supabase UUID. Enforce self access through `auth_user_id -> firebase_uid` mapping and retain restricted profile-update columns. |

The seven explicitly approved Phase 2 groups remain the intentional
exceptions to Firestore's default-deny rules: `attendance`,
`level_permissions`, `paper_configs`, `subject_paper_configs`, `user_roles`,
`sms_jobs`, and `sms_outbox`. The first five are app-referenced; the latter
two currently appear only in the imported dataset and existing server-side
work. The Phase 2 school-member/admin policy split is the accepted baseline;
do not generalize its CRUD grants to other tables.

### Child relations whose RLS must follow their parent

Every listed child relation is an independently exposed PostgREST table and
therefore needs RLS enabled, explicit grants, and a policy. It must enforce
the same source/tenant and parent-role predicate as its parent; parent access
must not be inferred from a client-supplied `parent_firestore_id`. The
assignment-class children must also prove access to the actual assignment
parent row. The listed `_nested_values` relations are migration-preservation
tables; keep them inaccessible to clients unless an approved app query
actually needs them.

| Parent | Child relations |
|---|---|
| `audit_logs` | `audit_logs_nested_values` |
| `attendance` | `attendance_counts`, `attendance_entries`, `attendance_nested_values` |
| `exams` | `exams_nested_values` |
| `fee_audit_log` | `fee_audit_log_nested_values` |
| `fee_structures` | `fee_structure_items`, `fee_structures_nested_values` |
| `fee_transactions` | `fee_transactions_nested_values` |
| `level_permissions` | `level_permissions_nested_values` |
| `mpesa_pending_transactions` | `mpesa_pending_transactions_nested_values` |
| `paper_configs` | `paper_config_items`, `paper_configs_nested_values` |
| `school_timetables` | `school_timetable_slots`, `school_timetables_nested_values` |
| `schools` | `school_class_teachers`, `school_custom_classes`, `school_subject_options`, `schools_nested_values` |
| `student_balances` | `student_balances_nested_values` |
| `student_scores` | `student_score_papers`, `student_scores_nested_values` |
| `students` | `students_nested_values` |
| `subject_paper_configs` | `subject_paper_config_items`, `subject_paper_configs_nested_values` |
| `teachers` | `teacher_assignment_classes`, `teacher_assignments`, `teacher_scopes`, `teachers_nested_values` |
| `timetable_settings` | `timetable_setting_periods`, `timetable_settings_nested_values` |
| `user_roles` | `user_role_assignment_classes`, `user_role_assignments`, `user_role_scopes`, `user_roles_nested_values` |
| `users` | `user_assignment_classes`, `user_assignments`, `user_scopes`, `users_nested_values` |

## Unimported app collections: proposed table and relationship inventory

There are 43 active-flow collection names without a Phase 2 parent relation.
The 10 likely dead references listed above are not included in the Phase 4
schema target. The proposed physical names below use the Phase 2 prefix; each
is a separate relation, not an alias for a similarly named imported table.
Default table shape is a source-scoped original ID, `school_id`, typed domain
fields, and source timestamps. Do not put an entire array/object into an
invented JSON column or make tables accessible until source shape, foreign
keys, and role policy have been reviewed.

Foreign keys to Phase 2 students/teachers/users below are proposed only when
the source ID is demonstrated to be that source's Firestore document ID.
The Phase 2 `schools` relation has no unique `(source_project, school_id)`
key, so a school FK also needs a verified unique school-ID mapping before it
can be added. Since Firebase UIDs and Supabase Auth UUIDs differ, Auth
references must use the Phase 3 source-scoped mapping; no Firebase UID may
be cast to UUID.

| Domain | Proposed distinct root tables | Proposed normalized children and FK intent |
|---|---|---|
| Academic/configuration | `firebase_migration_assessment_configs` | Assessment config has scoped school/level/class/subject/term keys; confirm uniqueness before a compound unique constraint. The `class_summaries` helper is likely dead and excluded. |
| Exams/activity | `firebase_migration_exam_submissions`, `firebase_migration_activities` | `exam_submissions` should FK `exam_id` to `firebase_migration_exams` only if callers store the Firestore exam document ID; FK `student_id` to the source-scoped student row only after confirming whether it is document ID or Auth UID. Activities have a school FK. Any submission answers/attachments arrays require separate children after payload review. |
| Student lifecycle | `firebase_migration_archived_students`, `firebase_migration_student_archives`, `firebase_migration_student_promotion_operations` | Keep `archived_students` distinct from `student_archives`; their equivalence is unverified. `student_archives` stores a student snapshot map; model a typed immutable snapshot relation/table linked to the archive rather than opaque JSON, with columns based on the app's student shape. Promotion operations store before/after snapshots, `changedFields[]`, actor/action/status/timestamps; student history is also an array of typed events. Normalize both arrays to child relations, and add same-source student FKs only after validating IDs. |
| Finance | `firebase_migration_fee_invoices`, `firebase_migration_invoices`, `firebase_migration_invoice_summaries`, `firebase_migration_term_locks` | Active collections stay distinct from imported `fee_transactions`/`student_balances`. Invoices use a deterministic school/student/term/year ID and contain student identity, item list, totals, status, due date, notes, creator and timestamps. `items[]` becomes invoice-item children. `payments` is only initialized empty and has no append writer; `studentIds[]` is UI selection state and is not persisted. The per-invoice `studentId` is the selected student's `id`; preserve it as a source Firestore document ID. `invoice_summaries` is only read and no field contract is established; term locks use a deterministic ID and store school/term/year/lock/actor/time. `feeBalances` and `receipts` are excluded as likely dead. |
| Messaging/communications | `firebase_migration_sms_gateway`, `firebase_migration_sms_history`, `firebase_migration_sms_templates` | Keep `sms_history` and `sms_templates` separate from imported `sms_jobs`/`sms_outbox`. History stores actor/transport/recipient-kind/message/count/status and `outcomes[]`; outcomes need a typed child relation keyed by history and ordinal. Gateway config is server-only if it contains credentials; keep secret columns unavailable to app clients. `sms_queue`, `communications`, and `message_templates` are excluded as likely dead. |
| Notifications | `firebase_migration_notifications` | School/recipient relation: FK to school; add auth-recipient link to `auth.users` only after deciding whether target IDs are Firebase UIDs, profile IDs, or emails. The exact recipient field shape is unresolved; do not assume an audience array. Preserve only read/readAt update for recipients and same-school delete behavior from rules. |
| Discipline | `firebase_migration_discipline_records` | Typed school, student, recorded-by Auth mapping, incident date/category/severity/summary/action fields as constrained by Firestore validation. Student FK requires confirming `studentId` document-ID semantics; `recorded_by_auth_user_id` must map the source UID and match caller on insert. Append/update policy follows the discipline role rule; delete denied. |
| Health | `firebase_migration_allergies`, `firebase_migration_health_records`, `firebase_migration_immunizations`, `firebase_migration_medical_staff`, `firebase_migration_prescriptions`, `firebase_migration_medical_inventory` | Model each as a separate school-scoped root. Patient/student FK and provider/staff FK only after source IDs are confirmed. Medication/allergy lists, vital arrays, and visit notes need typed child relations if present; exact child table names/keys require a read-only source shape profile. The Firestore rules have no `medical_inventory` match, so that app call is currently denied by the global fallback. |
| Inventory | `firebase_migration_inventory_logs`, `firebase_migration_school_inventory` | `school_inventory` is a root item; `inventory_logs` references an item only if the source field is verified. For nested stock movements/adjustments, use one movement child per event with a parent FK and typed quantity/actor/time fields; exact field evidence is required. No explicit Firestore matches exist for these collection names. |
| School exit/transfers | `firebase_migration_school_exits`, `firebase_migration_student_transfers`, `firebase_migration_transfer_packages` | School exit references a student; transfer references the student and source/target school. Transfer package contains one student snapshot and `scores[]`, so model typed snapshot data and score child rows keyed by package and ordinal, with FKs after source ID semantics are confirmed. Validate whether a cross-school transfer is intentionally allowed: the current Firestore rule confines a transfer row to the caller's `schoolId`, but destination tenant semantics are not described. |
| Boarding | `firebase_migration_dormitories`, `firebase_migration_dorm_assignments`, `firebase_migration_dorm_patrons`, `firebase_migration_dorm_maintenance`, `firebase_migration_dorm_rules`, `firebase_migration_dorm_inventory` | Proposed FKs: assignments → dormitory and student; patrons → student/guardian only if source keys establish those identities; maintenance/rules/inventory → dormitory where present. All need same-source school consistency. Any assigned-student arrays become a junction table. Keep each root separate; roles differ for maintenance (member write) versus other dorm records (school-admin write). |
| Transport | `firebase_migration_assignments`, `firebase_migration_buses`, `firebase_migration_routes`, `firebase_migration_drivers`, `firebase_migration_fuel_records`, `firebase_migration_maintenance`, `firebase_migration_transport_payments` | Keep generic transport `assignments` separate from imported teacher/user assignment children. Proposed FKs: assignments → student, route, bus; routes → bus/driver only if fields demonstrate; fuel/maintenance → bus; payments → student and transport assignment. Transport payments preserve student self-read, school-admin write, no delete. Verify all IDs/field semantics before adding constraints. |
| Timetable/system | `firebase_migration_duty_rosters`, `firebase_migration_timetable_events`, `firebase_migration__usage_stats` | Duty rosters/events reference school and, if observed, teacher. Timetable event recurrence/participant lists become child rows. `_usage_stats` must not inherit unconstrained client writes. `report_latest`, `report_snapshots`, callback error/orphan records, and `receipts` are excluded as likely dead or server-only. |
| Miscellaneous | `firebase_migration_visits` | The generic loader includes `visits`, but there is no explicit domain/rule evidence to determine if this means medical visits or school visits. Confirm intended meaning before schema/FK design; do not combine it with health visit records by name alone. |

The rows above propose relationship direction, not approved constraints or
DDL. Read-only aggregate profiling already found zero source documents in
these additional collections for both tenants, so there are no existing
records to export/profile and no source shape to infer. Future-write columns
and known nested cardinalities below are derived from reachable app
constructors; unresolved fields and identity semantics remain explicit
blockers. Do not guess a child schema or preserve a known nested relation only
as an ad-hoc JSON blob. Parent rows and every
child must use `(source_project, firestore_id)`-style keys and composite
same-source foreign keys, with school consistency enforced wherever both
records are tenant-scoped.

### Schema and import execution plan (preparation only)

For review, each new root table should use the existing Phase 2 physical
prefix, a source check (`ku`/`kiwanja`), original source document ID, typed
school/domain columns, and `PRIMARY KEY (source_project, firestore_id)`.
Child/junction rows should have their own source-scoped key plus
`parent_firestore_id`, ordinal or typed relationship key as applicable, and
composite same-source parent/tenant foreign keys. Add a verified unique
school-key relation before declaring school foreign keys. Store timestamps as
typed `timestamptz` after validating Firestore timestamp conversion. Any
proven list/map must be represented by one typed relational child row per
element/key; do not use a generic JSON path/value table or one opaque JSON
blob as the app's relational model. Preservation-only source snapshots, if
needed for rollback, must be separately reviewed and not exposed to clients.

Original preparation order and current completion:

1. Reuse the completed read-only source inventories and aggregate counts:
   all 53 additional collection names have zero documents in each Firebase
   source. Do not read/export document bodies solely for these empty
   collections. Record future-write fields from reachable app constructors;
   any shape not established there remains a blocker.
2. Resolve names with no explicit production Firestore rule (currently
   default-denied) and the ambiguity decisions above. The app callsite alone
   does not authorize data access.
3. Generate the additive ownership-prefixed schema. **Complete:** 38 empty
   relations exist; 27 have separately approved policies and authenticated
   grants, with the remaining 11 default-denied. Gateway secrets and
   unresolved collections remain server-only/denied.
4. Validate schema names, constraints, FKs, and fail-closed RLS offline;
   preflight database names/read-only catalogs only when separately
   authorized. No Phase 2 relation is altered, renamed, truncated, or
   repopulated.
5. Prepare a parameterized importer that reads only ignored local exports,
   maps each export to a fixed source, validates exact IDs/counts/child
   cardinality, rejects conflicting pre-existing source rows, and uses one
   serializable transaction per source with rollback on error. Keep source
   imports as separate approval gates; do not merge sources by email or
   unscoped document ID.
6. Prepare offline parity tests for every parent and child relation, role
   policy tests for tenant/source/role/self boundaries, and migration dry
   runs. **Complete for the approved Phase 4 RLS scope:** static contract
   tests, dry run, post-apply checks, and a live same-school/unrelated-school
   helper check passed. Phase 2 grants, data imports, and app-flow cutovers
   remain separate approvals.

No Firebase documents were read/exported for this work and no application
code or Firebase configuration was switched.

## Firestore role intents for unimported app collections

The relations started with RLS enabled and no client grants. Firestore's
global fallback denies all unlisted collections. The following records the
per-role intents found for app-referenced names and whether the reviewed
subset is now applied in Postgres.

| Collections | Existing explicit Firestore intent |
|---|---|
| `student_promotion_operations` | Lifecycle managers read/create. Create requires school, student, academic year, `status=applied`, and a student in that same school. Only `applied -> rolled_back` update with unchanged school/student and rollback audit fields; no delete. |
| `student_archives` | Lifecycle managers read/create; create requires student ID, academic year, a map `studentSnapshot`, and a same-school source student. Only constrained status/reversal updates; no delete. |
| `assessment_configs` | Any signed-in same-school user reads; school teacher (including admin roles per helper) writes including delete. |
| `archived_students`, `fee_invoices`, `invoice_summaries`, `term_locks`, `sms_gateway`, `medical_inventory`, `visits`, `inventory_logs`, `school_inventory`, `transfer_packages` | No match in `firestore.rules`; default-denied in the confirmed production rules. These are active app flows; do not make them available by inventing a broad tenant policy. Define a reviewed policy before cutover. |
| `exam_submissions` | Same-school teachers or the matching student read; school members create/update; school admins delete. Confirm student UID mapping and constrain update fields if required by actual workflow; Firestore does not constrain those fields here. |
| `invoices` | Fee managers or matching student read; fee managers create/update valid invoice fields; delete only when status is not `paid`. Preserve `total >= 0`, term/year, and allowed status validation. |
| `duty_rosters` | Same-school members read; lifecycle managers create/update; no delete. |
| `timetable_events` | Same-school members read; lifecycle managers create/update/delete. |
| `dormitories`, `dorm_assignments`, `dorm_patrons`, `dorm_rules`, `dorm_inventory` | Same-school members read; school admins create/update/delete. |
| `dorm_maintenance` | Same-school members read and any same-school member can create/update/delete. This is intentionally broader than the other boarding tables; confirm whether to preserve. |
| `buses`, `routes`, `drivers`, `fuel_records` | Same-school members read; school admins create/update/delete. |
| `transport_payments` | Same-school member reads if school admin or matching student; school admins create/update; no delete. |
| `health_records`, `allergies` | Same-school admins or teachers read; school admins write/delete. |
| `prescriptions` | Same-school admins read/write/delete. |
| `immunizations`, `medical_staff` | Same-school members read; school admins write/delete. |
| `sms_history` | Headteachers (and platform admins) read/append; no update/delete. |
| `sms_templates` | Headteachers read/create/update/delete; updates cannot change tenant. |
| `activities` | Same-school members read/append; no update/delete. |
| `notifications` | Same-school members read/create/update only `read`/`readAt`/delete. Recipient identity is not enforced by the current rules; flag for decision before broad same-school access is implemented. |
| `school_exits`, `student_transfers` | Same-school admins read/create/update; no delete. `student_transfers` currently has no destination-school boundary check; confirm transfer semantics before allowing a cross-tenant record. In addition, `Transfer.jsx` queries with `schools array-contains schoolId`, while this rule's list check requires `resource.data.schoolId == userSchoolId()`; the query does not constrain `schoolId`, so it is incompatible with the current rules and must be fixed or explicitly reauthorized before cutover. |
| `discipline_records` | Headteacher/deputy-headteacher or platform admin reads/creates/updates; create validates required incident fields, severity, and `recordedBy == auth.uid()`; updates keep school fixed; no delete. |
| `_usage_stats` | Platform admins read. Any signed-in user may create/update any valid-ID row under the current rule, with no tenant or field restriction; do not reproduce that broad write policy without explicit confirmation. No delete. |

The above uses the exact `isSchoolAdmin`, `isFeeManager`, and
`canManageStudentLifecycle` role lists from `firestore.rules`. Platform
administrator access must remain a separately verified server-controlled
membership, not a client-writable role or custom value. Read/list policies
must still constrain every query to the member's source and school.

## Provisioning-flow plan and existing Netlify candidates

**Use a new dedicated source-scoped function**, tentatively
`netlify/functions/provision-supabase-account.js`, rather than changing an
existing Firebase function in place. The Netlify deployment pins
`AUTH_MIGRATION_SOURCE=ku` or `kiwanja`; caller input never selects the source.
The function must validate Supabase bearer tokens for authenticated admin
actions, resolve the caller's trusted Phase 3 Auth mapping and tenant
membership, validate role/action/target school server-side, and keep the
service-role key only in Netlify server environment. Public school signup
must be a separate tightly validated action/endpoint, create no privileged
client-selected role or pre-confirmed email, require verification, and
perform school/profile/membership writes atomically or with idempotent
compensation. The exact registration approval, rate-limit, and trial policy
still requires a user decision. Never accept a service-role key, source
project, claimed role, or unchecked school ID from the app.

| Existing function/flow | Finding | Use in Phase 4 plan |
|---|---|---|
| `migrate-firebase-password.js` | Already source-scoped for legacy password conversion; uses service-role access for one narrowly defined task. It does not create profiles/schools or authorize provisioning. | Keep separate and unchanged. Reuse its fixed-source configuration pattern only. |
| `provision-student-account.js` | Unauthenticated POST; looks up Firebase data and creates/resets Firebase passwords to admission numbers, sets email verified, and writes Firebase student fields. No caller/role authorization. | **Not safe to host/reuse.** Preserve as Firebase Admin only until its callers are migrated; do not graft Supabase service role into it. |
| `manage-school-admins.js` | Authenticated through Firebase `requireAuth`, then mutates Firestore roles/deletion state and Firebase Auth. Admin checks are useful business-rule evidence, but caller identity and persisted state are Firebase-specific. | **Not safe as-is.** Port reviewed role-limit and approval rules only into a new Supabase-token-verified handler; don't mix Firebase and Supabase Admin credentials in one flow. |
| `send-teacher-welcome.js`, `backfill-email-domains.js`, `provision-student-account.js` | Existing supporting/admin functions are Firebase/Firestore-bound or perform unrelated email/domain tasks. | Not a Supabase provisioning host. Review callers separately during their own migration. |
| `Login.jsx`, `PlatformAdmin/Schools.jsx` signup | Client creates Firebase Auth users plus school/profile records; platform school creation also creates accounts from a privileged screen. | Replace with the dedicated source-scoped flow after deciding whether platform account creation sends an invite/password-reset link or accepts a temporary password, how tenant membership is granted, and how duplicate emails across source projects are handled. Do not let client calls write `user_roles` or tenant membership directly. |

The app's existing Netlify helper targets the current site's function origin
by default, which allows KU and Kiwanja deployments to call their own pinned
source. Existing `REACT_APP_NETLIFY_FUNCTIONS_URL` may override it; before
deployment, verify each build points to the correct site and does not point
KU at the Kiwanja function or vice versa. The provisioning function and
password-migration function must be separately authenticated, rate-limited,
and tested with source-mismatch requests.

## User decisions required before implementation/import

### Decisions received

- Public school registration is disabled. New school provisioning remains a
  trusted administrative action.
- School-admin invitations use a verified email invitation/password-setup
  link; no administrator-set shared temporary passwords.
- The target is one Supabase Auth identity with separately authorized
  source-project memberships for a person present in both Firebase sources.
  The Phase 3 Auth mapping now enforces per-source uniqueness. Linking still
  requires proof of the second source's legacy password and resetting the
  shared password.
- Platform-admin authority is source-scoped, not a cross-source global
  override. The source-scoped membership relation is applied and empty; no
  global admin assignments were backfilled.
- For a duplicate email across sources, require proof of the second source's
  legacy password and a verified Supabase email, then set a new shared
  password. Never link based on email alone. This also means a source's
  legacy password must not silently overwrite an already shared password.

The uniqueness and password-migration scope follow-up is applied. A
source-link flow is still unimplemented; it must require an authenticated,
email-verified Supabase user, verify the pinned source's legacy password
server-side, record only the matching source membership, and set the
explicitly supplied new shared password. The function must not accept source
selection from the client.

1. Resolve ambiguous identities and policy behavior before enabling an
   affected collection: teacher-list rule's
   tautological `isUser(request.auth.uid)`; whether `students.studentId` is
   Firebase UID or business ID; student/teacher class assignment source and
   the missing score class/subject write checks; notification recipient
   boundary; cross-school transfer destination; `_usage_stats` write
   authorization; public school email-domain discovery; the transfer query's
   mismatch with its Firestore list rule; `fee_structures`/`student_balances`
   update tenant checks; platform-admin global versus per-source scope; and
   whether `dorm_maintenance` same-school member writes remain broad. As
   approved, any behavior with unresolved semantics remains denied until its
   own rule is reviewed; no broad client policy is inferred.
2. Keep similarly named active collections separate (including
   `fee_invoices`, `invoices`, `sms_jobs`, `sms_outbox`, `archived_students`,
   and `student_archives`). No live rows exist in the additional collections
   to establish that they are aliases. Likely dead references remain out of
   scope.
3. Confirm role-limit behavior and account deletion/rollback semantics for
   trusted school-admin provisioning. Public signup and invitation mechanism
   are resolved above; implement neither until the profile/membership write
   and Firebase coexistence behavior are specified.
4. Confirm the trusted source membership/role feed for Supabase app sessions,
   plus the controlled procedure for populating source-scoped platform-admin
   membership.
   The existing Phase 3 user map/memberships are server-only or read-self only;
   this    plan does not expose them or add client mutation grants. The old global
   `firebase_migration_platform_admins` table is not an authorization source;
   the new source-scoped relation remains empty until a trusted, reviewed
   population procedure is defined.

## Auth, profile, and offline blockers

- Phase 3 maps Firebase UIDs to Supabase UUIDs in the server-only
  `firebase_migration_auth_user_map`. Firestore profile document IDs remain
  Firebase UIDs in `firebase_migration_users`, `firebase_migration_teachers`,
  and `firebase_migration_students`. Those profile relations have no client
  access policy, so the app cannot safely hydrate the profile by querying
  them after Supabase sign-in. The membership self-read can provide the
  trusted source, school, and role, but not the full existing profile or
  school branding. No source/role is inferred from email or a client-supplied
  school ID.
- The first-login function is hosted on each source-specific Netlify site.
  `src/services/netlifyApi.js` uses the current site origin by default (or the
  existing `REACT_APP_NETLIFY_FUNCTIONS_URL` override), which is the safe
  basis for calling that site's `/migrate-firebase-password` function. The
  app login fallback was not wired because proceeding would create an Auth
  session that the current Firestore-dependent app cannot use.
- `SyncContext` currently replays Firebase-specific operations (`setDoc`,
  `updateDoc`, `deleteDoc`) and deterministic Firestore score IDs. Several
  queue producers write collections that were never imported. Repointing the
  generic queue at Postgres without a reviewed per-collection serializer,
  source key, permission contract, and child-row strategy would either lose
  writes or bypass the intended RLS semantics. The IndexedDB stores and queue
  were left untouched.
- The current app also has real-time Firestore listeners. Those listeners need
  a defined Supabase Realtime publication/table policy and a migration plan
  for offline cache invalidation; they were not replaced with polling or
  partial subscriptions.
- Firebase Auth/Firestore dependencies and `src/firebase.js` remain in place.
  There are still Firebase client imports and direct Firestore callsites in
  dozens of app files, plus server-side Firebase Admin functions. Removing
  client dependencies before every callsite is converted would break builds
  and runtime behavior.

## Validation and changes

This update changes only this review document; no application changes were
made, so no Phase 4 tests, lint, or build were run. `git diff --check` passed.
The active-flow trace classified 43 of the 53 non-Phase-2 static references
as reachable and 10 as likely dead; no code was deleted or altered. Read-only
Firestore aggregation counts confirmed 0 documents for all 53 additional
collection names in both sources; the existing `students` count validated the
source credentials and count method. No document bodies were read or
exported. Phase 2 schema/import artifacts, Phase 3 Auth bridge, Firestore
rules, app router, and candidate Netlify functions were inspected. No DDL,
imports, service-role operations, or Firebase Admin writes were executed.

After policy and collection decisions are approved, resume by translating the
Firestore rules for every app-used imported table, accounting for the
source-scoped Auth mapping and typed child relations, migrating one
collection/service at a time with offline/realtime tests, and only then
switching Auth and removing Firebase client dependencies.
