# Phase 4 — active-flow schema and RLS proposal

**Status: the approved 38-relation DDL and 27-relation RLS/grant subset are
applied.** The other 11 Phase 4 relations remain default-denied. The 53
additional Firestore collection names had zero
documents in both projects. This proposal is for future app writes and
reachable reads only; it does not call for exports or backfills. The
route-level payload evidence and the full Firestore role-intent inventory are
in `MIGRATION-PHASE-4-APP-REVIEW.md`.

## Physical design

- Keep every Firebase collection distinct as its own
  `public.firebase_migration_<collection>` relation. Do not merge similarly
  named collections.
- Each writable root has `source_project text CHECK (source_project IN
  ('ku','kiwanja'))`, the original `firestore_id text`, a typed `school_id
  text`, and `PRIMARY KEY (source_project, firestore_id)`. Preserve
  deterministic IDs exactly; do not generate UUID replacements for source
  records.
- Store timestamps written as server timestamps in `timestamptz`; store
  date-only/form text and numeric-looking strings as `text` unless the
  existing writer explicitly converts them to a number. Use booleans and
  numeric SQL types only where the app contract establishes them.
- Normalize each observed array/map into typed child rows. A child key is
  `(source_project, parent_firestore_id, ordinal)` and its composite FK
  references the root. Policies authorize children by checking the parent
  row, never by trusting a client-supplied tenant value.
- Do not add a school FK until a unique source-scoped school-ID relation is
  verified. Add student, teacher, or exam FKs only when callsites prove the
  values are source document IDs and the delete/archive behavior will not
  break existing flows. Auth FKs must use the Phase 3 source mapping.
- Every new relation has RLS enabled. The approved RLS subset is described
  below; unapproved relations remain inaccessible to clients.

## Proposed active-flow relations

