import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "../src/db.js";
import { RoomStore } from "../src/roomStore.js";

test("finished hands clear the table and stop later auto actions", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const users = [0, 1, 2, 3].map((index) => db.getOrCreateGuest(undefined, `P${index}`));
  const room = store.createRoom(users[0], "test", { minBuyIn: 1000, maxBuyIn: 1000, smallBlind: 10, bigBlind: 20, actionTimeoutSeconds: 1 });

  users.slice(1).forEach((user) => store.joinRoom(user, room.id));
  users.forEach((user, seat) => {
    store.sit(user, seat, 1000);
    store.setReady(user.id, true);
  });

  store.startGame(users[0].id);
  store.action(users[3].id, "fold");
  store.action(users[0].id, "fold");
  store.action(users[1].id, "fold");
  store.autoAction(room.id);

  assert.equal(room.status, "lobby");
  assert.equal(room.engine, null);
  assert.equal(store.publicRoom(room.id, users[0].id).game, null);
  assert.equal(room.seats.reduce((sum, seat) => sum + (seat?.chips ?? 0), 0), 4000);
});

test("room state version increments and rejects stale actions", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const user = db.getOrCreateGuest(undefined, "P0");
  const room = store.createRoom(user);
  const firstVersion = store.publicRoom(room.id, user.id).stateVersion;

  store.sit(user, 0, 1000);
  assert.equal(store.publicRoom(room.id, user.id).stateVersion > firstVersion, true);
  assert.throws(() => store.assertFresh(user.id, firstVersion), /State version is stale/);
  assert.doesNotThrow(() => store.assertFresh(user.id, store.publicRoom(room.id, user.id).stateVersion));
  db.close();
});

test("public room snapshots are immutable per viewer and hide private cards", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const users = [0, 1, 2].map((index) => db.getOrCreateGuest(undefined, `P${index}`));
  const room = store.createRoom(users[0], "test", { minBuyIn: 1000, maxBuyIn: 1000 });
  store.joinRoom(users[1], room.id);
  store.joinRoom(users[2], room.id);
  store.sit(users[0], 0, 1000);
  store.sit(users[1], 1, 1000);
  store.setReady(users[0].id, true);
  store.setReady(users[1].id, true);
  store.startGame(users[0].id);

  const alpha = store.publicRoom(room.id, users[0].id);
  const beta = store.publicRoom(room.id, users[1].id);
  const spectator = store.publicRoom(room.id, users[2].id);
  const alphaHand = room.engine!.state.players.find((player) => player.id === users[0].id)!.hand;
  const betaHand = room.engine!.state.players.find((player) => player.id === users[1].id)!.hand;
  const serialized = JSON.stringify({ alpha, beta, spectator });

  assert.equal("deck" in alpha.game!, false);
  for (const forbidden of ["deck", "remainingDeck", "burnedCards", "random", "timerGeneration", "settledHandIds", "members", "actionId"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(alpha.game!.players.find((player) => player.id === users[0].id)?.hand?.length, 2);
  assert.equal(alpha.game!.players.find((player) => player.id === users[1].id)?.hand, undefined);
  assert.equal(beta.game!.players.find((player) => player.id === users[1].id)?.hand?.length, 2);
  assert.equal(beta.game!.players.find((player) => player.id === users[0].id)?.hand, undefined);
  assert.equal(spectator.game!.players.some((player) => player.hand), false);
  assert.equal(JSON.stringify(alpha).includes(JSON.stringify(betaHand)), false);
  assert.equal(JSON.stringify(beta).includes(JSON.stringify(alphaHand)), false);
  assert.equal(JSON.stringify(spectator).includes(JSON.stringify(alphaHand)), false);
  assert.equal(JSON.stringify(spectator).includes(JSON.stringify(betaHand)), false);

  const boardLength = alpha.game!.board.length;
  const chips = alpha.seats[0]!.chips;
  room.engine!.state.board.push({ rank: 14, suit: "S" });
  room.seats[0]!.chips += 1;
  assert.equal(alpha.game!.board.length, boardLength);
  assert.equal(alpha.seats[0]!.chips, chips);
  db.close();
});

test("connection-only changes require a fresh timer without advancing the turn", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const users = [0, 1].map((index) => db.getOrCreateGuest(undefined, `C${index}`));
  const room = store.createRoom(users[0], "test", { minBuyIn: 1000, maxBuyIn: 1000 });
  store.joinRoom(users[1], room.id);
  users.forEach((user, seat) => {
    store.sit(user, seat, 1000);
    store.setReady(user.id, true);
  });

  store.startGame(users[0].id);
  const currentTurnSeat = room.engine!.state.currentTurnSeat;
  const nonActor = room.engine!.state.players.find((player) => player.seat !== currentTurnSeat)!;
  const oldToken = store.createActionTimerToken(room, Date.now() + 1000)!;

  store.markConnected(nonActor.id, false);
  assert.equal(room.engine!.state.currentTurnSeat, currentTurnSeat);
  assert.equal(store.autoActionIfCurrent(oldToken), null);
  assert.equal(room.engine!.state.currentTurnSeat, currentTurnSeat);

  const freshToken = store.createActionTimerToken(room, Date.now() + 1000)!;
  const updated = store.autoActionIfCurrent(freshToken);
  assert.ok(updated);
  assert.equal(room.status, "lobby");
  assert.equal(room.engine, null);
  db.close();
});

test("room hand ids advance across hands and stale timer tokens cannot auto act", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const users = [0, 1].map((index) => db.getOrCreateGuest(undefined, `T${index}`));
  const room = store.createRoom(users[0], "test", { minBuyIn: 1000, maxBuyIn: 1000 });
  store.joinRoom(users[1], room.id);
  users.forEach((user, seat) => {
    store.sit(user, seat, 1000);
    store.setReady(user.id, true);
  });

  store.startGame(users[0].id);
  assert.equal(store.publicRoom(room.id, users[0].id).handId, 1);
  const staleTimer = store.createActionTimerToken(room, Date.now() + 1000);
  const actor = room.engine!.state.players.find((player) => player.seat === room.engine!.state.currentTurnSeat)!;
  store.action(actor.id, "call");
  const afterActionVersion = store.publicRoom(room.id, users[0].id).stateVersion;
  assert.equal(store.autoActionIfCurrent(staleTimer!), null);
  assert.equal(store.publicRoom(room.id, users[0].id).stateVersion, afterActionVersion);

  while (room.status === "playing") {
    const next = room.engine!.state.players.find((player) => player.seat === room.engine!.state.currentTurnSeat)!;
    const actions = room.engine!.getPublicState(next.id).availableActions!;
    store.action(next.id, actions.canCheck ? "check" : "call");
  }
  users.forEach((user) => store.setReady(user.id, true));
  store.startGame(users[0].id);
  assert.equal(store.publicRoom(room.id, users[0].id).handId, 2);
  db.close();
});
