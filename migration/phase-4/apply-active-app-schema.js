"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { connectDatabase } = require("../phase-2/db");

const SCHEMA_PATH = path.join(__dirname, "active-app-schema.sql");

function validateSchema(sql) {
  const tables = [...sql.matchAll(/CREATE TABLE public\.([a-z0-9_]+)\s*\(/gi)]
    .map((match) => match[1]);
  const rlsTables = [...sql.matchAll(/ALTER TABLE public\.([a-z0-9_]+) ENABLE ROW LEVEL SECURITY;/gi)]
    .map((match) => match[1]);
  const plannedBlock = sql.match(/planned_tables text\[\] := ARRAY\[([\s\S]*?)\n  \];/i)?.[1] || "";
  const plannedTables = [...plannedBlock.matchAll(/'([a-z0-9_]+)'/gi)]
    .map((match) => match[1]);
  const revokeBlock = sql.match(
    /REVOKE ALL ON TABLE([\s\S]*?)FROM PUBLIC, anon, authenticated, service_role;/i,
  )?.[1] || "";
  if (
    !sql.includes("BEGIN;") ||
    !sql.trimEnd().endsWith("COMMIT;") ||
    /\b(DROP|TRUNCATE|DELETE\s+FROM|GRANT|CREATE\s+POLICY|DISABLE\s+ROW LEVEL SECURITY)\b/i.test(sql) ||
    tables.length === 0 ||
    new Set(tables).size !== tables.length ||
    tables.length !== plannedTables.length ||
    tables.some((table) => !plannedTables.includes(table)) ||
    tables.length !== rlsTables.length ||
    tables.some((table) => !rlsTables.includes(table)) ||
    tables.some((table) => !revokeBlock.includes(`public.${table}`))
  ) {
    throw new Error("Phase 4 active app schema failed additive/RLS-deny safety checks");
  }
}

async function run(args) {
  const apply = args.length === 1 && args[0] === "--apply";
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (apply === dryRun) {
    throw new Error("Usage: node apply-active-app-schema.js --dry-run|--apply");
  }
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  validateSchema(sql);
  if (dryRun) {
    console.log("Phase 4 active app schema passed fail-closed checks; no database connection opened.");
    return;
  }

  const client = await connectDatabase();
  try {
    await client.query(sql);
    console.log("Phase 4 active app schema applied with all client and service-role access revoked.");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Phase 4 active app schema application failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, validateSchema };
