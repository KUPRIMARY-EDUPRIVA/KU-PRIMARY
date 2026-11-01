# Phase 2 — Firestore export and data-shape review

**Status:** Firestore export, inspection, and approved offline hook transformation are complete. No Supabase connection, import, schema change, or application rewrite has been performed. Firestore JSON, transformed JSON, manifests, structural profiles, and local service configs remain under the ignored `.migration/` directory.

## Live collection inventories and export counts

The exports were checked against `node collections.js` for each Firebase project. Every exported row has its original `firestore_id`; IDs are unique within each exported collection.

| KU collection | Rows | Kiwanja collection | Rows |
|---|---:|---|---:|
| `audit_logs` | 1,066 | `attendance` | 5 |
| `fee_audit_log` | 3 | `audit_logs` | 455 |
| `fee_structures` | 1 | `exams` | 5 |
| `fee_transactions` | 5 | `fee_audit_log` | 2 |
| `level_permissions` | 13 | `fee_structures` | 2 |
| `mpesa_pending_transactions` | 3 | `fee_transactions` | 2 |
| `schools` | 1 | `level_permissions` | 12 |
| `sms_jobs` | 2 | `paper_configs` | 16 |
| `sms_outbox` | 11 | `school_timetables` | 6 |
| `student_scores` | 1 | `schools` | 1 |
| `students` | 1,971 | `student_balances` | 1 |
| `subject_paper_configs` | 1 | `student_scores` | 705 |
| `teachers` | 41 | `students` | 730 |
| `timetable_settings` | 1 | `subject_paper_configs` | 16 |
| `user_roles` | 44 | `teachers` | 10 |
| `users` | 44 | `timetable_settings` | 1 |
|  |  | `user_roles` | 11 |
|  |  | `users` | 12 |
| **Total: 16 collections** | **3,208** | **Total: 18 collections** | **1,992** |

Five collections exist only in the Kiwanja project: `attendance`, `exams`, `paper_configs`, `school_timetables`, and `student_balances`. No document-ID overlap was observed among the 13 collection names shared by the two current snapshots. The snapshots also had no overlapping `schoolId`, Firebase UID, or normalized user-email values. This is snapshot evidence, not a guarantee against future collisions.

## Observed nested shapes and proposed relational children

Parent documents retain their complete original nested fields as `jsonb`; child rows are additive relational representations. Every hook also emits each nested object/array and timestamp payload into a collection-specific `<collection>_nested_values` table with a composite parent foreign key, JSON path segments, leaf value, value type, and source order. The domain-specific child tables below provide one relational row per known list/map entry; mapped fields and raw values are retained in each row's `payload jsonb`, while source key, school key, parent key, ordinal, and verified student references are typed columns. Nested assignment-class rows reference their immediate assignment child row.

| Source collection and observed field | Proposed child table(s) | Preservation notes |
|---|---|---|
| Kiwanja `attendance.entries[]`, `attendance.counts{}` | `attendance_entries`, `attendance_counts` | Preserve each full entry in `raw_entry`; retain original arrays/maps in the parent. |
| Both `fee_structures.items[]` | `fee_structure_items` | Normalize observed amount/category/description/optional fields and retain `raw_item`. |
| Both `schools.customClasses[]`, subject arrays, `classTeachers{}` | `school_custom_classes`, `school_subject_options`, `school_class_teachers` | Keep all original configuration fields on `schools`. |
| KU `sms_jobs.studentIds[]` | `sms_job_students` | Preserve source order and original array. |
| Both `student_scores.papers{}` | `student_score_papers` | Store the learning-area key and full score value as `jsonb`; keep original `papers`. |
| Kiwanja `paper_configs.papers[]`; both `subject_paper_configs.papers[]` | `paper_config_items`, `subject_paper_config_items` | Keep the two source collections distinct pending confirmation that they are not aliases. |
| Kiwanja `school_timetables.schedule{day}{period}` | `school_timetable_slots` | Store day, period, and full slot value; preserve original schedule. |
| Both `timetable_settings.periods{level}[]` | `timetable_setting_periods` | Store level, original period object, and ordering. |
| Both `teachers.assignments[]`, nested `classes[]`, `classes[]`, `levels[]`, `subjects[]` | `teacher_assignments`, `teacher_assignment_classes`, `teacher_scopes` | Keep legacy convenience arrays and raw assignments on `teachers`. |
| Both `user_roles.assignments[]`, nested `classes[]`, assigned scope arrays | `user_role_assignments`, `user_role_assignment_classes`, `user_role_scopes` | Preserve original scope arrays and nested assignments. |
| Both `users.assignments[]`, nested `classes[]`, classes/levels/subjects | `user_assignments`, `user_assignment_classes`, `user_scopes` | Keep `permissions` and all source fields unchanged. |
| Both `students.history[]` | `student_history_entries` | Current exports contain empty histories; retain the hook for future/non-empty records. |

