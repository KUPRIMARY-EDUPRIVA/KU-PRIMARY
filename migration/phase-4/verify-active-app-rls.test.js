"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { extractArray } = require("./verify-active-app-rls");

test("post-apply verifier inventories the approved 38 relations and 27 granted relations", () => {
  const schema = fs.readFileSync(path.join(__dirname, "active-app-schema.sql"), "utf8");
  const rls = fs.readFileSync(path.join(__dirname, "active-app-rls.sql"), "utf8");
  assert.equal(extractArray(schema, "planned_tables").length, 38);
  assert.equal(extractArray(rls, "required_tables").length, 27);
});
