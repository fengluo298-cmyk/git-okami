import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ClientUpgradeRequiredError, guestLogin, register, login, verifyToken, isPasswordHash, parseClientBuild, readMinimumClientBuild, requireClientBuild } from "../src/auth.js";
import { AppDatabase, databaseFile } from "../src/db.js";
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
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMinBuild = process.env.MIN_CLIENT_BUILD;
  assert.throws(() => requireClientBuild(undefined, 2), ClientUpgradeRequiredError);
  assert.throws(() => requireClientBuild(1, 2), ClientUpgradeRequiredError);
  assert.throws(() => requireClientBuild("abc", 3), ClientUpgradeRequiredError);
  assert.throws(() => requireClientBuild(Number.NaN, 3), ClientUpgradeRequiredError);
  assert.throws(() => requireClientBuild(Number.POSITIVE_INFINITY, 3), ClientUpgradeRequiredError);
  assert.throws(() => requireClientBuild("2.5", 3), ClientUpgradeRequiredError);
  assert.doesNotThrow(() => requireClientBuild("2", 2));
  assert.throws(() => requireClientBuild(2, 3), /Client version/);
  assert.doesNotThrow(() => requireClientBuild(3, 3));
  assert.doesNotThrow(() => requireClientBuild(4, 3));
  assert.equal(parseClientBuild(""), null);
  assert.equal(parseClientBuild("-1"), null);
  assert.equal(readMinimumClientBuild("3"), 3);
  assert.throws(() => readMinimumClientBuild("bad"), /MIN_CLIENT_BUILD/);
  try {
    process.env.NODE_ENV = "development";
    delete process.env.MIN_CLIENT_BUILD;
    assert.equal(readMinimumClientBuild(), 2);

    process.env.NODE_ENV = "production";
    delete process.env.MIN_CLIENT_BUILD;
    assert.throws(() => readMinimumClientBuild(), /MIN_CLIENT_BUILD/);
  } finally {
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("MIN_CLIENT_BUILD", originalMinBuild);
  }
});

test("register validates username shape and password length", async () => {
  const db = testDb();

  await assert.rejects(() => register(db, { username: "bad name", password: "secret1" }), /Username can only use/);
  await assert.rejects(() => register(db, { username: "a".repeat(33), password: "secret1" }), /Username can only use/);
  await assert.rejects(() => register(db, { username: "valid_name", password: "x".repeat(129) }), /Password is too long/);
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

test("sqlite file keeps users after database reopen", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "holdem-")), "persist.db");
  const first = new AppDatabase(file);
  const { user } = await register(first, { username: "persist", password: "secret1", nickname: "Persist" });
  first.adjustUserChips(user.id, -500, "admin_adjust");
  first.close();

  const second = new AppDatabase(file);
  assert.equal(second.getUser(user.id)?.username, "persist");
  assert.equal(second.getUser(user.id)?.chips, 9500);
  second.close();
});

test("sqlite enables durability pragmas and rejects unknown future schema", () => {
  const file = join(mkdtempSync(join(tmpdir(), "holdem-")), "pragma.db");
  const db = new AppDatabase(file);
  assert.throws(() => db.logChipTransaction("missing", "win_pot", 1, 0, 1), /constraint/i);
  db.close();

  const raw = new DatabaseSync(file);
  assert.equal((raw.prepare("pragma journal_mode").get() as { journal_mode: string }).journal_mode.toLowerCase(), "wal");
  raw.exec("insert into schema_migrations (version) values (999)");
  raw.close();

  assert.throws(() => new AppDatabase(file), /schema is newer/);
});

test("production database refuses temp and memory paths", () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => new AppDatabase("/tmp/holdem.db"), /must not use \/tmp/);
    assert.throws(() => new AppDatabase(":memory:"), /in-memory/);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test("database path prefers DATABASE_PATH and keeps legacy fallbacks", () => {
  const originalPath = process.env.DATABASE_PATH;
  const originalUrl = process.env.DATABASE_URL;
  const originalDbFile = process.env.DB_FILE;
  try {
    process.env.DATABASE_PATH = "DATABASE_PATH=/var/data/main.db";
    process.env.DATABASE_URL = "/var/data/legacy.db";
    process.env.DB_FILE = "/var/data/dbfile.db";
    assert.equal(databaseFile(), "/var/data/main.db");

    delete process.env.DATABASE_PATH;
    process.env.DATABASE_URL = "DATABASE_URL=/var/data/legacy.db";
    assert.equal(databaseFile(), "/var/data/legacy.db");

    delete process.env.DATABASE_URL;
    assert.equal(databaseFile(), "/var/data/dbfile.db");
  } finally {
    restoreEnv("DATABASE_PATH", originalPath);
    restoreEnv("DATABASE_URL", originalUrl);
    restoreEnv("DB_FILE", originalDbFile);
  }
});

function testDb(): AppDatabase {
  return new AppDatabase(join(mkdtempSync(join(tmpdir(), "holdem-")), "test.db"));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
