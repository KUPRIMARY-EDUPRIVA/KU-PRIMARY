"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  CHILD_PARENTS,
  CONTROL_TABLES,
  PARENT_TABLES,
  SCHOOL_ADMIN_CRUD,
  SCHOOL_MEMBER_CRUD,
  STUDENT_REFERENCE_TABLES,
  rootCollection,
} = require("./schema-spec");

function sortChildTables() {
  const pending = new Set(Object.keys(CHILD_PARENTS));
  const ordered = [];
  while (pending.size) {
    let progressed = false;
    for (const child of [...pending].sort()) {
      const parent = CHILD_PARENTS[child];
      if (PARENT_TABLES.includes(parent) || ordered.includes(parent)) {
        ordered.push(child);
        pending.delete(child);
        progressed = true;
      }
    }
    if (!progressed) {
      throw new Error(`Child-table dependency cycle: ${[...pending].join(", ")}`);
    }
  }
  return ordered;
}

const allTables = [
  "students",
  ...PARENT_TABLES.filter((table) => table !== "students"),
  ...sortChildTables(),
];
const allObjects = [...CONTROL_TABLES, ...allTables];

function assertSpec() {
  if (new Set(PARENT_TABLES).size !== PARENT_TABLES.length) {
    throw new Error("Duplicate parent table in schema specification");
  }
  for (const [child, parent] of Object.entries(CHILD_PARENTS)) {
    if (!PARENT_TABLES.includes(parent) && !CHILD_PARENTS[parent]) {
      throw new Error(`${child} references unknown parent table ${parent}`);
    }
    if (parent === child) throw new Error(`${child} cannot be its own parent`);
  }
  if (allObjects.length !== new Set(allObjects).size) {
    throw new Error("Duplicate migration object name");
  }
}

