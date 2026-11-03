"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateSchema } = require("./apply-active-app-schema");

const sql = fs.readFileSync(path.join(__dirname, "active-app-schema.sql"), "utf8");
const tables = [...sql.matchAll(/CREATE TABLE public\.([a-z0-9_]+)\s*\(/gi)]
  .map((match) => match[1]);

test("active app schema is additive, transaction bounded, and denies all roles", () => {
  assert.doesNotThrow(() => validateSchema(sql));
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE\s+FROM|GRANT|CREATE\s+POLICY)\b/i);
  assert.match(sql, /\bBEGIN;/);
  assert.match(sql.trimEnd(), /COMMIT;$/);
});

test("every new active-flow relation has RLS enabled and no client access", () => {
  const rlsTables = [...sql.matchAll(/ALTER TABLE public\.([a-z0-9_]+) ENABLE ROW LEVEL SECURITY;/gi)]
    .map((match) => match[1]);
  const revokeBlock = sql.match(
    /REVOKE ALL ON TABLE([\s\S]*?)FROM PUBLIC, anon, authenticated, service_role;/i,
  )?.[1] || "";
  assert.equal(tables.length, 38);
  assert.deepEqual(new Set(rlsTables), new Set(tables));
  assert.ok(tables.every((table) => revokeBlock.includes(`public.${table}`)));
});

test("observed nested arrays use source-scoped child foreign keys", () => {
  for (const child of [
    "firebase_migration_invoice_items",
    "firebase_migration_sms_history_outcomes",
    "firebase_migration_student_transfer_schools",
    "firebase_migration_student_transfer_history",
    "firebase_migration_route_days",
    "firebase_migration_duty_roster_entries",
    "firebase_migration_timetable_event_days",
    "firebase_migration_timetable_event_periods",
    "firebase_migration_timetable_event_classes",
  ]) {
    const body = sql.split(`CREATE TABLE public.${child} (`)[1]?.split("\n);")[0];
    assert.ok(body, `${child} must exist`);
    assert.match(body, /PRIMARY KEY \(source_project,/);
    assert.match(body, /FOREIGN KEY \(source_project,/);
    assert.match(body, /REFERENCES public\.firebase_migration_/);
  }
});

test("invoice student references preserve original document IDs without unreviewed delete constraints", () => {
  const invoiceTable = sql.split("CREATE TABLE public.firebase_migration_invoices (")[1]
    ?.split("\n);")[0];
  assert.ok(invoiceTable);
  assert.match(invoiceTable, /student_id text NOT NULL/);
  assert.doesNotMatch(invoiceTable, /FOREIGN KEY/);
  assert.doesNotMatch(sql, /studentIds|invoice_payments/i);
});

test("safety validator rejects policies, grants, drops, and missing RLS", () => {
  assert.throws(() => validateSchema(sql.replace("COMMIT;", "GRANT SELECT ON public.firebase_migration_invoices TO authenticated;\nCOMMIT;")), /safety checks/);
  assert.throws(() => validateSchema(sql.replace("COMMIT;", "DROP TABLE public.firebase_migration_invoices;\nCOMMIT;")), /safety checks/);
  assert.throws(() => validateSchema(sql.replace("ALTER TABLE public.firebase_migration_invoices ENABLE ROW LEVEL SECURITY;\n", "")), /safety checks/);
});
