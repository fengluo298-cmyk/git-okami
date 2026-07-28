import test from "node:test";
import assert from "node:assert/strict";
import { chooseCorsOrigin, parseCorsOrigins, readCorsOrigins } from "../src/cors.js";

test("CORS origin parsing supports single multiple spaced duplicate and empty entries", () => {
  assert.deepEqual(parseCorsOrigins("https://example.com"), ["https://example.com"]);
  assert.deepEqual(parseCorsOrigins("https://a.example.com,https://b.example.com"), ["https://a.example.com", "https://b.example.com"]);
  assert.deepEqual(parseCorsOrigins("https://a.example.com, https://b.example.com"), ["https://a.example.com", "https://b.example.com"]);
  assert.deepEqual(parseCorsOrigins("https://a.example.com,https://a.example.com"), ["https://a.example.com"]);
  assert.deepEqual(parseCorsOrigins("https://a.example.com,, https://b.example.com,"), ["https://a.example.com", "https://b.example.com"]);
  assert.deepEqual(parseCorsOrigins(undefined), []);
  assert.deepEqual(parseCorsOrigins("   "), []);
  assert.equal(parseCorsOrigins("*"), "*");
  assert.throws(() => parseCorsOrigins("https://example.com/path"), /HTTP\(S\) origins/);
  assert.throws(() => parseCorsOrigins("not a url"), /valid origins/);
  assert.throws(() => parseCorsOrigins("*,https://example.com"), /cannot combine/);
});

test("HTTP and Socket.IO share the same parsed CORS origins", () => {
  const origins = readCorsOrigins("CORS_ORIGIN", {
    NODE_ENV: "production",
    CORS_ORIGIN: "https://a.example.com, https://b.example.com, https://a.example.com"
  });

  assert.deepEqual(origins, ["https://a.example.com", "https://b.example.com"]);
  assert.equal(chooseCorsOrigin(origins, "https://a.example.com"), "https://a.example.com");
  assert.equal(chooseCorsOrigin(origins, "https://b.example.com"), "https://b.example.com");
  assert.equal(chooseCorsOrigin(origins, "https://c.example.com"), null);
  assert.equal(chooseCorsOrigin(origins, undefined), "https://a.example.com");
});

test("production CORS requires explicit trusted origins", () => {
  assert.throws(() => readCorsOrigins("CORS_ORIGIN", { NODE_ENV: "production" }), /explicit trusted origins/);
  assert.throws(() => readCorsOrigins("CORS_ORIGIN", { NODE_ENV: "production", CORS_ORIGIN: "" }), /explicit trusted origins/);
  assert.throws(() => readCorsOrigins("CORS_ORIGIN", { NODE_ENV: "production", CORS_ORIGIN: "*" }), /explicit trusted origins/);
  assert.equal(readCorsOrigins("CORS_ORIGIN", { NODE_ENV: "development" }), "*");
});
