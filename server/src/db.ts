import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type UserRecord = {
  id: string;
  username: string | null;
  nickname: string;
  avatar: string;
  chips: number;
};

export type ChipTransactionType = "buy_in" | "cash_out" | "win_pot" | "lose_bet" | "admin_adjust" | "recovery_refund";
export type ChipTransaction = {
  id: string;
  user_id: string;
  type: ChipTransactionType;
  balance_scope: "wallet" | "table";
  amount: number;
  before_chips: number;
  after_chips: number;
  room_id: string | null;
  hand_id: number | null;
  created_at: string;
};
export type TableEscrow = {
  user_id: string;
  room_id: string;
  chips: number;
  last_hand_id: number | null;
  created_at: string;
  updated_at: string;
};
export type TableHandStack = { userId: string; beforeChips: number; chips: number };
type RuntimeLease = { lease_key: string; owner_id: string; heartbeat_at: string; expires_at: string };

const DEFAULT_CHIPS = positiveInt(process.env.DEFAULT_CHIPS, 10000);
const CURRENT_SCHEMA_VERSION = 2;

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(file = databaseFile()) {
    assertDurableDatabaseFile(file);
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("pragma foreign_keys = on");
    this.db.exec("pragma busy_timeout = 5000");
    if (file !== ":memory:") this.db.exec("pragma journal_mode = WAL");
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        applied_at text not null default current_timestamp
      );
    `);
    this.assertKnownSchemaVersion();
    this.applyMigration(1, readMigration("001_init.sql"));
    this.applyMigration(2, readMigration("002_table_escrows.sql"));
    this.addColumnIfMissing("users", "username", "text");
    this.addColumnIfMissing("users", "password_hash", "text");
    this.addColumnIfMissing("users", "avatar_url", "text");
    if (this.hasColumn("users", "avatar")) this.db.exec("update users set avatar_url = avatar where avatar_url is null");
    this.db.exec("create unique index if not exists idx_users_username on users(username) where username is not null");
    this.assertKnownSchemaVersion();
  }

  close(): void {
    this.releaseRuntimeLease();
    this.db.close();
  }

  getOrCreateGuest(id?: string, nickname?: string): UserRecord {
    const existing = id ? this.getUser(id) : null;
    if (existing) return existing;

    const userId = id || randomUUID();
    const user: UserRecord = {
      id: userId,
      username: null,
      nickname: cleanNickname(nickname) || `Guest-${userId.slice(0, 4)}`,
      avatar: `P${Math.floor(Math.random() * 90 + 10)}`,
      chips: DEFAULT_CHIPS
    };
    this.db
      .prepare("insert into users (id, nickname, avatar_url, chips) values (?, ?, ?, ?)")
      .run(user.id, user.nickname, user.avatar, user.chips);
    return user;
  }

  createUser(username: string, passwordHash: string, nickname: string, avatar?: string): UserRecord {
    const cleanUsername = normalizeUsername(username);
    if (!cleanUsername) throw new Error("Username is required");
    if (this.findByUsername(cleanUsername)) throw new Error("Username already exists");
    const user: UserRecord = {
      id: randomUUID(),
      username: cleanUsername,
      nickname: cleanNickname(nickname) || cleanUsername,
      avatar: cleanAvatar(avatar) || `P${Math.floor(Math.random() * 90 + 10)}`,
      chips: DEFAULT_CHIPS
    };
    this.db
      .prepare("insert into users (id, username, password_hash, nickname, avatar_url, chips) values (?, ?, ?, ?, ?, ?)")
      .run(user.id, user.username, passwordHash, user.nickname, user.avatar, user.chips);
    return user;
  }

  findByUsername(username: string): (UserRecord & { passwordHash: string | null }) | null {
    return this.rowToUser(
      this.db.prepare("select id, username, password_hash, nickname, avatar_url, chips from users where username = ?").get(normalizeUsername(username))
    );
  }

  getUser(id: string): UserRecord | null {
    const user = this.rowToUser(this.db.prepare("select id, username, password_hash, nickname, avatar_url, chips from users where id = ?").get(id));
    return user ? stripPassword(user) : null;
  }

  updateUserChips(id: string, chips: number): void {
    this.db.prepare("update users set chips = ?, updated_at = current_timestamp where id = ?").run(chips, id);
  }

  adjustUserChips(userId: string, amount: number, type: ChipTransactionType, roomId?: string, handId?: number): UserRecord {
    this.db.exec("begin immediate");
    try {
      const user = this.getUser(userId);
      if (!user) throw new Error("User not found");
      const before = user.chips;
      const after = before + amount;
      if (after < 0) throw new Error("Not enough chips");
      this.db.prepare("update users set chips = ?, updated_at = current_timestamp where id = ?").run(after, userId);
      this.logChipTransaction(userId, type, amount, before, after, roomId, handId);
      this.db.exec("commit");
      return { ...user, chips: after };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  openTableEscrow(userId: string, roomId: string, chips: number): UserRecord {
    assertChipAmount(chips, "Table escrow");
    this.db.exec("begin immediate");
    try {
      if (this.getTableEscrow(userId)) throw new Error("Already seated");
      const user = this.getUser(userId);
      if (!user) throw new Error("User not found");
      const after = user.chips - chips;
      if (after < 0) throw new Error("Not enough chips");
      this.db.prepare("update users set chips = ?, updated_at = current_timestamp where id = ?").run(after, userId);
      this.logChipTransaction(userId, "buy_in", -chips, user.chips, after, roomId);
      this.db.prepare("insert into table_escrows (user_id, room_id, chips) values (?, ?, ?)").run(userId, roomId, chips);
      this.db.exec("commit");
      return { ...user, chips: after };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  settleTableHand(roomId: string, handId: number, playerStacks: TableHandStack[]): void {
    if (!Number.isSafeInteger(handId) || handId <= 0) throw new Error("Hand id must be a safe positive integer");
    this.db.exec("begin immediate");
    try {
      const escrows = playerStacks.map((stack) => {
        assertNonNegativeChipAmount(stack.beforeChips, "Table escrow before chips");
        assertNonNegativeChipAmount(stack.chips, "Table escrow chips");
        const escrow = this.getTableEscrow(stack.userId);
        if (!escrow || escrow.room_id !== roomId) throw new Error("Table escrow missing");
        return { stack, escrow };
      });
      if (escrows.every(({ escrow }) => escrow.last_hand_id === handId)) {
        this.db.exec("commit");
        return;
      }
      if (escrows.some(({ escrow }) => escrow.last_hand_id === handId)) throw new Error("Table settlement conflict");
      for (const { stack, escrow } of escrows) {
        if (escrow.chips !== stack.beforeChips) throw new Error("Table escrow changed");
        const delta = stack.chips - stack.beforeChips;
        if (delta !== 0) this.logChipTransaction(stack.userId, delta > 0 ? "win_pot" : "lose_bet", delta, stack.beforeChips, stack.chips, roomId, handId);
        const updated = this.db
          .prepare("update table_escrows set chips = ?, last_hand_id = ?, updated_at = current_timestamp where user_id = ? and room_id = ? and (last_hand_id is null or last_hand_id < ?)")
          .run(stack.chips, handId, stack.userId, roomId, handId) as { changes: number };
        if (updated.changes !== 1) throw new Error("Table settlement conflict");
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  cashOutTableEscrow(userId: string, roomId: string): UserRecord | null {
    this.db.exec("begin immediate");
    try {
      const escrow = this.getTableEscrow(userId);
      const user = this.getUser(userId);
      if (!user) throw new Error("User not found");
      if (!escrow || escrow.room_id !== roomId) {
        this.db.exec("commit");
        return user;
      }
      const after = user.chips + escrow.chips;
      this.db.prepare("update users set chips = ?, updated_at = current_timestamp where id = ?").run(after, userId);
      if (escrow.chips > 0) this.logChipTransaction(userId, "cash_out", escrow.chips, user.chips, after, roomId, escrow.last_hand_id ?? undefined);
      this.db.prepare("delete from table_escrows where user_id = ?").run(userId);
      this.db.exec("commit");
      return { ...user, chips: after };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  recoverOrphanedTableEscrows(ownerId = this.leaseOwnerId, now = new Date()): number {
    if (!ownerId) throw new Error("Runtime lease required");
    const escrows = this.db.prepare("select * from table_escrows order by rowid").all() as TableEscrow[];
    if (escrows.length === 0) return 0;
    this.db.exec("begin immediate");
    try {
      this.assertRuntimeLease(ownerId, now);
      for (const escrow of escrows) {
        const user = this.getUser(escrow.user_id);
        if (!user) {
          this.db.prepare("delete from table_escrows where user_id = ?").run(escrow.user_id);
          continue;
        }
        const after = user.chips + escrow.chips;
        this.db.prepare("update users set chips = ?, updated_at = current_timestamp where id = ?").run(after, user.id);
        if (escrow.chips > 0) this.logChipTransaction(user.id, "recovery_refund", escrow.chips, user.chips, after, escrow.room_id, escrow.last_hand_id ?? undefined);
        this.db.prepare("delete from table_escrows where user_id = ?").run(user.id);
      }
      this.db.exec("commit");
      return escrows.length;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  getTableEscrow(userId: string): TableEscrow | null {
    return (this.db.prepare("select * from table_escrows where user_id = ?").get(userId) as TableEscrow | undefined) ?? null;
  }

  logChipTransaction(userId: string, type: ChipTransactionType, amount: number, before: number, after: number, roomId?: string, handId?: number): void {
    this.db
      .prepare("insert into chip_transactions (id, user_id, type, balance_scope, amount, before_chips, after_chips, room_id, hand_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), userId, type, chipTransactionScope(type), amount, before, after, roomId ?? null, handId ?? null);
  }

  getChipTransactions(userId: string): ChipTransaction[] {
    return this.db.prepare("select * from chip_transactions where user_id = ? order by rowid").all(userId) as ChipTransaction[];
  }

  private leaseOwnerId: string | null = null;

  acquireRuntimeLease(ownerId: string = randomUUID(), ttlMs = 30_000, now = new Date()): string | null {
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + ttlMs).toISOString();
    this.db.exec("begin immediate");
    try {
      const row = this.db.prepare("select * from server_runtime_lease where lease_key = 'server'").get() as RuntimeLease | undefined;
      if (row && row.owner_id !== ownerId && row.expires_at > nowIso) {
        this.db.exec("commit");
        return null;
      }
      this.db
        .prepare(
          "insert into server_runtime_lease (lease_key, owner_id, heartbeat_at, expires_at) values ('server', ?, ?, ?) on conflict(lease_key) do update set owner_id = excluded.owner_id, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at"
        )
        .run(ownerId, nowIso, expiresIso);
      this.db.exec("commit");
      this.leaseOwnerId = ownerId;
      return ownerId;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  heartbeatRuntimeLease(ownerId = this.leaseOwnerId, ttlMs = 30_000, now = new Date()): boolean {
    if (!ownerId) return false;
    const result = this.db
      .prepare("update server_runtime_lease set heartbeat_at = ?, expires_at = ? where lease_key = 'server' and owner_id = ?")
      .run(now.toISOString(), new Date(now.getTime() + ttlMs).toISOString(), ownerId) as { changes: number };
    return result.changes === 1;
  }

  releaseRuntimeLease(ownerId = this.leaseOwnerId): boolean {
    if (!ownerId) return false;
    const result = this.db.prepare("delete from server_runtime_lease where lease_key = 'server' and owner_id = ?").run(ownerId) as { changes: number };
    if (result.changes === 1 && this.leaseOwnerId === ownerId) this.leaseOwnerId = null;
    return result.changes === 1;
  }

  private rowToUser(row: unknown): (UserRecord & { passwordHash: string | null }) | null {
    if (!row) return null;
    const record = row as { id: string; username: string | null; password_hash: string | null; nickname: string; avatar_url: string | null; chips: number };
    return {
      id: record.id,
      username: record.username,
      passwordHash: record.password_hash,
      nickname: record.nickname,
      avatar: record.avatar_url || "P00",
      chips: record.chips
    };
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) this.db.exec(`alter table ${table} add column ${column} ${definition}`);
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private applyMigration(version: number, sql: string): void {
    const existing = this.db.prepare("select version from schema_migrations where version = ?").get(version);
    if (existing) return;
    this.db.exec("begin immediate");
    try {
      this.db.exec(sql);
      this.db.prepare("insert into schema_migrations (version) values (?)").run(version);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private assertKnownSchemaVersion(): void {
    const row = this.db.prepare("select max(version) as version from schema_migrations").get() as { version: number | null };
    if ((row.version ?? 0) > CURRENT_SCHEMA_VERSION) throw new Error("Database schema is newer than this server");
  }

  private assertRuntimeLease(ownerId: string, now: Date): void {
    const row = this.db.prepare("select * from server_runtime_lease where lease_key = 'server' and owner_id = ?").get(ownerId) as RuntimeLease | undefined;
    if (!row || row.expires_at <= now.toISOString()) throw new Error("Runtime lease required");
  }
}

function cleanNickname(nickname?: string): string {
  return (nickname ?? "").trim().slice(0, 16);
}

function cleanAvatar(avatar?: string): string {
  return (avatar ?? "").trim().slice(0, 120);
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function stripPassword(user: UserRecord & { passwordHash: string | null }): UserRecord {
  return { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, chips: user.chips };
}

export function databaseFile(): string {
  let file = process.env.DATABASE_PATH ?? process.env.DATABASE_URL ?? process.env.DB_FILE ?? "";
  while (file.startsWith("DATABASE_PATH=") || file.startsWith("DATABASE_URL=")) {
    file = file.replace(/^DATABASE_(PATH|URL)=/, "");
  }
  if (!file || (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(file))) {
    if (isProduction()) throw new Error("DATABASE_PATH must point to a durable SQLite file in production");
    file = resolve(process.cwd(), "data", "holdem.db");
  }
  return file;
}

export function assertDurableDatabaseFile(file: string): void {
  if (!isProduction()) return;
  const normalized = file.replace(/\\/g, "/");
  if (normalized === ":memory:" || normalized.includes("mode=memory")) throw new Error("DATABASE_PATH must not use an in-memory database in production");
  if (normalized === "/tmp/holdem.db" || normalized.startsWith("/tmp/")) {
    throw new Error("DATABASE_PATH must not use /tmp in production; configure a persistent disk path such as /var/data/holdem.db");
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function assertChipAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a safe positive integer`);
}

function assertNonNegativeChipAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe non-negative integer`);
}

function chipTransactionScope(type: ChipTransactionType): "wallet" | "table" {
  return type === "win_pot" || type === "lose_bet" ? "table" : "wallet";
}

function readMigration(fileName: string): string {
  return readFileSync(new URL(`../migrations/${fileName}`, import.meta.url), "utf8");
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
