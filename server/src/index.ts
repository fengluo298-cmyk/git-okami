import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Server, type Socket } from "socket.io";
import { ClientUpgradeRequiredError, guestLogin, login, readMinimumClientBuild, register, requireClientBuild, signVoiceToken, verifyToken } from "./auth.js";
import { AppDatabase, type UserRecord } from "./db.js";
import { RoomStore, type Room, type RoomRules } from "./roomStore.js";
import type { PlayerAction } from "./game/gameEngine.js";
import { parseChipAmount } from "./amount.js";
import { OperationDeduper, RoomActionQueue, type AckResult } from "./operations.js";
import { SocketPresence } from "./socketPresence.js";
import { createRateLimiter } from "./rateLimiter.js";

const port = Number(process.env.PORT ?? 4000);
const corsOrigin = readCorsOrigin("CORS_ORIGIN");
const socketCorsOrigin = process.env.SOCKET_CORS_ORIGIN ?? corsOrigin;
const minClientBuild = readMinimumClientBuild();
const latestClientVersion = process.env.LATEST_CLIENT_VERSION ?? "1.0.2";
const clientDownloadUrl = process.env.CLIENT_DOWNLOAD_URL?.trim() || null;
const maxJsonBytes = Number(process.env.MAX_JSON_BYTES ?? 16_384);
const trustProxyHops = readTrustProxyHops();
const voiceEnabled = (process.env.VOICE_PROVIDER ?? "none") !== "none";
const db = new AppDatabase();
const runtimeLeaseOwnerId = db.acquireRuntimeLease();
if (!runtimeLeaseOwnerId) throw new Error("Another server instance is active");
db.recoverOrphanedTableEscrows(runtimeLeaseOwnerId);
const runtimeLeaseHeartbeat = setInterval(() => {
  if (!db.heartbeatRuntimeLease(runtimeLeaseOwnerId)) {
    console.error(JSON.stringify({ level: "fatal", event: "runtimeLeaseLost" }));
    process.exit(1);
  }
}, 10_000);
runtimeLeaseHeartbeat.unref();
const rooms = new RoomStore(db);
const actionTimers = new Map<string, NodeJS.Timeout>();
const userSockets = new SocketPresence();
const operations = new OperationDeduper();
const authLimiter = createRateLimiter(20, 15 * 60_000, { maxKeys: 10_000 });
const roomLocks = new RoomActionQueue();

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ level: "error", event: "unhandledRejection", message: safeLogMessage(reason) }));
});

process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({ level: "error", event: "uncaughtException", message: safeLogMessage(error) }));
  process.exit(1);
});

process.once("exit", cleanupRuntime);
process.once("SIGTERM", () => {
  cleanupRuntime();
  process.exit(0);
});
process.once("SIGINT", () => {
  cleanupRuntime();
  process.exit(0);
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
    if (req.method === "GET" && url.pathname === "/client-version") return sendJson(res, 200, { ok: true, minimumBuild: minClientBuild, latestVersion: latestClientVersion, downloadUrl: clientDownloadUrl }, requestId);
    if (req.method === "POST" && url.pathname === "/auth/register") {
      requireClientBuild(headerClientBuild(req), minClientBuild, clientVersionMeta());
      const body = await readJson(req);
      checkAuthLimit(req, body.username);
      return sendJson(res, 200, { ok: true, ...(await register(db, body)) }, requestId);
    }
    if (req.method === "POST" && url.pathname === "/auth/login") {
      requireClientBuild(headerClientBuild(req), minClientBuild, clientVersionMeta());
      const body = await readJson(req);
      checkAuthLimit(req, body.username);
      return sendJson(res, 200, { ok: true, ...(await login(db, body)) }, requestId);
    }
    if (req.method === "POST" && url.pathname === "/auth/guest") {
      requireClientBuild(headerClientBuild(req), minClientBuild, clientVersionMeta());
      checkAuthLimit(req, "guest");
      return sendJson(res, 200, { ok: true, ...guestLogin(db, await readJson(req)) }, requestId);
    }
    if (req.method === "GET" && url.pathname === "/auth/me") {
      requireClientBuild(headerClientBuild(req), minClientBuild, clientVersionMeta());
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
    requireClientBuild(auth.clientBuild, minClientBuild, clientVersionMeta());
    socket.data.user = verifyToken(db, auth.token);
    next();
  } catch (error) {
    const requestId = randomUUID();
    const publicError = toPublicError(error);
    const socketError = new Error(publicError.message) as Error & { data?: Record<string, unknown> };
    socketError.data = errorPayload(publicError, requestId);
    next(socketError);
  }
});

