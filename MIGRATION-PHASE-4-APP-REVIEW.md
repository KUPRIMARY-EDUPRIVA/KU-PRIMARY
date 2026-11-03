# Phase 4 — app-layer migration review

**Status: pre-cutover plan prepared; app cutover remains blocked.** The user
approved preparing plans for all app-referenced collections and a dedicated
source-scoped Netlify account-provisioning function. No application code,
Firebase configuration, exports for the newly identified collections, or
database objects were changed in this planning update. Supabase Auth and the
Phase 2 data remain live, but current client grants/RLS and the Phase 2 import
inventory are not sufficient for a safe app cutover. This review records the
proposed mapping, policy intents, missing-collection schemas, provisioning
approach, and decisions needed before implementation.

## Approved scope and remaining gates

The approved planning scope is **all app-referenced collections** and a
**dedicated source-scoped Netlify provisioning function**. This does not
authorize reading/exporting the newly identified live collections, applying
schema or RLS changes, importing rows, or switching app code.

The approved read-only count profile is complete. It found no live documents
in any of the 53 additional collection names in either Firebase project, so
there are no live nested shapes to export or import for those collections.
The database count check was sanity-checked against the existing `students`
counts (KU 1,971; Kiwanja 730), which match the Phase 2 source snapshots.
Schema details for future records must therefore come from app payload
constructors and remain conservative where those constructors do not
establish field or ID semantics.

The remaining gates are: (1) complete the static app-payload contract for
future records and resolve the documented identity/rule ambiguities; and (2)
separate approval of the exact generated schema/RLS plan before any DDL,
client grants, or app cutover. No permissions have been widened and no
application flow has been partially switched.

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
| `sms_jobs`, `sms_outbox` | `firebase_migration_sms_jobs`, `firebase_migration_sms_outbox`; recipients in `sms_job_students` | Imported and policy-enabled per the earlier explicit Phase 2 decision. No direct app `collection()`/`doc()` callsite was found in the static inventory below; keep these Phase 2 grants until separately reviewed, but do not count them as migrated app flows. |
| `audit_logs` | `firebase_migration_audit_logs` | Imported, but no client grant/policy. |
| `exams` | `firebase_migration_exams` | Imported, but no client grant/policy. |
| `fee_audit_log`, `fee_structures`, `fee_transactions` | `firebase_migration_fee_audit_log`, `firebase_migration_fee_structures`, `firebase_migration_fee_transactions`; fee items in `fee_structure_items` | Imported, but no client grant/policy. |
| `mpesa_pending_transactions` | `firebase_migration_mpesa_pending_transactions` | Imported, but no client grant/policy. |
| `school_timetables`, `timetable_settings` | `firebase_migration_school_timetables`, `firebase_migration_timetable_settings`; slots/periods in `school_timetable_slots` / `timetable_setting_periods` | Imported, but no client grant/policy. |
| `schools` | `firebase_migration_schools`; configuration children include `school_custom_classes`, `school_subject_options`, `school_class_teachers` | Imported, but no client grant/policy. Branding and tenant discovery cannot be moved to these relations yet. |
| `student_balances`, `student_scores` | `firebase_migration_student_balances`, `firebase_migration_student_scores`; score papers in `student_score_papers` | Imported, but no client grant/policy. |
| `students` | `firebase_migration_students`; history in `student_history_entries` | Imported, but no client grant/policy. |
| `teachers`, `users` | `firebase_migration_teachers`, `firebase_migration_users`; assignment/scope children are in the Phase 2 schema | Imported, but no client grant/policy. Profile reads/writes are therefore blocked. |
| `assessment_configs`, `class_summaries` | No Phase 2 relation | Not exported/imported; no safe mapping. |
| `fee_invoices`, `feeBalances`, `invoices`, `invoice_summaries`, `term_locks` | No exact Phase 2 relation | Not exported/imported. In particular, `feeBalances` is not assumed to be `student_balances`, nor are `invoices` and `fee_invoices` assumed aliases. |
| `archived_students`, `student_archives`, `student_promotion_operations` | No Phase 2 relation | Not exported/imported. |
| `sms_templates`, `sms_queue`, `sms_gateway`, `sms_history` | No Phase 2 relation | Not exported/imported. `sms_queue` is not assumed to be either `sms_jobs` or `sms_outbox`. |
| `communications`, `message_templates`, `notifications`, `activities`, `exam_submissions` | No Phase 2 relation | Not exported/imported. |
| `discipline_records` | No Phase 2 relation | Not exported/imported. |
| `allergies`, `health_records`, `immunizations`, `medical_staff`, `prescriptions` | No Phase 2 relation | Not exported/imported. |
| `inventory_logs`, `school_inventory` | No Phase 2 relation | Not exported/imported. |
| `school_exits` | No Phase 2 relation | Not exported/imported; includes realtime subscriptions. |
| `student_transfers`, `transfer_packages` | No Phase 2 relation | Not exported/imported. |
| `dorm_assignments`, `dorm_inventory`, `dorm_maintenance`, `dorm_patrons`, `dorm_rules`, `dormitories` | No Phase 2 relation | Not exported/imported. |
| `assignments`, `buses`, `drivers`, `fuel_records`, `maintenance`, `routes`, `transport_payments` | No Phase 2 relation | Not exported/imported. `assignments` is not assumed to mean teacher/user assignment child rows. |
| `report_latest`, `report_snapshots`, `duty_rosters`, `timetable_events`, `mpesa_callback_errors`, `mpesa_orphan_callbacks`, `receipts`, `_usage_stats` | No Phase 2 relation | Not exported/imported. `_usage_stats` and some payment collections are also used by server-side code, which is outside the app rewrite scope. |

