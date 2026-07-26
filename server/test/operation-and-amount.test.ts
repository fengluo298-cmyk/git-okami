import test from "node:test";
import assert from "node:assert/strict";
import { parseChipAmount } from "../src/amount.js";
import { OperationDeduper, RoomActionQueue } from "../src/operations.js";
import { createRateLimiter } from "../src/rateLimiter.js";

test("chip amount parser rejects unsafe numeric input", () => {
  for (const value of ["", " ", "0", "-1", "1.5", "1e3", "Infinity", "NaN", `${Number.MAX_SAFE_INTEGER + 1}`]) {
    assert.throws(() => parseChipAmount(value), /positive integer|too large/);
  }
  assert.equal(parseChipAmount("1000"), 1000);
  assert.equal(parseChipAmount(1000), 1000);
});

test("operation deduper returns the first result for duplicate operation ids", () => {
  const deduper = new OperationDeduper();
  const scope = deduper.scope({ userId: "u1", roomId: "r1", actionId: "op_12345678", event: "game:action", payload: { type: "call" } });
  deduper.set(scope, { ok: true, roomId: "first" });
  deduper.set(scope, { ok: true, roomId: "second" });

  assert.deepEqual(deduper.get(scope), { ok: true, roomId: "first" });
  assert.equal(deduper.get(deduper.scope({ userId: "u2", roomId: "r1", actionId: "op_12345678", event: "game:action", payload: { type: "call" } })), null);
  assert.deepEqual(deduper.get(deduper.scope({ userId: "u1", roomId: "r2", actionId: "op_12345678", event: "game:action", payload: { type: "call" } })), { ok: true, roomId: "first" });
  assert.throws(() => deduper.get(deduper.scope({ userId: "u1", roomId: "r1", actionId: "op_12345678", event: "game:action", payload: { type: "raise", amount: 100 } })), /different parameters/);
  assert.throws(() => deduper.get(deduper.scope({ userId: "u1", roomId: "r1", actionId: "op_12345678", event: "seat:ready", payload: { ready: true } })), /different parameters/);
  assert.throws(() => deduper.scope({ userId: "u1", roomId: "r1", actionId: "short", event: "game:action", payload: {} }), /Action id/);
  assert.throws(() => deduper.scope({ userId: "u1", roomId: "r1", actionId: "bad id!!", event: "game:action", payload: {} }), /Action id/);
  assert.throws(() => deduper.scope({ userId: "u1", roomId: "r1", actionId: "a".repeat(81), event: "game:action", payload: {} }), /Action id/);
});

test("operation deduper runs concurrent duplicate work once and classifies cached failures", async () => {
  const deduper = new OperationDeduper();
  const shouldCache = (result: { ok: boolean; code?: unknown }) => result.ok || result.code === "STATE_VERSION_STALE";
  const scope = deduper.scope({ userId: "u1", actionId: "op_atomic1", event: "rooms:create", payload: { name: "A" } });
  let runs = 0;

  const [first, second] = await Promise.all([
    deduper.run(scope, async () => {
      runs += 1;
      await delay(10);
      return { ok: true, roomId: "room-1" };
    }),
    deduper.run(scope, async () => {
      runs += 1;
      return { ok: true, roomId: "room-2" };
    })
  ]);

  assert.equal(runs, 1);
  assert.deepEqual(second, first);
  assert.equal(first.roomId, "room-1");
  assert.throws(() => deduper.scope({ userId: "u1", actionId: "op_atomic1", event: "rooms:create", payload: { name: "B" } }), /different parameters/);

  const stale = deduper.scope({ userId: "u1", actionId: "op_stale11", event: "game:action", payload: { type: "call", stateVersion: 1 } });
  const staleResult = await deduper.run(stale, () => {
    runs += 1;
    return { ok: false, code: "STATE_VERSION_STALE", stateVersion: 2 };
  }, shouldCache);
  assert.deepEqual(await deduper.run(stale, () => ({ ok: true }), shouldCache), staleResult);
  assert.throws(() => deduper.scope({ userId: "u1", actionId: "op_stale11", event: "game:action", payload: { type: "call", stateVersion: 2 } }), /different parameters/);

  const transient = deduper.scope({ userId: "u1", actionId: "op_db_busy1", event: "game:action", payload: { type: "call", stateVersion: 1 } });
  assert.deepEqual(await deduper.run(transient, () => {
    runs += 1;
    return { ok: false, code: "DATABASE_BUSY" };
  }, shouldCache), { ok: false, code: "DATABASE_BUSY" });
  assert.deepEqual(await deduper.run(transient, () => {
    runs += 1;
    return { ok: true, code: "OK" };
  }, shouldCache), { ok: true, code: "OK" });

  const thrown = deduper.scope({ userId: "u1", actionId: "op_throw11", event: "game:action", payload: { type: "call", stateVersion: 1 } });
  await assert.rejects(() => deduper.run(thrown, () => {
    runs += 1;
    throw new Error("boom");
  }), /boom/);
  assert.deepEqual(await deduper.run(thrown, () => ({ ok: true, code: "OK" })), { ok: true, code: "OK" });
  assert.equal(runs, 5);
});