| Domain / roots | Typed root columns evidenced by app writers/readers | Normalized child relations and remaining schema blockers |
|---|---|---|
| `assessment_configs` | `level`, `class`, `subject`, `assessment_type`, `term`, `deadline` (`Date`/Firestore timestamp), `created_by`, `is_active`, timestamps; retain the deterministic scoped Firestore ID. | No child array found. Confirm deadline conversion and uniqueness before adding a composite unique constraint. |
| `exam_submissions`, `activities` | School-scoped roots; current shipped clients only query submissions by status and activities by tenant/time. No reachable client writer was found. | No submission answer/attachment shape or activity writer contract is established; do not invent columns or child rows. Keep client access denied until the producing server/route and consumed fields are reviewed. |
| `archived_students` | `student_id`, reason, archive time, actor, and full student snapshot. | `fullSnapshot` must be a typed student-snapshot relation, not JSON. Its full field list must match the canonical student contract before DDL; the separate legacy writer must also be reconciled with the main archive path. |
| `student_archives`, `student_promotion_operations` | Archives: student/year/reason/actor/time/status. Operations: student/year/action/request/status, before/after state, actor and rollback timestamps. | Normalize immutable student snapshots, `changedFields[]`, and student history events to child relations. History event fields are type/decision/year/academic year/date/from-level/from-class plus action-specific target/destination/reason/notes. Snapshot columns and `studentId` identity semantics remain unresolved. |
| `fee_invoices`, `invoices`, `invoice_summaries`, `term_locks` | Invoices: student document ID/name/class/level/admission number, term/year, subtotal/tax/discount/total, paid amount/remaining balance, due date, status, notes, creator and timestamps. Term locks: integer year, `locked`, `lockedBy`, `lockedByName`, and `lockedAt`, under deterministic school/term/year ID. `fee_invoices` is count-only; `invoice_summaries` has no observed field access or writer. | `invoices.items[]` becomes `invoice_items` (ordinal, description, amount, quantity, unit price). `studentId` is built from `student.id` where `loadAllStudents` sets `id` from `item.id` (Firestore document ID). Keep it as a source-scoped text reference in this draft; decide whether a student FK can preserve existing archive/delete behavior before adding it. `payments` is only initialized as an empty array; no append writer exists, so do not create an invoice-payment table yet. `studentIds[]` is UI state only and is not persisted; each selected student's document ID is written on its own invoice. Do not alias these to Phase 2 fee relations. Count-only relations have no current writer contract. |
| `sms_gateway`, `sms_history`, `sms_templates` | History: creator UID/name, transport, recipient kind, SIM metadata, assessment/template name, message, recipient/submitted/failed/skipped counts, status, creation time. Gateway client fields: status, API URL/key, device ID, default sender. Template read fields: name/category/audience and body/content. | `outcomes[]` becomes typed `sms_history_outcomes` (ordinal, recipient ID/admission number, status, error). Gateway API credentials must be server-only; replace client config reads with a trusted function before cutover. Mounted template flow is read-only; unmounted template writers remain out of scope. |
| `notifications` | School, transfer-linked notification type/title/message fields are observed; dashboard reads unread ordered rows. | Recipient identity/shape is unresolved and current Firestore rules do not enforce it. Do not enable client access until a trusted recipient relation and same-source transfer semantics are defined. |
| `discipline_records` | Student document reference and denormalized name/admission/class/level/parent phone; incident date/category/severity/summary/action/follow-up; status, parent-notified flag/time, recorder UID/name and timestamps. | No nested children observed. `studentId` is selected from the source student's document ID; keep it typed as text until delete/archive semantics for a student FK are reviewed. Preserve immutable school ownership and recorder identity. |
| `health_records`, `prescriptions`, `allergies`, `immunizations`, `medical_staff` | Use the required/optional form fields in the app review. Text measurements stay text. Staff has name/email/phone/role and optional qualification/license/status/notes. | No nested arrays observed. Student/staff references are text until their source-ID semantics are verified. Preserve each collection's distinct read/write roles. |
| `visits`, `medical_inventory` | Routed Health Records page only performs school-filtered reads/listeners. | No routed writer or field-level consumer contract was found. These collections are default-denied by Firestore; keep client access denied pending a confirmed producer and need. |
| `school_inventory`, `inventory_logs` | Inventory root: name/category/SKU, quantity/minimum, price, condition/status/location/assignee/notes and timestamps; quantity uses numeric values. | Inventory logs have no Firestore write in the routed page (logs are local). Keep both default-denied until the current missing-rule behavior and log writer are addressed. |
| `school_exits` | Student/teacher identity, reason/date/notes/destination, actor and timestamp; a second page reads status-bearing documents. | Two payload shapes appear under the same collection; establish whether they are one lifecycle or distinct events before enforcing required fields/uniqueness. |
| `student_transfers`, `transfer_packages` | Transfer root: admission number and requested name, releasing/receiving school IDs/names, stage/status, reason/notes, initiator, verification/release/admission/decline actor/timestamps. The request starts without one `school_id` or verified student ID; both school IDs are in `schools[]`. | `history[]` becomes typed stage/status/time/note/user rows; `schools[]` becomes source-scoped school child rows. The applied correction makes `school_id` and `student_id` nullable and adds request/verified workflow columns. Cross-school authorization remains blocked because the app's transfer query and Firestore rule disagree. `transfer_packages` and its student snapshot/score children remain excluded (default-denied path; sensitive cross-school data). |
| `dormitories`, `dorm_assignments`, `dorm_patrons`, `dorm_maintenance`, `dorm_rules`, `dorm_inventory` | Use the required/optional form fields in the app review. Capacity and quantity are integers; maintenance cost is numeric. Assignment/patron writes denormalize student/teacher/dorm names. | No nested arrays observed. Do not create FK constraints based only on form IDs. Preserve the broader existing member-write rule for maintenance only if explicitly accepted. |
| `buses`, `routes`, `drivers`, `assignments`, `transport_payments`, `maintenance`, `fuel_records` | Use the required/optional form fields in the app review. Only payment amount, maintenance cost, and fuel amount/cost are explicitly coerced to numbers; other numeric-looking form fields remain text. | No nested arrays observed. Confirm `assignments` is transportation (not teacher assignment) and confirm document-ID semantics before adding relations. |
| `duty_rosters`, `timetable_events` | Roster root: term/year and updated actor/time. Event root: supplied/derived Firestore ID, title/description/location/color, level, teacher name/initials, term/year, updated actor/time. | Normalize duty roster by day and duty-area ID; child fields are teacher ID/initials/full name and area ID/label/start/end. Normalize event `days[]`, `periodIds[]`, and `classes[]` into separate typed children with ordinal. No recurrence/participants fields were found in the routed form. |
| `_usage_stats` | Platform dashboard reads fixed daily-usage and storage documents; server increments dynamic dotted counters. | Keep server-only. No client table grants or policies; dynamic counter field semantics belong to a server RPC, not client JSON writes. |

