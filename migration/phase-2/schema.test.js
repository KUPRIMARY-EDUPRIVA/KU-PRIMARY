"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  CHILD_PARENTS,
  PARENT_TABLES,
  SCHOOL_ADMIN_CRUD,
  SCHOOL_MEMBER_CRUD,
} = require("./schema-spec");
const { allTables, generateSql } = require("./generate-schema");
const { rowValues } = require("./load-source");
const { parseArgs } = require("./import");
const { expectedPolicyTables, parseArgs: parseSchemaValidationArgs } = require("./validate-schema");

test("schema contains all reviewed parent and child tables exactly once", () => {
  assert.equal(PARENT_TABLES.length, 21);
  assert.equal(Object.keys(CHILD_PARENTS).length, 42);
  assert.equal(allTables.length, 63);
  assert.equal(new Set(allTables).size, 63);
});

test("committed SQL artifacts are reproducible from the schema specification", () => {
  const generated = generateSql();
  assert.equal(
    fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"),
    generated.schemaSql,
  );
  assert.equal(
    fs.readFileSync(path.join(__dirname, "rollback-access.sql"), "utf8"),
    generated.rollbackAccess,
  );
});

test("child tables are ordered after their parent relations", () => {
  for (const [child, parent] of Object.entries(CHILD_PARENTS)) {
    assert.ok(allTables.indexOf(parent) < allTables.indexOf(child), `${child} -> ${parent}`);
  }
});

test("schema is additive, enables RLS, and grants only the approved collections", () => {
  const { schemaSql: sql, rollbackAccess } = generateSql();
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /DISABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(rollbackAccess, /\b(DROP|TRUNCATE)\b/i);
  for (const table of allTables) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  for (const table of [...SCHOOL_MEMBER_CRUD, ...SCHOOL_ADMIN_CRUD]) {
    assert.match(sql, new RegExp(`CREATE POLICY ${table}_tenant_`));
    assert.match(sql, new RegExp(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\\.${table}`));
  }
  assert.match(sql, /membership\.role = 'admin'/);
  assert.match(sql, /membership\.source_project = /);
  assert.match(sql, /membership\.school_id = /);
  assert.match(sql, /ON UPDATE RESTRICT ON DELETE RESTRICT/);
  assert.match(sql, /_tenant_parent_fk/);
  assert.match(sql, /student_scores_student_fk/);
  assert.equal(
    (sql.match(/CREATE POLICY [^\s]+_tenant_(?:member|admin) ON public\./g) || [])
      .length,
    22,
  );
  assert.doesNotMatch(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.students TO authenticated/);
});

test("parent and child rows map to lossless database payloads", () => {
  const parent = rowValues("students", {
    firestore_id: "student-1",
    source_project: "ku",
    schoolId: "school-1",
    firstName: "Ada",
    history: [{ year: 2024 }],
  }, "ku");
  assert.equal(parent.school_id, "school-1");
  assert.deepEqual(parent.document, {
    schoolId: "school-1",
    firstName: "Ada",
    history: [{ year: 2024 }],
  });

  const child = rowValues("attendance_entries", {
    firestore_id: "attendance_entries|a|0",
    source_project: "kiwanja",
    schoolId: "school-2",
    parent_firestore_id: "attendance-a",
    ordinal: 0,
    studentId: "student-2",
    status: "present",
  }, "kiwanja");
  assert.deepEqual(child, {
    source_project: "kiwanja",
    firestore_id: "attendance_entries|a|0",
    school_id: "school-2",
    student_firestore_id: "student-2",
    parent_firestore_id: "attendance-a",
    ordinal: 0,
    payload: { studentId: "student-2", status: "present" },
  });
});

test("import requires an explicit source and mode", () => {
  assert.deepEqual(parseArgs(["--source", "ku", "--dry-run"]), {
    source: "ku",
    apply: false,
  });

  test("schema validation expects policies only on the approved table groups", () => {
    assert.equal(expectedPolicyTables().size, 22);
    assert.ok(expectedPolicyTables().has("user_roles_nested_values"));
    assert.ok(!expectedPolicyTables().has("students"));
    assert.throws(() => parseSchemaValidationArgs([]), /--database/);
  });
  assert.deepEqual(parseArgs(["--source", "kiwanja", "--apply"]), {
    source: "kiwanja",
    apply: true,
  });
  assert.throws(() => parseArgs(["--source", "ku"]), /exactly one/);
  assert.throws(
    () => parseArgs(["--source", "ku", "--apply", "--dry-run"]),
    /exactly one/,
  );
});
