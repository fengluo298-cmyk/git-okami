import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine, type StartPlayer } from "../src/game/gameEngine.js";
import type { Card, Rank, Suit } from "../src/game/cards.js";

test("no-limit rejects bets above the player stack", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([100, 100]), { dealerSeat: 0, deck: deck() });

  assert.throws(() => engine.executeAction("p0", "raise", 101), /exceed|Not enough/);
});

test("pot-limit caps the raise target at the pot-limit amount", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "pot_limit" });
  engine.startHand(players([500, 500]), { dealerSeat: 0, deck: deck() });

  assert.throws(() => engine.executeAction("p0", "raise", 61), /exceed/);
  engine.executeAction("p0", "raise", 60);
  assert.equal(engine.state.players.find((player) => player.id === "p0")?.bet, 60);
});

test("fixed-limit only allows the fixed bet size", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "fixed_limit" });
  engine.startHand(players([500, 500]), { dealerSeat: 0, deck: deck() });

  assert.throws(() => engine.executeAction("p0", "raise", 60), /Fixed-limit|exceed/);
  engine.executeAction("p0", "raise", 40);
  assert.equal(engine.state.players.find((player) => player.id === "p0")?.bet, 40);
});

test("minimum raise is enforced, but short all-in is allowed without reopening action", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([100, 25, 100]), { dealerSeat: 0, deck: deck() });

  assert.throws(() => engine.executeAction("p0", "raise", 30), /minimum/);
  engine.executeAction("p0", "call");
  engine.executeAction("p1", "all-in");
  assert.equal(engine.state.players.find((player) => player.id === "p1")?.allIn, true);
});

test("folded players cannot act and timeout folds when check is unavailable", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([100, 100, 100]), { dealerSeat: 0, deck: deck() });

  engine.executeAction("p0", "fold");
  assert.throws(() => engine.executeAction("p0", "call"), /turn|Folded/);

  engine.autoAction();
  assert.equal(engine.state.players.find((player) => player.id === "p1")?.folded, true);
});

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

function c(rank: Rank, suit: Suit = "S"): Card {
  return { rank, suit };
}

function deck(): Card[] {
  const cards: Card[] = [];
  const seen = new Set<string>();
  for (const suit of ["S", "H", "D", "C"] as Suit[]) {
    for (let rank = 2; rank <= 14; rank += 1) {
      const card = c(rank as Rank, suit);
      const key = `${card.rank}${card.suit}`;
      if (!seen.has(key)) {
        seen.add(key);
        cards.push(card);
      }
    }
  }
  return cards;
}
