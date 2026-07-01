import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHand } from "../src/game/handEvaluator.js";
import { GameEngine, settlePots, type EnginePlayer, type StartPlayer } from "../src/game/gameEngine.js";
import type { Card, Rank, Suit } from "../src/game/cards.js";

test("evaluates all holdem hand categories", () => {
  assert.equal(evaluateHand([c(10, "H"), c(11, "H"), c(12, "H"), c(13, "H"), c(14, "H")]).category, 10);
  assert.equal(evaluateHand([c(5, "S"), c(6, "S"), c(7, "S"), c(8, "S"), c(9, "S")]).category, 9);
  assert.equal(evaluateHand([c(9), c(9, "H"), c(9, "D"), c(9, "C"), c(2)]).category, 8);
  assert.equal(evaluateHand([c(8), c(8, "H"), c(8, "D"), c(4), c(4, "H")]).category, 7);
  assert.equal(evaluateHand([c(2, "C"), c(5, "C"), c(8, "C"), c(11, "C"), c(13, "C")]).category, 6);
  assert.equal(evaluateHand([c(14), c(2), c(3), c(4), c(5)]).ranks[0], 5);
  assert.equal(evaluateHand([c(7), c(7, "H"), c(7, "D"), c(12), c(2)]).category, 4);
  assert.equal(evaluateHand([c(6), c(6, "H"), c(3), c(3, "H"), c(14)]).category, 3);
  assert.equal(evaluateHand([c(6), c(6, "H"), c(3), c(8), c(14)]).category, 2);
  assert.equal(evaluateHand([c(2), c(6, "H"), c(9), c(11), c(14)]).category, 1);
});

test("folding awards the whole pot to the last live player", () => {
  const engine = new GameEngine({ small: 10, big: 20 });
  engine.startHand(players([100, 100]), { dealerSeat: 0, deck: predictableDeck() });

  engine.executeAction("p0", "fold");

  assert.equal(engine.state.street, "finished");
  assert.equal(engine.state.players.find((player) => player.id === "p0")?.chips, 90);
  assert.equal(engine.state.players.find((player) => player.id === "p1")?.chips, 110);
});

test("heads-up all-in runs the board and preserves chips", () => {
  const engine = new GameEngine({ small: 10, big: 20 });
  engine.startHand(players([50, 50]), { dealerSeat: 0, deck: predictableDeck() });

  engine.executeAction("p0", "all-in");
  engine.executeAction("p1", "call");

  assert.equal(engine.state.street, "finished");
  assert.equal(engine.state.board.length, 5);
  assert.equal(engine.state.players.reduce((sum, player) => sum + player.chips, 0), 100);
});

test("side pots pay each capped pot to eligible winners", () => {
  const playersForPot = [
    enginePlayer("a", 0, [c(14), c(14, "H")], 100),
    enginePlayer("b", 1, [c(13), c(13, "H")], 200),
    enginePlayer("c", 2, [c(2), c(3, "D")], 300)
  ];
  const board = [c(14, "D"), c(7), c(7, "H"), c(9), c(10)] as Card[];

  const result = settlePots(playersForPot, board, 0).awards;

  assert.deepEqual(
    Object.fromEntries(result.map((award) => [award.playerId, award.amount])),
    { a: 300, b: 200, c: 100 }
  );
});

function c(rank: Rank, suit: Suit = "S"): Card {
  return { rank, suit };
}

function players(chips: number[]): StartPlayer[] {
  return chips.map((stack, seat) => ({
    id: `p${seat}`,
    nickname: `P${seat}`,
    avatar: `P${seat}`,
    chips: stack,
    connected: true,
    seat
  }));
}

function enginePlayer(id: string, seat: number, hand: Card[], totalBet: number): EnginePlayer {
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
    folded: false,
    allIn: true,
    acted: true
  };
}

function predictableDeck(): Card[] {
  const deck: Card[] = [];
  const seen = new Set<string>();
  const push = (card: Card) => {
    const key = `${card.rank}${card.suit}`;
    if (!seen.has(key)) {
      seen.add(key);
      deck.push(card);
    }
  };
  for (const suit of ["S", "H", "D", "C"] as Suit[]) {
    for (let rank = 2; rank <= 14; rank += 1) push(c(rank as Rank, suit));
  }
  return deck;
}