The hooks cover all 21 live collection names across both sources, including nested audit metadata, fee-audit actor/metadata, fee-transaction student snapshots, SMS recipient details, user permissions, and configuration maps. The original source fields remain intact as `jsonb` for lossless recovery, while the path/value child rows prevent those nested structures from being available only as opaque blobs. Firestore timestamp objects are also captured leafwise; conversion to typed `timestamptz` columns remains a separate reviewed schema decision.

The exported fee, score, attendance, balance, pending-payment, and SMS student references were checked against each source's student document IDs: 23 KU references and 963 Kiwanja references matched, with no unmatched reference in these live collections. The schema proposal can therefore add composite foreign keys from these `studentId`/`studentIds` columns to `students(source_project, firestore_id)`, plus a tenant-consistency validation. The student profiles' own `studentId` business identifier is not treated as a foreign key.

`paper_configs` and `subject_paper_configs` are used through distinct application APIs (query-by-level versus deterministic document lookup); they will remain separate during migration rather than being merged.

## Shared-project identity and tenant plan

The selected key design is the composite primary key `(source_project, firestore_id)`, preserving each exact Firestore document ID while preventing future collisions between the distinct Firebase projects. `source_project` is the fixed value `ku` or `kiwanja`; the importer will add it to every parent row from its source manifest, including collections with no nested data. Child tables use the same composite key and foreign keys `(source_project, parent_firestore_id)` to their parent table's `(source_project, firestore_id)`. Assignment-class rows reference the composite key of the assignment child row.

The stock helper importer only supports a scalar generated key and infers SQL types from observed values; it cannot safely create this composite-key schema as-is. The import plan therefore requires a reviewed importer/schema path that creates additive tables, parameterizes values, preserves the source key, and uses idempotent upserts. Imports will be staged and reconciled by source before any tenant-facing cutover. No existing table will be dropped or truncated.

Every exported non-empty collection has a `schoolId` field, with exactly one distinct non-null school tenant per source in this snapshot. Two `users` rows (one per project) have null `schoolId`, role `user`, and no matching `user_roles` row. Per the selected handling, preserve those rows but deny tenant data access until an explicit assignment exists; do not infer a school.

RLS must be enabled on every tenant table. Policies must derive the authorized tenant from a trusted authenticated-user-to-tenant membership relation, not from a client-supplied `schoolId`. The two unassigned user rows receive no tenant membership and therefore no tenant access.

## Additive schema and RLS contract for approval

The shared project will contain 21 parent tables: `audit_logs`, `attendance`, `exams`, `fee_audit_log`, `fee_structures`, `fee_transactions`, `level_permissions`, `mpesa_pending_transactions`, `paper_configs`, `school_timetables`, `schools`, `sms_jobs`, `sms_outbox`, `student_balances`, `student_scores`, `students`, `subject_paper_configs`, `teachers`, `timetable_settings`, `user_roles`, and `users`.

