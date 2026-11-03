const assert = require("node:assert/strict");
const test = require("node:test");
const { _test, handler } = require("./migrate-firebase-password");

const validEnv = {
  AUTH_MIGRATION_SOURCE: "ku",
  SUPABASE_URL: "https://example.supabase.co/",
  SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
  AUTH_MIGRATION_RATE_LIMIT_SECRET: "y".repeat(32),
  FIREBASE_SCRYPT_SIGNER_KEY: "a".repeat(44),
  FIREBASE_SCRYPT_SALT_SEPARATOR: "Bw==",
  FIREBASE_SCRYPT_ROUNDS: "8",
  FIREBASE_SCRYPT_MEM_COST: "14",
};

test("legacy password request validates inputs without trimming passwords", () => {
  assert.equal(_test.validBody({ source: "ku", email: " user@example.test ", password: " pass " }), true);
  assert.equal(_test.validBody({ source: "other", email: "user@example.test", password: "pass" }), false);
  assert.equal(_test.validBody({ source: "ku", email: " ", password: "pass" }), false);
  assert.equal(_test.validBody({ source: "ku", email: "user@example.test", password: "" }), false);
  assert.equal(_test.validBody({ source: "ku", email: "user@example.test", password: "x".repeat(1025) }), false);
  assert.equal(_test.validBody([]), false);
});

test("server configuration is source-scoped and normalizes the Supabase URL", () => {
  assert.equal(_test.sourceConfig(validEnv).source, "ku");
  assert.equal(_test.sourceConfig(validEnv).supabaseUrl, "https://example.supabase.co");
  assert.throws(
    () => _test.sourceConfig({ ...validEnv, AUTH_MIGRATION_SOURCE: "other" }),
    /configuration/,
  );
  assert.throws(
    () => _test.sourceConfig({ ...validEnv, AUTH_MIGRATION_RATE_LIMIT_SECRET: "short" }),
    /configuration/,
  );
  assert.throws(
    () => _test.sourceConfig({ ...validEnv, FIREBASE_SCRYPT_SIGNER_KEY: "not-base64!" }),
    /configuration/,
  );
});

test("legacy password requests cannot select a different source than the deployment", () => {
  assert.equal(_test.sourceMatches("ku", "ku"), true);
  assert.equal(_test.sourceMatches("kiwanja", "ku"), false);
});

test("Supabase requests carry the service key in both required headers", () => {
  assert.deepEqual(_test.apiHeaders("service-key"), {
    apikey: "service-key",
    Authorization: "Bearer service-key",
    "Content-Type": "application/json",
  });
});

test("rate buckets are opaque and separated by source and purpose", () => {
  const first = _test.rateBucket("s".repeat(32), "email", "ku", "user@example.test");
  assert.equal(first.length, 64);
  assert.ok(!first.includes("user@example.test"));
  assert.notEqual(first, _test.rateBucket("s".repeat(32), "email", "kiwanja", "user@example.test"));
  assert.notEqual(first, _test.rateBucket("s".repeat(32), "ip", "ku", "user@example.test"));
});

test("mapping completion is scoped to the source Firebase UID", async () => {
  const originalFetch = global.fetch;
  let requestUrl = "";
  global.fetch = async (url) => {
    requestUrl = String(url);
    return {
      ok: true,
      text: async () => JSON.stringify([{
        auth_user_id: "auth-uuid",
        password_migrated_at: "2025-01-01T00:00:00.000Z",
      }]),
    };
  };
  try {
    await _test.markPasswordMigrated(
      { source: "ku", supabaseUrl: "https://example.supabase.co", serviceRoleKey: "key" },
      { auth_user_id: "auth-uuid", firebase_uid: "firebase-uid" },
    );
    const query = new URL(requestUrl).searchParams;
    assert.equal(query.get("source_project"), "eq.ku");
    assert.equal(query.get("firebase_uid"), "eq.firebase-uid");
    assert.equal(query.get("auth_user_id"), "eq.auth-uuid");
  } finally {
    global.fetch = originalFetch;
  }
});

test("legacy password migration refuses to change a password shared across sources", async () => {
  const originalFetch = global.fetch;
  let requestUrl = "";
  global.fetch = async (url) => {
    requestUrl = String(url);
    return { ok: true, text: async () => JSON.stringify([{ source_project: "kiwanja" }]) };
  };
  try {
    assert.equal(
      await _test.hasOtherSourceMapping(
        { source: "ku", supabaseUrl: "https://example.supabase.co", serviceRoleKey: "key" },
        { auth_user_id: "auth-uuid" },
      ),
      true,
    );
    const query = new URL(requestUrl).searchParams;
    assert.equal(query.get("auth_user_id"), "eq.auth-uuid");
    assert.equal(query.get("source_project"), "neq.ku");
  } finally {
    global.fetch = originalFetch;
  }
});

test("handler rejects methods and malformed requests before external calls", async () => {
  const method = await handler({ httpMethod: "GET", headers: {} });
  assert.equal(method.statusCode, 405);
  const malformed = await handler({
    httpMethod: "POST",
    headers: {},
    body: "{",
  });
  assert.equal(malformed.statusCode, 400);
  const missingSource = await handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({ email: "user@example.test", password: "password" }),
  });
  assert.equal(missingSource.statusCode, 400);
});

test("legacy verifier accepts the firebase-scrypt test vector and rejects a wrong password", async () => {
  const config = {
    scrypt: {
      memCost: 1,
      rounds: 1,
      saltSeparator: "separator",
      signerKey: "superlongkey",
    },
  };
  assert.equal(await _test.verifyLegacyPassword(config, "test", "salt", "PrZI5nfqjOEk"), true);
  assert.equal(await _test.verifyLegacyPassword(config, "wrong", "salt", "PrZI5nfqjOEk"), false);
});
