import test from "node:test";
import assert from "node:assert/strict";
import { parseChipAmount } from "../src/amount.js";
import { OperationDeduper } from "../src/operations.js";

test("chip amount parser rejects unsafe numeric input", () => {
  for (const value of ["", " ", "0", "-1", "1.5", "1e3", "Infinity", "NaN", `${Number.MAX_SAFE_INTEGER + 1}`]) {
    assert.throws(() => parseChipAmount(value), /positive integer|too large/);
  }
  assert.equal(parseChipAmount("1000"), 1000);
  assert.equal(parseChipAmount(1000), 1000);
});

test("operation deduper returns the first result for duplicate operation ids", () => {
  const deduper = new OperationDeduper();
  const op = "op_12345678";
  deduper.set("u1", op, { ok: true, roomId: "first" });
  deduper.set("u1", op, { ok: true, roomId: "second" });

  assert.deepEqual(deduper.get("u1", op), { ok: true, roomId: "first" });
  assert.equal(deduper.get("u2", op), null);
});
