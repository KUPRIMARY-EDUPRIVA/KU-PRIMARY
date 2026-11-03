const crypto = require("node:crypto");
const { withCors } = require("./_lib/cors");

const MAX_BODY_BYTES = 8192;
const RATE_WINDOW_SECONDS = 900;
const EMAIL_RATE_LIMIT = 10;
const IP_RATE_LIMIT = 60;
const GENERIC_AUTH_ERROR = { success: false, message: "Invalid credentials." };

function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function normalizedEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function validBody(body) {
  return (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof body.email === "string" &&
    body.email.length <= 320 &&
    normalizedEmail(body.email).includes("@") &&
    typeof body.password === "string" &&
    body.password.length > 0 &&
    Buffer.byteLength(body.password, "utf8") <= 1024
  );
}

function validBase64Url(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) &&
    Buffer.from(value, "base64").length > 0
  );
}

function sourceConfig(env) {
  const source = env.AUTH_MIGRATION_SOURCE;
  const rounds = Number(env.FIREBASE_SCRYPT_ROUNDS);
  const memCost = Number(env.FIREBASE_SCRYPT_MEM_COST);
  let supabaseUrl;
  try {
    supabaseUrl = new URL(env.SUPABASE_URL);
  } catch {
    throw new Error("Auth migration function is missing valid server configuration");
  }
  if (
    !["ku", "kiwanja"].includes(source) ||
    !env.SUPABASE_URL ||
    supabaseUrl.protocol !== "https:" ||
    supabaseUrl.pathname !== "/" ||
    supabaseUrl.username ||
    supabaseUrl.password ||
    supabaseUrl.search ||
    supabaseUrl.hash ||
    !env.SUPABASE_SERVICE_ROLE_KEY ||
    /\s/.test(env.SUPABASE_SERVICE_ROLE_KEY) ||
    !env.AUTH_MIGRATION_RATE_LIMIT_SECRET ||
    Buffer.byteLength(env.AUTH_MIGRATION_RATE_LIMIT_SECRET, "utf8") < 32 ||
    !validBase64Url(env.FIREBASE_SCRYPT_SIGNER_KEY) ||
    !validBase64Url(env.FIREBASE_SCRYPT_SALT_SEPARATOR) ||
    !Number.isSafeInteger(rounds) ||
    rounds < 1 ||
    !Number.isSafeInteger(memCost) ||
    memCost < 1
  ) {
    throw new Error("Auth migration function is missing valid server configuration");
  }
  return {
    source,
    supabaseUrl: supabaseUrl.origin,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    rateLimitSecret: env.AUTH_MIGRATION_RATE_LIMIT_SECRET,
    scrypt: {
      rounds,
      memCost,
      signerKey: env.FIREBASE_SCRYPT_SIGNER_KEY,
      saltSeparator: env.FIREBASE_SCRYPT_SALT_SEPARATOR,
    },
  };
}

function requestIp(event) {
  const headers = event.headers || {};
  const candidate =
    headers["x-nf-client-connection-ip"] ||
    headers["X-Nf-Client-Connection-Ip"] ||
    event.clientContext?.ip ||
    "unknown";
  return typeof candidate === "string" && candidate.length <= 128
    ? candidate
    : "unknown";
}