This registry includes the 43 reachable collection names from the app review.
Where the app only reads an empty collection or no reliable field contract
exists, the proposal intentionally withholds a guessed relational schema and
client policy. Those rows are blockers, not permission to preserve an
unreviewed JSON blob.

## Executable fail-closed DDL applied

`migration/phase-4/active-app-schema.sql` created the 38 fully evidenced
relations listed in its preflight. It creates roots and typed children only;
every relation has RLS enabled and explicitly revokes all access from
`PUBLIC`, `anon`, `authenticated`, and `service_role`. It adds no policies,
grants, imports, or app changes.

Post-apply verification confirmed all 38 relations exist with RLS enabled,
nine foreign keys, and zero rows. The subsequent approved RLS step applied
60 policies and authenticated grants on 27 relations, with immutable-key
triggers on those 27 and six invoice validation checks; the remaining 11
relations still have no client grants or policies. The pre-existing Phase 3
baseline remains 62 Auth mappings and 54 tenant memberships. The migration
control version is `1`.

The draft intentionally excludes records whose required shape or access
boundary is not established: student snapshot/archive and promotion
relations, invoice summaries/count-only fee invoices, exam submissions,
activities, notifications, visits, medical inventory, inventory logs,
school exits' conflicting payloads, transfer packages/snapshots, and
`_usage_stats`. It also does not create client access for any table included
in the script; several are explicitly default-denied by current Firestore
rules.

The transfer-contract correction has since been applied and verified against
the empty transfer relation. This resolves the request-shape nullability
mismatch only; it does not authorize cross-school transfer reads or writes.

## RLS and grants

The exact Firestore rule intents and role lists are recorded in the
`Firestore role intents for unimported app collections` section of
`MIGRATION-PHASE-4-APP-REVIEW.md`. The SQL policy mapping is:

1. All table access is source-and-school scoped through the trusted
   `firebase_migration_user_tenant_memberships` row for `auth.uid()`. Never
   use request-body `source_project`, `school_id`, role, or Firebase UID as
   authorization.
2. Source-scoped platform override may consult only
   `firebase_migration_platform_admin_memberships`; the former global admin
   relation is not an override. The new relation currently has no rows.
3. Use per-collection role predicates from the verified Firestore rules:
   lifecycle managers for promotion/archive operations; fee managers for
   invoices; headteacher/deputy-headteacher for discipline; the existing
   explicit role lists for health, boarding, transport, SMS, transfer, and
   timetable flows. Do not generalize a policy from a similarly named table.
4. Preserve append-only/transition-only behavior (SMS history, activity and
   fee audits, promotion rollback, fee transaction updates) with narrowly
   scoped SQL policies or trusted RPCs, not table-wide CRUD.
5. Active collections that have no Firestore match remain default-denied:
   `archived_students`, `fee_invoices`, `invoice_summaries`, `term_locks`,
   `sms_gateway`, `medical_inventory`, `visits`, `inventory_logs`,
   `school_inventory`, and `transfer_packages`. Read/write callers must be
   changed or explicitly reauthorized before cutover.
6. Every normalized child relation needs RLS enabled and parent-row
   authorization in its own policy. App clients receive grants only on
   relations used by approved queries; snapshot, secret, and system relations
   remain server-only.

## Decisions/blockers before policies and app cutover

- Resolve the identity and policy questions in the app review, especially
  Firebase UID versus student business/document ID, score teacher
  class/subject scope, transfer destination/source boundaries, notification
  recipient scope, school discovery, school-exit dual shape, and
  `dorm_maintenance` writes. Where unanswered, retain default deny.
- Confirm student snapshot columns from the canonical student writer/model
  before designing archive/promotion/transfer snapshot child relations.
- Confirm the actual server producers and purpose of read-only `visits`,
  `medical_inventory`, `exam_submissions`, and `activities`. Gateway
  credentials require a server function before migrating Communications.
- The transfer-contract correction is applied. Transfer policies still
  require resolving source/destination tenant boundaries and the incompatible
  Firestore list rule.
- Resolve the app's Supabase profile/session hydration and per-collection
  offline queue serializers before any app data-path cutover. Firebase
  remains the working app baseline until that work passes feature-level
  tests.

No data import or app cutover is performed by this proposal. The separately
reviewed `migration/phase-4/active-app-rls.sql` has been applied; its exact
27-relation scope and validation results are recorded in
`MIGRATION-PHASE-4-RLS-PLAN.md`. Any extension for excluded relations and
runtime tenant/role tests will be presented separately after the identified
blockers are resolved.
