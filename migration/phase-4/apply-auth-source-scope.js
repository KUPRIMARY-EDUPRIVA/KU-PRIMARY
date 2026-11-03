"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { connectDatabase } = require("../phase-2/db");

const SCHEMA_PATH = path.join(__dirname, "auth-source-scope.sql");
const ALLOWED_DROPPED_INDEXES = new Set([
  "firebase_migration_auth_user_id_unique",
  "firebase_migration_auth_email_unique",
]);

function validateSchema(sql) {
  const droppedIndexes = [
    ...sql.matchAll(/\bDROP\s+INDEX\s+public\.([a-z0-9_]+)/gi),
  ].map((match) => match[1]);
  const allowedDropPattern =
    /\bDROP\s+INDEX\s+public\.firebase_migration_auth_(?:user_id|email)_unique;/gi;
  const sqlWithoutAllowedDrops = sql.replace(allowedDropPattern, "");
  if (
    !sql.includes("BEGIN;") ||
    !sql.trimEnd().endsWith("COMMIT;") ||
    /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bDISABLE\s+ROW LEVEL SECURITY\b/i.test(sqlWithoutAllowedDrops) ||
    droppedIndexes.length !== ALLOWED_DROPPED_INDEXES.size ||
    droppedIndexes.some((index) => !ALLOWED_DROPPED_INDEXES.has(index)) ||
    !sql.includes("ENABLE ROW LEVEL SECURITY")
  ) {
    throw new Error("Phase 4 Auth schema failed its additive/RLS safety checks");
  }
}

async function run(args) {
  const apply = args.length === 1 && args[0] === "--apply";
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (apply === dryRun) {
    throw new Error("Usage: node apply-auth-source-scope.js --dry-run|--apply");
  }

  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  validateSchema(sql);
  if (dryRun) {
    console.log("Phase 4 Auth source-scope schema passed safety checks; no database connection opened.");
    return;
  }

  const client = await connectDatabase();
  try {
    await client.query(sql);
    console.log("Phase 4 Auth source-scope schema applied.");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Phase 4 Auth schema application failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, validateSchema };
