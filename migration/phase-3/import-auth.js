const crypto = require("node:crypto");
const { connectDatabase } = require("../phase-2/db");
const { normalizeEmail } = require("./auth-utils");
const { validateExports } = require("./validate-auth-exports");

function parseArgs(args) {
  if (
    args.length !== 3 ||
    args[0] !== "--source" ||
    !["ku", "kiwanja"].includes(args[1]) ||
    !["--dry-run", "--apply"].includes(args[2])
  ) {
    throw new Error("Usage: node import-auth.js --source ku|kiwanja --dry-run|--apply");
  }
  return { source: args[1], apply: args[2] === "--apply" };
}

function providerMetadata(providerData) {
  const providers = [...new Set(providerData.map(({ providerId }) => {
    switch (providerId) {
      case "password":
        return "email";
      case "google.com":
        return "google";
      case "facebook.com":
        return "facebook";
      case "phone":
        return "phone";
      default:
        return providerId;
    }
  }))];
  return {
    provider: providers[0] || "email",
    providers: providers.length ? providers : ["email"],
  };
}

function accountTimestamps(user) {
  const createdAt = user.createdAt ? new Date(user.createdAt) : new Date();
  const lastSignInAt = user.lastSignInAt ? new Date(user.lastSignInAt) : null;
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(`Auth user ${user.uid} has an invalid creation timestamp`);
  }
  if (lastSignInAt && Number.isNaN(lastSignInAt.getTime())) {
    throw new Error(`Auth user ${user.uid} has an invalid last-sign-in timestamp`);
  }
  return { createdAt: createdAt.toISOString(), lastSignInAt: lastSignInAt?.toISOString() || null };
}

async function assertAuthSchema(client) {
  const version = await client.query(
    `SELECT value FROM public.firebase_migration_control WHERE key = $1`,
    ["phase3_auth_schema_version"],
  );
  if (version.rowCount !== 1 || version.rows[0].value !== "1") {
    throw new Error("Phase 3 Auth schema version 1 is not installed");
  }
}

async function assertNoExistingAccounts(client, plan) {
  const emails = plan.accounts.map(({ email }) => email);
  const result = await client.query(
    "SELECT 1 FROM auth.users WHERE lower(email) = ANY($1::text[]) LIMIT 1",
    [emails],
  );
  if (result.rowCount) {
    throw new Error("One or more Auth emails already exist in Supabase; refusing to merge accounts");
  }
  const memberships = await client.query(
    "SELECT 1 FROM public.firebase_migration_user_tenant_memberships WHERE source_project = $1 LIMIT 1",
    [plan.source],
  );
  if (memberships.rowCount) {
    throw new Error(`${plan.source} memberships already exist without an Auth mapping`);
  }
}

async function assertProfilesMatch(client, plan) {
  const result = await client.query(
    "SELECT firestore_id, document FROM public.firebase_migration_users WHERE source_project = $1",
    [plan.source],
  );
  const expectedProfiles = plan.accounts.filter(({ profile }) => profile);
  if (result.rowCount !== expectedProfiles.length) {
    throw new Error(`${plan.source} user profiles differ from the validated Firestore export`);
  }
  const actualByUid = new Map(
    result.rows.map((row) => [row.firestore_id, row.document]),
  );
  for (const account of expectedProfiles) {
    const document = actualByUid.get(account.user.uid);
    if (
      !document ||
      document.uid !== account.user.uid ||
      normalizeEmail(document.email) !== account.email ||
      (document.schoolId ?? null) !== (account.profile.schoolId ?? null) ||
      (document.role ?? null) !== (account.profile.role ?? null)
    ) {
      throw new Error(`${plan.source} user profile differs from the validated Auth mapping`);
    }
  }
}

