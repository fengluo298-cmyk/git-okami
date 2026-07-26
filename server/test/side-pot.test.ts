import test from "node:test";
import assert from "node:assert/strict";
import { settlePots, type EnginePlayer } from "../src/game/gameEngine.js";
import type { Card, Rank, Suit } from "../src/game/cards.js";

test("side pots pay each capped layer to eligible winners", () => {
  const result = settlePots(
    [
      player("a", 0, [c(14), c(14, "H")], 100),
      player("b", 1, [c(13), c(13, "H")], 200),
      player("c", 2, [c(2), c(3, "D")], 300)
    ],
    [c(14, "D"), c(7), c(7, "H"), c(9), c(10)],
    0
  ).awards;

  assert.deepEqual(amounts(result), { a: 300, b: 200, c: 100 });
});

test("folded players fund pots but cannot win them", () => {
  const result = settlePots(
    [
      player("folded", 0, [c(14), c(14, "H")], 100, true),
      player("short", 1, [c(13), c(13, "H")], 100),
      player("deep", 2, [c(2), c(3, "D")], 200)
    ],
    [c(13, "D"), c(8), c(8, "H"), c(9), c(10)],
    0
  ).awards;

  assert.deepEqual(amounts(result), { short: 300, deep: 100 });
});

test("split pots divide odd chips starting left of the dealer", () => {
  const result = settlePots(
    [
      player("dealer", 0, [c(14), c(13)], 5, true),
      player("left", 1, [c(14, "H"), c(13, "H")], 5),
      player("right", 2, [c(14, "D"), c(13, "D")], 5)
    ],
    [c(2, "C"), c(4, "D"), c(6, "H"), c(8, "C"), c(10, "D")],
    0
  ).awards;

  assert.deepEqual(amounts(result), { left: 8, right: 7 });
});

test("odd split chip skips the dealer until players to the left are paid", () => {
  const result = settlePots(
    [
      player("dealer", 0, [c(14), c(13)], 5),
      player("left", 1, [c(14, "H"), c(13, "H")], 5),
      player("right", 2, [c(14, "D"), c(13, "D")], 5)
    ],
    [c(2, "C"), c(4, "D"), c(6, "H"), c(8, "C"), c(10, "D")],
    0
  ).awards;

  assert.deepEqual(amounts(result), { left: 5, right: 5, dealer: 5 });
});

test("odd split chip goes to dealer-left winner when dealer is also a winner", () => {
  const result = settlePots(
    [
      player("dealer", 0, [c(14), c(13)], 5),
      player("left", 1, [c(14, "H"), c(13, "H")], 5),
      player("right", 2, [c(12, "D"), c(11, "D")], 5, true)
    ],
    [c(2, "C"), c(4, "D"), c(6, "H"), c(8, "C"), c(10, "D")],
    0
  ).awards;

  assert.deepEqual(amounts(result), { left: 8, dealer: 7 });
});

function amounts(awards: Array<{ playerId: string; amount: number }>): Record<string, number> {
  return Object.fromEntries(awards.map((award) => [award.playerId, award.amount]));
}

function player(id: string, seat: number, hand: Card[], totalBet: number, folded = false): EnginePlayer {
  return {
    id,
    nickname: id,
    avatar: id,
    seat,
    chips: 0,
    connected: true,
    hand,
    bet: 0,
    totalBet,
    folded,
    allIn: !folded,
    acted: true
  };
}

function c(rank: Rank, suit: Suit = "S"): Card {
  return { rank, suit };
}
