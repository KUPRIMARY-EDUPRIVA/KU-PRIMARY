"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { connectDatabase } = require("../phase-2/db");

const SQL_PATH = path.join(__dirname, "shared-tenant-schema.sql");

function validateSql(sql) {
  const expectedSafetyMarkers = [
    "BEGIN;",
    "COMMIT;",
    "source_project IN ('ku', 'kiwanja', 'platform')",
    "PRIMARY KEY (auth_user_id, source_project, school_id)",
    "firebase_migration_schools_school_id_unique",
    "phase5_shared_tenant_schema_version",
  ];
  if (
    !/\bBEGIN;\s/.test(sql) ||
    !sql.trimEnd().endsWith("COMMIT;") ||
    expectedSafetyMarkers.some((marker) => !sql.includes(marker)) ||
    /\b(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.firebase_migration_)\b/i.test(sql) ||
    !/IF source_check_count <> 104 OR exact_source_check_count <> 104/.test(sql) ||
    !sql.includes("source_columns_without_check <> 1") ||
    !sql.includes("membership_count") ||
    !sql.includes("school_count") ||
    /\bGRANT\b/i.test(sql)
  ) {
    throw new Error("Phase 5 tenant schema failed static safety checks");
  }
}

async function run(args) {
  const apply = args.length === 1 && args[0] === "--apply";
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (apply === dryRun) {
    throw new Error("Usage: node apply-shared-tenant-schema.js --dry-run|--apply");
  }
  const sql = fs.readFileSync(SQL_PATH, "utf8");
  validateSql(sql);
  if (dryRun) {
    console.log("Phase 5 shared tenant schema passed local safety checks; no database connection opened.");
    return;
  }
  const client = await connectDatabase();
  try {
    await client.query(sql);
    console.log("Phase 5 shared tenant schema applied.");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Phase 5 shared tenant schema failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, validateSql };
