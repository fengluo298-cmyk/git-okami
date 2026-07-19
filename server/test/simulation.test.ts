import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine, potTotal, type StartPlayer } from "../src/game/gameEngine.js";
import { cardCode } from "../src/game/cards.js";

test("fixed-seed random hands preserve core invariants", () => {
  const failures: Array<{ seed: number; step: number; action: string }> = [];
  for (let seed = 1; seed <= 5000; seed += 1) {
    const random = lcg(seed);
    const playerCount = 2 + Math.floor(random() * 5);
    const startingChips = 1000;
    const engine = new GameEngine({ smallBlind: 10, bigBlind: 20, minRaise: 20, bettingMode: "no_limit" });
    const players = Array.from({ length: playerCount }, (_, seat): StartPlayer => ({ id: `p${seat}`, nickname: `P${seat}`, avatar: `P${seat}`, seat, chips: startingChips, connected: true }));
    engine.startHand(players, { dealerSeat: Math.floor(random() * playerCount), random });
    let lastAction = "start";

    try {
      for (let step = 0; step < 100 && engine.state.street !== "finished"; step += 1) {
        checkInvariants(engine, playerCount * startingChips);
        const actor = engine.state.players.find((player) => player.seat === engine.state.currentTurnSeat);
        assert.ok(actor);
        const actions = engine.getPublicState(actor.id).availableActions;
        assert.ok(actions);
        const action = chooseAction(actions, random);
        lastAction = `${actor.id}:${JSON.stringify(action)}`;
        engine.executeAction(actor.id, action.type, action.amount);
      }
      checkInvariants(engine, playerCount * startingChips);
      assert.equal(engine.state.street, "finished");
    } catch (error) {
      failures.push({ seed, step: failures.length, action: lastAction });
      throw error;
    }
  }
  assert.deepEqual(failures, []);
});

function checkInvariants(engine: GameEngine, totalChips: number): void {
  const cards = [...engine.state.deck, ...engine.state.board, ...engine.state.players.flatMap((player) => player.hand)].map(cardCode);
  assert.equal(new Set(cards).size, cards.length);
  assert.equal(cards.length, 52);
  for (const player of engine.state.players) {
    assert.equal(player.chips >= 0, true);
    assert.equal(player.bet >= 0, true);
    assert.equal(player.totalBet >= 0, true);
  }
  const stacks = engine.state.players.reduce((sum, player) => sum + player.chips, 0);
  if (engine.state.street === "finished") assert.equal(stacks, totalChips);
  else assert.equal(stacks + potTotal(engine.state.players), totalChips);
  if (engine.state.currentTurnSeat !== null) {
    const current = engine.state.players.find((player) => player.seat === engine.state.currentTurnSeat);
    assert.ok(current);
    assert.equal(!current.folded && !current.allIn && current.chips > 0, true);
  }
}

function chooseAction(actions: NonNullable<ReturnType<GameEngine["getPublicState"]>["availableActions"]>, random: () => number): { type: "fold" | "check" | "call" | "bet" | "raise" | "all-in"; amount?: number } {
  const choices: Array<{ type: "fold" | "check" | "call" | "bet" | "raise" | "all-in"; amount?: number }> = [{ type: "fold" }];
  if (actions.canCheck) choices.push({ type: "check" });
  if (actions.canCall) choices.push({ type: "call" });
  if (actions.canBet) choices.push({ type: "bet", amount: actions.minRaiseTo });
  if (actions.canRaise) choices.push({ type: "raise", amount: actions.minRaiseTo });
  if (actions.canAllIn) choices.push({ type: "all-in" });
  return choices[Math.floor(random() * choices.length)];
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
