"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const DUMP_ROOT = path.resolve(__dirname, "../../.migration/dumps");
const HOOK_ROOT = path.join(__dirname, "hooks");
const BUILD_ROOT = path.join(DUMP_ROOT, "processed-build");
const FINAL_ROOT = path.join(DUMP_ROOT, "processed");
const SOURCES = ["ku", "kiwanja"];

const CHILD_PARENTS = {
  attendance_counts: "attendance",
  attendance_entries: "attendance",
  fee_structure_items: "fee_structures",
  paper_config_items: "paper_configs",
  school_class_teachers: "schools",
  school_custom_classes: "schools",
  school_subject_options: "schools",
  school_timetable_slots: "school_timetables",
  sms_job_students: "sms_jobs",
  student_history_entries: "students",
  student_score_papers: "student_scores",
  subject_paper_config_items: "subject_paper_configs",
  teacher_assignment_classes: "teacher_assignments",
  teacher_assignments: "teachers",
  teacher_scopes: "teachers",
  timetable_setting_periods: "timetable_settings",
  user_assignment_classes: "user_assignments",
  user_assignments: "users",
  user_role_assignment_classes: "user_role_assignments",
  user_role_assignments: "user_roles",
  user_role_scopes: "user_roles",
  user_scopes: "users",
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function safeTableName(name) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unexpected table name: ${name}`);
  }
}

function validateSourceRows(source, rowsByTable) {
  const collectionNames = new Set(
    JSON.parse(
      fs.readFileSync(path.join(DUMP_ROOT, source, "manifest.json"), "utf8"),
    ).collections.map((item) => item.name),
  );
  for (const [table, rows] of rowsByTable) {
    safeTableName(table);
    const ids = new Set();
    for (const row of rows) {
      if (row.source_project !== source) {
        throw new Error(`${source}/${table} has an incorrect source_project`);
      }
      if (typeof row.firestore_id !== "string" || !row.firestore_id) {
        throw new Error(`${source}/${table} has a missing firestore_id`);
      }
      if (ids.has(row.firestore_id)) {
        throw new Error(`${source}/${table} has duplicate firestore_id values`);
      }
      ids.add(row.firestore_id);
    }
  }

  for (const [table, rows] of rowsByTable) {
    if (!table.endsWith("_nested_values") && !CHILD_PARENTS[table]) continue;
    const parentTable = table.endsWith("_nested_values")
      ? table.slice(0, -"_nested_values".length)
      : CHILD_PARENTS[table];
    const parents = rowsByTable.get(parentTable);
    if (!parents) throw new Error(`${source}/${table} is missing parent table ${parentTable}`);
    const parentsById = new Map(parents.map((row) => [row.firestore_id, row]));
    for (const row of rows) {
      const parent = parentsById.get(row.parent_firestore_id);
      if (!parent) {
        throw new Error(`${source}/${table} has an unresolved parent foreign key`);
      }
      if ((row.schoolId ?? null) !== (parent.schoolId ?? null)) {
        throw new Error(`${source}/${table} has a tenant mismatch with its parent`);
      }
    }
  }

  const students = rowsByTable.get("students");
  if (!students) throw new Error(`${source} is missing the students parent collection`);
  const studentIds = new Set(students.map((row) => row.firestore_id));
  for (const [table, rows] of rowsByTable) {
    if (collectionNames.has(table) && table === "students") continue;
    for (const row of rows) {
      const refs = [];
      if (typeof row.studentId === "string") refs.push(row.studentId);
      if (Array.isArray(row.studentIds)) refs.push(...row.studentIds.map(String));
      for (const studentId of refs) {
        if (!studentIds.has(studentId)) {
          throw new Error(`${source}/${table} has an unresolved student foreign key`);
        }
      }
    }
  }
}

function transformSource(source) {
  const sourceRoot = path.join(DUMP_ROOT, source);
  const sourceManifest = readJson(path.join(sourceRoot, "manifest.json"));
  const collectionNames = new Set(sourceManifest.collections.map((item) => item.name));
  const rowsByTable = new Map();
  const recordCounters = {};

  function writeRecord(table, row, counters) {
    safeTableName(table);
    if (collectionNames.has(table)) {
      throw new Error(`Child table name conflicts with live collection ${source}/${table}`);
    }
    if (!rowsByTable.has(table)) rowsByTable.set(table, []);
    rowsByTable.get(table).push(row);
    counters[table] = (counters[table] || 0) + 1;
  }

  for (const collection of sourceManifest.collections) {
    const hookFile = path.join(HOOK_ROOT, `${collection.name}_processDocument.js`);
    if (!fs.existsSync(hookFile)) {
      throw new Error(`Missing hook for live collection ${source}/${collection.name}`);
    }
    safeTableName(collection.name);
    const hook = require(hookFile);
    const records = readJson(path.join(sourceRoot, `${collection.name}.json`));
    if (!Array.isArray(records) || records.length !== collection.records) {
      throw new Error(`${source}/${collection.name} does not match its export manifest`);
    }
    const processed = [];

    for (const original of records) {
      const doc = JSON.parse(JSON.stringify(original));
      const originalId = doc.firestore_id;
      process.env.MIGRATION_SOURCE = source;
      const result = hook(collection.name, doc, recordCounters, writeRecord);
      if (!result || result.firestore_id !== originalId) {
        throw new Error(`${source}/${collection.name} changed or lost the original document ID`);
      }
      if (result.source_project !== source) {
        throw new Error(`${source}/${collection.name} failed to attach source_project`);
      }
      const originalComparable = JSON.parse(JSON.stringify(original));
      const resultComparable = JSON.parse(JSON.stringify(result));
      delete originalComparable.source_project;
      delete resultComparable.source_project;
      if (!isDeepStrictEqual(resultComparable, originalComparable)) {
        throw new Error(`${source}/${collection.name} modified original document fields`);
      }
      processed.push(result);
    }
    rowsByTable.set(collection.name, processed);
  }

  validateSourceRows(source, rowsByTable);
  const sourceOutput = path.join(BUILD_ROOT, source);
  fs.mkdirSync(sourceOutput, { recursive: true });
  const collectionCounts = [];
  const childCounts = [];
  for (const [table, rows] of rowsByTable) {
    writeJson(path.join(sourceOutput, `${table}.json`), rows);
    const entry = { table, records: rows.length };
    if (sourceManifest.collections.some((item) => item.name === table)) {
      collectionCounts.push(entry);
    } else {
      childCounts.push(entry);
    }
  }
  return {
    source,
    collections: collectionCounts,
    childTables: childCounts,
    totalParentRecords: collectionCounts.reduce((sum, item) => sum + item.records, 0),
    totalChildRecords: childCounts.reduce((sum, item) => sum + item.records, 0),
  };
}

if (fs.existsSync(FINAL_ROOT) || fs.existsSync(BUILD_ROOT)) {
  throw new Error("Refusing to overwrite an existing processed output directory");
}

for (const source of SOURCES) {
  const manifestPath = path.join(DUMP_ROOT, source, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing canonical ${source} export manifest`);
  }
}

fs.mkdirSync(BUILD_ROOT, { recursive: false });
const results = SOURCES.map(transformSource);
writeJson(path.join(BUILD_ROOT, "manifest.json"), {
  generatedAt: new Date().toISOString(),
  operation: "offline hook transformation",
  sources: results,
});
fs.renameSync(BUILD_ROOT, FINAL_ROOT);

for (const result of results) {
  console.log(
    `${result.source}: ${result.totalParentRecords} parent records, ` +
      `${result.totalChildRecords} child records across ${result.childTables.length} tables`,
  );
}
console.log("Offline transformation complete; source exports were not modified.");
