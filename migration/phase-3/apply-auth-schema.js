const fs = require("node:fs");
const path = require("node:path");
const { connectDatabase } = require("../phase-2/db");

const SCHEMA_PATH = path.join(__dirname, "auth-schema.sql");

async function run(args) {
  const apply = args.length === 1 && args[0] === "--apply";
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (apply === dryRun) {
    throw new Error("Usage: node apply-auth-schema.js --dry-run|--apply");
  }
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  if (
    !sql.includes("BEGIN;") ||
    !sql.trimEnd().endsWith("COMMIT;") ||
    /\b(DROP|TRUNCATE)\b/i.test(sql) ||
    /DISABLE ROW LEVEL SECURITY/i.test(sql)
  ) {
    throw new Error("Auth schema must be additive, transaction-bounded, and RLS-safe");
  }
  if (dryRun) {
    console.log("Phase 3 Auth schema is additive and transaction-bounded; no database connection opened.");
    return;
  }

  const client = await connectDatabase();
  try {
    await client.query(sql);
    console.log("Additive Phase 3 Auth schema applied.");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Auth schema application failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