async function insertAccount(client, account, profileFound) {
  const authUserId = crypto.randomUUID();
  const { user, email } = account;
  const timestamps = accountTimestamps(user);
  const appMetadata = {
    ...providerMetadata(user.providerData),
    firebaseCustomClaims: user.customClaims || {},
  };
  const userMetadata = {
    displayName: user.displayName,
    photoURL: user.photoURL,
    phoneNumber: user.phoneNumber,
    emailVerified: Boolean(user.emailVerified),
  };
  const emailConfirmedAt = user.emailVerified ? new Date().toISOString() : null;

  if (
    !user.providerData.some((provider) => provider.providerId === "password") ||
    user.providerData.some((provider) => provider.providerId !== "password")
  ) {
    throw new Error(`Auth user ${user.uid} has an unsupported provider mapping`);
  }

  await client.query(
    `INSERT INTO auth.users (
       id, aud, role, email, encrypted_password, email_confirmed_at,
       last_sign_in_at, raw_app_meta_data, raw_user_meta_data,
       is_super_admin, created_at, updated_at, phone
     ) VALUES (
       $1, 'authenticated', 'authenticated', $2, '', $3, $4,
       $5::jsonb, $6::jsonb, false, $7, now(), $8
     )`,
    [
      authUserId,
      email,
      emailConfirmedAt,
      timestamps.lastSignInAt,
      JSON.stringify(appMetadata),
      JSON.stringify(userMetadata),
      timestamps.createdAt,
      user.phoneNumber,
    ],
  );

  await client.query(
    `INSERT INTO auth.identities (
       provider_id, user_id, identity_data, provider, last_sign_in_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3::jsonb, 'email', $4, $5, now())`,
    [
      email,
      authUserId,
      JSON.stringify({
        sub: authUserId,
        email,
        email_verified: Boolean(user.emailVerified),
        phone_verified: false,
      }),
      timestamps.lastSignInAt,
      timestamps.createdAt,
    ],
  );

  await client.query(
    `INSERT INTO public.firebase_migration_auth_user_map (
       source_project, firebase_uid, auth_user_id, email, profile_found,
       disabled, provider_data
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      account.source,
      user.uid,
      authUserId,
      email,
      profileFound,
      user.disabled,
      JSON.stringify(user.providerData),
    ],
  );

  if (user.passwordHash && user.passwordSalt) {
    await client.query(
      `INSERT INTO public.firebase_migration_auth_credentials (
         source_project, firebase_uid, password_hash, password_salt
       ) VALUES ($1, $2, $3, $4)`,
      [account.source, user.uid, user.passwordHash, user.passwordSalt],
    );
  }
  return authUserId;
}

async function verifyCounts(client, plan, insertedMembershipCount) {
  const accounts = await client.query(
    "SELECT count(*)::int AS count FROM public.firebase_migration_auth_user_map WHERE source_project = $1",
    [plan.source],
  );
  const credentials = await client.query(
    "SELECT count(*)::int AS count FROM public.firebase_migration_auth_credentials WHERE source_project = $1",
    [plan.source],
  );
  const memberships = await client.query(
    "SELECT count(*)::int AS count FROM public.firebase_migration_user_tenant_memberships WHERE source_project = $1",
    [plan.source],
  );
  const identities = await client.query(
    `SELECT count(*)::int AS count
     FROM auth.identities
     WHERE user_id IN (
       SELECT auth_user_id
       FROM public.firebase_migration_auth_user_map
       WHERE source_project = $1
     ) AND provider = 'email'`,
    [plan.source],
  );
  if (
    accounts.rows[0].count !== plan.accounts.length ||
    credentials.rows[0].count !== plan.credentialCount ||
    memberships.rows[0].count !== insertedMembershipCount ||
    identities.rows[0].count !== plan.accounts.length
  ) {
    throw new Error(`${plan.source} Auth import counts differ from the validated plan`);
  }
}

async function importPlan(client, plan) {
  await assertAuthSchema(client);
  await assertProfilesMatch(client, plan);
  const existing = await client.query(
    "SELECT count(*)::int AS count FROM public.firebase_migration_auth_user_map WHERE source_project = $1",
    [plan.source],
  );
  if (existing.rows[0].count) {
    throw new Error(`${plan.source} Auth users are already imported; refusing duplicate import`);
  }
  await assertNoExistingAccounts(client, plan);

  const authIdsByUid = new Map();
  for (const account of plan.accounts) {
    const profileFound = Boolean(account.profile);
    const authUserId = await insertAccount(client, account, profileFound);
    authIdsByUid.set(account.user.uid, authUserId);
  }

  for (const membership of plan.memberships) {
    const authUserId = authIdsByUid.get(membership.firebaseUid);
    if (!authUserId) {
      throw new Error("A school membership has no corresponding imported Auth account");
    }
    await client.query(
      `INSERT INTO public.firebase_migration_user_tenant_memberships (
         auth_user_id, source_project, school_id, role
       ) VALUES ($1, $2, $3, $4)`,
      [authUserId, plan.source, membership.schoolId, membership.role],
    );
  }

  await verifyCounts(client, plan, plan.memberships.length);
}

async function run(args) {
  const { source, apply } = parseArgs(args);
  const plans = validateExports();
  const plan = plans.find((item) => item.source === source);
  if (!plan) throw new Error(`Validated import plan for ${source} is missing`);

  if (!apply) {
    console.log(
      `${source}: dry-run validated ${plan.accounts.length} Auth users, ` +
        `${plan.credentialCount} Firebase password credentials, and ` +
        `${plan.memberships.length} school memberships; no database connection opened.`,
    );
    return;
  }

  const client = await connectDatabase();
  let transactionStarted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionStarted = true;
    await importPlan(client, plan);
    await client.query("COMMIT");
    transactionStarted = false;
    console.log(
      `${source}: imported ${plan.accounts.length} Auth users, ` +
        `${plan.credentialCount} legacy password credentials, and ` +
        `${plan.memberships.length} school memberships.`,
    );
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Auth import failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  accountTimestamps,
  assertAuthSchema,
  assertNoExistingAccounts,
  assertProfilesMatch,
  importPlan,
  insertAccount,
  parseArgs,
  providerMetadata,
  run,
  verifyCounts,
};
