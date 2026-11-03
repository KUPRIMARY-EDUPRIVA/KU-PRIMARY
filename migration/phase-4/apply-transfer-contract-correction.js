"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { connectDatabase } = require("../phase-2/db");

const SQL_PATH = path.join(__dirname, "transfer-contract-correction.sql");

function validateSql(sql) {
  const sqlWithoutNullableRelaxations = sql.replace(
    /\bALTER\s+COLUMN\s+(?:school_id|student_id)\s+DROP\s+NOT\s+NULL\b/gi,
    "",
  );
  if (
    !sql.includes("BEGIN;") ||
    !sql.trimEnd().endsWith("COMMIT;") ||
    /\b(DROP|TRUNCATE|DELETE\s+FROM|GRANT|CREATE\s+POLICY|DISABLE\s+ROW LEVEL SECURITY)\b/i.test(sqlWithoutNullableRelaxations) ||
    !sql.includes("IF EXISTS (SELECT 1 FROM public.firebase_migration_student_transfers)")
  ) {
    throw new Error("Transfer contract correction failed additive/empty-table safety checks");
  }
}

async function run(args) {
  const apply = args.length === 1 && args[0] === "--apply";
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (apply === dryRun) {
    throw new Error("Usage: node apply-transfer-contract-correction.js --dry-run|--apply");
  }
  const sql = fs.readFileSync(SQL_PATH, "utf8");
  validateSql(sql);
  if (dryRun) {
    console.log("Transfer correction passed fail-closed checks; no database connection opened.");
    return;
  }
  const client = await connectDatabase();
  try {
    await client.query(sql);
    console.log("Additive transfer-contract correction applied.");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Transfer contract correction failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, validateSql };
