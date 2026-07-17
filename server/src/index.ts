import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import { guestLogin, login, register, requireClientBuild, signVoiceToken, verifyToken } from "./auth.js";
import { AppDatabase, type UserRecord } from "./db.js";
import { RoomStore, type Room, type RoomRules } from "./roomStore.js";
import type { PlayerAction } from "./game/gameEngine.js";
import { parseChipAmount } from "./amount.js";
import { OperationDeduper, type AckResult } from "./operations.js";

const port = Number(process.env.PORT ?? 4000);
const corsOrigin = readCorsOrigin("CORS_ORIGIN");
const socketCorsOrigin = process.env.SOCKET_CORS_ORIGIN ?? corsOrigin;
const minClientBuild = Number(process.env.MIN_CLIENT_BUILD ?? 3);
const maxJsonBytes = Number(process.env.MAX_JSON_BYTES ?? 16_384);
const voiceEnabled = (process.env.VOICE_PROVIDER ?? "none") !== "none";
const db = new AppDatabase();
const rooms = new RoomStore(db);
const actionTimers = new Map<string, NodeJS.Timeout>();
const operations = new OperationDeduper();
const authLimiter = rateLimiter(20, 15 * 60_000);
const roomLocks = new Set<string>();

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ level: "error", event: "unhandledRejection", message: safeLogMessage(reason) }));
});

process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({ level: "error", event: "uncaughtException", message: safeLogMessage(error) }));
  process.exit(1);
});

const httpServer = createServer(async (req, res) => {
  const requestId = randomUUID();
  setCors(req, res);
  if (req.method === "OPTIONS") return sendJson(res, 204, {}, requestId);
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/") return sendJson(res, 200, { ok: true, service: "texas-holdem-server" }, requestId);
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, status: "ok" }, requestId);
    if (req.method === "GET" && url.pathname === "/ready") return sendJson(res, 200, { ok: true, status: "ready" }, requestId);
    if (req.method === "POST" && url.pathname === "/auth/register") {
      requireClientBuild(headerClientBuild(req), minClientBuild);
      const body = await readJson(req);
      checkAuthLimit(req, body.username);
      return sendJson(res, 200, { ok: true, ...(await register(db, body)) }, requestId);
    }
    if (req.method === "POST" && url.pathname === "/auth/login") {
      requireClientBuild(headerClientBuild(req), minClientBuild);
      const body = await readJson(req);
      checkAuthLimit(req, body.username);
      return sendJson(res, 200, { ok: true, ...(await login(db, body)) }, requestId);
    }
    if (req.method === "POST" && url.pathname === "/auth/guest") {
      requireClientBuild(headerClientBuild(req), minClientBuild);
      checkAuthLimit(req, "guest");
      return sendJson(res, 200, { ok: true, ...guestLogin(db, await readJson(req)) }, requestId);
    }
    if (req.method === "GET" && url.pathname === "/auth/me") {
      requireClientBuild(headerClientBuild(req), minClientBuild);
      return sendJson(res, 200, { ok: true, user: verifyToken(db, bearer(req)) }, requestId);
    }
    return sendError(res, requestId, apiError("NOT_FOUND", "未找到", 404));
  } catch (error) {
    const publicError = toPublicError(error);
    if (publicError.status >= 500) logError(requestId, error);
    return sendError(res, requestId, publicError);
  }
});

const io = new Server(httpServer, {
  cors: { origin: socketCorsOrigin },
  connectionStateRecovery: {
    maxDisconnectionDuration: 120_000
  }
});

io.use((socket, next) => {
  try {
    const auth = socket.handshake.auth as { token?: string; clientBuild?: number };
    requireClientBuild(auth.clientBuild, minClientBuild);
    socket.data.user = verifyToken(db, auth.token);
    next();
  } catch (error) {
    next(error instanceof Error ? error : new Error("Unauthorized"));
  }
});

