import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "../src/db.js";
import { RoomStore } from "../src/roomStore.js";

test("finished hands keep showdown state and stop later auto actions", () => {
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

  assert.equal(room.status, "finished");
  assert.ok(room.engine);
  const snapshot = store.publicRoom(room.id, users[0].id);
  assert.equal(snapshot.status, "finished");
  assert.ok(snapshot.game);
  assert.equal(snapshot.game.currentTurnSeat, null);
  assert.equal(snapshot.game.winners.length > 0, true);
  assert.equal(room.seats.reduce((sum, seat) => sum + (seat?.chips ?? 0), 0), 4000);
  const token = store.createActionTimerToken(room, Date.now() + 1000);
  assert.equal(token, null);
  assert.equal(store.autoAction(room.id).status, "finished");
});

test("users must leave a room before creating or joining another", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const users = [0, 1, 2].map((index) => db.getOrCreateGuest(undefined, `M${index}`));
  const first = store.createRoom(users[0], "first");
  const second = store.createRoom(users[2], "second");
  const beforeVersion = first.version;

  assert.throws(() => store.createRoom(users[0], "other"), /Already in a room/);
  assert.throws(() => store.joinRoom(users[0], second.id), /Already in a room/);
  assert.equal(store.currentRoom(users[0].id)?.id, first.id);
  assert.equal(first.members.has(users[0].id), true);
  assert.equal(second.members.has(users[0].id), false);
  assert.equal(first.version, beforeVersion);

  const repeat = store.joinRoom(users[0], first.id);
  assert.equal(repeat.id, first.id);
  assert.equal(first.version, beforeVersion);
});

test("playing rooms reject create join and leave without mutating membership or chips", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const users = [0, 1, 2].map((index) => db.getOrCreateGuest(undefined, `G${index}`));
  const room = store.createRoom(users[0], "game", { minBuyIn: 1000, maxBuyIn: 1000 });
  store.joinRoom(users[1], room.id);
  store.sit(users[0], 0, 1000);
  store.sit(users[1], 1, 1000);
  store.setReady(users[0].id, true);
  store.setReady(users[1].id, true);
  store.startGame(users[0].id);
  const before = JSON.stringify(store.publicRoom(room.id, users[0].id));

  assert.throws(() => store.createRoom(users[0], "other"), /Already in a room/);
  assert.throws(() => store.joinRoom(users[0], store.createRoom(users[2], "other").id), /Already in a room/);
  assert.throws(() => store.leaveRoom(users[0].id), /Cannot leave during a hand/);
  assert.equal(JSON.stringify(store.publicRoom(room.id, users[0].id)), before);
  assert.equal(db.getUser(users[0].id)?.chips, 9000);
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

test("connection-only changes keep the existing deadline and turn token", () => {
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
  assert.equal(store.isActionTimerCurrent(oldToken), true);
  assert.equal(store.createActionTimerToken(room, Date.now() + 10_000)?.actionDeadlineAt, oldToken.actionDeadlineAt);
  const updated = store.autoActionIfCurrent(oldToken);
  assert.ok(updated);
  assert.notEqual(room.engine?.state.currentTurnSeat, currentTurnSeat);
  db.close();
});

test("repeated reconnect and voice changes do not extend the active deadline", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const users = [0, 1].map((index) => db.getOrCreateGuest(undefined, `V${index}`));
  const room = store.createRoom(users[0], "test", { minBuyIn: 1000, maxBuyIn: 1000 });
  store.joinRoom(users[1], room.id);
  users.forEach((user, seat) => {
    store.sit(user, seat, 1000);
    store.setReady(user.id, true);
  });

  store.startGame(users[0].id);
  const token = store.createActionTimerToken(room, Date.now() + 200)!;
  const currentTurnSeat = room.engine!.state.currentTurnSeat;
  const nonActor = room.engine!.state.players.find((player) => player.seat !== currentTurnSeat)!;

  for (let index = 0; index < 10; index += 1) {
    store.markConnected(nonActor.id, false);
    store.markConnected(nonActor.id, true);
  }
  store.joinVoice(nonActor.id);
  store.setVoiceSpeaking(nonActor.id, true);
  store.setVoiceSpeaking(nonActor.id, false);

  assert.equal(room.actionDeadlineAt, token.actionDeadlineAt);
  assert.equal(store.createActionTimerToken(room, Date.now() + 10_000)?.actionDeadlineAt, token.actionDeadlineAt);
  assert.equal(store.isActionTimerCurrent(token), true);
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

test("room rules reject malformed and unsafe input at runtime", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const user = db.getOrCreateGuest(undefined, "Rules");
  const invalidRules: unknown[] = [
    { bettingMode: "invalid" },
    { allowSpectators: "false" },
    { maxPlayers: 7 },
    { actionTimeoutSeconds: 9999 },
    { smallBlind: Number.NaN },
    { bigBlind: Number.POSITIVE_INFINITY },
    { smallBlind: [] },
    { minBuyIn: { value: 1000 } },
    { minBuyIn: Number.MAX_SAFE_INTEGER + 1 },
    { bigBlind: 10, smallBlind: 20 },
    { minBuyIn: 2000, maxBuyIn: 1000 },
    { maxBetPerRound: {} },
    { __proto__: { polluted: true } }
  ];

  for (const rules of invalidRules) {
    assert.throws(() => store.createRoom(user, "bad", rules as any), /Room rules/);
  }
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("allowSpectators blocks new spectators only while a hand is running", () => {
  const db = new AppDatabase(join(tmpdir(), `holdem-${randomUUID()}.db`));
  const store = new RoomStore(db);
  const users = [0, 1, 2, 3].map((index) => db.getOrCreateGuest(undefined, `S${index}`));
  const room = store.createRoom(users[0], "private", { minBuyIn: 1000, maxBuyIn: 1000, allowSpectators: false });
  store.joinRoom(users[1], room.id);
  store.joinRoom(users[2], room.id);
  store.sit(users[0], 0, 1000);
  store.sit(users[1], 1, 1000);
  store.setReady(users[0].id, true);
  store.setReady(users[1].id, true);
  store.startGame(users[0].id);

  assert.throws(() => store.joinRoom(users[3], room.id), /Spectators are not allowed/);
  assert.equal(room.members.has(users[2].id), true);
});