io.on("connection", (socket: Socket) => {
  const userId = currentSocketUser(socket).id;
  userSockets.add(userId, socket.id);
  socket.emit("session", currentSocketUser(socket));
  socket.emit("rooms:list", rooms.listRooms());

  socket.on("rooms:list", () => socket.emit("rooms:list", rooms.listRooms()));
  socket.on("rooms:resume", (payloadOrAck?: { reason?: string } | Ack, ack?: Ack) => {
    const callback = typeof payloadOrAck === "function" ? payloadOrAck : ack;
    void resumeRoom(socket)
      .then((result) => {
        if (callback) callback(result);
        else socket.emit("room:state", result.state);
      })
      .catch((error) => {
        logSocketTaskError("rooms:resume", error);
        const publicError = toPublicError(error);
        const result = errorPayload(publicError, randomUUID());
        if (callback) callback(result);
        else socket.emit("error:message", { message: result.message, code: result.code, requestId: result.requestId });
      });
  });

  socket.on("rooms:create", (payload: { name?: string; rules?: Partial<RoomRules>; operationId?: string } = {}, ack?: Ack) =>
    handle("rooms:create", socket, ack, payload, () => {
      const room = rooms.createRoom(currentSocketUser(socket), payload.name, payload.rules);
      joinUserSockets(userId, room.id);
      emitRoom(room);
      emitRooms();
      return { roomId: room.id };
    }, { lockRoomId: `user:${userId}:membership` })
  );

  socket.on("rooms:join", (payload: { roomId: string; operationId?: string }, ack?: Ack) =>
    handle("rooms:join", socket, ack, payload, () => {
      const room = rooms.joinRoom(currentSocketUser(socket), payload.roomId);
      joinUserSockets(userId, room.id);
      emitRoom(room);
      emitRooms();
      return { roomId: room.id };
    }, { lockRoomId: payload.roomId })
  );

  socket.on("rooms:leave", (payload: { operationId?: string; stateVersion?: number } = {}, ack?: Ack) =>
    handle("rooms:leave", socket, ack, payload, () => {
      const room = rooms.leaveRoom(userId);
      if (room) leaveUserSockets(userId, room.id);
      emitToUser(userId, "room:state", null, room ? { reason: "leave", roomId: room.id, roomEpoch: room.roomEpoch } : { reason: "leave" });
      refreshUserSessions(userId);
      emitRooms();
      if (room) emitRoom(room);
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("seat:sit", (payload: { seat: number; buyIn?: number | string; operationId?: string; stateVersion?: number }, ack?: Ack) =>
    handle("seat:sit", socket, ack, payload, () => {
      const current = rooms.currentRoom(userId);
      const buyIn = parseChipAmount(payload.buyIn ?? current?.rules.minBuyIn ?? 1000, "Buy-in");
      const room = rooms.sit(currentSocketUser(socket), payload.seat, buyIn);
      refreshUserSessions(userId);
      emitRoom(room);
      emitRooms();
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("seat:leave", (payload: { operationId?: string; stateVersion?: number } = {}, ack?: Ack) =>
    handle("seat:leave", socket, ack, payload, () => {
      const room = rooms.leaveSeat(userId);
      refreshUserSessions(userId);
      emitRoom(room);
      emitRooms();
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("seat:ready", (payload: { ready: boolean; operationId?: string; stateVersion?: number }, ack?: Ack) =>
    handle("seat:ready", socket, ack, payload, () => {
      const room = rooms.setReady(userId, Boolean(payload.ready));
      emitRoom(room);
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("game:start", (payload: { operationId?: string; stateVersion?: number } = {}, ack?: Ack) =>
    handle("game:start", socket, ack, payload, () => {
      const room = rooms.startGame(userId);
      scheduleRoomTimer(room);
      emitRoom(room);
      emitRooms();
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("game:action", (payload: { type: PlayerAction; amount?: number | string; operationId?: string; stateVersion?: number }, ack?: Ack) =>
    handle("game:action", socket, ack, payload, () => {
      const amount = payload.amount === undefined ? undefined : parseChipAmount(payload.amount, "Bet");
      const room = rooms.action(userId, payload.type, amount);
      scheduleRoomTimer(room);
      emitRoom(room);
      emitRooms();
      return {};
    }, { checkStateVersion: true, lockRoom: true })
  );

  socket.on("voice:join", (payload: { operationId?: string } = {}, ack?: Ack) =>
    handle("voice:join", socket, ack, payload, () => {
      if (!voiceEnabled) throw new Error("Voice is not available");
      const room = rooms.joinVoice(userId);
      emitRoom(room);
      return { voiceToken: signVoiceToken(userId, room.id), roomId: room.id };
    }, { lockRoom: true })
  );

  socket.on("voice:leave", (payload: { operationId?: string } = {}, ack?: Ack) =>
    handle("voice:leave", socket, ack, payload, () => {
      if (!voiceEnabled) throw new Error("Voice is not available");
      const room = rooms.leaveVoice(userId);
      emitRoom(room);
      return {};
    }, { lockRoom: true })
  );

  socket.on("voice:mute", (payload: { muted: boolean; operationId?: string }, ack?: Ack) =>
    handle("voice:mute", socket, ack, payload, () => {
      if (!voiceEnabled) throw new Error("Voice is not available");
      const room = rooms.setVoiceMuted(userId, Boolean(payload.muted));
      emitRoom(room);
      return {};
    }, { lockRoom: true })
  );

  socket.on("voice:speaking", (payload: { speaking: boolean; operationId?: string }, ack?: Ack) =>
    handle("voice:speaking", socket, ack, payload, () => {
      if (!voiceEnabled) throw new Error("Voice is not available");
      const room = rooms.setVoiceSpeaking(userId, Boolean(payload.speaking));
      emitRoom(room);
      return {};
    }, { lockRoom: true })
  );

  socket.on("disconnect", () => {
    userSockets.remove(userId, socket.id);
    if (userSockets.has(userId)) return;
    void markDisconnected(userId).catch((error) => logSocketTaskError("disconnect", error));
  });
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Texas Hold'em server listening on http://0.0.0.0:${port}`);
});

type Ack = (result: AckResult) => void;
type HandleOptions = { checkStateVersion?: boolean; lockRoom?: boolean; lockRoomId?: string };

async function handle(event: string, socket: Socket, ack: Ack | undefined, payload: { actionId?: unknown; operationId?: unknown; stateVersion?: unknown }, work: () => Record<string, unknown>, options: HandleOptions = {}): Promise<void> {
  const user = currentSocketUser(socket);
  const requestId = randomUUID();
  try {
    const actionId = payload.actionId ?? payload.operationId;
    const scope = operations.scope({
      userId: user.id,
      roomId: rooms.currentRoom(user.id)?.id ?? "lobby",
      actionId,
      event,
      payload
    });
    const result = await operations.run(scope, async () =>
      withRoomLock(options.lockRoomId ?? rooms.currentRoom(user.id)?.id, options.lockRoom || options.lockRoomId !== undefined, () => {
        try {
          if (options.checkStateVersion) rooms.assertFresh(user.id, payload.stateVersion);
          const output = work();
          const currentRoom = rooms.currentRoom(user.id);
          return {
            ok: true,
            code: "OK",
            actionId: scope.actionId,
            ...output,
            stateVersion: currentRoom?.version,
            state: currentRoom ? rooms.publicRoom(currentRoom.id, user.id) : null
          };
        } catch (error) {
          const publicError = toPublicError(error);
          return { ...errorPayload(publicError, requestId), actionId: scope.actionId, stateVersion: rooms.currentRoom(user.id)?.version };
        }
      }),
      shouldCacheOperationResult
    );
    if (!result.ok) socket.emit("error:message", { message: result.message, code: result.code, requestId: result.requestId });
    ack?.(result);
  } catch (error) {
    const publicError = toPublicError(error);
    const result = { ...errorPayload(publicError, requestId), stateVersion: rooms.currentRoom(user.id)?.version };
    socket.emit("error:message", { message: publicError.message, code: publicError.code, requestId });
    ack?.(result);
  }
}

function shouldCacheOperationResult(result: AckResult): boolean {
  if (result.ok) return true;
  const code = typeof result.code === "string" ? result.code : "";
  return !["INTERNAL_ERROR", "DATABASE_BUSY", "ROOM_BUSY", "LOCK_TIMEOUT", "ACTION_ID_CONFLICT"].includes(code);
}

function emitRooms(): void {
  io.emit("rooms:list", rooms.listRooms());
}

function emitRoom(room: Room, exceptSocketId?: string): void {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.id === exceptSocketId) continue;
    const user = socket.data.user as UserRecord | undefined;
    if (user && room.members.has(user.id)) socket.emit("room:state", rooms.publicRoom(room.id, user.id));
  }
}

async function resumeRoom(socket: Socket): Promise<AckResult> {
  const userId = currentSocketUser(socket).id;
  const current = rooms.currentRoom(userId);
  if (!current) {
    return { ok: true, code: "OK", state: null };
  }
  const result = await roomLocks.run(current.id, () => {
    const previousVersion = current.version;
    const room = rooms.markConnected(userId, true);
    if (!room) return { ok: true, code: "OK", state: null };
    socket.join(room.id);
    if (room.version !== previousVersion) {
      emitRoom(room, socket.id);
      scheduleRoomTimer(room);
    }
    const state = rooms.publicRoom(room.id, userId);
    return { ok: true, code: "OK", stateVersion: state.stateVersion, state };
  });
  return result;
}

async function markDisconnected(userId: string): Promise<void> {
  const current = rooms.currentRoom(userId);
  if (!current) return;
  await roomLocks.run(current.id, () => {
    const previousVersion = current.version;
    const room = rooms.markConnected(userId, false);
    if (room) {
      emitRoom(room);
      if (room.version !== previousVersion) scheduleRoomTimer(room);
    }
  });
}

function scheduleRoomTimer(room: Room): void {
  const oldTimer = actionTimers.get(room.id);
  if (oldTimer) clearTimeout(oldTimer);
  actionTimers.delete(room.id);
  const deadline = Date.now() + room.rules.actionTimeoutSeconds * 1000;
  const token = rooms.createActionTimerToken(room, deadline);
  if (!token) return;
  actionTimers.set(
    room.id,
    setTimeout(() => {
      void roomLocks
        .run(token.roomId, () => {
          const updated = rooms.autoActionIfCurrent(token);
          if (!updated) return;
          emitRoom(updated);
          emitRooms();
          scheduleRoomTimer(updated);
        })
        .catch((error) => console.error(JSON.stringify({ level: "error", event: "actionTimer", message: safeLogMessage(error) })));
    }, Math.max(0, token.actionDeadlineAt - Date.now()))
  );
}

function cleanupRuntime(): void {
  clearInterval(runtimeLeaseHeartbeat);
  for (const timer of actionTimers.values()) clearTimeout(timer);
  actionTimers.clear();
  db.releaseRuntimeLease(runtimeLeaseOwnerId);
}

function refreshUserSessions(userId: string): void {
  const fresh = db.getUser(userId);
  if (!fresh) return;
  for (const socketId of userSockets.ids(userId)) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    socket.data.user = fresh;
    socket.emit("session", fresh);
  }
}

function emitToUser(userId: string, event: string, payload: unknown, meta?: unknown): void {
  for (const socketId of userSockets.ids(userId)) io.sockets.sockets.get(socketId)?.emit(event, payload, meta);
}

function joinUserSockets(userId: string, roomId: string): void {
  for (const socketId of userSockets.ids(userId)) io.sockets.sockets.get(socketId)?.join(roomId);
}

function leaveUserSockets(userId: string, roomId: string): void {
  for (const socketId of userSockets.ids(userId)) io.sockets.sockets.get(socketId)?.leave(roomId);
}

function currentSocketUser(socket: Socket): UserRecord {
  return socket.data.user as UserRecord;
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
  sendJson(res, error.status, errorPayload(error, requestId), requestId);
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allowed = chooseCorsOrigin(origin);
  if (allowed) res.setHeader("access-control-allow-origin", allowed);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization,x-client-build");
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function headerClientBuild(req: IncomingMessage): unknown {
  return req.headers["x-client-build"];
}

type PublicError = Error & { code: string; status: number; details?: Record<string, unknown> };

function apiError(code: string, message: string, status: number, details?: Record<string, unknown>): PublicError {
  const error = new Error(message) as PublicError;
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function toPublicError(error: unknown): PublicError {
  if (error instanceof ClientUpgradeRequiredError) {
    return apiError(error.code, "当前版本已停止服务，请安装最新版本", error.status, {
      minimumBuild: error.minimumBuild,
      currentBuild: error.currentBuild,
      latestVersion: error.latestVersion,
      downloadUrl: error.downloadUrl
    });
  }
  if (isPublicError(error)) return error;
  const message = error instanceof Error ? error.message : "";
  if (message === "Username already exists") return apiError("AUTH_USERNAME_TAKEN", "用户名已存在", 409);
  if (message === "Invalid username or password") return apiError("AUTH_INVALID_CREDENTIALS", "用户名或密码错误", 401);
  if (message === "Missing token" || message === "Invalid token" || message === "Token expired" || message === "Unauthorized") return apiError("AUTH_INVALID_TOKEN", "登录已失效，请重新登录", 401);
  if (message === "Voice is not available") return apiError("VOICE_UNAVAILABLE", "语音功能开发中", 409);
  if (message === "Already in a room") return apiError("ALREADY_IN_ROOM", "Already in a room", 409);
  if (message === "Spectators are not allowed") return apiError("SPECTATORS_NOT_ALLOWED", "Spectators are not allowed", 403);
  if (message === "Room rules are invalid") return apiError("ROOM_RULES_INVALID", "Room rules are invalid", 400);
  if (message === "State version is required") return apiError("STATE_VERSION_REQUIRED", "State version is required", 400);
  if (message === "State version is invalid") return apiError("STATE_VERSION_INVALID", "State version is invalid", 400);
  if (message === "State version is stale") return apiError("STATE_VERSION_STALE", "牌桌状态已更新，请重试", 409);
  if (message === "Room is busy") return apiError("ROOM_BUSY", "牌桌正在处理上一项操作，请稍后重试", 409);
  if (message === "Action id is required") return apiError("ACTION_ID_REQUIRED", "操作编号缺失，请同步牌桌后重试", 400);
  if (message === "Action id is invalid") return apiError("ACTION_ID_INVALID", "操作编号无效，请同步牌桌后重试", 400);
  if (message === "Action id was already used with different parameters") return apiError("ACTION_ID_CONFLICT", "该操作编号已用于其他操作，请同步牌桌后重试", 409);
  if (message === "Raise is not reopened") return apiError("ACTION_NOT_ALLOWED", "短码全下未重新开放加注，请选择跟注或弃牌", 409);
  if (knownClientError(message)) return apiError("BAD_REQUEST", message, 400);
  return apiError("INTERNAL_ERROR", "服务暂不可用，请稍后重试", 500);
}

function errorPayload(error: PublicError, requestId: string): { ok: false; code: string; message: string; error: string; requestId: string; [key: string]: unknown } {
  return { ok: false, code: error.code, message: error.message, error: error.message, requestId, ...(error.details ?? {}) };
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
    "Already in a room",
    "Spectators are not allowed",
    "Room rules are invalid",
    "State version is required",
    "State version is invalid",
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

function clientVersionMeta(): { latestVersion: string; downloadUrl: string | null } {
  return { latestVersion: latestClientVersion, downloadUrl: clientDownloadUrl };
}

function checkAuthLimit(req: IncomingMessage, username: unknown): void {
  const ip = clientIp(req);
  const userKey = typeof username === "string" ? username.trim().toLowerCase().slice(0, 32) : "unknown";
  if (!authLimiter.allow(`ip:${ip}`) || !authLimiter.allow(`user:${userKey}:${ip}`)) throw apiError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
}

function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  if (trustProxyHops <= 0) return remote;
  const header = req.headers["x-forwarded-for"];
  if (typeof header !== "string") return remote;
  const hops = header.split(",").map((part) => part.trim()).filter(Boolean);
  const candidate = hops[hops.length - trustProxyHops];
  return candidate && isIP(candidate) ? candidate : remote;
}

function withRoomLock<T>(roomId: string | undefined, enabled: boolean | undefined, work: () => T | Promise<T>): T | Promise<T> {
  if (!enabled) return work();
  if (!roomId) return work();
  return roomLocks.run(roomId, work);
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

function readTrustProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) throw new Error("TRUST_PROXY_HOPS must be a safe integer from 0 to 10");
  return value;
}

function safeLogMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]").replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]");
}

function logError(requestId: string, error: unknown): void {
  console.error(JSON.stringify({ level: "error", requestId, message: safeLogMessage(error) }));
}

function logSocketTaskError(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: "error", event, message: safeLogMessage(error) }));
}
