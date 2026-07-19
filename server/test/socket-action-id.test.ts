import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";

type Json = Record<string, any>;

test("socket game actionId retry returns the first result without replaying the action", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_action");
    const beta = await register(server.port, "beta_action");
    const alphaSocket = await connectPlayer(server.port, alpha.token);
    const betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(alphaSocket, betaSocket);

    const alphaStates: Json[] = [];
    const betaStates: Json[] = [];
    alphaSocket.on("room:state", (state) => alphaStates.push(state));
    betaSocket.on("room:state", (state) => betaStates.push(state));

    const start = await startHeadsUpRoom(alphaSocket, betaSocket);
    await delay(50);
    alphaStates.length = 0;
    betaStates.length = 0;

    const actionId = "action_retry_001";
    const first = await emitAck(alphaSocket, "game:action", { actionId, type: "call", stateVersion: start.stateVersion });
    await delay(50);
    assert.equal(first.ok, true);
    const alphaToCall = start.game.currentBet - player(start, alpha.user.id).bet;
    assert.equal(player(first.state, alpha.user.id).chips, player(start, alpha.user.id).chips - alphaToCall);
    assert.notEqual(first.state.game.currentTurnSeat, start.game.currentTurnSeat);
    assert.ok(first.stateVersion > start.stateVersion);
    const broadcastCount = alphaStates.length + betaStates.length;
    assert.ok(broadcastCount > 0);

    const retry = await emitAck(alphaSocket, "game:action", { actionId, type: "call", stateVersion: start.stateVersion });
    await delay(50);
    assert.deepEqual(retry, first);
    assert.equal(player(retry.state, alpha.user.id).chips, player(first.state, alpha.user.id).chips);
    assert.equal(retry.state.game.currentTurnSeat, first.state.game.currentTurnSeat);
    assert.equal(retry.stateVersion, first.stateVersion);
    assert.equal(alphaStates.length + betaStates.length, broadcastCount);

    const changedPayload = await emitAck(alphaSocket, "game:action", { actionId, type: "raise", amount: 300, stateVersion: first.stateVersion });
    assert.equal(changedPayload.ok, false);
    assert.equal(changedPayload.code, "ACTION_ID_CONFLICT");
    assert.equal(changedPayload.stateVersion, first.stateVersion);

    const changedEvent = await emitAck(alphaSocket, "seat:ready", { actionId, ready: true, stateVersion: first.stateVersion });
    assert.equal(changedEvent.ok, false);
    assert.equal(changedEvent.code, "ACTION_ID_CONFLICT");

    const invalid = await emitAck(alphaSocket, "game:action", { actionId: "bad id!!", type: "call", stateVersion: first.stateVersion });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "ACTION_ID_INVALID");

    const tooLong = await emitAck(alphaSocket, "game:action", { actionId: "a".repeat(81), type: "call", stateVersion: first.stateVersion });
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.code, "ACTION_ID_INVALID");

    const otherUser = await emitAck(betaSocket, "game:action", { actionId, type: "check", stateVersion: first.stateVersion });
    assert.equal(otherUser.ok, true);
    assert.notEqual(otherUser.stateVersion, first.stateVersion);

    const gamma = await register(server.port, "gamma_action");
    const delta = await register(server.port, "delta_action");
    const gammaSocket = await connectPlayer(server.port, gamma.token);
    const deltaSocket = await connectPlayer(server.port, delta.token);
    sockets.push(gammaSocket, deltaSocket);
    const secondRoom = await startHeadsUpRoom(gammaSocket, deltaSocket);
    const otherRoom = await emitAck(gammaSocket, "game:action", { actionId, type: "call", stateVersion: secondRoom.stateVersion });
    assert.equal(otherRoom.ok, true);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("upgrade and health endpoints expose version state without requiring a client build", async () => {
  const server = await startServer();
  try {
    assert.equal((await request(server.port, "GET", "/health")).status, 200);
    assert.equal((await request(server.port, "GET", "/ready")).status, 200);
    const version = await request(server.port, "GET", "/client-version");
    assert.equal(version.status, 200);
    assert.equal(version.body.minimumBuild, 3);
    assert.equal(version.body.latestVersion, "1.0.2");
    assert.equal(version.body.downloadUrl, "https://example.invalid/git-okami.apk");

    const blocked = await request(server.port, "POST", "/auth/login", { username: "none", password: "secret1" }, "2");
    assert.equal(blocked.status, 426);
    assert.equal(blocked.body.code, "CLIENT_UPGRADE_REQUIRED");
    assert.equal(blocked.body.minimumBuild, 3);
    assert.equal(blocked.body.currentBuild, 2);
    assert.equal(blocked.body.latestVersion, "1.0.2");
    assert.equal(blocked.body.downloadUrl, "https://example.invalid/git-okami.apk");
    assert.equal(typeof blocked.body.requestId, "string");

    const user = await register(server.port, "socket_upgrade");
    await assert.rejects(
      () => connectPlayer(server.port, user.token, 2),
      (error: Error & { data?: Json }) => {
        assert.equal(error.data?.code, "CLIENT_UPGRADE_REQUIRED");
        assert.equal(error.data?.minimumBuild, 3);
        assert.equal(error.data?.currentBuild, 2);
        assert.equal(error.data?.latestVersion, "1.0.2");
        assert.equal(error.data?.downloadUrl, "https://example.invalid/git-okami.apk");
        assert.equal(typeof error.data?.requestId, "string");
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

async function startHeadsUpRoom(alpha: ClientSocket, beta: ClientSocket): Promise<Json> {
  const created = await emitAck(alpha, "rooms:create", { actionId: unique("create") });
  assert.equal(created.ok, true);
  const roomId = created.roomId;
  assert.equal((await emitAck(beta, "rooms:join", { actionId: unique("join"), roomId })).ok, true);
  assert.equal((await emitAck(alpha, "seat:sit", { actionId: unique("sit_a"), seat: 0, buyIn: 1000 })).ok, true);
  assert.equal((await emitAck(beta, "seat:sit", { actionId: unique("sit_b"), seat: 1, buyIn: 1000 })).ok, true);
  assert.equal((await emitAck(alpha, "seat:ready", { actionId: unique("ready_a"), ready: true })).ok, true);
  assert.equal((await emitAck(beta, "seat:ready", { actionId: unique("ready_b"), ready: true })).ok, true);
  const started = await emitAck(alpha, "game:start", { actionId: unique("start") });
  assert.equal(started.ok, true);
  return started.state;
}

async function register(port: number, username: string): Promise<Json> {
  const response = await request(port, "POST", "/auth/register", { username, password: "secret1", nickname: username }, "3");
  assert.equal(response.status, 200);
  return response.body;
}

async function request(port: number, method: string, path: string, body?: Json, clientBuild?: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(clientBuild ? { "x-client-build": clientBuild } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() as Json };
}

async function connectPlayer(port: number, token: string, clientBuild = 3): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(`http://127.0.0.1:${port}`, {
      auth: { token, clientBuild },
      reconnection: false,
      timeout: 2000,
      transports: ["websocket"]
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("socket connect timeout"));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function emitAck(socket: ClientSocket, event: string, payload: Json): Promise<Json> {
  return new Promise((resolve, reject) => {
    socket.timeout(2000).emit(event, payload, (error: Error | null, result?: Json) => {
      if (error) reject(error);
      else resolve(result ?? {});
    });
  });
}

async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const port = await freePort();
  const cwd = process.cwd().endsWith(`${sep}server`) ? process.cwd() : resolve("server");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATABASE_PATH: join(mkdtempSync(join(tmpdir(), "holdem-socket-")), "test.db"),
      JWT_SECRET: "test-secret-for-socket-action-id-1234567890",
      MIN_CLIENT_BUILD: "3",
      LATEST_CLIENT_VERSION: "1.0.2",
      CLIENT_DOWNLOAD_URL: "https://example.invalid/git-okami.apk"
    }
  });
  const logs: string[] = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  await waitForServer(port, child, logs);
  return { port, close: () => stopServer(child) };
}

async function waitForServer(port: number, child: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join("")}`);
    try {
      if ((await request(port, "GET", "/health")).status === 200) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`server did not become healthy: ${logs.join("")}`);
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")));
    });
  });
}

function unique(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function player(state: Json, userId: string): Json {
  const found = state.game.players.find((candidate: Json) => candidate.id === userId);
  assert.ok(found);
  return found;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
