import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server, type Socket } from "socket.io";
import { login, register, signVoiceToken, verifyToken } from "./auth.js";
import { AppDatabase, type UserRecord } from "./db.js";
import { RoomStore, type Room, type RoomRules } from "./roomStore.js";
import type { PlayerAction } from "./game/gameEngine.js";

const port = Number(process.env.PORT ?? 4000);
const corsOrigin = process.env.CORS_ORIGIN ?? "*";
const socketCorsOrigin = process.env.SOCKET_CORS_ORIGIN ?? corsOrigin;
const db = new AppDatabase();
const rooms = new RoomStore(db);
const actionTimers = new Map<string, NodeJS.Timeout>();

const httpServer = createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/") return sendJson(res, 200, { ok: true, service: "texas-holdem-server" });
    if (req.method === "POST" && url.pathname === "/auth/register") return sendJson(res, 200, { ok: true, ...(await register(db, await readJson(req))) });
    if (req.method === "POST" && url.pathname === "/auth/login") return sendJson(res, 200, { ok: true, ...(await login(db, await readJson(req))) });
    if (req.method === "GET" && url.pathname === "/auth/me") return sendJson(res, 200, { ok: true, user: verifyToken(db, bearer(req)) });
    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Unknown error" });
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
    const auth = socket.handshake.auth as { token?: string };
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

  socket.on("rooms:create", (payload: { name?: string; rules?: Partial<RoomRules> } = {}, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.createRoom(user, payload.name, payload.rules);
      socket.join(room.id);
      socket.emit("room:state", rooms.publicRoom(room.id, user.id));
      emitRooms();
      return { roomId: room.id };
    })
  );

  socket.on("rooms:join", (payload: { roomId: string }, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.joinRoom(user, payload.roomId);
      socket.join(room.id);
      emitRoom(room);
      emitRooms();
      return { roomId: room.id };
    })
  );

  socket.on("rooms:leave", (_payload: unknown, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.leaveRoom(user.id);
      if (room) socket.leave(room.id);
      socket.emit("room:state", null);
      refreshSession(socket);
      emitRooms();
      if (room) emitRoom(room);
      return {};
    })
  );

  socket.on("seat:sit", (payload: { seat: number; buyIn?: number }, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.sit(user, payload.seat, Number(payload.buyIn ?? 1000));
      refreshSession(socket);
      emitRoom(room);
      emitRooms();
      return {};
    })
  );

  socket.on("seat:leave", (_payload: unknown, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.leaveSeat(user.id);
      refreshSession(socket);
      emitRoom(room);
      emitRooms();
      return {};
    })
  );

  socket.on("seat:ready", (payload: { ready: boolean }, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.setReady(user.id, Boolean(payload.ready));
      emitRoom(room);
      return {};
    })
  );

  socket.on("game:start", (_payload: unknown, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.startGame(user.id);
      emitRoom(room);
      emitRooms();
      scheduleRoomTimer(room);
      return {};
    })
  );

  socket.on("game:action", (payload: { type: PlayerAction; amount?: number }, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.action(user.id, payload.type, Number(payload.amount ?? 0));
      emitRoom(room);
      emitRooms();
      scheduleRoomTimer(room);
      return {};
    })
  );

  socket.on("voice:join", (_payload: unknown, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.joinVoice(user.id);
      emitRoom(room);
      return { voiceToken: signVoiceToken(user.id, room.id), roomId: room.id };
    })
  );

  socket.on("voice:leave", (_payload: unknown, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.leaveVoice(user.id);
      emitRoom(room);
      return {};
    })
  );

  socket.on("voice:mute", (payload: { muted: boolean }, ack?: Ack) =>
    handle(socket, ack, () => {
      const room = rooms.setVoiceMuted(user.id, Boolean(payload.muted));
      emitRoom(room);
      return {};
    })
  );

  socket.on("voice:speaking", (payload: { speaking: boolean }, ack?: Ack) =>
    handle(socket, ack, () => {
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

type Ack = (result: { ok: boolean; error?: string; [key: string]: unknown }) => void;

function handle(socket: Socket, ack: Ack | undefined, work: () => Record<string, unknown>): void {
  try {
    ack?.({ ok: true, ...work() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    socket.emit("error:message", { message });
    ack?.({ ok: false, error: message });
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
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, string>) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", corsOrigin);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : undefined;
}
