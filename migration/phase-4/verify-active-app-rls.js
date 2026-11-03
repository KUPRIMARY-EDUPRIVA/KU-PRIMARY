"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { connectDatabase } = require("../phase-2/db");

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, "active-app-schema.sql"), "utf8");
const RLS_SQL = fs.readFileSync(path.join(__dirname, "active-app-rls.sql"), "utf8");

function extractArray(sql, name) {
  const block = sql.match(new RegExp(`${name} text\\[\\] := ARRAY\\[([\\s\\S]*?)\\n  \\];`, "i"))?.[1];
  if (!block) throw new Error(`Missing ${name} inventory`);
  return [...block.matchAll(/'([a-z0-9_]+)'/gi)].map((match) => match[1]);
}

async function verify() {
  const allTables = extractArray(SCHEMA_SQL, "planned_tables");
  const policyTables = extractArray(RLS_SQL, "required_tables");
  const client = await connectDatabase();
  try {
    const state = await client.query(`
      WITH expected(name) AS (SELECT unnest($1::text[])), phase4 AS (
        SELECT e.name, c.oid, c.relrowsecurity,
               (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
               has_table_privilege('authenticated', c.oid, 'SELECT') OR
                 has_table_privilege('authenticated', c.oid, 'INSERT') OR
                 has_table_privilege('authenticated', c.oid, 'UPDATE') OR
                 has_table_privilege('authenticated', c.oid, 'DELETE') AS auth_access,
               has_table_privilege('anon', c.oid, 'SELECT') OR
                 has_table_privilege('anon', c.oid, 'INSERT') OR
                 has_table_privilege('anon', c.oid, 'UPDATE') OR
                 has_table_privilege('anon', c.oid, 'DELETE') AS anon_access,
               has_table_privilege('service_role', c.oid, 'SELECT') OR
                 has_table_privilege('service_role', c.oid, 'INSERT') OR
                 has_table_privilege('service_role', c.oid, 'UPDATE') OR
                 has_table_privilege('service_role', c.oid, 'DELETE') AS service_access
        FROM expected e
        LEFT JOIN pg_class c
          ON c.relname = e.name AND c.relnamespace = 'public'::regnamespace
      )
      SELECT count(*)::int AS relation_count,
             count(*) FILTER (WHERE oid IS NOT NULL AND relrowsecurity)::int AS rls_enabled_count,
             count(*) FILTER (WHERE policy_count > 0)::int AS policy_relation_count,
             coalesce(sum(policy_count), 0)::int AS policy_count,
             count(*) FILTER (WHERE auth_access)::int AS authenticated_relation_count,
             count(*) FILTER (WHERE anon_access)::int AS anon_access_relation_count,
             count(*) FILTER (WHERE service_access)::int AS service_access_relation_count,
             (SELECT count(*)::int
                FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
               WHERE c.relnamespace = 'public'::regnamespace
                 AND t.tgname LIKE 'firebase_migration_phase4_identity_guard_%'
                 AND NOT t.tgisinternal) AS identity_trigger_count,
             (SELECT count(*)::int
                FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
               WHERE c.relnamespace = 'public'::regnamespace
                 AND c.relname = 'firebase_migration_invoices'
                 AND (k.conname LIKE 'firebase_migration_invoices_%_valid'
                   OR k.conname = 'firebase_migration_invoices_total_nonnegative')) AS invoice_check_count,
             EXISTS (SELECT 1 FROM public.firebase_migration_control
                      WHERE key = 'phase4_active_app_rls_version') AS version_recorded
      FROM phase4
    `, [allTables]);

    const row = state.rows[0];
    const expected = {
      relation_count: allTables.length,
      rls_enabled_count: allTables.length,
      policy_relation_count: policyTables.length,
      policy_count: 60,
      authenticated_relation_count: policyTables.length,
      anon_access_relation_count: 0,
      service_access_relation_count: 0,
      identity_trigger_count: policyTables.length,
      invoice_check_count: 6,
      version_recorded: true,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (row[key] !== value) {
        throw new Error(`${key}: expected ${value}, got ${row[key]}`);
      }
    }

    let rowCount = 0;
    for (const table of allTables) {
      const count = await client.query(`SELECT count(*)::int AS count FROM public."${table}"`);
      rowCount += count.rows[0].count;
    }
    if (rowCount !== 0) throw new Error(`Expected empty Phase 4 relations; found ${rowCount} rows`);

    console.log(JSON.stringify({ ...row, phase4_row_count: rowCount }, null, 2));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  verify().catch((error) => {
    console.error(`Phase 4 RLS verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { verify, extractArray };