This inventory comes from statically named Firestore `collection()`/`doc()`
references under `src/` and literal collection lists passed to generic
collection loaders. The set contains 72 distinct app-referenced collection
names: 19 map to Phase 2 parent relations and 53 do not. Collection names
passed indirectly through helper parameters are represented by their caller's
names. Each mapped collection's app flow still needs query/write conversion
and role-specific RLS; table-name correspondence alone is not authorization.

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

There are 53 distinct app-referenced collection names without a Phase 2
parent relation. The proposed physical names below use the Phase 2 prefix;
each is a separate relation, not an alias for a similarly named imported
table. Default table shape is a source-scoped original ID, `school_id`,
typed domain fields, and source timestamps. Do not put an entire array/object
into an invented JSON column or make tables accessible until source shape,
foreign keys, and role policy have been reviewed.

Foreign keys to Phase 2 students/teachers/users below are proposed only when
the source ID is demonstrated to be that source's Firestore document ID.
The Phase 2 `schools` relation has no unique `(source_project, school_id)`
key, so a school FK also needs a verified unique school-ID mapping before it
can be added. Since Firebase UIDs and Supabase Auth UUIDs differ, Auth
references must use the Phase 3 source-scoped mapping; no Firebase UID may
be cast to UUID.

| Domain | Proposed distinct root tables | Proposed normalized children and FK intent |
|---|---|---|
| Academic/configuration | `firebase_migration_assessment_configs`, `firebase_migration_class_summaries` | Assessment config has scoped school/level/class/subject/term keys; confirm uniqueness before a compound unique constraint. A summary is keyed by source ID and school; do not infer student ownership or child grain until payload/export profile is available. App `class_summaries` uses deterministic IDs built from school/level/class/subject/term. |
| Exams/activity | `firebase_migration_exam_submissions`, `firebase_migration_activities` | `exam_submissions` should FK `exam_id` to `firebase_migration_exams` only if callers store the Firestore exam document ID; FK `student_id` to the source-scoped student row only after confirming whether it is document ID or Auth UID. Activities have a school FK. Any submission answers/attachments arrays require separate children after payload review. |
| Student lifecycle | `firebase_migration_archived_students`, `firebase_migration_student_archives`, `firebase_migration_student_promotion_operations` | Keep `archived_students` distinct from `student_archives`; their equivalence is unverified. `student_archives` has an observed `studentSnapshot` map: model a typed immutable snapshot relation/table linked to the archive and student rather than opaque JSON, but derive its typed columns from real snapshots. Both archive kinds and promotion operations need same-source student FKs after validating `studentId`; promotion operations carry school, student, academic year, status and rollback audit fields. |
| Finance | `firebase_migration_fee_invoices`, `firebase_migration_feebalances`, `firebase_migration_invoices`, `firebase_migration_invoice_summaries`, `firebase_migration_term_locks`, `firebase_migration_receipts` | Keep `fee_invoices`, `invoices`, and `feeBalances` distinct from each other and from imported `fee_transactions`/`student_balances`. `invoices` has observed `studentId`, `term`, `academicYear`, `total`, `status`; `items[]` written by `Fees.jsx` must become `invoice_items(invoice source, invoice id, ordinal, description, amount, typed tax/discount fields after review)`. The UI also writes `studentIds[]`; normalize to `invoice_students` with source/invoice/student FKs after checking whether each ID is a document ID. `invoice_summaries` and `feeBalances` need source snapshots before their aggregate grain can be fixed. `term_locks` references school/term; do not let an aggregate or lock bypass financial RLS. Receipts reference a transaction/invoice only if the stored identifier semantics are confirmed. |
| Messaging/communications | `firebase_migration_communications`, `firebase_migration_message_templates`, `firebase_migration_sms_gateway`, `firebase_migration_sms_history`, `firebase_migration_sms_queue`, `firebase_migration_sms_templates` | Keep `sms_queue`, `sms_history`, `sms_templates`, and imported `sms_jobs`/`sms_outbox` separate. Proposed children: `sms_queue_recipients` (queue → student), `sms_history_recipients` (history → student/contact), `communication_recipients` (communication → student/contact), each with source, parent ID, ordinal, and typed destination/status fields. Template records remain independent; gateway config is one-per-school only if a unique constraint is supported by source data. Credentials/secrets in gateway documents must never be selectable by app clients; confirm whether these records should instead be server-only. |
| Notifications | `firebase_migration_notifications` | School/recipient relation: FK to school; add auth-recipient link to `auth.users` only after deciding whether target IDs are Firebase UIDs, profile IDs, or emails. A notification child/audience table is needed if the source stores recipient arrays; validate actual field shape. Preserve only read/readAt update for recipients and same-school delete behavior from rules. |
| Discipline | `firebase_migration_discipline_records` | Typed school, student, recorded-by Auth mapping, incident date/category/severity/summary/action fields as constrained by Firestore validation. Student FK requires confirming `studentId` document-ID semantics; `recorded_by_auth_user_id` must map the source UID and match caller on insert. Append/update policy follows the discipline role rule; delete denied. |
| Health | `firebase_migration_allergies`, `firebase_migration_health_records`, `firebase_migration_immunizations`, `firebase_migration_medical_staff`, `firebase_migration_prescriptions`, `firebase_migration_medical_inventory` | Model each as a separate school-scoped root. Patient/student FK and provider/staff FK only after source IDs are confirmed. Medication/allergy lists, vital arrays, and visit notes need typed child relations if present; exact child table names/keys require a read-only source shape profile. The Firestore rules have no `medical_inventory` match, so that app call is currently denied by the global fallback. |
| Inventory | `firebase_migration_inventory_logs`, `firebase_migration_school_inventory` | `school_inventory` is a root item; `inventory_logs` references an item only if the source field is verified. For nested stock movements/adjustments, use one movement child per event with a parent FK and typed quantity/actor/time fields; exact field evidence is required. No explicit Firestore matches exist for these collection names. |
| School exit/transfers | `firebase_migration_school_exits`, `firebase_migration_student_transfers`, `firebase_migration_transfer_packages` | School exit references a student; transfer references the student and source/target school; transfer package should have `transfer_package_students` junction rows if it contains multiple student IDs. Validate whether a cross-school transfer is intentionally allowed: the current Firestore rule confines a transfer row to the caller's `schoolId`, but destination tenant semantics are not described. |
| Boarding | `firebase_migration_dormitories`, `firebase_migration_dorm_assignments`, `firebase_migration_dorm_patrons`, `firebase_migration_dorm_maintenance`, `firebase_migration_dorm_rules`, `firebase_migration_dorm_inventory` | Proposed FKs: assignments → dormitory and student; patrons → student/guardian only if source keys establish those identities; maintenance/rules/inventory → dormitory where present. All need same-source school consistency. Any assigned-student arrays become a junction table. Keep each root separate; roles differ for maintenance (member write) versus other dorm records (school-admin write). |
| Transport | `firebase_migration_assignments`, `firebase_migration_buses`, `firebase_migration_routes`, `firebase_migration_drivers`, `firebase_migration_fuel_records`, `firebase_migration_maintenance`, `firebase_migration_transport_payments` | Keep generic transport `assignments` separate from imported teacher/user assignment children. Proposed FKs: assignments → student, route, bus; routes → bus/driver only if fields demonstrate; fuel/maintenance → bus; payments → student and transport assignment. Transport payments preserve student self-read, school-admin write, no delete. Verify all IDs/field semantics before adding constraints. |
| Timetable/report/system | `firebase_migration_duty_rosters`, `firebase_migration_timetable_events`, `firebase_migration_report_latest`, `firebase_migration_report_snapshots`, `firebase_migration_mpesa_callback_errors`, `firebase_migration_mpesa_orphan_callbacks`, `firebase_migration__usage_stats` | Duty rosters/events reference school and, if observed, teacher. Timetable event recurrence/participant lists become child rows. Report snapshots/latest are separate school/admin tables; confirm whether latest rows FK snapshots. Payment callback error/orphan records are server-only (not exposed to app clients) pending server-side callsite review. `_usage_stats` is platform-admin read-only to clients; writes must not be unconstrained public client writes. |
| Miscellaneous | `firebase_migration_visits` | The generic loader includes `visits`, but there is no explicit domain/rule evidence to determine if this means medical visits or school visits. Confirm intended meaning before schema/FK design; do not combine it with health visit records by name alone. |

