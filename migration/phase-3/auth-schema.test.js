const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sql = fs.readFileSync(path.join(__dirname, "auth-schema.sql"), "utf8");

test("Phase 3 Auth schema is additive and transaction-bounded", () => {
  assert.match(sql, /\bBEGIN;/);
  assert.match(sql.trimEnd(), /COMMIT;$/);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /DISABLE ROW LEVEL SECURITY/i);
});

test("Auth identity and credential tables are RLS protected and server only", () => {
  for (const table of [
    "firebase_migration_auth_user_map",
    "firebase_migration_auth_credentials",
    "firebase_migration_auth_rate_limits",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`));
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table}[\\s\\S]*?FROM PUBLIC, anon, authenticated`));
  }
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.firebase_migration_auth_user_map\s+TO service_role/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.firebase_migration_auth_credentials\s+TO service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.firebase_migration_check_auth_rate_limit[\s\S]*?TO service_role/);
});

test("Auth email mapping is unique and the rate-limit function is input guarded", () => {
  assert.match(sql, /UNIQUE INDEX firebase_migration_auth_email_unique[\s\S]*?lower\(email\)/);
  assert.match(sql, /CREATE UNIQUE INDEX firebase_migration_auth_user_id_unique/);
  assert.match(sql, /p_limit < 1 OR p_limit > 1000/);
  assert.match(sql, /p_window_seconds < 1 OR p_window_seconds > 86400/);
});
