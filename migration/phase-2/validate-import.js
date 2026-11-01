"use strict";

const { connectDatabase } = require("./db");
const { allTables } = require("./generate-schema");
const { loadSource } = require("./load-source");
const { assertParity } = require("./import");

function parseArgs(args) {
  const sourceIndex = args.indexOf("--source");
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] : null;
  const database = args.includes("--database");
  const known = new Set(["--source", "ku", "kiwanja", "--database"]);
  if (args.some((arg) => !known.has(arg))) {
    throw new Error("Usage: node validate-import.js --source ku|kiwanja [--database]");
  }
  if (!source || !["ku", "kiwanja"].includes(source)) {
    throw new Error("Specify exactly one source with --source ku|kiwanja");
  }
  return { source, database };
}

async function validateDatabase(sourceData) {
  const client = await connectDatabase();
  try {
    const schema = await client.query(
      "SELECT value FROM public.migration_control WHERE key = $1",
      ["phase2_schema_version"],
    );
    if (schema.rowCount !== 1 || schema.rows[0].value !== "1") {
      throw new Error("Phase 2 schema version 1 is not installed");
    }
    const expected = new Map(
      [
        ...sourceData.manifest.collections,
        ...sourceData.manifest.childTables,
      ].map(({ table, records }) => [table, records]),
    );
    await assertParity(
      client,
      allTables.map((table) => ({
        table,
        expectedCount: expected.get(table) || 0,
      })),
      sourceData.source,
    );
  } finally {
    await client.end();
  }
}

async function run(args) {
  const { source, database } = parseArgs(args);
  const sourceData = loadSource(source);
  if (database) {
    await validateDatabase(sourceData);
    console.log(`${source}: imported row counts match the processed manifest.`);
    return;
  }
  console.log(
    `${source}: offline data validated (${sourceData.manifest.totalParentRecords} parents, ${sourceData.manifest.totalChildRecords} children); no database connection opened.`,
  );
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Import validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run, validateDatabase };
