# Firebase to Supabase migration status

## Current status

The database preparation is complete for the reviewed Phase 4 schema and RLS
scope, but the application has **not** been cut over. The production app must
continue using Firebase until Supabase Auth provisioning, profile/session
hydration, each feature's data access, and offline behavior are migrated and
validated together.

This repository is a **Create React App application wrapped with Capacitor**,
not a Dart/Flutter application. There is no `pubspec.yaml` or Flutter
`main.dart`; the active app entry points include `src/firebase.js` and
`src/context/AuthContext.jsx`.

## Applied database work

- Phase 3 imported the KU and Kiwanja Auth users and retained their
  source-scoped Firebase credential mappings.
- Phase 4 changed Auth mapping uniqueness to be source-scoped and added the
  source-scoped platform-admin membership table. No platform-admin rows were
  backfilled.
- The additive Phase 4 schema contains 38 empty typed relations. The transfer
  request contract correction was applied without adding access.
- The approved Phase 4 RLS change applied 60 policies and authenticated grants
  to 27 relations, plus immutable-identity update triggers and invoice
  validation constraints. All 38 relations have RLS enabled. The 11 relations
  below remain default-denied.
- Phase 4 relations remain empty; this is schema preparation, not a transfer
  of app data. Firebase remains the app's active backend.

## Phase 4 relations still default-denied

These are the exact 11 relations in the Phase 4 schema that do not have a
client policy or authenticated table grant:

| Relation | Why access is still denied |
|---|---|
| `firebase_migration_term_locks` | No confirmed production Firestore rule; keep denied until the intended lock-management roles and workflow are approved. |
| `firebase_migration_sms_gateway` | Contains gateway credentials. Replace client configuration reads with a trusted server-side function; never expose the API key to the app. |
| `firebase_migration_discipline_records` | Insert authorization depends on mapping the recorder's Firebase UID safely to the Supabase Auth UUID. |
| `firebase_migration_school_inventory` | No explicit production Firestore rule; define and approve a replacement policy before enabling app access. |
| `firebase_migration_student_transfers` | The request/list query and Firestore rule disagree about school scoping. Cross-school source/destination authorization and notifications need a reviewed model. |
| `firebase_migration_student_transfer_schools` | Child access depends on resolving the transfer's cross-school authorization boundary. |
| `firebase_migration_student_transfer_history` | Child access depends on resolving the transfer's cross-school authorization boundary. |
| `firebase_migration_dorm_maintenance` | Existing same-school write behavior is broader than the proposed role grants; confirm the intended write roles. |
| `firebase_migration_assignments` | No reviewed app policy for this relation has been approved. |
| `firebase_migration_transport_payments` | Student self-read requires resolving Firebase UID versus student document-ID semantics; manager access also needs a reviewed policy. |
| `firebase_migration_maintenance` | No reviewed app policy for this relation has been approved. |

This list covers only the 11 Phase 4 relations intentionally excluded from
the approved RLS grant set. It is **not** a complete list of all tables the
app would need: many imported Phase 2 relations also require separate RLS
review and grants before their Firebase-backed features can move.

## Why Firebase dependencies remain

The runtime still imports Firebase Auth, Firestore, and Storage from
`src/firebase.js` and uses them across active pages, services, auth/profile
hydration, and the IndexedDB sync queue. The queue currently stores and replays
Firestore-shaped operations; replacing its backend without serializers and
replay tests would break offline writes and may duplicate or lose changes.
The Netlify Firebase Admin functions also remain server-side integrations and
are separate from the client migration.

Do not remove the `firebase` package, Firebase configuration, or
`google-services.json` yet. The Android Gradle configuration applies Google's
Services plugin when `android/app/google-services.json` exists and notes that
push notifications depend on it. Remove these only after their active app and
native-plugin use has been replaced and tested.

## Transitional Auth bridge

The current branch adds a **staff/admin login shadow session**: after Firebase
validates the login, the client signs into Supabase with the same credentials.
If Supabase rejects the password as an invalid credential, the client calls
the source-pinned Netlify migration function and retries Supabase Auth. It
then requires a self-readable membership for the configured source before
retaining the Supabase session. Firebase remains the app's primary identity
for profile hydration and Firestore access. The Supabase UUID is exposed
separately as `supabaseUserId`; it does not replace the Firebase UID.

Configure these public build variables per source deployment:

```text
REACT_APP_SUPABASE_URL
REACT_APP_SUPABASE_ANON_KEY
REACT_APP_AUTH_MIGRATION_SOURCE=ku|kiwanja
```

The Netlify function independently pins `AUTH_MIGRATION_SOURCE` and rejects a
request whose source does not match that deployment. The service-role key and
Firebase scrypt parameters remain server-only. With the source variable
unset, the transitional Supabase session is disabled and the existing
Firebase login behavior remains unchanged. Student login, account creation,
biometric/offline entry, and any data repository are not yet cut over.

## Remaining cutover work

1. Provision/link each source-specific identity through the trusted server
   flow. Resolve the source membership and profile for the authenticated
   Supabase UUID; do not infer school, role, or source from client-supplied
   values or email alone.
2. Migrate one reachable feature at a time, including tenant-scoped query and
   write serializers, parent/child relations, authorization checks, and
   Realtime where currently used. Keep Firebase available until that feature
   passes parity and authorization tests.
3. Replace Firestore offline replay with a durable Supabase-aware queue,
   including conflict/idempotency handling and tests for reconnect/replay.
4. Configure the React/Capacitor application with the public Supabase URL and
   anon key through the project's environment configuration. Never include a
   service-role key in the client or an APK.
5. Add end-to-end tests for login, source membership/profile hydration,
   representative reads and writes, cross-school/source denial, and offline
   replay. Only then remove unused Firebase client dependencies and native
   configuration.
6. Complete Phase 5 with a documented table mapping, approved access-policy
   mapping, data parity evidence for any future imports, rollback procedure,
   and manual follow-ups.

## Validation commands

```sh
node --test migration/phase-4/*.test.js netlify/functions/migrate-firebase-password.test.js
node migration/phase-4/apply-active-app-rls.js --dry-run
node migration/phase-4/verify-active-app-rls.js
```

`verify-active-app-rls.js` connects to the configured migration database and
checks the applied Phase 4 relation, policy, privilege, trigger, constraint,
and row-count state. Do not copy credentials into this repository; keep them
in the ignored `.migration/` directory.