The rows above propose relationship direction, not approved constraints or
DDL. Before import, profile each collection's exported records and all
app-side payload constructors; derive required/nullable columns, cardinality,
source IDs, nested child tables, uniqueness, and referential integrity from
that evidence. For an array/object not evidenced here, the concrete blocker
is the missing source shape and identity semantics; do not guess a child
schema or preserve it only as an ad-hoc JSON blob. Parent rows and every
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

Proposed preparation order:

1. Produce read-only source inventories and per-collection shape profiles for
   both Firebase projects, recording row counts, field/type presence,
   candidate IDs, nested cardinality, and source-specific differences. Do not
   copy personal data or credentials into the repository.
2. Resolve names with no explicit production Firestore rule (currently
   default-denied) and the ambiguity decisions above. The app callsite alone
   does not authorize data access.
3. Generate an additive, ownership-prefixed schema plan for the 53 distinct
   missing app collections and reviewed normalized children. All new tables
   start with RLS enabled, no `anon`/`authenticated` grants or policies; keep
   callback error/orphan, gateway-secret, and usage/system data server-only
   unless separately approved. Add explicit RLS and grants only after the
   per-role map is approved.
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
   runs. Live schema apply, any row import, and subsequent RLS grants require
   separate explicit approval.

No phase-4 DDL, exports, imports, service-role calls, or database preflights
were performed for this planning update.

