"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateSql } = require("./apply-transfer-contract-correction");

const sql = fs.readFileSync(path.join(__dirname, "transfer-contract-correction.sql"), "utf8");

test("transfer correction is additive and transaction bounded", () => {
  assert.doesNotThrow(() => validateSql(sql));
  assert.match(sql, /\bBEGIN;/);
  assert.match(sql.trimEnd(), /COMMIT;$/);
  assert.doesNotMatch(sql, /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b/i);
});

test("correction aborts if the relation is missing, already corrected, or populated", () => {
  assert.match(sql, /to_regclass\('public\.firebase_migration_student_transfers'\) IS NULL/);
  assert.match(sql, /key = 'phase4_transfer_contract_version'/);
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM public\.firebase_migration_student_transfers\)/);
});

test("transfer request identity and student verification fields are optional and explicit", () => {
  assert.match(sql, /ALTER COLUMN school_id DROP NOT NULL/);
  assert.match(sql, /ALTER COLUMN student_id DROP NOT NULL/);
  for (const column of [
    "requested_student_name",
    "verified_student_id",
    "verified_student_name",
    "initiated_by",
    "released_at",
    "released_by",
    "admitted_at",
    "new_student_id",
    "declined_at",
    "decline_reason",
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN ${column} `));
  }
});