io.on("connection", (socket: Socket) => {
  const user = socket.data.user as UserRecord;
  socket.emit("session", user);
  socket.emit("rooms:list", rooms.listRooms());
  resumeRoom(socket, user);

  socket.on("rooms:list", () => socket.emit("rooms:list", rooms.listRooms()));
  socket.on("rooms:resume", () => resumeRoom(socket, user));

  socket.on("rooms:create", (payload: { name?: string; rules?: Partial<RoomRules>; operationId?: string } = {}, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      const room = rooms.createRoom(user, payload.name, payload.rules);
      socket.join(room.id);
      socket.emit("room:state", rooms.publicRoom(room.id, user.id));
      emitRooms();
      return { roomId: room.id };
    })
  );

  socket.on("rooms:join", (payload: { roomId: string; operationId?: string }, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      const room = rooms.joinRoom(user, payload.roomId);
      socket.join(room.id);
      emitRoom(room);
      emitRooms();
      return { roomId: room.id };
    })
  );

  socket.on("rooms:leave", (payload: { operationId?: string; stateVersion?: number } = {}, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      const room = rooms.leaveRoom(user.id);
      if (room) socket.leave(room.id);
      socket.emit("room:state", null);
      refreshSession(socket);
      emitRooms();
      if (room) emitRoom(room);
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("seat:sit", (payload: { seat: number; buyIn?: number | string; operationId?: string; stateVersion?: number }, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      const current = rooms.currentRoom(user.id);
      const buyIn = parseChipAmount(payload.buyIn ?? current?.rules.minBuyIn ?? 1000, "Buy-in");
      const room = rooms.sit(user, payload.seat, buyIn);
      refreshSession(socket);
      emitRoom(room);
      emitRooms();
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("seat:leave", (payload: { operationId?: string; stateVersion?: number } = {}, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      const room = rooms.leaveSeat(user.id);
      refreshSession(socket);
      emitRoom(room);
      emitRooms();
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("seat:ready", (payload: { ready: boolean; operationId?: string; stateVersion?: number }, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      const room = rooms.setReady(user.id, Boolean(payload.ready));
      emitRoom(room);
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("game:start", (payload: { operationId?: string; stateVersion?: number } = {}, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      const room = rooms.startGame(user.id);
      emitRoom(room);
      emitRooms();
      scheduleRoomTimer(room);
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("game:action", (payload: { type: PlayerAction; amount?: number | string; operationId?: string; stateVersion?: number }, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      const amount = payload.amount === undefined ? undefined : parseChipAmount(payload.amount, "Bet");
      const room = rooms.action(user.id, payload.type, amount);
      emitRoom(room);
      emitRooms();
      scheduleRoomTimer(room);
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("voice:join", (payload: { operationId?: string } = {}, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      if (!voiceEnabled) throw new Error("Voice is not available");
      const room = rooms.joinVoice(user.id);
      emitRoom(room);
      return { voiceToken: signVoiceToken(user.id, room.id), roomId: room.id };
    })
  );

  socket.on("voice:leave", (payload: { operationId?: string } = {}, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      if (!voiceEnabled) throw new Error("Voice is not available");
      const room = rooms.leaveVoice(user.id);
      emitRoom(room);
      return {};
    })
  );

  socket.on("voice:mute", (payload: { muted: boolean; operationId?: string }, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      if (!voiceEnabled) throw new Error("Voice is not available");
      const room = rooms.setVoiceMuted(user.id, Boolean(payload.muted));
      emitRoom(room);
      return {};
    })
  );

  socket.on("voice:speaking", (payload: { speaking: boolean; operationId?: string }, ack?: Ack) =>
    handle(socket, ack, payload, () => {
      if (!voiceEnabled) throw new Error("Voice is not available");
      const room = rooms.setVoiceSpeaking(user.id, Boolean(payload.speaking));
      emitRoom(room);
      return {};
    })
  );

  socket.on("disconnect", () => {
    const room = rooms.markConnected(user.id, false);
    if (room) emitRoom(room);
  });
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Texas Hold'em server listening on http://0.0.0.0:${port}`);
});

type Ack = (result: AckResult) => void;
type HandleOptions = { checkStateVersion?: boolean; lockRoom?: boolean };

function handle(socket: Socket, ack: Ack | undefined, payload: { operationId?: unknown; stateVersion?: unknown }, work: () => Record<string, unknown>, options: HandleOptions = {}): void {
  const user = socket.data.user as UserRecord;
  const requestId = randomUUID();
  const cached = operations.get(user.id, payload.operationId);
  if (cached) {
    ack?.(cached);
    return;
  }
  try {
    if (options.checkStateVersion) rooms.assertFresh(user.id, payload.stateVersion);
    const result = withRoomLock(user.id, options.lockRoom, () => ({ ok: true, ...work(), stateVersion: rooms.currentRoom(user.id)?.version }));
    operations.set(user.id, payload.operationId, result);
    ack?.(result);
  } catch (error) {
    const publicError = toPublicError(error);
    const result = { ok: false, code: publicError.code, message: publicError.message, error: publicError.message, requestId, stateVersion: rooms.currentRoom(user.id)?.version };
    operations.set(user.id, payload.operationId, result);
    socket.emit("error:message", { message: publicError.message, code: publicError.code, requestId });
    ack?.(result);
  }
}

function emitRooms(): void {
  io.emit("rooms:list", rooms.listRooms());
}

function emitRoom(room: Room): void {
  for (const socket of io.sockets.sockets.values()) {
    const user = socket.data.user as UserRecord | undefined;
    if (user && room.members.has(user.id)) socket.emit("room:state", rooms.publicRoom(room.id, user.id));
  }
}

function resumeRoom(socket: Socket, user: UserRecord): void {
  const room = rooms.markConnected(user.id, true);
  if (!room) return;
  socket.join(room.id);
  socket.emit("room:state", rooms.publicRoom(room.id, user.id));
  emitRoom(room);
}

function scheduleRoomTimer(room: Room): void {
  const oldTimer = actionTimers.get(room.id);
  if (oldTimer) clearTimeout(oldTimer);
  actionTimers.delete(room.id);
  if (room.status !== "playing" || !room.engine || room.engine.state.currentTurnSeat === null) return;
  actionTimers.set(
    room.id,
    setTimeout(() => {
      const updated = rooms.autoAction(room.id);
      emitRoom(updated);
      emitRooms();
      scheduleRoomTimer(updated);
    }, room.rules.actionTimeoutSeconds * 1000)
  );
}

function refreshSession(socket: Socket): void {
  const user = socket.data.user as UserRecord;
  const fresh = db.getUser(user.id);
  if (!fresh) return;
  socket.data.user = fresh;
  socket.emit("session", fresh);
}

async function readJson(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxJsonBytes) throw apiError("REQUEST_TOO_LARGE", "请求内容过大", 413);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? (JSON.parse(text) as Record<string, string>) : {};
  } catch {
    throw apiError("BAD_JSON", "请求格式错误", 400);
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, requestId?: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(requestId ? { requestId, ...body } : body));
}

function sendError(res: ServerResponse, requestId: string, error: PublicError): void {
  sendJson(res, error.status, { ok: false, code: error.code, message: error.message, error: error.message }, requestId);
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allowed = chooseCorsOrigin(origin);
  if (allowed) res.setHeader("access-control-allow-origin", allowed);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function headerClientBuild(req: IncomingMessage): number {
  return Number(req.headers["x-client-build"] ?? 0);
}

type PublicError = Error & { code: string; status: number };

function apiError(code: string, message: string, status: number): PublicError {
  const error = new Error(message) as PublicError;
  error.code = code;
  error.status = status;
  return error;
}

function toPublicError(error: unknown): PublicError {
  if (isPublicError(error)) return error;
  const message = error instanceof Error ? error.message : "";
  if (message === "Username already exists") return apiError("AUTH_USERNAME_TAKEN", "用户名已存在", 409);
  if (message === "Invalid username or password") return apiError("AUTH_INVALID_CREDENTIALS", "用户名或密码错误", 401);
  if (message === "Missing token" || message === "Invalid token" || message === "Token expired" || message === "Unauthorized") return apiError("AUTH_INVALID_TOKEN", "登录已失效，请重新登录", 401);
  if (message === "Voice is not available") return apiError("VOICE_UNAVAILABLE", "语音功能开发中", 409);
  if (message === "State version is stale") return apiError("STATE_VERSION_STALE", "牌桌状态已更新，请重试", 409);
  if (message === "Room is busy") return apiError("ROOM_BUSY", "牌桌正在处理上一项操作，请稍后重试", 409);
  if (knownClientError(message)) return apiError("BAD_REQUEST", message, 400);
  return apiError("INTERNAL_ERROR", "服务暂不可用，请稍后重试", 500);
}

function isPublicError(error: unknown): error is PublicError {
  return error instanceof Error && typeof (error as Partial<PublicError>).code === "string" && typeof (error as Partial<PublicError>).status === "number";
}

function knownClientError(message: string): boolean {
  return [
    "Username is required",
    "Username can only use 1-32 lowercase letters, numbers, and underscores",
    "Password must be at least 6 characters",
    "Password is too long",
    "Client version is no longer supported",
    "Not found",
    "Cannot leave during a hand",
    "Cannot change seats during a hand",
    "Seat is taken",
    "Cannot leave seat during a hand",
    "Hand is already running",
    "Sit down first",
    "Only the owner can start",
    "Need at least two ready players",
    "No active hand",
    "Join the room first",
    "Join voice first",
    "Join a room first",
    "Room not found",
    "At least five cards are required",
    "At least two players are required",
    "Player is not in this hand",
    "It is not this player's turn",
    "Folded players cannot act",
    "All-in players cannot act",
    "Cannot check while facing a bet",
    "Nothing to call",
    "Bet must add chips",
    "Not enough chips",
    "Use raise while facing a bet",
    "Use bet to open action",
    "Bet must beat the current bet",
    "Raise is below the minimum",
    "Opening bet is below the minimum",
    "Deck is empty",
    "No next occupied seat",
    "Invalid action",
    "Bet must be a safe positive integer",
    "Buy-in must be a positive integer",
    "Request content is too large"
  ].includes(message) || message.startsWith("Seat must be ") || message.startsWith("Buy-in must be ") || message.startsWith("Bet cannot exceed ") || message.startsWith("Fixed-limit bet must be ");
}

function checkAuthLimit(req: IncomingMessage, username: unknown): void {
  const ip = req.socket.remoteAddress ?? "unknown";
  const userKey = typeof username === "string" ? username.trim().toLowerCase().slice(0, 32) : "unknown";
  if (!authLimiter.allow(`ip:${ip}`) || !authLimiter.allow(`user:${userKey}:${ip}`)) throw apiError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
}

function withRoomLock<T>(userId: string, enabled: boolean | undefined, work: () => T): T {
  if (!enabled) return work();
  const roomId = rooms.currentRoom(userId)?.id;
  if (!roomId) return work();
  if (roomLocks.has(roomId)) throw new Error("Room is busy");
  roomLocks.add(roomId);
  try {
    return work();
  } finally {
    roomLocks.delete(roomId);
  }
}

function chooseCorsOrigin(origin: string | undefined): string | null {
  if (corsOrigin === "*") return "*";
  const allowed = corsOrigin.split(",").map((item) => item.trim()).filter(Boolean);
  if (!origin) return allowed[0] ?? null;
  return allowed.includes(origin) ? origin : null;
}

function readCorsOrigin(name: string): string {
  const value = process.env[name] ?? (process.env.NODE_ENV === "production" ? "" : "*");
  if (process.env.NODE_ENV === "production" && (!value || value.trim() === "*")) {
    throw new Error(`${name} must be set to explicit trusted origins in production`);
  }
  return value;
}

function safeLogMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]").replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]");
}

function logError(requestId: string, error: unknown): void {
  console.error(JSON.stringify({ level: "error", requestId, message: safeLogMessage(error) }));
}

function rateLimiter(maxHits: number, windowMs: number): { allow(key: string): boolean } {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string): boolean {
    const now = Date.now();
      const since = now - windowMs;
      const recent = (hits.get(key) ?? []).filter((hit) => hit > since);
      recent.push(now);
      hits.set(key, recent);
      return recent.length <= maxHits;
    }
  };
}