## Firestore role intents for unimported app collections

All 53 proposed relations start with RLS enabled and no client grants.
Firestore's global fallback denies all unlisted collections. The following
rules are the complete per-role intents found for the app-referenced names;
they are not database policies yet.

| Collections | Existing explicit Firestore intent |
|---|---|
| `student_promotion_operations` | Lifecycle managers read/create. Create requires school, student, academic year, `status=applied`, and a student in that same school. Only `applied -> rolled_back` update with unchanged school/student and rollback audit fields; no delete. |
| `student_archives` | Lifecycle managers read/create; create requires student ID, academic year, a map `studentSnapshot`, and a same-school source student. Only constrained status/reversal updates; no delete. |
| `assessment_configs` | Any signed-in same-school user reads; school teacher (including admin roles per helper) writes including delete. |
| `class_summaries`, `archived_students`, `feeBalances`, `fee_invoices`, `invoice_summaries`, `term_locks`, `receipts`, `sms_gateway`, `sms_queue`, `message_templates`, `medical_inventory`, `visits`, `inventory_logs`, `school_inventory`, `transfer_packages`, `mpesa_callback_errors`, `mpesa_orphan_callbacks` | No match in `firestore.rules`; default-denied in the confirmed production rules. Current app callsites relying on them cannot be made available by inventing a broad tenant policy. Obtain explicit permission/behavior decisions or keep the corresponding flow blocked. Some are server-function data, and this plan does not authorize app access to them. |
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
| `communications` | Same-school members read; school admins append; no update/delete. |
| `sms_history` | Headteachers (and platform admins) read/append; no update/delete. |
| `sms_templates` | Headteachers read/create/update/delete; updates cannot change tenant. |
| `report_snapshots`, `report_latest` | Same-school admins read; admins create/update; snapshots may be deleted by admins, latest may not be deleted. |
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
2. The plan keeps similarly named collections separate (including
   `fee_invoices`, `feeBalances`, `invoices`, `sms_queue`, `sms_jobs`,
   `sms_outbox`, `archived_students`, and `student_archives`). No live rows
   exist in the additional collections to establish that they are aliases.
3. Decide whether public school registration is permitted on each source
   deployment, the allowed admin invite mechanism, role-limit behavior,
   account deletion/rollback semantics, and how a single Supabase email
   identity behaves if the same email later appears in both source projects.
4. Confirm the trusted source membership/role feed for Supabase app sessions,
   plus the controlled procedure for populating platform-admin membership.
   The existing Phase 3 user map/memberships are server-only or read-self only;
   this plan does not expose them or add client mutation grants.
   The applied `firebase_migration_platform_admins` table is keyed only by
   Auth UUID (not `source_project`); decide whether that global override is
   acceptable or whether a source-scoped admin relation is required before
   translating platform-admin rules.

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
A local static inventory confirmed 72 distinct app-referenced collection
names (19 Phase 2 parents and 53 without Phase 2 parent relations). Read-only
Firestore aggregation counts confirmed 0 documents for all 53 additional
collection names in both sources; the existing `students` count validated the
source credentials and count method. No document bodies were read or
exported. Phase 2's schema/import artifacts, Phase 3 Auth bridge, Firestore
rules, and candidate Netlify functions were inspected. No DDL, imports,
service-role operations, or Firebase Admin writes were executed.

After policy and collection decisions are approved, resume by translating the
Firestore rules for every app-used imported table, accounting for the
source-scoped Auth mapping and typed child relations, migrating one
collection/service at a time with offline/realtime tests, and only then
switching Auth and removing Firebase client dependencies.
