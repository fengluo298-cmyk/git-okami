import { mkdirSync } from "node:fs";
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

export type ChipTransactionType = "buy_in" | "cash_out" | "win_pot" | "lose_bet" | "admin_adjust";
export type ChipTransaction = {
  id: string;
  user_id: string;
  type: ChipTransactionType;
  amount: number;
  before_chips: number;
  after_chips: number;
  room_id: string | null;
  hand_id: number | null;
  created_at: string;
};

const DEFAULT_CHIPS = positiveInt(process.env.DEFAULT_CHIPS, 10000);

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(file = databaseFile()) {
    assertDurableDatabaseFile(file);
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        applied_at text not null default current_timestamp
      );
    `);
    this.applyMigration(1, `
      create table if not exists users (
        id text primary key,
        username text,
        password_hash text,
        nickname text not null,
        avatar_url text,
        chips integer not null,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      );
      create table if not exists chip_transactions (
        id text primary key,
        user_id text not null,
        type text not null,
        amount integer not null,
        before_chips integer not null,
        after_chips integer not null,
        room_id text,
        hand_id integer,
        created_at text not null default current_timestamp,
        foreign key (user_id) references users(id)
      );
    `);
    this.addColumnIfMissing("users", "username", "text");
    this.addColumnIfMissing("users", "password_hash", "text");
    this.addColumnIfMissing("users", "avatar_url", "text");
    if (this.hasColumn("users", "avatar")) this.db.exec("update users set avatar_url = avatar where avatar_url is null");
    this.db.exec("create unique index if not exists idx_users_username on users(username) where username is not null");
  }

  close(): void {
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

  logChipTransaction(userId: string, type: ChipTransactionType, amount: number, before: number, after: number, roomId?: string, handId?: number): void {
    this.db
      .prepare("insert into chip_transactions (id, user_id, type, amount, before_chips, after_chips, room_id, hand_id) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), userId, type, amount, before, after, roomId ?? null, handId ?? null);
  }

  getChipTransactions(userId: string): ChipTransaction[] {
    return this.db.prepare("select * from chip_transactions where user_id = ? order by rowid").all(userId) as ChipTransaction[];
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
  let file = process.env.DATABASE_URL ?? process.env.DB_FILE ?? "";
  while (file.startsWith("DATABASE_URL=")) file = file.slice("DATABASE_URL=".length);
  if (!file || (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(file))) {
    if (isProduction()) throw new Error("DATABASE_URL must point to a durable SQLite file in production");
    file = resolve(process.cwd(), "data", "holdem.db");
  }
  return file;
}

export function assertDurableDatabaseFile(file: string): void {
  if (!isProduction()) return;
  const normalized = file.replace(/\\/g, "/");
  if (normalized === ":memory:" || normalized.includes("mode=memory")) throw new Error("DATABASE_URL must not use an in-memory database in production");
  if (normalized === "/tmp/holdem.db" || normalized.startsWith("/tmp/")) {
    throw new Error("DATABASE_URL must not use /tmp in production; configure a persistent disk path such as /var/data/holdem.db");
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
