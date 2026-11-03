# Phase 4 — app-layer migration review

**Status: blocked before app cutover.** No application code, Firebase configuration,
or database objects were changed in this phase. The Supabase Auth users and
`firebase_migration_*` data imported in Phases 2 and 3 are live, but the
currently applied client grants/RLS policies and the Phase 2 import inventory
are not sufficient for a safe application cutover. Changing Auth first would
also remove the Firebase identity used by all remaining Firestore requests.
This review records the concrete blockers so the user can decide on the
required pre-cutover work.

## Required pre-cutover decisions

1. **Approve a policy-complete RLS rollout for app-used imported tables.** The
   Phase 2 schema intentionally grants access to only seven collections (and
   their child tables). `schools`, `users`, `teachers`, `students`,
   `student_scores`, `exams`, `school_timetables`, `timetable_settings`, and
   other imported tables used throughout the app have no authenticated grants
   or policies. Phase 2 explicitly left those denied until their
   role/self/class rules were translated. Without those policies, profile
   hydration, school branding, most pages/services, and Auth route resolution
   fail closed. Phase 4 does not include database DDL, so it cannot make those
   tables readable or writable.
2. **Decide which non-exported app collections must be migrated and define
   their reviewed relational schema/RLS.** Those collections have no
   `firebase_migration_*` relation or approved Phase 2 data import. They cannot
   be treated as aliases for similarly named tables.
3. **Approve the cutover of existing Firestore-backed signup/admin
   provisioning flows.** School registration and admin-created accounts
   create Auth users and profile/school documents together. A Supabase Auth
   switch without a reviewed replacement for these writes would leave a
   partially provisioned account.

Until these are resolved, switching the shared Auth provider would leave
Firebase Firestore calls unauthenticated, while leaving Auth on Firebase would
not implement the requested Auth migration. No permissions were weakened and
no application flow was partially switched.

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
| `sms_jobs`, `sms_outbox` | `firebase_migration_sms_jobs`, `firebase_migration_sms_outbox`; recipients in `sms_job_students` | School-member CRUD is granted. |
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
references under `src/`. Collection names passed indirectly through helper
parameters are represented by their caller's names above. Each mapped
collection's app flow still needs query/write conversion and role-specific
RLS; table-name correspondence alone is not authorization.

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

No application changes were made, so no Phase 4 tests, lint, or build were run.
This is a blocker review, not a cutover. Phase 2's schema/import artifacts and
Phase 3's Auth bridge were inspected; no DDL, imports, service-role calls, or
Firebase Admin functions were executed or modified.

After policy and collection decisions are approved, resume by translating the
Firestore rules for every app-used imported table, accounting for the
source-scoped Auth mapping and typed child relations, migrating one
collection/service at a time with offline/realtime tests, and only then
switching Auth and removing Firebase client dependencies.