The 42 child tables are `attendance_counts`, `attendance_entries`, `attendance_nested_values`, `audit_logs_nested_values`, `exams_nested_values`, `fee_audit_log_nested_values`, `fee_structure_items`, `fee_structures_nested_values`, `fee_transactions_nested_values`, `level_permissions_nested_values`, `mpesa_pending_transactions_nested_values`, `paper_config_items`, `paper_configs_nested_values`, `school_class_teachers`, `school_custom_classes`, `school_subject_options`, `school_timetable_slots`, `school_timetables_nested_values`, `schools_nested_values`, `sms_job_students`, `sms_jobs_nested_values`, `sms_outbox_nested_values`, `student_balances_nested_values`, `student_score_papers`, `student_scores_nested_values`, `students_nested_values`, `subject_paper_config_items`, `subject_paper_configs_nested_values`, `teacher_assignment_classes`, `teacher_assignments`, `teacher_scopes`, `teachers_nested_values`, `timetable_setting_periods`, `timetable_settings_nested_values`, `user_assignment_classes`, `user_assignments`, `user_role_assignment_classes`, `user_role_assignments`, `user_role_scopes`, `user_roles_nested_values`, `user_scopes`, and `users_nested_values`.

Each parent table has `source_project text NOT NULL`, `firestore_id text NOT NULL`, `school_id text NULL`, and `document jsonb NOT NULL`, with primary key `(source_project, firestore_id)` and a check limiting source to `ku` or `kiwanja`. It also has a unique `(source_project, firestore_id, school_id)` key for tenant-safe foreign keys. `school_id` is copied from the original `schoolId` without changing the preserved `document`. Each child table has the same source/key/school columns plus `parent_firestore_id text NOT NULL`, `ordinal integer NOT NULL`, and `payload jsonb NOT NULL`, with primary key `(source_project, firestore_id)`, a composite parent foreign key `(source_project, parent_firestore_id)`, and a second composite foreign key including `school_id` to enforce tenant consistency whenever a school is assigned. For the three assignment-class tables the parent is the corresponding assignment child table; all other children reference their source collection parent. Foreign keys use `ON DELETE RESTRICT`; source rows are never silently cascaded away. The seven tables with verified student references (`attendance_entries`, `fee_audit_log`, `fee_transactions`, `mpesa_pending_transactions`, `sms_job_students`, `student_balances`, and `student_scores`) also have nullable `student_firestore_id` and a composite foreign key to `students(source_project, firestore_id, school_id)`. The import preflight separately checks all exported student references. Nested-value tables retain path/value/type in their child `payload`; parent documents and child payloads preserve original values losslessly.

An additive `user_tenant_memberships` table will contain `auth_user_id uuid REFERENCES auth.users(id)`, `source_project text`, `school_id text`, and trusted `role text`, keyed by `(auth_user_id, source_project)`. No membership is created for a profile without a verified Supabase Auth account and non-null school. Auth UID linkage and role derivation must be verified during the separate Auth phase; clients receive no insert/update/delete policy on this table. A separate, initially empty `platform_admins` table records verified platform administrators where the existing Firestore rules grant that override; it also has RLS enabled and no client write policy.

All 63 data tables have RLS enabled; the three control tables (`migration_control`, `user_tenant_memberships`, and `platform_admins`) also have RLS. The seven approved collection groups and their 15 child tables receive authenticated grants/policies in this Phase 2 schema. School access policies match both `source_project` and `school_id` against a membership row for `(select auth.uid())`; this prevents cross-project access even if school IDs later collide. The other 41 data tables have no authenticated grants or policies yet and therefore remain default-denied until their complete role/self/class policies are added in the app/RLS phase before cutover. The rules-to-RLS table remains the mapping proposal for that later phase; no broader access is inferred. Membership role is populated/updated only by a trusted migration or server process.

The schema creates the explicitly approved school-scoped CRUD policies on `attendance`, `subject_paper_configs`, `sms_jobs`, and `sms_outbox`, plus equivalent policies on their child tables. For `level_permissions`, `paper_configs`, and `user_roles`, school members may read; only school-scoped admins may write, including their child tables. All other tables remain unavailable to authenticated clients in this import phase. Their translated role/self/class rules must be implemented and tested before the app switches away from Firebase.

Before applying, the SQL fails closed unless all target relation names are absent and Supabase Auth/API roles are available; it never alters an existing relation. A failed transactional import rolls back that source's inserts. The importer allows an identical retry but rejects conflicting rows and any unexpected existing source rows. `rollback-access.sql` only revokes client table grants; it does not drop schema or data. Once committed, rollback means stopping access and preserving imported rows; removing any migration-owned schema or rows requires a separately approved, ownership-checked cleanup and is not part of the default rollback.

## Review-artifact commands

These are local/offline checks and do not connect to Supabase:

```sh
npm install --prefix migration/phase-2 --no-audit --no-fund
npm test --prefix migration/phase-2
npm run --prefix migration/phase-2 generate-schema
node migration/phase-2/apply-schema.js --dry-run
node migration/phase-2/import.js --source ku --dry-run
node migration/phase-2/import.js --source kiwanja --dry-run
node migration/phase-2/validate-import.js --source ku
node migration/phase-2/validate-import.js --source kiwanja
```

Database commands exist but were not run; each requires an explicit `--apply` or `--database` flag and separate user approval:

```sh
node migration/phase-2/apply-schema.js --apply
node migration/phase-2/validate-schema.js --database
node migration/phase-2/import.js --source ku --apply
node migration/phase-2/import.js --source kiwanja --apply
node migration/phase-2/validate-import.js --source ku --database
node migration/phase-2/validate-import.js --source kiwanja --database
```

The schema stores source documents and child payloads as JSONB but places each nested item/map entry in its own foreign-keyed child relation; the seven verified student-reference tables additionally expose a typed composite FK. Auth membership is not seeded in Phase 2 because Supabase Auth accounts and Firebase password-hash parameters belong to the separately gated Auth phase.

## Firestore rules → proposed RLS mapping

The mapping below is based on the checked-in `firestore.rules`, whose global fallback denies access. It is a proposal only; no policy has been applied.

| Live collection | Checked-in Firestore access | Proposed Supabase policy behavior |
|---|---|---|
| `schools` | Tenant members get; platform admins list/create/delete; admin/headteacher manage profile with protected fields. | Tenant-scoped select; trusted platform-admin list/create/delete; profile-manager update with protected-column checks. |
| `users` | Self and authorized school/platform admins read; self profile updates are field-limited; admins cannot change protected role/tenant assignments; platform-admin deletion is restricted. | Self/tenant/platform reads; self-update allowlist; admin updates constrained to same tenant and unchanged role; privileged deletion mirrors managed-role restriction. |
| `teachers` | Same-school admin or self reads; school admin creates/deletes; self updates are limited to contact/assignment fields. | Tenant-scoped reads and role-checked writes; self-update allowlist; no client role/tenant changes. |
| `students` | School/fee/communications admins read; teachers are class-scoped; student self-read compares `studentId` to Auth UID; school admins write. | Tenant/role reads plus class-membership predicate; admin writes preserve school/admission identity. Student-self access remains denied until an explicit Auth-to-student mapping is verified. |
| `school_timetables`, `timetable_settings` | School members read; lifecycle managers create/update; deletes denied. | Tenant-member select; manager insert/update; no delete. |
| `mpesa_pending_transactions` | Fee managers or the matching student read; all client writes denied. | Fee-manager/verified-self read; writes only through an authenticated server webhook/function. |
| `fee_transactions` | Fee managers or matching student read; valid idempotent inserts; only constrained void updates; deletes denied. | Role/self read; append-only inserts with idempotency checks; restricted void RPC/update; no delete. |
| `student_balances` | Communications/fee managers or matching student read; fee manager create/update; deletes denied. | Tenant/role/self read; server or fee-manager writes; no delete. |
| `fee_structures` | School members read; fee managers write. | Tenant-member read; fee-manager write. |
| `fee_audit_log` | Fee managers read/append; update/delete denied. | Fee-manager select/insert; immutable after insert. |
| `student_scores` | Communications users, teachers, or matching students read; teachers create/update; school admins delete. | Tenant/role/self read, class-aware teacher predicate; teacher writes; admin-only delete. |
| `exams` | School members read; teachers write. | Tenant-member read; teacher write. |
| `audit_logs` | Listed same-school roles and platform admins read; signed same-school/platform users append; update/delete denied. | Role-scoped tenant read/append; immutable after insert. |
| `attendance`, `subject_paper_configs`, `sms_jobs`, `sms_outbox` | No explicit match; the checked-in global fallback denies all client access. | Signed-in school members may select, insert, update, and delete rows only in their own `(source_project, school_id)`. |
| `level_permissions`, `paper_configs`, `user_roles` | No explicit match; the checked-in global fallback denies all client access. | Signed-in school members may read only their own `(source_project, school_id)`; only school-scoped users with trusted role `admin` may insert, update, or delete. |

