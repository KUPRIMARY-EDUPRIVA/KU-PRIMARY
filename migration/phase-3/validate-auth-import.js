const { isDeepStrictEqual } = require("node:util");
const { connectDatabase } = require("../phase-2/db");
const { providerMetadata } = require("./import-auth");
const { validateExports } = require("./validate-auth-exports");

function parseArgs(args) {
  if (
    args.length !== 3 ||
    args[0] !== "--source" ||
    !["ku", "kiwanja"].includes(args[1]) ||
    args[2] !== "--database"
  ) {
    throw new Error("Usage: node validate-auth-import.js --source ku|kiwanja --database");
  }
  return args[1];
}

async function validateSource(client, plan) {
  const mapped = await client.query(
    `SELECT mapping.firebase_uid,
            mapping.auth_user_id,
            mapping.email,
            mapping.profile_found,
            mapping.disabled,
            mapping.provider_data,
            mapping.password_migrated_at,
            auth_user.email AS auth_email,
            auth_user.raw_app_meta_data,
            auth_user.raw_user_meta_data
     FROM public.firebase_migration_auth_user_map AS mapping
     JOIN auth.users AS auth_user ON auth_user.id = mapping.auth_user_id
     WHERE mapping.source_project = $1`,
    [plan.source],
  );
  if (mapped.rowCount !== plan.accounts.length) {
    throw new Error(`${plan.source} Auth account count differs from the export`);
  }

  const expectedByUid = new Map(
    plan.accounts.map((account) => [account.user.uid, account]),
  );
  const authIdsByUid = new Map();
  const firebaseUidByAuthId = new Map();
  for (const row of mapped.rows) {
    const expected = expectedByUid.get(row.firebase_uid);
    if (
      !expected ||
      row.email !== expected.email ||
      row.auth_email !== expected.email ||
      row.profile_found !== Boolean(expected.profile) ||
      row.disabled !== Boolean(expected.user.disabled) ||
      !isDeepStrictEqual(row.provider_data, expected.user.providerData) ||
      !isDeepStrictEqual(row.raw_app_meta_data, {
        ...providerMetadata(expected.user.providerData),
        firebaseCustomClaims: expected.user.customClaims || {},
      }) ||
      !isDeepStrictEqual(row.raw_user_meta_data, {
        displayName: expected.user.displayName,
        photoURL: expected.user.photoURL,
        phoneNumber: expected.user.phoneNumber,
        emailVerified: Boolean(expected.user.emailVerified),
      })
    ) {
      throw new Error(`${plan.source} Auth identity mapping differs from the export`);
    }
    authIdsByUid.set(row.firebase_uid, row.auth_user_id);
    firebaseUidByAuthId.set(row.auth_user_id, row.firebase_uid);
  }

  const credentials = await client.query(
    `SELECT firebase_uid, password_hash, password_salt
     FROM public.firebase_migration_auth_credentials
     WHERE source_project = $1`,
    [plan.source],
  );
  const identities = await client.query(
    `SELECT identity.user_id, identity.provider_id, identity.email,
            identity.provider, identity.identity_data
     FROM auth.identities AS identity
     WHERE identity.user_id = ANY($1::uuid[])`,
    [mapped.rows.map((row) => row.auth_user_id)],
  );
  const identitiesByUser = new Map(
    identities.rows.map((identity) => [identity.user_id, identity]),
  );
  if (identities.rowCount !== plan.accounts.length) {
    throw new Error(`${plan.source} email identity count differs from the export`);
  }
  for (const row of mapped.rows) {
    const identity = identitiesByUser.get(row.auth_user_id);
    if (
      !identity ||
      identity.provider !== "email" ||
      identity.provider_id !== row.email ||
      identity.email !== row.email ||
      !isDeepStrictEqual(identity.identity_data, {
        sub: row.auth_user_id,
        email: row.email,
        email_verified: Boolean(expectedByUid.get(row.firebase_uid).user.emailVerified),
        phone_verified: false,
      })
    ) {
      throw new Error(`${plan.source} email identity differs from the export`);
    }
  }
  const credentialsByUid = new Map(
    credentials.rows.map((row) => [row.firebase_uid, row]),
  );
  const migratedCount = mapped.rows.filter(
    (row) => row.password_migrated_at !== null,
  ).length;
  for (const account of plan.accounts) {
    const { user } = account;
    const credential = credentialsByUid.get(user.uid);
    if (user.passwordHash && user.passwordSalt) {
      if (credential) {
        if (
          credential.password_hash !== user.passwordHash ||
          credential.password_salt !== user.passwordSalt
        ) {
          throw new Error(`${plan.source} legacy password credential differs from the export`);
        }
      } else {
        const row = mapped.rows.find((candidate) => candidate.firebase_uid === user.uid);
        if (!row?.password_migrated_at) {
          throw new Error(`${plan.source} legacy credential is missing before first-login migration`);
        }
      }
    } else if (credential) {
      throw new Error(`${plan.source} has an unexpected legacy password credential`);
    }
  }

  const memberships = await client.query(
    `SELECT auth_user_id, school_id, role
     FROM public.firebase_migration_user_tenant_memberships
     WHERE source_project = $1`,
    [plan.source],
  );
  const expectedMemberships = new Map(
    plan.memberships.map((membership) => [membership.firebaseUid, membership]),
  );
  if (memberships.rowCount !== expectedMemberships.size) {
    throw new Error(`${plan.source} school membership count differs from the export`);
  }
  for (const row of memberships.rows) {
    const firebaseUid = firebaseUidByAuthId.get(row.auth_user_id);
    const expected = firebaseUid ? expectedMemberships.get(firebaseUid) : null;
    if (!expected || row.school_id !== expected.schoolId || row.role !== expected.role) {
      throw new Error(`${plan.source} school membership differs from the profile export`);
    }
  }

  return {
    accounts: mapped.rowCount,
    retainedLegacyCredentials: credentials.rowCount,
    passwordMigrated: migratedCount,
    memberships: memberships.rowCount,
  };
}

async function run(args) {
  const source = parseArgs(args);
  const plans = validateExports();
  const plan = plans.find((item) => item.source === source);
  const client = await connectDatabase();
  try {
    const summary = await validateSource(client, plan);
    console.log(
      `${source}: Auth parity passed (${summary.accounts} accounts, ` +
        `${summary.retainedLegacyCredentials} retained legacy credentials, ` +
        `${summary.passwordMigrated} first-login migrations, ` +
        `${summary.memberships} school memberships).`,
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Auth import validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run, validateSource };