test("operation deduper expires cached and hung entries with the injected clock", async () => {
  let now = 0;
  const deduper = new OperationDeduper(100, 1, () => now);
  const first = deduper.scope({ userId: "u1", actionId: "op_clock11", event: "game:action", payload: { type: "call", stateVersion: 1 } });
  await deduper.run(first, () => ({ ok: true, code: "OK" }));
  assert.equal(deduper.size(), 1);

  now = 101;
  assert.equal(deduper.size(), 0);

  const hung = deduper.scope({ userId: "u1", actionId: "op_hung111", event: "game:action", payload: { type: "call", stateVersion: 1 } });
  void deduper.run(hung, () => new Promise<any>(() => undefined));
  assert.equal(deduper.size(), 1);
  now = 202;
  assert.equal(deduper.size(), 0);
});

test("operation deduper does not evict active in-flight entries when full", async () => {
  let resolveFirst!: (value: { ok: boolean; code: string }) => void;
  const deduper = new OperationDeduper(100_000, 1);
  const firstScope = deduper.scope({ userId: "u1", actionId: "op_full111", event: "game:action", payload: { type: "call", stateVersion: 1 } });
  const secondScope = deduper.scope({ userId: "u1", actionId: "op_full222", event: "game:action", payload: { type: "call", stateVersion: 1 } });
  let runs = 0;
  const first = deduper.run(firstScope, () => {
    runs += 1;
    return new Promise<{ ok: boolean; code: string }>((resolve) => {
      resolveFirst = resolve;
    });
  });
  const duplicate = deduper.run(firstScope, () => {
    runs += 1;
    return { ok: true, code: "DUPLICATE" };
  });
  await Promise.resolve();

  await assert.rejects(() => deduper.run(secondScope, () => ({ ok: true, code: "SECOND" })), /Room is busy/);
  assert.equal(runs, 1);
  resolveFirst({ ok: true, code: "OK" });
  assert.deepEqual(await first, { ok: true, code: "OK" });
  assert.deepEqual(await duplicate, { ok: true, code: "OK" });
  assert.equal(deduper.size(), 1);
});

test("operation deduper evicts old entries at the configured cap", () => {
  const deduper = new OperationDeduper(100_000, 2);
  for (const actionId of ["op_11111111", "op_22222222", "op_33333333"]) {
    const scope = deduper.scope({ userId: "u1", roomId: "r1", actionId, event: "game:action", payload: { type: "call", actionId } });
    deduper.set(scope, { ok: true, actionId });
  }

  assert.equal(deduper.size(), 2);
  assert.equal(deduper.get(deduper.scope({ userId: "u1", roomId: "r1", actionId: "op_11111111", event: "game:action", payload: { type: "call", actionId: "op_11111111" } })), null);
});

test("operation deduper can clear cached actions for a deleted room", () => {
  const deduper = new OperationDeduper();
  const kept = deduper.scope({ userId: "u1", roomId: "r2", actionId: "op_kept111", event: "game:action", payload: { type: "call" } });
  const removed = deduper.scope({ userId: "u1", roomId: "r1", actionId: "op_removed1", event: "game:action", payload: { type: "call" } });
  deduper.set(kept, { ok: true });
  deduper.set(removed, { ok: true });

  deduper.deleteRoom("r1");

  assert.equal(deduper.get(removed), null);
  assert.deepEqual(deduper.get(kept), { ok: true });
});

test("room action queue serializes one room and clears after failures", async () => {
  const queue = new RoomActionQueue();
  const order: string[] = [];

  await Promise.all([
    queue.run("r1", async () => {
      await delay(10);
      order.push("a");
    }),
    queue.run("r1", () => {
      order.push("b");
    }),
    queue.run("r2", () => {
      order.push("c");
    })
  ]);

  assert.deepEqual(order.filter((item) => item !== "c"), ["a", "b"]);
  await assert.rejects(() => queue.run("r1", () => Promise.reject(new Error("boom"))), /boom/);
  await queue.run("r1", () => order.push("d"));
  assert.equal(queue.size(), 0);
});

test("room action queue survives concurrent pressure without leaking", async () => {
  const queue = new RoomActionQueue();
  let count = 0;
  await Promise.all(Array.from({ length: 250 }, (_, index) => queue.run(`r${index % 5}`, () => count++)));

  assert.equal(count, 250);
  assert.equal(queue.size(), 0);
});

test("rate limiter rejects new keys at capacity without evicting active limits", () => {
  let now = 0;
  const limiter = createRateLimiter(2, 100, { maxKeys: 2, now: () => now });

  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  assert.equal(limiter.allow("b"), true);
  assert.equal(limiter.allow("c"), false);
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.allow("a"), false);

  now = 101;
  assert.equal(limiter.allow("c"), true);
  assert.equal(limiter.size(), 1);
});

test("rate limiter caps many usernames and recovers after the window", () => {
  let now = 0;
  const limiter = createRateLimiter(1, 100, { maxKeys: 10_000, now: () => now });

  for (let index = 0; index < 10_000; index += 1) assert.equal(limiter.allow(`user-${index}`), true);
  assert.equal(limiter.size(), 10_000);
  assert.equal(limiter.allow("overflow"), false);
  assert.equal(limiter.allow("user-0"), false);

  now = 101;
  assert.equal(limiter.allow("overflow"), true);
  assert.equal(limiter.size(), 1);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