function rateBucket(secret, kind, source, value) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${kind}\0${source}\0${value}`)
    .digest("hex");
}

function apiHeaders(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function fetchJson(url, options) {
  const result = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10000),
  });
  const text = await result.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Supabase returned an invalid response");
    }
  }
  if (!result.ok) {
    const error = new Error("Supabase request failed");
    error.status = result.status;
    throw error;
  }
  return data;
}

async function rateAllowed(config, bucketKey, limit) {
  const data = await fetchJson(
    `${config.supabaseUrl}/rest/v1/rpc/firebase_migration_check_auth_rate_limit`,
    {
      method: "POST",
      headers: apiHeaders(config.serviceRoleKey),
      body: JSON.stringify({
        p_bucket_key: bucketKey,
        p_limit: limit,
        p_window_seconds: RATE_WINDOW_SECONDS,
      }),
    },
  );
  if (typeof data !== "boolean") {
    throw new Error("Auth migration rate-limit RPC returned an invalid response");
  }
  return data;
}

async function findUser(config, email) {
  const query = new URLSearchParams({
    select: "auth_user_id,firebase_uid,disabled",
    source_project: `eq.${config.source}`,
    email: `eq.${email}`,
    password_migrated_at: "is.null",
    limit: "1",
  });
  const users = await fetchJson(
    `${config.supabaseUrl}/rest/v1/firebase_migration_auth_user_map?${query}`,
    { headers: apiHeaders(config.serviceRoleKey) },
  );
  return Array.isArray(users) && users.length === 1 ? users[0] : null;
}

async function findCredentials(config, firebaseUid) {
  const query = new URLSearchParams({
    select: "password_hash,password_salt",
    source_project: `eq.${config.source}`,
    firebase_uid: `eq.${firebaseUid}`,
    limit: "1",
  });
  const rows = await fetchJson(
    `${config.supabaseUrl}/rest/v1/firebase_migration_auth_credentials?${query}`,
    { headers: apiHeaders(config.serviceRoleKey) },
  );
  return Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
}

async function updateSupabasePassword(config, authUserId, password) {
  const url = `${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`;
  await fetchJson(url, {
    method: "PUT",
    headers: apiHeaders(config.serviceRoleKey),
    body: JSON.stringify({ password }),
  });
}

async function markPasswordMigrated(config, user) {
  const query = new URLSearchParams({
    select: "auth_user_id,password_migrated_at",
    auth_user_id: `eq.${user.auth_user_id}`,
  });
  const updated = await fetchJson(
    `${config.supabaseUrl}/rest/v1/firebase_migration_auth_user_map?${query}`,
    {
      method: "PATCH",
      headers: apiHeaders(config.serviceRoleKey, { Prefer: "return=representation" }),
      body: JSON.stringify({ password_migrated_at: new Date().toISOString() }),
    },
  );
  if (!Array.isArray(updated) || updated.length !== 1 || !updated[0].password_migrated_at) {
    throw new Error("Auth migration mapping could not be marked complete");
  }
}

async function verifyLegacyPassword(config, password, salt, hash) {
  const FirebaseScryptLib = require("firebase-scrypt");
  const verifier = new FirebaseScryptLib.FirebaseScrypt(config.scrypt);
  return verifier.verify(password, salt, hash);
}

async function handler(event) {
  if (event.httpMethod !== "POST") {
    return response(405, { success: false, message: "Method not allowed." }, {
      Allow: "POST, OPTIONS",
    });
  }
  if (Buffer.byteLength(event.body || "", "utf8") > MAX_BODY_BYTES) {
    return response(413, { success: false, message: "Request is too large." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "");
  } catch {
    return response(400, { success: false, message: "Invalid request." });
  }
  if (!validBody(body)) {
    return response(400, { success: false, message: "Invalid request." });
  }

  let config;
  try {
    config = sourceConfig(process.env);
  } catch (error) {
    console.error("[migrate-firebase-password] server configuration invalid");
    return response(503, { success: false, message: "Password migration is unavailable." });
  }

  const email = normalizedEmail(body.email);
  const ip = requestIp(event);
  try {
    const emailBucket = rateBucket(config.rateLimitSecret, "email", config.source, email);
    const ipBucket = rateBucket(config.rateLimitSecret, "ip", config.source, ip);
    const [emailAllowed, ipAllowed] = await Promise.all([
      rateAllowed(config, emailBucket, EMAIL_RATE_LIMIT),
      rateAllowed(config, ipBucket, IP_RATE_LIMIT),
    ]);
    if (!emailAllowed || !ipAllowed) {
      return response(429, { success: false, message: "Too many attempts. Try again later." }, {
        "Retry-After": String(RATE_WINDOW_SECONDS),
      });
    }

    const user = await findUser(config, email);
    if (!user || user.disabled) return response(401, GENERIC_AUTH_ERROR);
    const credentials = await findCredentials(config, user.firebase_uid);
    if (!credentials) return response(401, GENERIC_AUTH_ERROR);

    const isValid = await verifyLegacyPassword(
      config,
      body.password,
      credentials.password_salt,
      credentials.password_hash,
    );
    if (!isValid) return response(401, GENERIC_AUTH_ERROR);

    await updateSupabasePassword(config, user.auth_user_id, body.password);
    await markPasswordMigrated(config, user);
    return response(200, { success: true });
  } catch (error) {
    console.error(
      "[migrate-firebase-password] request failed",
      Number.isInteger(error.status) ? `upstream_status=${error.status}` : "internal_error",
    );
    return response(503, { success: false, message: "Password migration is temporarily unavailable." });
  }
}

exports.handler = withCors(handler);
exports._test = {
  apiHeaders,
  normalizedEmail,
  rateBucket,
  sourceConfig,
  validBody,
  validBase64Url,
  verifyLegacyPassword,
};