function tableDdl(table) {
  const studentReference = STUDENT_REFERENCE_TABLES.includes(table);
  const columns = [
    "source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja'))",
    "firestore_id text NOT NULL",
    "school_id text",
  ];
  const constraints = [
    "PRIMARY KEY (source_project, firestore_id)",
    `CONSTRAINT ${table}_tenant_key UNIQUE (source_project, firestore_id, school_id)`,
  ];

  if (PARENT_TABLES.includes(table)) {
    if (studentReference) columns.push("student_firestore_id text");
    columns.push("document jsonb NOT NULL");
    if (studentReference) {
      constraints.push(
        `CONSTRAINT ${table}_student_fk FOREIGN KEY (source_project, student_firestore_id, school_id) REFERENCES public.students (source_project, firestore_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      );
    }
  } else {
    const parent = CHILD_PARENTS[table];
    if (studentReference) columns.push("student_firestore_id text");
    columns.push(
      "parent_firestore_id text NOT NULL",
      "ordinal integer NOT NULL CHECK (ordinal >= 0)",
      "payload jsonb NOT NULL",
    );
    constraints.push(
      `CONSTRAINT ${table}_parent_fk FOREIGN KEY (source_project, parent_firestore_id) REFERENCES public.${parent} (source_project, firestore_id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      `CONSTRAINT ${table}_tenant_parent_fk FOREIGN KEY (source_project, parent_firestore_id, school_id) REFERENCES public.${parent} (source_project, firestore_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
    );
    if (studentReference) {
      constraints.push(
        `CONSTRAINT ${table}_student_fk FOREIGN KEY (source_project, student_firestore_id, school_id) REFERENCES public.students (source_project, firestore_id, school_id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
      );
    }
  }

  return `CREATE TABLE public.${table} (\n  ${[
    ...columns,
    ...constraints,
  ].join(",\n  ")}\n);`;
}

function membershipPredicate(table, adminOnly = false) {
  const conditions = [
    "membership.auth_user_id = (SELECT auth.uid())",
    `membership.source_project = ${table}.source_project`,
    `membership.school_id = ${table}.school_id`,
  ];
  if (adminOnly) conditions.push("membership.role = 'admin'");
  return `EXISTS (
    SELECT 1
    FROM public.user_tenant_memberships AS membership
    WHERE ${conditions.join("\n      AND ")}
  )`;
}

function policyDdl(table, policyType) {
  const predicate = membershipPredicate(table, policyType === "admin");
  const prefix = `CREATE POLICY ${table}_tenant_${policyType}`;
  return `${prefix} ON public.${table}
  FOR ALL TO authenticated
  USING (${predicate})
  WITH CHECK (${predicate});`;
}

function generateSql() {
  assertSpec();
  const preflightObjects = allObjects
    .map(
      (name) =>
        `  IF to_regclass('public.${name}') IS NOT NULL THEN\n` +
        `    RAISE EXCEPTION 'Refusing to overwrite existing relation public.${name}';\n` +
        "  END IF;",
    )
    .join("\n");
  const tableStatements = [
    `CREATE TABLE public.migration_control (
  key text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`,
    `CREATE TABLE public.user_tenant_memberships (
  auth_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  source_project text NOT NULL CHECK (source_project IN ('ku', 'kiwanja')),
  school_id text NOT NULL,
  role text NOT NULL,
  PRIMARY KEY (auth_user_id, source_project)
);`,
    `CREATE TABLE public.platform_admins (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);`,
    ...allTables.map(tableDdl),
  ];
  const rlsStatements = [
    ...allObjects.map(
      (table) => `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`,
    ),
    `CREATE POLICY user_tenant_memberships_select_self
  ON public.user_tenant_memberships
  FOR SELECT TO authenticated
  USING (auth_user_id = (SELECT auth.uid()));`,
    `CREATE POLICY platform_admins_select_self
  ON public.platform_admins
  FOR SELECT TO authenticated
  USING (auth_user_id = (SELECT auth.uid()));`,
    ...PARENT_TABLES.concat(Object.keys(CHILD_PARENTS)).flatMap((table) => {
      const parent = rootCollection(table);
      if (SCHOOL_MEMBER_CRUD.includes(parent)) {
        return [policyDdl(table, "member")];
      }
      if (SCHOOL_ADMIN_CRUD.includes(parent)) {
        return [policyDdl(table, "admin")];
      }
      return [];
    }),
  ];
  const grantStatements = [
    ...allObjects.map(
      (table) =>
        `REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`,
    ),
    "GRANT SELECT ON TABLE public.user_tenant_memberships TO authenticated;",
    "GRANT SELECT ON TABLE public.platform_admins TO authenticated;",
    ...PARENT_TABLES.concat(Object.keys(CHILD_PARENTS))
      .filter(      (table) => {
        const parent = rootCollection(table);
        return (
          SCHOOL_MEMBER_CRUD.includes(parent) ||
          SCHOOL_ADMIN_CRUD.includes(parent)
        );
      })
      .map(
        (table) =>
          `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO authenticated;`,
      ),
  ];
  const rollbackAccess = [
    "-- Access-only rollback: data and schema remain untouched.",
    "BEGIN;",
    ...allObjects.map(
      (table) =>
        `REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`,
    ),
    "COMMIT;",
    "",
  ].join("\n");
  const schemaSql = [
    "-- Generated by node migration/phase-2/generate-schema.js",
    "-- Additive only; aborts if any target relation already exists.",
    "BEGIN;",
    "DO $migration_preflight$",
    "BEGIN",
    "  IF to_regclass('auth.users') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN",
    "    RAISE EXCEPTION 'Supabase Auth users table/function is required';",
    "  END IF;",
    "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') OR",
    "     NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN",
    "    RAISE EXCEPTION 'Expected Supabase API roles are missing';",
    "  END IF;",
    preflightObjects,
    "END;",
    "$migration_preflight$;",
    ...tableStatements,
    ...allTables.map(
      (table) =>
        `CREATE INDEX ${table}_tenant_idx ON public.${table} (source_project, school_id);`,
    ),
    ...rlsStatements,
    ...grantStatements,
    "INSERT INTO public.migration_control (key, value)",
    "VALUES ('phase2_schema_version', '1');",
    "COMMIT;",
    "",
  ].join("\n");
  return { schemaSql, rollbackAccess };
}

if (require.main === module) {
  const { schemaSql, rollbackAccess } = generateSql();
  const schemaPath = path.join(__dirname, "schema.sql");
  const rollbackPath = path.join(__dirname, "rollback-access.sql");
  fs.writeFileSync(schemaPath, schemaSql);
  fs.writeFileSync(rollbackPath, rollbackAccess);
  console.log(
    `Generated ${path.relative(process.cwd(), schemaPath)} and ${path.relative(process.cwd(), rollbackPath)}`,
  );
}

module.exports = { allTables, generateSql };
