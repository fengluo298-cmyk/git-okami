import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ClientUpgradeRequiredError, CURRENT_PROTOCOL_BUILD, guestLogin, register, login, verifyToken, isPasswordHash, parseClientBuild, readMinimumClientBuild, requireClientBuild } from "../src/auth.js";
import { AppDatabase, databaseFile } from "../src/db.js";
import { RoomStore, type Room } from "../src/roomStore.js";

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
  try {
    process.env.NODE_ENV = "development";
    delete process.env.MIN_CLIENT_BUILD;
    assert.equal(readMinimumClientBuild(), CURRENT_PROTOCOL_BUILD);

    process.env.NODE_ENV = "production";
    delete process.env.MIN_CLIENT_BUILD;
    assert.equal(readMinimumClientBuild(), CURRENT_PROTOCOL_BUILD);
  } finally {
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("MIN_CLIENT_BUILD", originalMinBuild);
  }

  assert.throws(() => requireClientBuild(undefined, 3), ClientUpgradeRequiredError);
  assert.throws(() => requireClientBuild(2, 3), /Client version/);
  assert.doesNotThrow(() => requireClientBuild(3, 3));
  assert.doesNotThrow(() => requireClientBuild(4, 3));
  assert.throws(() => requireClientBuild(3, 4), ClientUpgradeRequiredError);
  assert.doesNotThrow(() => requireClientBuild(4, 4));

  assert.equal(parseClientBuild(""), null);
  assert.equal(parseClientBuild("0"), null);
  assert.equal(parseClientBuild("-1"), null);
  assert.equal(parseClientBuild("2.5"), null);
  assert.equal(parseClientBuild(Number.NaN), null);
  assert.equal(parseClientBuild(Number.POSITIVE_INFINITY), null);
  assert.equal(parseClientBuild(String(Number.MAX_SAFE_INTEGER + 1)), null);
  assert.equal(readMinimumClientBuild("3"), 3);
  assert.equal(readMinimumClientBuild("4"), 4);
  for (const value of ["", "   ", "abc", "NaN", "Infinity", "2.5", "0", "-1", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => readMinimumClientBuild(value), /MIN_CLIENT_BUILD/);
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
  assert.equal(db.getTableEscrow(user.id)?.chips, 1000);
  assert.equal(rooms.publicRoom(room.id, user.id).seats[0]?.chips, 1000);

  rooms.leaveSeat(user.id);
  assert.equal(db.getUser(user.id)?.chips, 10000);
  assert.equal(db.getTableEscrow(user.id), null);
  assert.equal(rooms.publicRoom(room.id, user.id).seats[0], null);
  rooms.leaveSeat(user.id);
  assert.equal(db.getUser(user.id)?.chips, 10000);
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
  assert.equal(db.getTableEscrow(a.id)?.chips, rooms.publicRoom(room.id, a.id).seats[0]?.chips);
  assert.equal(db.getTableEscrow(b.id)?.chips, rooms.publicRoom(room.id, b.id).seats[1]?.chips);
  assert.equal(db.getTableEscrow(a.id)?.last_hand_id, room.handId);
  assert.equal(db.getTableEscrow(b.id)?.last_hand_id, room.handId);
  assert.equal(db.getChipTransactions(a.id).some((tx) => tx.type === "lose_bet" && tx.amount < 0), true);
  assert.equal(db.getChipTransactions(b.id).some((tx) => tx.type === "win_pot" && tx.amount > 0), true);
  assert.equal(db.getChipTransactions(a.id).find((tx) => tx.type === "buy_in")?.balance_scope, "wallet");
  assert.equal(db.getChipTransactions(a.id).find((tx) => tx.type === "lose_bet")?.balance_scope, "table");
  const txCount = db.getChipTransactions(a.id).length + db.getChipTransactions(b.id).length;
  db.settleTableHand(room.id, room.handId, [
    { userId: a.id, beforeChips: 0, chips: 0 },
    { userId: b.id, beforeChips: 0, chips: 0 }
  ]);
  assert.equal(db.getChipTransactions(a.id).length + db.getChipTransactions(b.id).length, txCount);
});

