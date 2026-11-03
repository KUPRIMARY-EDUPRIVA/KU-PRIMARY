const fs = require("node:fs/promises");
const path = require("node:path");
const admin = require("firebase-admin");

const ROOT = path.resolve(__dirname, "../..");
const FIREBASE_CONFIGS = {
  ku: path.join(
    ROOT,
    ".migration/firebase-to-supabase/firestore/firebase-service.json",
  ),
  kiwanja: path.join(
    ROOT,
    ".migration/firebase-to-supabase/firestore/firebase-service-kiwanja.json",
  ),
};
const OUTPUT_DIR = path.join(ROOT, ".migration/dumps/auth");

function parseSource(args) {
  if (args.length !== 2 || args[0] !== "--source") {
    throw new Error("Usage: node export-users.js --source ku|kiwanja");
  }
  const source = args[1];
  if (!Object.hasOwn(FIREBASE_CONFIGS, source)) {
    throw new Error("Source must be ku or kiwanja");
  }
  return source;
}

function sanitizeUser(user) {
  return {
    uid: user.uid,
    email: user.email || null,
    emailVerified: user.emailVerified,
    displayName: user.displayName || null,
    photoURL: user.photoURL || null,
    phoneNumber: user.phoneNumber || null,
    disabled: user.disabled,
    createdAt: user.metadata.creationTime || null,
    lastSignInAt: user.metadata.lastSignInTime || null,
    providerData: user.providerData.map((provider) => ({
      uid: provider.uid,
      email: provider.email || null,
      displayName: provider.displayName || null,
      photoURL: provider.photoURL || null,
      phoneNumber: provider.phoneNumber || null,
      providerId: provider.providerId,
    })),
    customClaims: user.customClaims || {},
    passwordHash: user.passwordHash || null,
    passwordSalt: user.passwordSalt || null,
  };
}

async function exportUsers(source) {
  const configPath = FIREBASE_CONFIGS[source];
  const serviceAccount = JSON.parse(await fs.readFile(configPath, "utf8"));
  const outputPath = path.join(OUTPUT_DIR, `${source}-users.json`);
  const temporaryPath = `${outputPath}.tmp`;
  await fs.mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(OUTPUT_DIR, 0o700);
  const app = admin.initializeApp(
    { credential: admin.credential.cert(serviceAccount) },
    `migration-${source}`,
  );

  const users = [];
  let pageToken;
  try {
    do {
      const page = await admin.auth(app).listUsers(1000, pageToken);
      users.push(...page.users.map(sanitizeUser));
      pageToken = page.pageToken;
    } while (pageToken);

    await fs.writeFile(temporaryPath, `${JSON.stringify(users)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, outputPath);
    await fs.chmod(outputPath, 0o600);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await app.delete();
  }

  return {
    source,
    count: users.length,
    withPasswordHash: users.filter((user) => user.passwordHash).length,
    disabled: users.filter((user) => user.disabled).length,
    missingEmail: users.filter((user) => !user.email).length,
    emailVerified: users.filter((user) => user.emailVerified).length,
    output: path.relative(ROOT, outputPath),
  };
}

async function run(args) {
  const source = parseSource(args);
  const summary = await exportUsers(source);
  console.log(
    `${summary.source}: exported ${summary.count} Auth users ` +
      `(${summary.withPasswordHash} with password hashes, ` +
    `${summary.emailVerified} email-verified, ` +
    `${summary.disabled} disabled, ${summary.missingEmail} without email) ` +
      `to ${summary.output}; file mode 0600.`,
  );
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`Firebase Auth export failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { exportUsers, parseSource, sanitizeUser };
