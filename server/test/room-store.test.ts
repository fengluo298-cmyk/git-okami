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