test("file database recovers orphaned table escrow once after restart", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "holdem-")), "escrow.db");
  const first = new AppDatabase(file);
  const user = (await register(first, { username: "escrow", password: "secret1", nickname: "Escrow" })).user;
  const rooms = new RoomStore(first);
  const room = rooms.createRoom(user);
  rooms.sit(user, 0, 1000);
  assert.equal(first.getUser(user.id)?.chips, 9000);
  first.close();

  const second = new AppDatabase(file);
  assert.equal(second.getUser(user.id)?.chips, 9000);
  assert.equal(second.getTableEscrow(user.id)?.chips, 1000);
  assert.throws(() => second.recoverOrphanedTableEscrows(), /Runtime lease/);
  const owner = second.acquireRuntimeLease("second")!;
  assert.equal(second.recoverOrphanedTableEscrows(owner), 1);
  assert.equal(second.getUser(user.id)?.chips, 10000);
  assert.equal(second.getTableEscrow(user.id), null);
  const refunds = second.getChipTransactions(user.id).filter((tx) => tx.type === "recovery_refund");
  assert.equal(refunds.length, 1);
  second.close();

  const third = new AppDatabase(file);
  const thirdOwner = third.acquireRuntimeLease("third")!;
  assert.equal(third.recoverOrphanedTableEscrows(thirdOwner), 0);
  assert.equal(third.getUser(user.id)?.chips, 10000);
  assert.equal(third.getChipTransactions(user.id).filter((tx) => tx.type === "recovery_refund").length, 1);
  third.close();
});

test("runtime lease prevents a second instance from refunding active escrows", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "holdem-")), "lease.db");
  const first = new AppDatabase(file);
  const ownerA = first.acquireRuntimeLease("owner-a", 1000, new Date(0))!;
  const user = (await register(first, { username: "leaseuser", password: "secret1", nickname: "Lease" })).user;
  const rooms = new RoomStore(first);
  const room = rooms.createRoom(user);
  rooms.sit(user, 0, 1000);

  const second = new AppDatabase(file);
  assert.equal(second.acquireRuntimeLease("owner-b", 1000, new Date(500)), null);
  assert.throws(() => second.recoverOrphanedTableEscrows("owner-b"), /Runtime lease/);
  assert.equal(second.getUser(user.id)?.chips, 9000);
  assert.equal(second.getTableEscrow(user.id)?.chips, 1000);

  const ownerB = second.acquireRuntimeLease("owner-b", 1000, new Date(1500))!;
  assert.equal(ownerB, "owner-b");
  assert.equal(second.recoverOrphanedTableEscrows(ownerB, new Date(1501)), 1);
  assert.equal(second.getUser(user.id)?.chips, 10000);
  assert.equal(second.getChipTransactions(user.id).filter((tx) => tx.type === "recovery_refund").length, 1);
  assert.equal(first.releaseRuntimeLease(ownerA), false);
  assert.equal(first.acquireRuntimeLease(ownerA, 1000, new Date(1600)), null);

  first.close();
  second.close();
});

test("table hand settlement rolls back escrow and ledger when a later update fails", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "holdem-")), "settle-rollback.db");
  const db = new AppDatabase(file);
  const a = (await register(db, { username: "rollbacka", password: "secret1", nickname: "A" })).user;
  const b = (await register(db, { username: "rollbackb", password: "secret1", nickname: "B" })).user;
  const rooms = new RoomStore(db);
  const room = rooms.createRoom(a);
  rooms.joinRoom(b, room.id);
  rooms.sit(a, 0, 1000);
  rooms.sit(b, 1, 1000);

  const raw = new DatabaseSync(file);
  raw.exec(`create trigger fail_second_escrow_update before update on table_escrows when new.user_id = '${b.id}' begin select raise(abort, 'settlement boom'); end;`);
  raw.close();

  assert.throws(
    () => db.settleTableHand(room.id, 1, [
      { userId: a.id, beforeChips: 1000, chips: 900 },
      { userId: b.id, beforeChips: 1000, chips: 1100 }
    ]),
    /settlement boom/
  );
  assert.equal(db.getTableEscrow(a.id)?.chips, 1000);
  assert.equal(db.getTableEscrow(b.id)?.chips, 1000);
  assert.equal(db.getChipTransactions(a.id).filter((tx) => tx.type === "lose_bet").length, 0);
  assert.equal(db.getUser(a.id)!.chips + db.getUser(b.id)!.chips + db.getTableEscrow(a.id)!.chips + db.getTableEscrow(b.id)!.chips, 20_000);
  db.close();
});

