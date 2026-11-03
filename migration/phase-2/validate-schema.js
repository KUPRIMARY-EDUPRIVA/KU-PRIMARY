"use strict";

const { connectDatabase } = require("./db");
const { allTables } = require("./generate-schema");
const {
  CHILD_PARENTS,
  CONTROL_TABLES,
  PARENT_TABLES,
  SCHOOL_ADMIN_CRUD,
  SCHOOL_MEMBER_CRUD,
  TABLE_PREFIX,
  physicalTableName,
  rootCollection,
} = require("./schema-spec");

function expectedPolicyTables() {
  return new Set(
    PARENT_TABLES.concat(Object.keys(CHILD_PARENTS)).filter((table) => {
      const parent = rootCollection(table);
      return (
        SCHOOL_MEMBER_CRUD.includes(parent) ||
        SCHOOL_ADMIN_CRUD.includes(parent)
      );
    }),
  );
}

function expectedPhysicalPolicyTables() {
  return new Set([...expectedPolicyTables()].map(physicalTableName));
}

function parseArgs(args) {
  if (args.length !== 1 || args[0] !== "--database") {
    throw new Error("Usage: node validate-schema.js --database");
  }
}

async function validate() {
  const client = await connectDatabase();
  try {
    const version = await client.query(
      `SELECT value FROM public.${TABLE_PREFIX}control WHERE key = $1`,
      ["phase2_schema_version"],
    );
    if (version.rowCount !== 1 || version.rows[0].value !== "1") {
      throw new Error("Phase 2 schema version 1 is missing");
    }

    const dataTables = allTables.map(physicalTableName);
    const relations = [...CONTROL_TABLES, ...dataTables];
    const tableResult = await client.query(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relname = ANY($1::text[])`,
      [relations],
    );
    if (tableResult.rowCount !== relations.length) {
      throw new Error("Expected migration tables are missing or not ordinary tables");
    }
    if (tableResult.rows.some((table) => !table.relrowsecurity)) {
      throw new Error("RLS is not enabled on every Phase 2 table");
    }

    const policies = await client.query(
      `SELECT tablename, policyname, qual, with_check
       FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])`,
      [relations],
    );
    const expected = expectedPolicyTables();
    const expectedNames = new Set([
      `${TABLE_PREFIX}user_tenant_memberships:select_self`,
      `${TABLE_PREFIX}platform_admins:select_self`,
      ...[...expected].map((table) => {
        const type = SCHOOL_ADMIN_CRUD.includes(rootCollection(table))
          ? "admin"
          : "member";
        return `${physicalTableName(table)}:tenant_${type}`;
      }),
    ]);
    const actualNames = new Set(
      policies.rows.map((policy) => `${policy.tablename}:${policy.policyname}`),
    );
    if (
      actualNames.size !== expectedNames.size ||
      [...expectedNames].some((name) => !actualNames.has(name))
    ) {
      throw new Error("RLS policies differ from the approved Phase 2 policy set");
    }
    for (const policy of policies.rows) {
      if (policy.tablename === `${TABLE_PREFIX}user_tenant_memberships`) continue;
      if (policy.tablename === `${TABLE_PREFIX}platform_admins`) continue;
      if (
        !policy.qual?.includes("user_tenant_memberships") ||
        !policy.qual.includes("auth.uid()") ||
        !policy.qual.includes("source_project") ||
        !policy.qual.includes("school_id") ||
        !policy.with_check?.includes("user_tenant_memberships") ||
        !policy.with_check.includes("source_project") ||
        !policy.with_check.includes("school_id")
      ) {
        throw new Error(`Tenant policy check failed for ${policy.tablename}`);
      }
      const logicalTable = allTables.find(
        (table) => physicalTableName(table) === policy.tablename,
      );
      if (!logicalTable) {
        throw new Error(`Unexpected policy table ${policy.tablename}`);
      }
      const parent = rootCollection(logicalTable);
      if (
        SCHOOL_ADMIN_CRUD.includes(parent) &&
        !policy.qual.includes("role = 'admin'")
      ) {
        throw new Error(`Admin-only policy check failed for ${policy.tablename}`);
      }
    }

    const privileges = await client.query(
      `SELECT table_name,
              has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT') AS can_select,
              has_table_privilege('authenticated', format('public.%I', table_name), 'INSERT') AS can_insert,
              has_table_privilege('authenticated', format('public.%I', table_name), 'UPDATE') AS can_update,
              has_table_privilege('authenticated', format('public.%I', table_name), 'DELETE') AS can_delete
       FROM unnest($1::text[]) AS t(table_name)`,
      [dataTables],
    );
    const allowed = expectedPhysicalPolicyTables();
    for (const privilege of privileges.rows) {
      const shouldHave = allowed.has(privilege.table_name);
      if (
        privilege.can_select !== shouldHave ||
        privilege.can_insert !== shouldHave ||
        privilege.can_update !== shouldHave ||
        privilege.can_delete !== shouldHave
      ) {
        throw new Error(`Authenticated table grants differ for ${privilege.table_name}`);
      }
    }

    const foreignKeys = await client.query(
      `SELECT count(*)::integer AS count
       FROM pg_constraint AS c
       JOIN pg_class AS t ON t.oid = c.conrelid
       JOIN pg_namespace AS n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND c.contype = 'f'
         AND t.relname = ANY($1::text[])`,
      [relations],
    );
    if (foreignKeys.rows[0].count !== 93) {
      throw new Error(
        `Expected 93 migration foreign keys, found ${foreignKeys.rows[0].count}`,
      );
    }

    const existingRows = await client.query(
      `SELECT COALESCE(sum(row_count), 0)::bigint AS count
       FROM (${allTables
         .map(
           (table) =>
             `SELECT count(*)::bigint AS row_count FROM public."${physicalTableName(table)}"`,
         )
         .join(" UNION ALL ")}) AS table_counts`,
    );
    if (existingRows.rows[0].count !== "0" && existingRows.rows[0].count !== 0) {
      throw new Error("Expected empty data tables before source import");
    }
    console.log(
      `Schema verified: ${allTables.length} data tables, ${CONTROL_TABLES.length} control tables, RLS enabled, ${policies.rowCount} policies, 93 foreign keys; data tables are empty.`,
    );
  } finally {
    await client.end();
  }
}

async function run(args) {
  parseArgs(args);
  await validate();
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Schema validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  expectedPhysicalPolicyTables,
  expectedPolicyTables,
  parseArgs,
  run,
  validate,
};
