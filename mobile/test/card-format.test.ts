import test from "node:test";
import assert from "node:assert/strict";
import { displayCardRank, formatCardRank, type Card } from "../src/utils/cards";

test("card rank display renders the whole deck without T for tens", () => {
  const suits: Card["suit"][] = ["S", "H", "D", "C"];
  const expected: Record<number, string> = {
    2: "2",
    3: "3",
    4: "4",
    5: "5",
    6: "6",
    7: "7",
    8: "8",
    9: "9",
    10: "10",
    11: "J",
    12: "Q",
    13: "K",
    14: "A"
  };

  for (const suit of suits) {
    assert.equal(formatCardRank(10), "10");
    for (let rank = 2; rank <= 14; rank += 1) {
      const card = { rank, suit };
      assert.equal(displayCardRank(card), expected[rank]);
    }
  }
});

test("hidden and invalid cards do not leak or invent a t rank", () => {
  assert.equal(displayCardRank({ rank: 10, suit: "S" }, true), "?");
  assert.equal(formatCardRank(1), "?");
  assert.equal(formatCardRank(15), "?");
  assert.notEqual(formatCardRank(10).toLowerCase(), "t");
});
