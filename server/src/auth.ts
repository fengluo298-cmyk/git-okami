import { createHmac, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { AppDatabase, UserRecord } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const VOICE_SECRET = process.env.VOICE_APP_SECRET || JWT_SECRET;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export type AuthSession = {
  token: string;
  user: UserRecord;
};

export async function register(db: AppDatabase, input: { username?: string; password?: string; nickname?: string; avatar?: string }): Promise<AuthSession> {
  const username = cleanUsername(input.username);
  const password = input.password ?? "";
  if (!username) throw new Error("Username is required");
  if (password.length < 6) throw new Error("Password must be at least 6 characters");
  const passwordHash = await bcrypt.hash(password, 12);
  const user = db.createUser(username, passwordHash, input.nickname || username, input.avatar);
  return { user, token: signToken(user.id) };
}

export async function login(db: AppDatabase, input: { username?: string; password?: string }): Promise<AuthSession> {
  const user = db.findByUsername(cleanUsername(input.username));
  if (!user?.passwordHash) throw new Error("Invalid username or password");
  const ok = await bcrypt.compare(input.password ?? "", user.passwordHash);
  if (!ok) throw new Error("Invalid username or password");
  return { user: stripPassword(user), token: signToken(user.id) };
}

export function verifyToken(db: AppDatabase, token?: string): UserRecord {
  const payload = verifyJwt(token);
  const user = db.getUser(String(payload.sub ?? ""));
  if (!user) throw new Error("Invalid token");
  return user;
}

export function signVoiceToken(userId: string, roomId: string): string {
  return signJwt({ sub: userId, roomId, scope: "voice" }, 10 * 60, VOICE_SECRET);
}

export function isPasswordHash(value: string): boolean {
  return value.startsWith("$2");
}

function signToken(userId: string): string {
  return signJwt({ sub: userId, scope: "access" }, TOKEN_TTL_SECONDS);
}

function signJwt(payload: Record<string, unknown>, ttlSeconds: number, secret = JWT_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = `${head}.${base64url(JSON.stringify(body))}`;
  return `${data}.${signature(data, secret)}`;
}

function verifyJwt(token?: string): Record<string, unknown> {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3) throw new Error("Missing token");
  const data = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signature(data, JWT_SECRET));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("Invalid token");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expired");
  return payload;
}

function signature(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function cleanUsername(username?: string): string {
  return (username ?? "").trim().toLowerCase().slice(0, 32);
}

function stripPassword(user: UserRecord & { passwordHash: string | null }): UserRecord {
  return { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, chips: user.chips };
}
