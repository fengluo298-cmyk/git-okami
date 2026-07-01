import test from "node:test";
import assert from "node:assert/strict";
import { compareHands, evaluateHand } from "../src/game/handEvaluator.js";
import type { Card, Rank, Suit } from "../src/game/cards.js";

test("detects every holdem hand category", () => {
  assertHand("Royal flush", [c(10, "H"), c(11, "H"), c(12, "H"), c(13, "H"), c(14, "H"), c(2), c(3)]);
  assertHand("Straight flush", [c(5, "S"), c(6, "S"), c(7, "S"), c(8, "S"), c(9, "S"), c(14), c(2)]);
  assertHand("Four of a kind", [c(9), c(9, "H"), c(9, "D"), c(9, "C"), c(2), c(3), c(4)]);
  assertHand("Full house", [c(8), c(8, "H"), c(8, "D"), c(4), c(4, "H"), c(2), c(3)]);
  assertHand("Flush", [c(2, "C"), c(5, "C"), c(8, "C"), c(11, "C"), c(13, "C"), c(3), c(4)]);
  assertHand("Straight", [c(14), c(13, "H"), c(12, "D"), c(11, "C"), c(10), c(2, "H"), c(3, "D")]);
  assertHand("Three of a kind", [c(7), c(7, "H"), c(7, "D"), c(12), c(2, "H"), c(3, "D"), c(4, "C")]);
  assertHand("Two pair", [c(6), c(6, "H"), c(3), c(3, "H"), c(14), c(2, "D"), c(4, "C")]);
  assertHand("One pair", [c(6), c(6, "H"), c(3), c(8, "H"), c(14), c(2, "D"), c(4, "C")]);
  assertHand("High card", [c(2), c(6, "H"), c(9, "D"), c(11, "C"), c(14), c(3, "H"), c(4, "D")]);
});

test("uses the best five cards from seven", () => {
  assert.deepEqual(evaluateHand([c(14), c(14, "H"), c(14, "D"), c(13), c(13, "H"), c(2), c(2, "H")]).ranks, [14, 13]);
  assert.deepEqual(evaluateHand([c(14, "C"), c(12, "C"), c(9, "C"), c(7, "C"), c(4, "C"), c(2, "C"), c(13)]).ranks, [14, 12, 9, 7, 4]);
  assert.deepEqual(evaluateHand([c(14), c(2), c(3), c(4), c(5), c(9), c(13)]).ranks, [5]);
});

test("compares kickers and made hands correctly", () => {
  assert.ok(compareHands(evaluateHand([c(14), c(14, "H"), c(13), c(9), c(8), c(7), c(2)]), evaluateHand([c(14), c(14, "D"), c(12), c(9), c(8), c(7), c(2)])) > 0);
  assert.ok(compareHands(evaluateHand([c(12), c(12, "H"), c(8), c(8, "H"), c(14), c(3), c(2)]), evaluateHand([c(12), c(12, "D"), c(7), c(7, "D"), c(14), c(3), c(2)])) > 0);
  assert.ok(compareHands(evaluateHand([c(6), c(6, "H"), c(6, "D"), c(14), c(13), c(2), c(3)]), evaluateHand([c(6), c(6, "C"), c(6, "S"), c(14), c(12), c(2), c(3)])) > 0);
  assert.equal(compareHands(evaluateHand([c(10), c(10, "H"), c(9), c(9, "H"), c(14), c(2, "D"), c(3, "C")]), evaluateHand([c(10, "D"), c(10, "C"), c(9, "D"), c(9, "C"), c(14, "H"), c(2), c(3, "H")])), 0);
});

function assertHand(name: string, cards: Card[]): void {
  assert.equal(evaluateHand(cards).name, name);
}

function c(rank: Rank, suit: Suit = "S"): Card {
  return { rank, suit };
}
