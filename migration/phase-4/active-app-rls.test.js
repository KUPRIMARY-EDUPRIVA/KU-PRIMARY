"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateSql } = require("./apply-active-app-rls");

const sql = fs.readFileSync(path.join(__dirname, "active-app-rls.sql"), "utf8");

test("RLS/grant script is transactional and creates exactly its declared policy set", () => {
  assert.doesNotThrow(() => validateSql(sql));
  assert.match(sql, /\bBEGIN;/);
  assert.match(sql.trimEnd(), /COMMIT;$/);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE\s+FROM|DISABLE ROW LEVEL SECURITY)\b/i);
});

test("all policies and table grants are scoped to declared authenticated relations", () => {
  const tableBlock = sql.match(/required_tables text\[\] := ARRAY\[([\s\S]*?)\n  \];/i)?.[1] || "";
  const policyBlock = sql.match(/planned_policies text\[\] := ARRAY\[([\s\S]*?)\n  \];/i)?.[1] || "";
  const tableNames = [...tableBlock.matchAll(/'([a-z0-9_]+)'/gi)].map((match) => match[1]);
  const policyNames = [...policyBlock.matchAll(/'([a-z0-9_]+)'/gi)].map((match) => match[1]);
  const actualTables = [...sql.matchAll(/CREATE POLICY [a-z0-9_]+ ON public\.([a-z0-9_]+)/gi)]
    .map((match) => match[1]);
  const actualPolicies = [...sql.matchAll(/CREATE POLICY ([a-z0-9_]+) ON public\./gi)]
    .map((match) => match[1]);
  assert.equal(new Set(tableNames).size, 27);
  assert.deepEqual(new Set(actualTables), new Set(tableNames));
  assert.deepEqual(new Set(actualPolicies), new Set(policyNames));
  assert.doesNotMatch(sql, /\bGRANT\b[^;]*\bTO\s+(?:PUBLIC|anon|service_role)\b/i);
});

test("policy helper is invoker-only and isolated from exposed public API schema", () => {
  assert.match(sql, /CREATE SCHEMA firebase_migration_private/);
  assert.match(sql, /CREATE FUNCTION firebase_migration_private\.has_school_access/);
  assert.match(sql, /SECURITY INVOKER/);
  assert.doesNotMatch(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = ''/);
  assert.match(sql, /REVOKE ALL ON SCHEMA firebase_migration_private FROM PUBLIC, anon/);
});

test("invoice constraints and all active relations preserve immutable identity keys", () => {
  assert.match(sql, /CHECK \(total >= 0\)/);
  assert.match(sql, /status IN \('pending', 'partial', 'paid', 'overdue', 'cancelled'\)/);
  assert.match(sql, /CREATE FUNCTION firebase_migration_private\.prevent_identity_change\(\)/);
  assert.match(sql, /to_jsonb\(NEW\) -> key_column/);
  assert.match(sql, /'source_project', 'firestore_id', 'school_id', 'student_id'/);
  assert.equal(
    [...sql.matchAll(/CREATE TRIGGER firebase_migration_phase4_identity_guard_[a-z0-9_]+\s+BEFORE UPDATE ON public\./gi)].length,
    27,
  );
});

test("unresolved or default-denied collections receive no policies", () => {
  for (const denied of [
    "firebase_migration_dorm_maintenance",
    "firebase_migration_student_transfers",
    "firebase_migration_notifications",
    "firebase_migration_school_inventory",
    "firebase_migration_sms_gateway",
    "firebase_migration_discipline_records",
    "firebase_migration_transport_payments",
  ]) {
    assert.doesNotMatch(sql, new RegExp(`CREATE POLICY [a-z0-9_]+ ON public\\.${denied}`));
  }
});

test("safety validator rejects broad privilege or definer-function changes", () => {
  assert.throws(
    () => validateSql(sql.replace("GRANT SELECT ON TABLE public.firebase_migration_sms_templates TO authenticated;", "GRANT SELECT ON TABLE public.firebase_migration_sms_templates TO anon;")),
    /safety checks/,
  );
  assert.throws(
    () => validateSql(sql.replace("SECURITY INVOKER", "SECURITY DEFINER")),
    /safety checks/,
  );
});
