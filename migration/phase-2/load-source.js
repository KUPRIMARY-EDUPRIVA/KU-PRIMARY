"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const {
  CHILD_PARENTS,
  PARENT_TABLES,
  STUDENT_REFERENCE_TABLES,
} = require("./schema-spec");

const DUMP_ROOT = path.resolve(__dirname, "../../.migration/dumps/processed");
const VALID_SOURCES = new Set(["ku", "kiwanja"]);
const RESERVED_CHILD_FIELDS = new Set([
  "source_project",
  "firestore_id",
  "schoolId",
  "parent_firestore_id",
  "ordinal",
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadSource(source) {
  if (!VALID_SOURCES.has(source)) {
    throw new Error("Source must be ku or kiwanja");
  }
  const manifest = readJson(path.join(DUMP_ROOT, "manifest.json"));
  const sourceManifest = manifest.sources.find((item) => item.source === source);
  if (!sourceManifest) throw new Error(`Missing processed manifest for ${source}`);

  const entries = [
    ...sourceManifest.collections,
    ...sourceManifest.childTables,
  ];
  const expected = new Map(entries.map(({ table, records }) => [table, records]));
  const sourceRoot = path.join(DUMP_ROOT, source);
  const rowsByTable = new Map();
  for (const [table, expectedCount] of expected) {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name in processed manifest: ${table}`);
    }
    const rows = readJson(path.join(sourceRoot, `${table}.json`));
    if (!Array.isArray(rows) || rows.length !== expectedCount) {
      throw new Error(`${source}/${table} count does not match processed manifest`);
    }
    rowsByTable.set(table, rows);
  }

  const collectionSet = new Set(
    sourceManifest.collections.map(({ table }) => table),
  );
  for (const [table, rows] of rowsByTable) {
    const ids = new Set();
    for (const row of rows) {
      if (row.source_project !== source) {
        throw new Error(`${source}/${table} has an incorrect source_project`);
      }
      if (typeof row.firestore_id !== "string" || !row.firestore_id) {
        throw new Error(`${source}/${table} has a missing Firestore ID`);
      }
      if (ids.has(row.firestore_id)) {
        throw new Error(`${source}/${table} contains duplicate Firestore IDs`);
      }
      ids.add(row.firestore_id);
      if (
        row.schoolId != null &&
        (typeof row.schoolId !== "string" || !row.schoolId)
      ) {
        throw new Error(`${source}/${table} has an invalid schoolId`);
      }
    }
    if (collectionSet.has(table)) continue;
    const parentTable = CHILD_PARENTS[table];
    if (!parentTable || !rowsByTable.has(parentTable)) {
      throw new Error(`${source}/${table} has no declared parent table`);
    }
    const parentsById = new Map(
      rowsByTable
        .get(parentTable)
        .map((parent) => [parent.firestore_id, parent]),
    );
    for (const row of rows) {
      const parent = parentsById.get(row.parent_firestore_id);
      if (!parent) {
        throw new Error(`${source}/${table} has an unresolved parent reference`);
      }
      if ((row.schoolId ?? null) !== (parent.schoolId ?? null)) {
        throw new Error(`${source}/${table} has a tenant mismatch with its parent`);
      }
    }
  }

  const studentIds = new Set(
    (rowsByTable.get("students") || []).map((student) => student.firestore_id),
  );
  if (!studentIds.size) throw new Error(`${source} has no student profiles`);
  for (const [table, rows] of rowsByTable) {
    if (table === "students") continue;
    for (const row of rows) {
      const references = [];
      if (typeof row.studentId === "string") references.push(row.studentId);
      if (Array.isArray(row.studentIds)) {
        references.push(...row.studentIds.map(String));
      }
      if (references.some((studentId) => !studentIds.has(studentId))) {
        throw new Error(`${source}/${table} has an unresolved student reference`);
      }
    }
  }

  for (const table of collectionSet) {
    if (!PARENT_TABLES.includes(table)) {
      throw new Error(`${source}/${table} is not in the reviewed schema`);
    }
  }

  for (const [table, rows] of rowsByTable) {
    for (const row of rows) rowValues(table, row, source);
  }

  return { source, manifest: sourceManifest, rowsByTable };
}

function rowValues(table, row, source) {
  if (row.source_project !== source) {
    throw new Error(`${source}/${table} has an incorrect source_project`);
  }
  if (typeof row.firestore_id !== "string" || !row.firestore_id) {
    throw new Error(`${source}/${table} has a missing Firestore ID`);
  }
  if (
    row.schoolId != null &&
    (typeof row.schoolId !== "string" || !row.schoolId)
  ) {
    throw new Error(`${source}/${table} has an invalid schoolId`);
  }
  if (
    STUDENT_REFERENCE_TABLES.includes(table) &&
    row.studentId != null &&
    (typeof row.studentId !== "string" || !row.studentId)
  ) {
    throw new Error(`${source}/${table} has an invalid student reference`);
  }
  if (PARENT_TABLES.includes(table)) {
    const document = { ...row };
    delete document.firestore_id;
    delete document.source_project;
    const values = {
      source_project: source,
      firestore_id: row.firestore_id,
      school_id: row.schoolId ?? null,
      document,
    };
    if (STUDENT_REFERENCE_TABLES.includes(table)) {
      values.student_firestore_id = row.studentId ?? null;
    }
    return values;
  }
  if (
    typeof row.parent_firestore_id !== "string" ||
    !Number.isInteger(row.ordinal) ||
    row.ordinal < 0
  ) {
    throw new Error(`${source}/${table} has invalid parent or ordering metadata`);
  }
  const payload = {};
  for (const [key, value] of Object.entries(row)) {
    if (!RESERVED_CHILD_FIELDS.has(key)) payload[key] = value;
  }
  const values = {
    source_project: source,
    firestore_id: row.firestore_id,
    school_id: row.schoolId ?? null,
    parent_firestore_id: row.parent_firestore_id,
    ordinal: row.ordinal,
    payload,
  };
  if (STUDENT_REFERENCE_TABLES.includes(table)) {
    values.student_firestore_id = row.studentId ?? null;
  }
  return values;
}

function sameValue(left, right) {
  return isDeepStrictEqual(left, right);
}

module.exports = {
  DUMP_ROOT,
  loadSource,
  readJson,
  rowValues,
  sameValue,
};
