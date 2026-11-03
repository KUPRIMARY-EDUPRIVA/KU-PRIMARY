# Phase 3 — Auth bridge review

**Status:** Auth exports and offline validation are complete. The additive Auth schema and first-login function are prepared and tested, but the schema has not been applied and no user has been imported into Supabase Auth. The exported Firebase Auth records remain in the ignored `.migration/dumps/auth/` directory with mode `0600`.

## Export and identity validation

The Firebase Admin user exports were read-only and use separate KU and Kiwanja service accounts. The signer parameters are not stored in the repository or included in these exports' summary output.

| Source | Auth users | Password credentials | Email verified | Matching user profiles | School memberships planned | No profile | Profile without school |
|---|---:|---:|---:|---:|---:|---:|---:|
| KU | 49 | 49 | 37 | 44 | 43 | 5 | 1 |
| Kiwanja | 13 | 13 | 4 | 12 | 11 | 1 | 1 |

Every profile matched an Auth account by Firebase UID and normalized email. There were no duplicate normalized emails within or across the two sources and no overlapping Firebase UIDs. The 6 accounts with no profile and 2 profiles without a school will be imported without a tenant membership; RLS therefore denies them school data access until a trusted profile/membership is resolved. Firebase reported 12 KU and 9 Kiwanja accounts as not email-verified. Their verification state remains false; the app rewrite must retain the verification gate and provide a Supabase email-verification flow rather than silently confirming them.

## Identity and password compatibility

Supabase Auth IDs are UUIDs; Firebase UIDs are strings. The import plan generates a Supabase UUID and retains the source-scoped `(source_project, firebase_uid) -> auth_user_id` relationship in `firebase_migration_auth_user_map`. It also creates the corresponding `auth.identities` email-provider row and keeps Firebase profile IDs unchanged in the Phase 2 data tables. User profiles with a non-null `schoolId` receive a trusted tenant membership from their validated profile role.

Supabase cannot directly authenticate Firebase Scrypt hashes as its password hashes. Imported accounts initially have no usable Supabase password. The Firebase hash and salt are kept only in the server-only `firebase_migration_auth_credentials` table. `migrate-firebase-password.js` verifies a submitted password with the source-specific Firebase Scrypt parameters, updates the password via Supabase Auth Admin, and marks the mapping migrated so the legacy verifier is not used again. The old hash and salt remain server-only for rollback until separately approved cleanup. The app must call this POST function after a Supabase password sign-in fails, then retry Supabase sign-in; wiring that flow belongs to the app-layer phase. Firebase email-verification state, provider metadata, and custom claims are retained for the app rewrite.

The stock migration repo's Auth scripts are not used: inspection found that its importer generates unrelated UUIDs, writes empty password hashes, does not retain the Firebase password verifier, interpolates user data into SQL, and exits non-zero after completion. Its verifier also accepts credentials in a GET URL and lacks the password-update step.

## Proposed additive Auth schema

The proposed `migration/phase-3/auth-schema.sql` adds three public relations:

| Relation | Purpose | Client access |
|---|---|---|
| `firebase_migration_auth_user_map` | Source Firebase UID to Supabase Auth UUID, normalized email, profile/disabled flags, provider metadata, and first-login migration timestamp | RLS enabled; no `PUBLIC`, `anon`, or `authenticated` grants or policies |
| `firebase_migration_auth_credentials` | Firebase password hash and salt, retained for rollback after first login | RLS enabled; only the server-side `service_role` can read |
| `firebase_migration_auth_rate_limits` | Opaque HMAC buckets used to rate-limit first-login attempts | RLS enabled; access through a security-definer RPC executable only by `service_role` |

The script is additive, transaction-bounded, and aborts if its target relations, indexes, or function already exist. It adds a schema-version marker to the existing control table. No existing table is altered or dropped. A post-apply check will verify RLS, grants, function privileges, and that no client-readable password material exists.

## First-login function configuration

The Netlify function is source-scoped by server environment variable, accepts POST only, never takes the source project from the caller, uses generic invalid-credential responses, rate-limits by HMACed email and Netlify client IP, and does not log the password, email, hash, salt, or signer key. It uses only server-side values:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
AUTH_MIGRATION_SOURCE
AUTH_MIGRATION_RATE_LIMIT_SECRET
FIREBASE_SCRYPT_SIGNER_KEY
FIREBASE_SCRYPT_SALT_SEPARATOR
FIREBASE_SCRYPT_ROUNDS
FIREBASE_SCRYPT_MEM_COST
```

Configure these independently for each Netlify deployment; `AUTH_MIGRATION_SOURCE` must be `ku` on the KU site and `kiwanja` on the Kiwanja site. `SUPABASE_SERVICE_ROLE_KEY` and all Scrypt parameters must remain Netlify server-side secrets and must never use a `REACT_APP_` prefix.

## Validation and approval gates

Offline checks:

```sh
node --test migration/phase-3/*.test.js netlify/functions/migrate-firebase-password.test.js
node migration/phase-3/validate-auth-exports.js
node migration/phase-3/import-auth.js --source ku --dry-run
node migration/phase-3/import-auth.js --source kiwanja --dry-run
node migration/phase-3/apply-auth-schema.js --dry-run
```

The proposed schema has not been applied. Applying it requires separate approval. KU and Kiwanja Auth imports will each require their own approval and will run as separate serializable transactions. After each import, `validate-auth-import.js --source <source> --database` checks Auth users, identities, retained legacy credentials, first-login migrations, and tenant memberships against the export.
