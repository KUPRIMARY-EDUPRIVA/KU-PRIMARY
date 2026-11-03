"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { connectDatabase } = require("../phase-2/db");

const SQL_PATH = path.join(__dirname, "active-app-rls.sql");

function extractNames(block, pattern) {
  return [...block.matchAll(pattern)].map((match) => match[1]);
}

function validateSql(sql) {
  const tableBlock = sql.match(/required_tables text\[\] := ARRAY\[([\s\S]*?)\n  \];/i)?.[1] || "";
  const policyBlock = sql.match(/planned_policies text\[\] := ARRAY\[([\s\S]*?)\n  \];/i)?.[1] || "";
  const plannedTables = extractNames(tableBlock, /'([a-z0-9_]+)'/gi);
  const plannedPolicies = extractNames(policyBlock, /'([a-z0-9_]+)'/gi);
  const policyMatches = [...sql.matchAll(/CREATE POLICY ([a-z0-9_]+) ON public\.([a-z0-9_]+)/gi)];
  const createdPolicies = policyMatches.map((match) => match[1]);
  const createdTables = [...new Set(policyMatches.map((match) => match[2]))];
  const tableGrants = [...sql.matchAll(/GRANT ([A-Z, ]+) ON TABLE public\.([a-z0-9_]+) TO authenticated;/gi)];
  const identityTriggers = [...sql.matchAll(/CREATE TRIGGER firebase_migration_phase4_identity_guard_[a-z0-9_]+\s+BEFORE UPDATE ON public\.([a-z0-9_]+)/gi)];
  const protectedTables = identityTriggers.map((match) => match[1]);
  const forbiddenGrants = /\bGRANT\b[^;]*\bTO\s+(?:PUBLIC|anon|service_role)\b/i.test(sql);

  if (
    !sql.includes("BEGIN;") ||
    !sql.trimEnd().endsWith("COMMIT;") ||
    /\b(DROP|TRUNCATE|DELETE\s+FROM|DISABLE\s+ROW LEVEL SECURITY)\b/i.test(sql) ||
    /\bSECURITY\s+DEFINER\b/i.test(sql) ||
    forbiddenGrants ||
    !sql.includes("SECURITY INVOKER") ||
    !sql.includes("SET search_path = ''") ||
    !sql.includes("firebase_migration_private.has_school_access") ||
    new Set(plannedTables).size !== plannedTables.length ||
    new Set(plannedPolicies).size !== plannedPolicies.length ||
    createdPolicies.length !== plannedPolicies.length ||
    createdPolicies.some((policy) => !plannedPolicies.includes(policy)) ||
    plannedPolicies.some((policy) => !createdPolicies.includes(policy)) ||
    createdTables.length !== plannedTables.length ||
    createdTables.some((table) => !plannedTables.includes(table)) ||
    tableGrants.length !== plannedTables.length ||
    tableGrants.some(([, , table]) => !plannedTables.includes(table)) ||
    protectedTables.length !== plannedTables.length ||
    new Set(protectedTables).size !== plannedTables.length ||
    protectedTables.some((table) => !plannedTables.includes(table)) ||
    !sql.includes("phase4_active_app_rls_version")
  ) {
    throw new Error("Phase 4 RLS script failed scope, grant, or safety checks");
  }
}

async function run(args) {
  const apply = args.length === 1 && args[0] === "--apply";
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (apply === dryRun) {
    throw new Error("Usage: node apply-active-app-rls.js --dry-run|--apply");
  }
  const sql = fs.readFileSync(SQL_PATH, "utf8");
  validateSql(sql);
  if (dryRun) {
    console.log("Phase 4 RLS/grant script passed scope and safety checks; no database connection opened.");
    return;
  }
  const client = await connectDatabase();
  try {
    await client.query(sql);
    console.log("Approved Phase 4 RLS policies and authenticated grants applied.");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Phase 4 RLS script failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run, validateSql };
