# Phase 4 — RLS and client-grant plan

**Approved 27-relation RLS/grant scope is applied and verified.** All 38
Phase 4 relations have RLS enabled. The 27 reviewed relations have 60
policies and authenticated grants; the other 11 remain without client
policies or table privileges. Existing Firebase remains the app baseline.

## Trust model

- Every policy binds `auth.uid()` to a trusted row in
  `firebase_migration_user_tenant_memberships`, then checks both
  `source_project` and `school_id`. Never accept the source, school, or role
  from a request body.
- The only platform override is an `auth_user_id` and `source_project` match
  in `firebase_migration_platform_admin_memberships`. The relation is empty;
  no old global-admin row is an override.
- Parent/child access must check the parent row under the same source and
  scope. Do not grant direct access to snapshot, credential, or system tables.
- This policy plan is not a cutover. App login/session, query serializers,
  IndexedDB offline replay, and Realtime have to be migrated and tested before
  the client starts calling Supabase.

## Candidate policy mapping for collections with explicit Firestore rules

| Phase 4 relation(s) | Candidate read | Candidate write | Constraints / status |
|---|---|---|---|
| `assessment_configs` | Any same-school member | School teacher (the exact Firestore helper includes admin roles): insert/update/delete | Scope source and school; deterministic key remains supplied by the app. |
| `invoices`, `invoice_items` | Fee-manager roles; student self-read is withheld because Firestore rules compare Auth UID while app invoice IDs are student document IDs | Fee-manager insert/update; delete only when existing status is not `paid`; item writes only through the fee-manager parent scope | Validate nonnegative total, status and immutable school/student on update. Do not port student self-read until Firebase UID/document-ID meaning is resolved. |
| `sms_history`, `sms_history_outcomes` | Headteacher, plus source-scoped platform admin | Append only; no update/delete | History parent controls child outcome rows. Use server-generated parent IDs. |
| `sms_templates` | Headteacher, plus source-scoped platform admin | Headteacher insert/update/delete; update cannot move school | Mounted Communications currently reads templates only. Keep the write grant out until a migrated template editor is actually routed. |
| `health_records` | School admins and teachers | School admins insert/update/delete | Preserve school and source predicates; student reference stays text. |
| `allergies` | School admins and teachers | School admins insert/update/delete | Same-source school predicate. |
| `prescriptions` | School admins | School admins insert/update/delete | Same-source school predicate. |
| `immunizations`, `medical_staff` | Same-school members | School admins insert/update/delete | Same-source school predicate. |
| `dormitories`, `dorm_assignments`, `dorm_patrons`, `dorm_rules`, `dorm_inventory` | Same-school members | School admins insert/update/delete | Do not FK form IDs until their document identity and delete behavior are verified. |
| `buses`, `routes`, `drivers`, `fuel_records` | Same-school members | School admins insert/update/delete | Route-day child access follows its route parent. |
| `duty_rosters`, `duty_roster_entries` | Same-school members | Lifecycle managers insert/update; no delete | Entry rows inherit roster scope; roster map normalized by weekday and duty-area ID. |
| `timetable_events`, `timetable_event_days`, `timetable_event_periods`, `timetable_event_classes` | Same-school members | Lifecycle managers insert/update/delete | Each child inherits the event parent scope. |
| `discipline_records` | Headteacher/deputy-headteacher; source-scoped platform admin | Headteacher/deputy-headteacher update; no delete. Insert is blocked until actor identity is safely mapped. | Firestore requires `recordedBy == auth.uid()` but current app writes Firebase UID. Do not compare it with Supabase UUID or omit the recorder check. |

Roles must exactly follow `firestore.rules`: fee manager is
`admin`, `user`, `school_admin`, `principal`, `finance`, `accountant`,
`headteacher`, or `deputy-headteacher`; school admin is `admin`, `principal`,
`finance`, `headteacher`, or `deputy-headteacher`; lifecycle manager is
`admin`, `user`, `school_admin`, `school-admin`, `principal`, `headteacher`,
or `deputy-headteacher`. Teacher means `teacher` plus the school-admin role
set. No platform role is inferred from client metadata.

The proposal intentionally omits client grants for `sms_gateway` because it
contains `apiKey`; a server-side proxy must replace direct config reads.
`school_inventory`, `term_locks`, and other collections with no explicit
Firestore rule remain denied until a replacement policy is approved.

## Explicitly denied pending decisions or contract corrections

No client policy/grant is proposed yet for:

- `student_transfers` and its school/history children. Initial writes omit
  `schoolId` and verified student ID; the additive empty-table correction is
  applied, but a list query uses `schools[]` while the Firestore rule requires
  `schoolId`. Cross-school membership, source-project boundary, and
  destination notification authorization also need resolution.
- `discipline_records` inserts until actor identity is mapped safely.
- `transport_payments` self-read until student Firebase UID versus document
  ID semantics are resolved. Manager reads/writes may be reviewed separately.
- `dorm_maintenance`: Firestore currently permits any same-school member to
  write, but that broader behavior was explicitly left for review.
- `notifications`: same-school rule does not check recipient ownership;
  define a trusted recipient model first.
- `school_exits`: two active pages write/read differing payloads under the
  same collection; reconcile the model.
- `archived_students`, `fee_invoices`, `invoice_summaries`, `term_locks`,
  `sms_gateway`, `medical_inventory`, `visits`, `inventory_logs`,
  `school_inventory`, and `transfer_packages`: these are default-denied by
  current rules. Do not create broad tenant policies to make existing calls
  succeed.
- `exam_submissions` and `activities`: app reads only, but no reachable
  writer/complete field contract was found. Keep denied until producer and
  fields are confirmed.
- `_usage_stats`: preserve server-only access; current client rule is
  unscoped and not safe to reproduce.

## Approval sequence

1. The transfer schema correction is applied and verified; it added no client
   access.
2. Resolve or keep denied the listed access blockers.
3. The user approved and `migration/phase-4/active-app-rls.sql` was applied:
   27 relations, 60 policies, authenticated grants only on those relations,
   immutable-key triggers, and six invoice validation constraints. Its
   preflight required the invoice table to be empty.
4. Migrate one app flow at a time, retaining Firebase until that flow's
   Supabase login, offline queue, read/write, and authorization tests pass.

The policy script deliberately leaves the other 11 Phase 4 relations
default-denied. `node migration/phase-4/apply-active-app-rls.js --dry-run`
performs local scope/safety checks only and does not connect to the database.
The post-apply database state is checked by
`node migration/phase-4/verify-active-app-rls.js`. It confirmed all 38
relations remain empty, RLS is enabled throughout, no `anon` or
`service_role` table privileges exist, and exactly the reviewed 27 relations
have authenticated access.