test("room action restores private engine state after final settlement failure and can retry cleanly", () => {
  const control = foldFinishScenario("control");
  const failing = foldFinishScenario("failing");
  failing.room.engine!.state = structuredClone(control.room.engine!.state);
  failing.room.handId = control.room.handId;
  failing.room.version = control.room.version;
  const actorId = control.room.engine!.state.players.find((player) => player.seat === control.room.engine!.state.currentTurnSeat)!.id;
  const beforeFailure = privateRoomState(failing.room);

  control.rooms.action(actorId, "fold");

  const raw = new DatabaseSync(failing.file);
  raw.exec("create trigger fail_halfstate_update before update on table_escrows when new.user_id = 'halfstate-b' begin select raise(abort, 'settlement boom'); end;");
  raw.close();

  assert.throws(() => failing.rooms.action(actorId, "fold"), /settlement boom/);
  assert.deepEqual(privateRoomState(failing.room), beforeFailure);
  assert.equal(failing.db.getUser("halfstate-a")!.chips + failing.db.getUser("halfstate-b")!.chips + failing.db.getTableEscrow("halfstate-a")!.chips + failing.db.getTableEscrow("halfstate-b")!.chips, 20_000);

  const cleanup = new DatabaseSync(failing.file);
  cleanup.exec("drop trigger fail_halfstate_update");
  cleanup.close();

  failing.rooms.action(actorId, "fold");
  assert.deepEqual(privateRoomState(failing.room), privateRoomState(control.room));
  assert.deepEqual(databaseSummary(failing.db, ["halfstate-a", "halfstate-b"]), databaseSummary(control.db, ["halfstate-a", "halfstate-b"]));
  failing.db.close();
  control.db.close();
});

test("cash out removes escrow so restart cannot refund twice", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "holdem-")), "cashout.db");
  const first = new AppDatabase(file);
  const user = (await register(first, { username: "cashout", password: "secret1", nickname: "Cash" })).user;
  const rooms = new RoomStore(first);
  const room = rooms.createRoom(user);
  rooms.sit(user, 0, 1000);
  rooms.leaveSeat(user.id);
  assert.equal(first.getUser(user.id)?.chips, 10000);
  first.close();

  const second = new AppDatabase(file);
  assert.equal(second.getUser(user.id)?.chips, 10000);
  assert.equal(second.getChipTransactions(user.id).filter((tx) => tx.type === "recovery_refund").length, 0);
  second.close();
});

test("mid-hand crash refunds the last persisted table escrow without creating chips", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "holdem-")), "midhand.db");
  const first = new AppDatabase(file);
  const a = (await register(first, { username: "crasha", password: "secret1", nickname: "A" })).user;
  const b = (await register(first, { username: "crashb", password: "secret1", nickname: "B" })).user;
  const rooms = new RoomStore(first);
  const room = rooms.createRoom(a, "crash", { minBuyIn: 1000, maxBuyIn: 1000 });
  rooms.joinRoom(b, room.id);
  rooms.sit(a, 0, 1000);
  rooms.sit(b, 1, 1000);
  rooms.setReady(a.id, true);
  rooms.setReady(b.id, true);
  rooms.startGame(a.id);
  assert.equal(first.getUser(a.id)!.chips + first.getUser(b.id)!.chips + first.getTableEscrow(a.id)!.chips + first.getTableEscrow(b.id)!.chips, 20_000);
  first.close();

  const second = new AppDatabase(file);
  const owner = second.acquireRuntimeLease("midhand-recovery")!;
  assert.equal(second.recoverOrphanedTableEscrows(owner), 2);
  assert.equal(second.getUser(a.id)!.chips + second.getUser(b.id)!.chips, 20_000);
  assert.equal(second.getTableEscrow(a.id), null);
  assert.equal(second.getTableEscrow(b.id), null);
  second.close();
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

