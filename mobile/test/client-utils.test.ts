import test from "node:test";
import assert from "node:assert/strict";
import { apiRequest, AuthExpiredError, InvalidResponseError, ServerError, TimeoutError, validateHttpBaseUrl, validateSocketUrl } from "../src/api/client";
import { clearStoredToken, isValidTokenShape, legacyTokenKey, readStoredToken, secureTokenKey } from "../src/auth/tokenCore";
import { parseChipAmount, parseChipAmountInRange } from "../src/utils/amount";
import { ErrorLimiter } from "../src/utils/errorLimiter";

const token = "aaa.bbb.ccc";

test("token shape rejects empty undefined and null strings", () => {
  assert.equal(isValidTokenShape(""), false);
  assert.equal(isValidTokenShape("undefined"), false);
  assert.equal(isValidTokenShape("null"), false);
  assert.equal(isValidTokenShape(token), true);
});

test("secure token migration keeps the legacy token unless secure write succeeds", async () => {
  const stores = memoryStores({ [legacyTokenKey]: token }, true);
  assert.equal(await readStoredToken(stores), token);
  assert.equal(stores.secureValues[secureTokenKey], token);
  assert.equal(stores.legacyValues[legacyTokenKey], undefined);

  const failing = memoryStores({ [legacyTokenKey]: token }, true, true);
  await assert.rejects(() => readStoredToken(failing), /write failed/);
  assert.equal(failing.legacyValues[legacyTokenKey], token);
});

test("clearing token does not throw when storage deletion fails", async () => {
  const stores = memoryStores({ [legacyTokenKey]: token }, true);
  stores.secure.deleteItemAsync = async () => {
    throw new Error("delete failed");
  };
  stores.legacy.removeItem = async () => {
    throw new Error("delete failed");
  };
  await assert.doesNotReject(() => clearStoredToken(stores));
});

test("api client classifies auth network server timeout and invalid responses", async () => {
  await assert.rejects(() => apiRequest("https://git-okami.onrender.com", "/me", { fetchImpl: response(401, "{}") }), AuthExpiredError);
  await assert.rejects(() => apiRequest("https://git-okami.onrender.com", "/me", { fetchImpl: response(500, "{}") }), ServerError);
  await assert.rejects(() => apiRequest("https://git-okami.onrender.com", "/me", { fetchImpl: response(200, "<html>", "text/html") }), InvalidResponseError);
  await assert.rejects(
    () =>
      apiRequest("https://git-okami.onrender.com", "/me", {
        timeoutMs: 1,
        fetchImpl: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          })
      }),
    TimeoutError
  );
});

test("production urls are restricted to trusted https and wss origins", () => {
  assert.equal(validateHttpBaseUrl("https://git-okami.onrender.com/path", false), "https://git-okami.onrender.com");
  assert.equal(validateSocketUrl("wss://git-okami.onrender.com/socket.io", false), "wss://git-okami.onrender.com");
  assert.throws(() => validateHttpBaseUrl("http://127.0.0.1:4000", false), /HTTPS/);
  assert.throws(() => validateSocketUrl("ws://evil.example.com", false), /WSS/);
});

test("chip amount parser rejects unsafe values and enforces ranges", () => {
  for (const value of ["", " ", "0", "-1", "1.5", "1e3", "Infinity", "NaN", `${Number.MAX_SAFE_INTEGER + 1}`]) {
    assert.throws(() => parseChipAmount(value), /正整数|过大/);
  }
  assert.equal(parseChipAmountInRange("1000", 1000, 10000), 1000);
  assert.throws(() => parseChipAmountInRange("999", 1000, 10000), /低于/);
  assert.throws(() => parseChipAmountInRange("10001", 1000, 10000), /高于/);
});

test("error limiter deduplicates repeated messages inside its window", () => {
  const limiter = new ErrorLimiter(1000);
  assert.equal(limiter.shouldShow("x", 1000), true);
  assert.equal(limiter.shouldShow("x", 1200), false);
  assert.equal(limiter.shouldShow("x", 2201), true);
  assert.equal(limiter.shouldShow("y", 2202), true);
});

function memoryStores(legacyValues: Record<string, string>, secureAvailable: boolean, secureWriteFails = false) {
  const secureValues: Record<string, string> = {};
  const stores = {
    legacyValues,
    secureValues,
    legacy: {
      getItem: async (key: string) => legacyValues[key] ?? null,
      removeItem: async (key: string) => {
        delete legacyValues[key];
      }
    },
    secure: {
      getItemAsync: async (key: string) => secureValues[key] ?? null,
      setItemAsync: async (key: string, value: string) => {
        if (secureWriteFails) throw new Error("write failed");
        secureValues[key] = value;
      },
      deleteItemAsync: async (key: string) => {
        delete secureValues[key];
      },
      isAvailableAsync: async () => secureAvailable
    }
  };
  return stores;
}

function response(status: number, body: string, contentType = "application/json"): typeof fetch {
  return async () => new Response(body, { status, headers: { "content-type": contentType } });
}