The user confirmed that checked-in `firestore.rules` matches the deployed rules for both Firebase projects, and explicitly requested school-scoped direct client access to all seven collections above. That request broadens the current default-deny behavior. The user further specified that only users with role `admin` may write `user_roles`, `level_permissions`, and `paper_configs`; the other four collections are writable by signed-in users in their own school. This must be implemented with trusted membership/role data, not client-supplied claims. Every child table derived from these collections must enforce the same source-project and school boundary. The `students` rules also use `studentId == request.auth.uid`, but no exported student `studentId` matched an exported user UID; student-self access remains disabled until an explicit Auth-to-student mapping is verified.

The planned policy helper uses a trusted membership row keyed by Supabase `auth.uid()`, `source_project`, and `school_id`; the membership's role is server-managed and cannot be changed by clients. Since the two Firebase projects are separate accounts, policies match both `source_project` and `school_id`, preventing an identical school ID in one project from granting access to the other. Class-limited teacher access uses a separate membership-class relation. Platform-admin status must come from trusted claims or a server-managed table, never client input. The null-school user rows remain without membership and default-denied.

## Schema/import plan — review artifacts prepared, execution requires separate approval

1. The reviewed hooks have run only against ignored local exports. `migration/phase-2/schema-spec.js` defines the 21 parents and 42 child tables; `generate-schema.js` creates the checked-in [`schema.sql`](migration/phase-2/schema.sql) and [`rollback-access.sql`](migration/phase-2/rollback-access.sql).
2. The schema preserves full source documents and child payloads as JSONB, with one row per nested item/map entry, composite parent keys, school-consistency foreign keys, and verified student-reference foreign keys. `paper_configs` and `subject_paper_configs` remain distinct.
3. RLS is enabled on all 63 data tables and the three control tables. Only the seven explicitly approved collection groups and their child tables receive client grants/policies; all remaining tables stay default-denied pending the complete role/self/class RLS implementation before app cutover.
4. `import.js` reads only ignored processed dumps, uses parameterized inserts, runs one source in a serializable transaction, preserves original Firestore IDs, permits identical retries, and aborts on conflicting or extra source rows. It never uses the stock helper importer.
5. Schema application aborts if any target relation already exists. Import validation checks every source/table count, child-parent references, same-school propagation, and student references. The importer compares stored JSON values before commit; `validate-import.js --database` checks persisted row-count parity.
6. The no-drop rollback artifact only revokes client grants. Failed imports roll back transactionally; committed data and schema remain in place unless a separate ownership-checked cleanup is explicitly approved. No existing table is dropped/truncated and RLS is never disabled.
7. Local tests and dry runs passed for both sources. These review artifacts do not contact Supabase. Applying schema, importing either source, or querying the target remains blocked until you review these files and explicitly approve the database operation.

## Export-tool corrections and validation

The helper's `limit=0` path stopped after the first 1,000 records, and empty collections could produce invalid JSON. Both defects were corrected only in the ignored local helper clone. The first incomplete KU pass was preserved separately and is excluded from the canonical dumps. The complete exports include 1,066 KU audit logs and 1,971 KU students.

`migration/phase-2/run-hooks.js` is the offline processor for the reviewed hooks. It reads only the existing ignored dumps, refuses to overwrite a prior processed output, verifies parent and student foreign keys and tenant propagation, preserves the source JSON, and publishes output only after validation. It does not initialize Firebase or connect to Supabase.

The approved offline transformation completed successfully. It produced 3,208 parent rows and 17,073 child rows across 33 child tables for KU, and 1,992 parent rows and 15,544 child rows across 37 child tables for Kiwanja. Persisted-output validation confirmed that every source document is preserved unchanged except for the added `source_project` tag, parent counts match the export manifests, every child has a resolvable parent, and every student reference resolves within its source project. The raw dumps remain unchanged.

Validated locally: both manifests match their respective live collection lists; all canonical JSON files parse; record counts match their manifests; source IDs are present and unique within each collection; the shared-source overlap report found no current ID collisions; all 21 per-collection hook files pass syntax checks and cover every live collection. No record values, IDs, emails, or credentials are included in this report.
