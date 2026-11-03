"use strict";

const { connectDatabase } = require("./db");
const { allTables } = require("./generate-schema");
const { loadSource, rowValues, sameValue } = require("./load-source");
const {
  STUDENT_REFERENCE_TABLES,
  physicalTableName,
  TABLE_PREFIX,
} = require("./schema-spec");

const BATCH_SIZE = 100;
const PARENT_COLUMNS = [
  "source_project",
  "firestore_id",
  "school_id",
  "document",
];
const CHILD_COLUMNS = [
  "source_project",
  "firestore_id",
  "school_id",
  "parent_firestore_id",
  "ordinal",
  "payload",
];

function columnsFor(table, row) {
  const columns = row.parent_firestore_id === undefined
    ? PARENT_COLUMNS
    : CHILD_COLUMNS;
  if (!STUDENT_REFERENCE_TABLES.includes(table)) return columns;
  return [
    ...columns.slice(0, 3),
    "student_firestore_id",
    ...columns.slice(3),
  ];
}

function parseArgs(args) {
  if (args.filter((arg) => arg === "--source").length !== 1) {
    throw new Error("Specify exactly one source with --source ku|kiwanja");
  }
  const sourceIndex = args.indexOf("--source");
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] : null;
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  const known = new Set(["--source", "ku", "kiwanja", "--apply", "--dry-run"]);
  if (args.some((arg) => !known.has(arg))) {
    throw new Error("Usage: node import.js --source ku|kiwanja [--dry-run|--apply]");
  }
  if (!source || !["ku", "kiwanja"].includes(source)) {
    throw new Error("Specify exactly one source with --source ku|kiwanja");
  }
  if (apply === dryRun) {
    throw new Error("Specify exactly one of --dry-run or --apply");
  }
  return { source, apply };
}

function tableEntries(sourceData) {
  const expected = new Map(
    [
      ...sourceData.manifest.collections,
      ...sourceData.manifest.childTables,
    ].map(({ table, records }) => [table, records]),
  );
  return allTables.map((table) => ({
    table,
    rows: sourceData.rowsByTable.get(table) || [],
    expectedCount: expected.get(table) || 0,
  }));
}

async function assertSchema(client) {
  const version = await client.query(
    `SELECT value FROM public.${TABLE_PREFIX}control WHERE key = $1`,
    ["phase2_schema_version"],
  );
  if (version.rowCount !== 1 || version.rows[0].value !== "1") {
    throw new Error("Phase 2 schema version 1 is not installed");
  }
}

async function insertRows(client, table, rows, source) {
  if (!rows.length) return;
  const columns = columnsFor(table, rows[0]);
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const params = [];
    const tuples = batch.map((rawRow) => {
      const row = rowValues(table, rawRow, source);
      const values = columns.map((column) => {
        const value = row[column];
        return column === "document" || column === "payload"
          ? JSON.stringify(value)
          : value;
      });
      const start = params.length;
      params.push(...values);
      return `(${values
        .map((_, columnIndex) => `$${start + columnIndex + 1}`)
        .join(", ")})`;
    });
    const quotedColumns = columns.map((column) => `"${column}"`).join(", ");
    const conflictColumns = `"source_project", "firestore_id"`;
    await client.query(
      `INSERT INTO public."${physicalTableName(table)}" (${quotedColumns}) VALUES ${tuples.join(", ")} ` +
        `ON CONFLICT (${conflictColumns}) DO NOTHING`,
      params,
    );
    await verifyRows(client, table, batch, columns, source);
  }
}

async function verifyRows(client, table, rows, columns, source) {
  const ids = rows.map((row) => row.firestore_id);
  const result = await client.query(
    `SELECT ${columns.map((column) => `"${column}"`).join(", ")} ` +
      `FROM public."${physicalTableName(table)}" WHERE source_project = $1 AND firestore_id = ANY($2::text[])`,
    [source, ids],
  );
  const actualById = new Map(
    result.rows.map((row) => [row.firestore_id, row]),
  );
  if (actualById.size !== rows.length) {
    throw new Error(`${source}/${table} did not persist every expected key`);
  }
  for (const rawRow of rows) {
    const expected = rowValues(table, rawRow, source);
    const actual = actualById.get(expected.firestore_id);
    if (!actual || columns.some((column) => !sameValue(actual[column], expected[column]))) {
      throw new Error(
        `${source}/${table} contains a conflicting pre-existing row; refusing overwrite`,
      );
    }
  }
}

async function assertParity(client, entries, source) {
  for (const { table, expectedCount } of entries) {
    const result = await client.query(
      `SELECT count(*)::integer AS count FROM public."${physicalTableName(table)}" WHERE source_project = $1`,
      [source],
    );
    const actualCount = result.rows[0].count;
    if (actualCount !== expectedCount) {
      throw new Error(
        `${source}/${table} count mismatch: expected ${expectedCount}, found ${actualCount}`,
      );
    }
  }
}

async function run() {
  const { source, apply } = parseArgs(process.argv.slice(2));
  const sourceData = loadSource(source);
  const entries = tableEntries(sourceData);
  const totalParents = sourceData.manifest.totalParentRecords;
  const totalChildren = sourceData.manifest.totalChildRecords;
  if (!apply) {
    console.log(
      `${source}: dry-run validated ${totalParents} parents and ${totalChildren} children across ${entries.length} schema tables; no database connection opened.`,
    );
    return;
  }

  const client = await connectDatabase();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await assertSchema(client);
    for (const { table, rows } of entries) {
      await insertRows(client, table, rows, source);
    }
    await assertParity(client, entries, source);
    await client.query("COMMIT");
    console.log(
      `${source}: committed ${totalParents} parents and ${totalChildren} children across ${entries.length} schema tables.`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Phase 2 import failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertParity,
  columnsFor,
  insertRows,
  parseArgs,
  run,
  tableEntries,
  verifyRows,
};