test("database migrates empty and version 1 files to schema version 2", async () => {
  const emptyFile = join(mkdtempSync(join(tmpdir(), "holdem-")), "empty.db");
  const empty = new AppDatabase(emptyFile);
  empty.migrate();
  assert.deepEqual(schemaVersions(emptyFile), [1, 2]);
  assert.equal(hasColumn(emptyFile, "chip_transactions", "balance_scope"), true);
  assert.equal(hasTable(emptyFile, "table_escrows"), true);
  assert.equal(hasTable(emptyFile, "server_runtime_lease"), true);
  assert.equal(hasIndex(emptyFile, "idx_chip_transactions_hand_result"), true);
  empty.close();

  const v1File = join(mkdtempSync(join(tmpdir(), "holdem-")), "v1.db");
  const raw = new DatabaseSync(v1File);
  raw.exec(`
    create table schema_migrations (version integer primary key, applied_at text not null default current_timestamp);
    insert into schema_migrations (version) values (1);
    create table users (
      id text primary key,
      username text,
      password_hash text,
      nickname text not null,
      avatar_url text,
      chips integer not null,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );
    create table chip_transactions (
      id text primary key,
      user_id text not null,
      type text not null,
      amount integer not null,
      before_chips integer not null,
      after_chips integer not null,
      room_id text,
      hand_id integer,
      created_at text not null default current_timestamp
    );
    insert into users (id, username, nickname, chips) values ('u1', 'old', 'Old', 1234);
    insert into chip_transactions (id, user_id, type, amount, before_chips, after_chips) values ('tx1', 'u1', 'admin_adjust', 0, 1234, 1234);
  `);
  raw.close();

  const upgraded = new AppDatabase(v1File);
  assert.deepEqual(schemaVersions(v1File), [1, 2]);
  assert.equal(upgraded.getUser("u1")?.chips, 1234);
  assert.equal(upgraded.getChipTransactions("u1")[0]?.balance_scope, "wallet");
  assert.equal(hasColumn(v1File, "chip_transactions", "balance_scope"), true);
  assert.equal(hasTable(v1File, "table_escrows"), true);
  assert.equal(hasTable(v1File, "server_runtime_lease"), true);
  assert.equal(hasIndex(v1File, "idx_chip_transactions_hand_result"), true);
  upgraded.close();

  const migration2 = readFileSync(join(process.cwd(), "migrations", "002_table_escrows.sql"), "utf8");
  assert.match(migration2, /balance_scope/);
  assert.match(migration2, /table_escrows/);
  assert.match(migration2, /server_runtime_lease/);
  assert.match(migration2, /idx_chip_transactions_hand_result/);
});

test("database migrations resolve from module path when cwd changes", () => {
  const originalCwd = process.cwd();
  const repoRootFile = join(mkdtempSync(join(tmpdir(), "holdem-")), "repo-root.db");
  const tempCwd = mkdtempSync(join(tmpdir(), "holdem-cwd-"));
  const tempCwdFile = join(mkdtempSync(join(tmpdir(), "holdem-")), "temp-cwd.db");
  const first = new AppDatabase(repoRootFile);
  first.close();
  try {
    process.chdir(tempCwd);
    const second = new AppDatabase(tempCwdFile);
    second.close();
  } finally {
    process.chdir(originalCwd);
  }
  assert.deepEqual(schemaVersions(repoRootFile), [1, 2]);
  assert.deepEqual(schemaVersions(tempCwdFile), [1, 2]);
  assert.equal(hasTable(repoRootFile, "table_escrows"), true);
  assert.equal(hasTable(tempCwdFile, "table_escrows"), true);
});

