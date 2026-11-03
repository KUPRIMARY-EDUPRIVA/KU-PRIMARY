const fs = require("node:fs");
const path = require("node:path");
const { loadSource } = require("../phase-2/load-source");
const { assertNoCrossSourceCollisions, buildImportPlan } = require("./auth-utils");

const DUMP_ROOT = path.resolve(__dirname, "../../.migration/dumps/auth");

function readAuthExport(source) {
  return JSON.parse(
    fs.readFileSync(path.join(DUMP_ROOT, `${source}-users.json`), "utf8"),
  );
}

function validateExports() {
  const plans = ["ku", "kiwanja"].map((source) => {
    const users = readAuthExport(source);
    const profiles = loadSource(source).rowsByTable.get("users");
    return buildImportPlan(source, users, profiles);
  });
  assertNoCrossSourceCollisions(plans);
  return plans;
}

function run() {
  for (const plan of validateExports()) {
    console.log(
      `${plan.source}: ${plan.accounts.length} Auth users, ` +
        `${plan.credentialCount} Firebase password credentials, ` +
        `${plan.memberships.length} school memberships, ` +
        `${plan.profilelessCount} accounts without profiles, ` +
        `${plan.profilesWithoutSchoolCount} profiles without a school.`,
    );
  }
  console.log("Auth exports are internally consistent; no email collisions across sources.");
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Auth export validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { readAuthExport, validateExports };
