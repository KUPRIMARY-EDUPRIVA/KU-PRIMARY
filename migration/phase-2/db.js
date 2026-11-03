"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { X509Certificate } = require("node:crypto");
const { Client } = require("pg");

const CONFIG_PATH = path.resolve(
  __dirname,
  "../../.migration/firebase-to-supabase/firestore/supabase-service.json",
);
const CA_PATH = path.resolve(
  __dirname,
  "../../.migration/firebase-to-supabase/firestore/prod-ca-2021.crt",
);

function readDatabaseConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const ca = fs.readFileSync(CA_PATH, "utf8");
  if (!new X509Certificate(ca).ca) {
    throw new Error("Supabase CA file is not a CA certificate");
  }
  const validUser =
    typeof config.user === "string" &&
    /^postgres(?:\.[a-z0-9_-]+)?$/i.test(config.user);
  if (
    !validUser ||
    typeof config.password !== "string" ||
    !config.password ||
    typeof config.host !== "string" ||
    !config.host ||
    !Number.isInteger(config.port) ||
    config.port !== 5432 ||
    config.database !== "postgres"
  ) {
    throw new Error(
      "Session Pooler config must use postgres[.PROJECT_REF], port 5432, database postgres, and valid credentials",
    );
  }
  return {
    user: config.user,
    password: config.password,
    host: config.host,
    port: config.port,
    database: config.database,
    ssl: { rejectUnauthorized: true, ca },
    connectionTimeoutMillis: 10000,
    application_name: "ku-primary-phase-2-migration",
  };
}

async function connectDatabase() {
  const client = new Client(readDatabaseConfig());
  await client.connect();
  return client;
}

module.exports = { connectDatabase };
