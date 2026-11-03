"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { connectDatabase } = require("./db");
const { generateSql } = require("./generate-schema");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");

async function run(args) {
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  if (args.some((arg) => !["--apply", "--dry-run"].includes(arg))) {
    throw new Error("Usage: node apply-schema.js [--dry-run|--apply]");
  }
  if (apply === dryRun) {
    throw new Error("Specify exactly one of --dry-run or --apply");
  }
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  if (sql !== generateSql().schemaSql) {
    throw new Error("Generated schema.sql is stale; run generate-schema first");
  }
  if (!sql.includes("BEGIN;") || !sql.trimEnd().endsWith("COMMIT;")) {
    throw new Error("Schema file is missing its transaction boundaries");
  }
  if (dryRun) {
    console.log("Schema SQL is present and transaction-bounded; no database connection opened.");
    return;
  }

  const client = await connectDatabase();
  try {
    await client.query(sql);
    console.log("Additive Phase 2 schema applied.");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Schema application failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
