# Phase 2 — Firestore export and data-shape review

**Status:** Export and inspection only. No Supabase connection, import, schema change, or application rewrite has been performed. Firestore JSON, manifests, structural profiles, and local service configs remain under the ignored `.migration/` directory.

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

Parent documents retain their complete original nested fields as `jsonb`; child rows are additive relational representations. Every hook also emits each nested object/array and timestamp payload into a collection-specific `<collection>_nested_values` table with a composite parent foreign key, JSON path segments, leaf value, value type, and source order. The domain-specific child tables below provide typed, queryable representations where the shape is known. Each child has its own `firestore_id`, `source_project`, `schoolId`, `parent_firestore_id`, and source order (`ordinal`); nested assignment-class rows reference their immediate assignment child row.

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

## Proposed next import plan — requires separate approval

1. Review the hook files in [`migration/phase-2/hooks`](migration/phase-2/hooks). They are proposals and have not been executed.
2. Keep the two paper-configuration collections separate and apply only the student foreign-key relationships verified from the current exports; review any additional relationships before adding constraints.
3. Implement and review an additive composite-key schema/importer. Create staging tables first; never drop/truncate tables, disable RLS, or overwrite pre-existing target data.
4. Run hook transformations against the already-exported local JSON (not Firestore) after hook approval; compare parent and child row counts to source manifests and check every foreign key before importing.
5. Present the exact SQL/schema, table mapping, RLS policies, rollback plan, and validation commands for approval before any Supabase write.
6. Only after approval, import in a transaction-safe, source-scoped manner and report per-table count parity.

## Export-tool corrections and validation

The helper's `limit=0` path stopped after the first 1,000 records, and empty collections could produce invalid JSON. Both defects were corrected only in the ignored local helper clone. The first incomplete KU pass was preserved separately and is excluded from the canonical dumps. The complete exports include 1,066 KU audit logs and 1,971 KU students.

Validated locally: both manifests match their respective live collection lists; all canonical JSON files parse; record counts match their manifests; source IDs are present and unique within each collection; the shared-source overlap report found no current ID collisions. All 21 per-collection hook previews pass syntax-only checks and cover every live collection; no hook has been executed. No record values, IDs, emails, or credentials are included in this report.
