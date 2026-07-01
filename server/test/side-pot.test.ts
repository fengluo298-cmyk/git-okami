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
    [c(2), c(4), c(6), c(8), c(10)],
    0
  ).awards;

  assert.deepEqual(amounts(result), { left: 8, right: 7 });
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
