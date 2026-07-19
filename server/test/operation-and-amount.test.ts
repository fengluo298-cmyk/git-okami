import test from "node:test";
import assert from "node:assert/strict";
import { parseChipAmount } from "../src/amount.js";
import { OperationDeduper, RoomActionQueue } from "../src/operations.js";

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
  assert.equal(deduper.get(deduper.scope({ userId: "u1", roomId: "r2", actionId: "op_12345678", event: "game:action", payload: { type: "call" } })), null);
  assert.throws(() => deduper.get(deduper.scope({ userId: "u1", roomId: "r1", actionId: "op_12345678", event: "game:action", payload: { type: "raise", amount: 100 } })), /different parameters/);
  assert.throws(() => deduper.get(deduper.scope({ userId: "u1", roomId: "r1", actionId: "op_12345678", event: "seat:ready", payload: { ready: true } })), /different parameters/);
  assert.throws(() => deduper.scope({ userId: "u1", roomId: "r1", actionId: "short", event: "game:action", payload: {} }), /Action id/);
  assert.throws(() => deduper.scope({ userId: "u1", roomId: "r1", actionId: "bad id!!", event: "game:action", payload: {} }), /Action id/);
  assert.throws(() => deduper.scope({ userId: "u1", roomId: "r1", actionId: "a".repeat(81), event: "game:action", payload: {} }), /Action id/);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
