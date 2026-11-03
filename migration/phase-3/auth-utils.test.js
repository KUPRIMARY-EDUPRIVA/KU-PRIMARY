const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertNoCrossSourceCollisions,
  buildImportPlan,
  normalizeEmail,
} = require("./auth-utils");
const {
  assertProfilesMatch,
  insertAccount,
  parseArgs,
  providerMetadata,
} = require("./import-auth");

function authUser(uid, email) {
  return {
    uid,
    email,
    emailVerified: true,
    disabled: false,
    metadata: {},
    providerData: [{ providerId: "password" }],
    passwordHash: "a".repeat(86) + "__",
    passwordSalt: "a".repeat(14) + "__",
  };
}

test("Auth plan normalizes emails and maps users to trusted school profiles", () => {
  const plan = buildImportPlan(
    "ku",
    [authUser("firebase-uid", " Teacher@School.example ")],
    [{
      firestore_id: "firebase-uid",
      uid: "firebase-uid",
      email: "teacher@school.example",
      schoolId: "school-1",
      role: "teacher",
    }],
  );
  assert.equal(plan.accounts[0].email, "teacher@school.example");
  assert.deepEqual(plan.memberships, [{
    firebaseUid: "firebase-uid",
    schoolId: "school-1",
    role: "teacher",
  }]);
  assert.equal(plan.credentialCount, 1);
});

test("Auth plan retains profileless accounts without granting school access", () => {
  const plan = buildImportPlan("kiwanja", [authUser("orphan", "orphan@example.test")], []);
  assert.equal(plan.profilelessCount, 1);
  assert.deepEqual(plan.memberships, []);
});

test("Auth plan rejects mismatched profile identity and invalid Firebase hashes", () => {
  assert.throws(
    () => buildImportPlan("ku", [authUser("one", "one@example.test")], [{
      firestore_id: "one",
      uid: "different",
      email: "one@example.test",
      schoolId: "school-1",
      role: "teacher",
    }]),
    /profile UID differs/,
  );
  const invalid = authUser("one", "one@example.test");
  invalid.passwordSalt = "not valid!";
  assert.throws(() => buildImportPlan("ku", [invalid], []), /invalid password salt/);
  const providerAccount = authUser("two", "two@example.test");
  providerAccount.providerData = [{ providerId: "google.com" }];
  assert.throws(
    () => buildImportPlan("ku", [providerAccount], []),
    /unsupported sign-in provider/,
  );
});

test("cross-source email collisions are rejected instead of merged", () => {
  const first = buildImportPlan("ku", [authUser("one", "same@example.test")], []);
  const second = buildImportPlan("kiwanja", [authUser("two", "SAME@example.test")], []);
  assert.throws(() => assertNoCrossSourceCollisions([first, second]), /email collision/);
  assert.equal(normalizeEmail(null), "");
});

test("Auth import requires an explicit source and mode", () => {
  assert.deepEqual(parseArgs(["--source", "ku", "--dry-run"]), {
    source: "ku",
    apply: false,
  });
  assert.deepEqual(parseArgs(["--source", "kiwanja", "--apply"]), {
    source: "kiwanja",
    apply: true,
  });
  assert.throws(() => parseArgs(["--source", "ku"]), /Usage/);
  assert.throws(() => parseArgs(["--source", "other", "--apply"]), /Usage/);
});

test("Firebase auth provider identifiers are translated to Supabase providers", () => {
  assert.deepEqual(providerMetadata([
    { providerId: "password" },
    { providerId: "google.com" },
    { providerId: "google.com" },
  ]), {
    provider: "email",
    providers: ["email", "google"],
  });
});

test("Auth identity insert omits Supabase's generated email column", async () => {
  const statements = [];
  const account = {
    source: "ku",
    email: "teacher@example.test",
    user: authUser("firebase-uid", "teacher@example.test"),
  };
  await insertAccount({
    query: async (sql, params) => {
      statements.push({ sql, params });
      return { rowCount: 1 };
    },
  }, account, true);
  const identity = statements.find(({ sql }) => sql.includes("INSERT INTO auth.identities"));
  assert.ok(identity);
  assert.match(identity.sql, /created_at,\s*updated_at\s*\)\s*VALUES/);
  assert.doesNotMatch(identity.sql, /updated_at,\s*email/);
  const identityData = JSON.parse(identity.params[2]);
  assert.match(identityData.sub, /^[0-9a-f-]{36}$/);
  assert.equal(identityData.email, "teacher@example.test");
  assert.equal(identityData.email_verified, true);
  assert.equal(identityData.phone_verified, false);
});

test("Auth import compares trusted membership fields with imported Firestore profiles", async () => {
  const plan = buildImportPlan("ku", [authUser("one", "one@example.test")], [{
    firestore_id: "one",
    uid: "one",
    email: "one@example.test",
    schoolId: "school-1",
    role: "teacher",
  }]);
  const matchingClient = {
    query: async () => ({
      rowCount: 1,
      rows: [{
        firestore_id: "one",
        document: {
          uid: "one",
          email: "ONE@example.test",
          schoolId: "school-1",
          role: "teacher",
        },
      }],
    }),
  };
  await assertProfilesMatch(matchingClient, plan);
  const conflictingClient = {
    query: async () => ({
      rowCount: 1,
      rows: [{
        firestore_id: "one",
        document: {
          uid: "one",
          email: "one@example.test",
          schoolId: "other-school",
          role: "teacher",
        },
      }],
    }),
  };
  await assert.rejects(
    () => assertProfilesMatch(conflictingClient, plan),
    /profile differs/,
  );
});