test("migration 2 rolls back if a later statement fails", () => {
  const file = join(mkdtempSync(join(tmpdir(), "holdem-")), "migration-fail.db");
  const raw = new DatabaseSync(file);
  raw.exec(`
    create table schema_migrations (version integer primary key, applied_at text not null default current_timestamp);
    insert into schema_migrations (version) values (1);
    create table users (
      id text primary key,
      username text,
      password_hash text,
      nickname text not null,
      avatar_url text,
      chips integer not null,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );
    create table chip_transactions (
      id text primary key,
      user_id text not null,
      type text not null,
      amount integer not null,
      before_chips integer not null,
      after_chips integer not null,
      room_id text,
      hand_id integer,
      created_at text not null default current_timestamp
    );
    insert into users (id, username, nickname, chips) values ('u1', 'old', 'Old', 1000);
    insert into chip_transactions (id, user_id, type, amount, before_chips, after_chips, room_id, hand_id) values ('tx1', 'u1', 'win_pot', 10, 100, 110, 'r1', 1);
    insert into chip_transactions (id, user_id, type, amount, before_chips, after_chips, room_id, hand_id) values ('tx2', 'u1', 'win_pot', 10, 110, 120, 'r1', 1);
  `);
  raw.close();

  assert.throws(() => new AppDatabase(file), /constraint|UNIQUE/i);
  assert.deepEqual(schemaVersions(file), [1]);
  assert.equal(hasColumn(file, "chip_transactions", "balance_scope"), false);
  assert.equal(hasTable(file, "table_escrows"), false);
  assert.equal(hasTable(file, "server_runtime_lease"), false);
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

function schemaVersions(file: string): number[] {
  const db = new DatabaseSync(file);
  const rows = db.prepare("select version from schema_migrations order by version").all() as Array<{ version: number }>;
  db.close();
  return rows.map((row) => row.version);
}

function hasTable(file: string, name: string): boolean {
  const db = new DatabaseSync(file);
  const row = db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(name);
  db.close();
  return Boolean(row);
}

function hasIndex(file: string, name: string): boolean {
  const db = new DatabaseSync(file);
  const row = db.prepare("select name from sqlite_master where type = 'index' and name = ?").get(name);
  db.close();
  return Boolean(row);
}

function hasColumn(file: string, table: string, column: string): boolean {
  const db = new DatabaseSync(file);
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  db.close();
  return rows.some((row) => row.name === column);
}

function foldFinishScenario(label: string): { file: string; db: AppDatabase; rooms: RoomStore; room: Room } {
  const file = join(mkdtempSync(join(tmpdir(), `holdem-${label}-`)), "halfstate.db");
  const db = new AppDatabase(file);
  const a = db.getOrCreateGuest("halfstate-a", "A");
  const b = db.getOrCreateGuest("halfstate-b", "B");
  const rooms = new RoomStore(db);
  const room = rooms.createRoom(a, label, { minBuyIn: 1000, maxBuyIn: 1000 });
  rooms.joinRoom(b, room.id);
  rooms.sit(a, 0, 1000);
  rooms.sit(b, 1, 1000);
  rooms.setReady(a.id, true);
  rooms.setReady(b.id, true);
  rooms.startGame(a.id);
  for (const seat of room.seats) {
    if (seat?.id === "halfstate-a") seat.avatar = "PA";
    if (seat?.id === "halfstate-b") seat.avatar = "PB";
  }
  for (const player of room.engine!.state.players) {
    if (player.id === "halfstate-a") player.avatar = "PA";
    if (player.id === "halfstate-b") player.avatar = "PB";
  }
  return { file, db, rooms, room };
}

function privateRoomState(room: Room): unknown {
  return {
    status: room.status,
    version: room.version,
    handId: room.handId,
    lastSettledHandId: room.lastSettledHandId,
    actionDeadlineAt: room.actionDeadlineAt,
    turnGeneration: room.turnGeneration,
    timerGeneration: room.timerGeneration,
    timerTurnSeat: room.timerTurnSeat,
    timerHandId: room.timerHandId,
    lastDealerSeat: room.lastDealerSeat,
    seats: structuredClone(room.seats),
    engine: room.engine ? structuredClone(room.engine.state) : null
  };
}

function databaseSummary(db: AppDatabase, userIds: string[]): unknown {
  return userIds.map((id) => ({
    id,
    chips: db.getUser(id)?.chips,
    escrow: db.getTableEscrow(id)
      ? {
          chips: db.getTableEscrow(id)!.chips,
          last_hand_id: db.getTableEscrow(id)!.last_hand_id
        }
      : null,
    transactions: db.getChipTransactions(id).map((tx) => ({
      type: tx.type,
      balance_scope: tx.balance_scope,
      amount: tx.amount,
      before_chips: tx.before_chips,
      after_chips: tx.after_chips,
      hand_id: tx.hand_id
    }))
  }));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
