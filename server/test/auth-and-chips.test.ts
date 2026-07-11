import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guestLogin, register, login, verifyToken, isPasswordHash, requireClientBuild } from "../src/auth.js";
import { AppDatabase } from "../src/db.js";
import { RoomStore } from "../src/roomStore.js";

test("register stores a bcrypt hash, rejects duplicates, and login returns a valid token", async () => {
  const db = testDb();
  const session = await register(db, { username: "Alice", password: "secret1", nickname: "Alice" });
  const row = db.findByUsername("alice");

  assert.ok(row?.passwordHash);
  assert.ok(isPasswordHash(row.passwordHash));
  assert.notEqual(row.passwordHash, "secret1");
  assert.equal("passwordHash" in (db.getUser(session.user.id) ?? {}), false);
  assert.equal(verifyToken(db, session.token).id, session.user.id);
  assert.equal((await login(db, { username: "alice", password: "secret1" })).user.id, session.user.id);
  await assert.rejects(() => register(db, { username: "ALICE", password: "secret1", nickname: "Other" }), /already exists/);
});

test("guest login creates a token-backed virtual chip user", () => {
  const db = testDb();
  const session = guestLogin(db, { nickname: "Guest" });

  assert.equal(session.user.username, null);
  assert.equal(session.user.nickname, "Guest");
  assert.equal(session.user.chips, 10000);
  assert.equal(verifyToken(db, session.token).id, session.user.id);
});

test("client build gate rejects old app versions", () => {
  assert.throws(() => requireClientBuild(undefined, 2), /Client version/);
  assert.throws(() => requireClientBuild(1, 2), /Client version/);
  assert.doesNotThrow(() => requireClientBuild(2, 2));
});

test("buy-in removes bank chips and cash-out restores table chips once", async () => {
  const db = testDb();
  const { user } = await register(db, { username: "bob", password: "secret1", nickname: "Bob" });
  const rooms = new RoomStore(db);
  const room = rooms.createRoom(user);
  rooms.joinRoom(user, room.id);

  rooms.sit(user, 0, 1000);
  assert.equal(db.getUser(user.id)?.chips, 9000);
  assert.equal(rooms.publicRoom(room.id, user.id).seats[0]?.chips, 1000);

  rooms.leaveSeat(user.id);
  assert.equal(db.getUser(user.id)?.chips, 10000);
  assert.equal(rooms.publicRoom(room.id, user.id).seats[0], null);
  assert.deepEqual(
    db.getChipTransactions(user.id).map((tx) => [tx.type, tx.amount, tx.before_chips, tx.after_chips]),
    [
      ["buy_in", -1000, 10000, 9000],
      ["cash_out", 1000, 9000, 10000]
    ]
  );
});

test("hand settlement logs table win and loss without changing bank chips", async () => {
  const db = testDb();
  const a = (await register(db, { username: "a", password: "secret1", nickname: "A" })).user;
  const b = (await register(db, { username: "b", password: "secret1", nickname: "B" })).user;
  const rooms = new RoomStore(db);
  const room = rooms.createRoom(a);
  rooms.joinRoom(b, room.id);
  rooms.sit(a, 0, 1000);
  rooms.sit(b, 1, 1000);
  rooms.setReady(a.id, true);
  rooms.setReady(b.id, true);
  rooms.startGame(a.id);

  rooms.action(a.id, "fold");

  assert.equal(db.getUser(a.id)?.chips, 9000);
  assert.equal(db.getUser(b.id)?.chips, 9000);
  assert.equal(db.getChipTransactions(a.id).some((tx) => tx.type === "lose_bet" && tx.amount < 0), true);
  assert.equal(db.getChipTransactions(b.id).some((tx) => tx.type === "win_pot" && tx.amount > 0), true);
});

function testDb(): AppDatabase {
  return new AppDatabase(join(mkdtempSync(join(tmpdir(), "holdem-")), "test.db"));
}
