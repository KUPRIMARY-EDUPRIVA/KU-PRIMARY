"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateSql } = require("./apply-shared-tenant-schema");

const sql = fs.readFileSync(path.join(__dirname, "shared-tenant-schema.sql"), "utf8");

test("shared tenant migration is transactional and fails closed on schema drift", () => {
  assert.doesNotThrow(() => validateSql(sql));
  assert.match(sql, /source_check_count <> 104/);
  assert.match(sql, /source_columns_without_check <> 1/);
  assert.match(sql, /Membership primary key has inbound foreign-key dependencies/);
});

test("adds platform provenance and multi-school memberships without changing rows", () => {
  assert.match(sql, /CHECK \(source_project IN \('ku', 'kiwanja', 'platform'\)\)/);
  assert.match(sql, /PRIMARY KEY \(auth_user_id, source_project, school_id\)/);
  assert.match(sql, /SELECT count\(\*\) FROM public\.firebase_migration_user_tenant_memberships\)[\s\S]*<> membership_count/);
  assert.match(sql, /SELECT count\(\*\) FROM public\.firebase_migration_schools\) <> school_count/);
  assert.match(sql, /CREATE UNIQUE INDEX firebase_migration_schools_school_id_unique/);
  assert.doesNotMatch(sql, /\b(DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});

test("safety validator rejects data mutation or missing source preflights", () => {
  assert.throws(() => validateSql(sql.replace("COMMIT;", "DELETE FROM public.firebase_migration_schools;\nCOMMIT;")), /safety checks/);
  assert.throws(() => validateSql(sql.replace("source_check_count <> 104", "source_check_count <> 100")), /safety checks/);
});
