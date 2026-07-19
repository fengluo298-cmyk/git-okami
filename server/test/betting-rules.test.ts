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

test("short all-in does not reopen raises and rejected raise leaves state unchanged", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([100, 25, 100, 100]), { dealerSeat: 0, deck: deck() });

  engine.executeAction("p3", "call");
  engine.executeAction("p0", "call");
  engine.executeAction("p1", "all-in");
  engine.executeAction("p2", "call");

  assert.equal(engine.state.currentTurnSeat, 3);
  assert.equal(engine.getPublicState("p3").availableActions?.canRaise, false);
  assert.equal(engine.getPublicState("p3").availableActions?.canCall, true);
  const before = snapshot(engine);
  assert.throws(() => engine.executeAction("p3", "raise", 45), /not reopened/);
  assert.equal(snapshot(engine), before);
  engine.executeAction("p3", "call");

  const foldEngine = shortAllInSpot();
  foldEngine.executeAction("p3", "fold");
  assert.equal(player(foldEngine, "p3").folded, true);
});

test("full raise reopens raises for players who already acted", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([200, 200, 200, 200]), { dealerSeat: 0, deck: deck() });

  engine.executeAction("p3", "call");
  engine.executeAction("p0", "call");
  engine.executeAction("p1", "raise", 40);
  engine.executeAction("p2", "call");

  assert.equal(engine.state.currentTurnSeat, 3);
  assert.equal(engine.getPublicState("p3").availableActions?.canRaise, true);
  engine.executeAction("p3", "raise", 60);
  assert.equal(player(engine, "p3").bet, 60);
});

test("new betting streets reset prior action flags through flop turn and river", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([500, 500, 500]), { dealerSeat: 0, deck: deck() });

  engine.executeAction("p0", "call");
  engine.executeAction("p1", "call");
  engine.executeAction("p2", "check");
  assertNewStreet(engine, "flop", 1);

  engine.executeAction("p1", "check");
  engine.executeAction("p2", "check");
  engine.executeAction("p0", "check");
  assertNewStreet(engine, "turn", 1);

  engine.executeAction("p1", "check");
  engine.executeAction("p2", "check");
  engine.executeAction("p0", "check");
  assertNewStreet(engine, "river", 1);
});

test("multiple short all-ins do not cumulatively reopen raises and reset on the next street", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([100, 25, 35, 100]), { dealerSeat: 0, deck: deck() });

  engine.executeAction("p3", "call");
  engine.executeAction("p0", "call");
  engine.executeAction("p1", "all-in");
  engine.executeAction("p2", "all-in");

  assert.equal(engine.state.currentTurnSeat, 3);
  assert.equal(engine.getPublicState("p3").availableActions?.canRaise, false);
  const before = snapshot(engine);
  assert.throws(() => engine.executeAction("p3", "raise", 55), /not reopened/);
  assert.equal(snapshot(engine), before);

  engine.executeAction("p3", "call");
  engine.executeAction("p0", "call");
  assertNewStreet(engine, "flop", 3);
});

test("heads-up short all-in skips all-in players and ends the betting round after response", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([25, 100]), { dealerSeat: 0, deck: deck() });

  assert.equal(engine.state.currentTurnSeat, 0);
  engine.executeAction("p0", "all-in");
  assert.equal(player(engine, "p0").allIn, true);
  assert.equal(engine.state.currentTurnSeat, 1);

  engine.executeAction("p1", "call");
  assertNewStreet(engine, "flop", 1);
  engine.executeAction("p1", "check");
  assertNewStreet(engine, "turn", 1);
  engine.executeAction("p1", "check");
  assertNewStreet(engine, "river", 1);
  engine.executeAction("p1", "check");
  assert.equal(engine.state.street, "finished");
});

test("folded players cannot act and timeout folds when check is unavailable", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([100, 100, 100]), { dealerSeat: 0, deck: deck() });

  engine.executeAction("p0", "fold");
  assert.throws(() => engine.executeAction("p0", "call"), /turn|Folded/);

  engine.autoAction();
  assert.equal(engine.state.players.find((player) => player.id === "p1")?.folded, true);
});

test("engine rejects invalid actions and unsafe bet amounts without changing chips", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([100, 100]), { dealerSeat: 0, deck: deck() });
  const before = engine.state.players.map((player) => [player.id, player.chips, player.bet, player.totalBet]);

  assert.throws(() => engine.executeAction("p0", "noop" as never), /Invalid action/);
  for (const amount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => engine.executeAction("p0", "raise", amount), /safe positive integer|exceed|Not enough/);
  }
  assert.deepEqual(engine.state.players.map((player) => [player.id, player.chips, player.bet, player.totalBet]), before);
});

test("engine accepts deterministic random injection for shuffling", () => {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([100, 100]), { dealerSeat: 0, random: () => 0 });

  assert.equal(engine.state.deck.length, 48);
  assert.equal(new Set(engine.state.players.flatMap((player) => player.hand).map((card) => `${card.rank}${card.suit}`)).size, 4);
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

function shortAllInSpot(): GameEngine {
  const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
  engine.startHand(players([100, 25, 100, 100]), { dealerSeat: 0, deck: deck() });
  engine.executeAction("p3", "call");
  engine.executeAction("p0", "call");
  engine.executeAction("p1", "all-in");
  engine.executeAction("p2", "call");
  return engine;
}

function player(engine: GameEngine, id: string) {
  const found = engine.state.players.find((candidate) => candidate.id === id);
  assert.ok(found);
  return found;
}

function assertNewStreet(engine: GameEngine, street: "flop" | "turn" | "river", currentTurnSeat: number): void {
  assert.equal(engine.state.street, street);
  assert.equal(engine.state.currentBet, 0);
  assert.equal(engine.state.currentTurnSeat, currentTurnSeat);
  for (const candidate of engine.state.players.filter((entry) => !entry.folded && !entry.allIn)) {
    assert.equal(candidate.acted, false);
  }
  assert.equal(engine.getPublicState(playerAtSeat(engine, currentTurnSeat).id).availableActions?.canBet, true);
}

function playerAtSeat(engine: GameEngine, seat: number) {
  const found = engine.state.players.find((candidate) => candidate.seat === seat);
  assert.ok(found);
  return found;
}

function snapshot(engine: GameEngine): string {
  return JSON.stringify(engine.state);
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
