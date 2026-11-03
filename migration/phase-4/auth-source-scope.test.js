"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateSchema } = require("./apply-auth-source-scope");

const sql = fs.readFileSync(path.join(__dirname, "auth-source-scope.sql"), "utf8");

test("Auth source-scope schema preserves tables and is transaction bounded", () => {
  assert.doesNotThrow(() => validateSchema(sql));
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
  assert.match(sql, /\bBEGIN;/);
  assert.match(sql.trimEnd(), /COMMIT;$/);
});

test("Auth mappings remain unique within each source and may share Auth identity across sources", () => {
  assert.match(
    sql,
    /CREATE UNIQUE INDEX firebase_migration_auth_source_user_id_unique\s+ON public\.firebase_migration_auth_user_map \(source_project, auth_user_id\)/,
  );
  assert.match(
    sql,
    /CREATE UNIQUE INDEX firebase_migration_auth_source_email_unique\s+ON public\.firebase_migration_auth_user_map \(source_project, lower\(email\)\)/,
  );
  assert.match(sql, /DROP INDEX public\.firebase_migration_auth_user_id_unique/);
  assert.match(sql, /DROP INDEX public\.firebase_migration_auth_email_unique/);
});

test("source-scoped platform admin memberships enable RLS and deny client writes", () => {
  assert.match(sql, /CREATE TABLE public\.firebase_migration_platform_admin_memberships/);
  assert.match(
    sql,
    /ALTER TABLE public\.firebase_migration_platform_admin_memberships\s+ENABLE ROW LEVEL SECURITY/,
  );
  assert.match(
    sql,
    /CREATE POLICY select_self[\s\S]*?auth_user_id = \(SELECT auth\.uid\(\)\)/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON TABLE public\.firebase_migration_platform_admin_memberships\s+FROM PUBLIC, anon, authenticated/,
  );
  assert.match(
    sql,
    /GRANT SELECT ON TABLE public\.firebase_migration_platform_admin_memberships\s+TO authenticated/,
  );
  assert.doesNotMatch(sql, /INSERT INTO public\.firebase_migration_platform_admin_memberships/i);
});

test("schema rejects unexpected index drops", () => {
  assert.throws(
    () => validateSchema(sql.replace("DROP INDEX public.firebase_migration_auth_email_unique;", "DROP INDEX public.unexpected;")),
    /safety checks/,
  );
});
