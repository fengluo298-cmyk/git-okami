import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";
import { acceptAuthoritativeRoomState, type AuthoritativeRoomState } from "../../mobile/src/roomState.js";

type Json = Record<string, any>;

test("socket create join and leave retries are atomic across same-user sockets", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_create_retry");
    const beta = await register(server.port, "beta_create_retry");
    const alphaOne = await connectPlayer(server.port, alpha.token);
    const alphaTwo = await connectPlayer(server.port, alpha.token);
    const betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(alphaOne, alphaTwo, betaSocket);
    const alphaOneStates: Json[] = [];
    const alphaTwoStates: Json[] = [];
    const alphaOneNullMetas: Json[] = [];
    const alphaTwoNullMetas: Json[] = [];
    alphaOne.on("room:state", (state) => alphaOneStates.push(state));
    alphaTwo.on("room:state", (state) => alphaTwoStates.push(state));
    alphaOne.on("room:state", (state, meta) => {
      if (state === null) alphaOneNullMetas.push(meta);
    });
    alphaTwo.on("room:state", (state, meta) => {
      if (state === null) alphaTwoNullMetas.push(meta);
    });

    const actionId = unique("create_atomic");
    const [first, second] = await Promise.all([
      emitAck(alphaOne, "rooms:create", { actionId, name: "atomic" }),
      emitAck(alphaTwo, "rooms:create", { actionId, name: "atomic" })
    ]);
    assert.deepEqual(second, first);
    assert.equal(first.ok, true);
    assert.equal(first.roomId, first.state.id);
    await waitFor(() => alphaOneStates.some((state) => state?.id === first.roomId) && alphaTwoStates.some((state) => state?.id === first.roomId));
    assert.deepEqual(await emitAck(alphaOne, "rooms:create", { actionId, name: "atomic" }), first);

    const join = await emitAck(betaSocket, "rooms:join", { actionId: unique("join_retry"), roomId: first.roomId });
    assert.equal(join.ok, true);
    const joinRetry = await emitAck(betaSocket, "rooms:join", { actionId: join.actionId, roomId: first.roomId });
    assert.deepEqual(joinRetry, join);

    const latestAlpha = [...alphaOneStates].reverse().find((state: Json | null) => state?.id === first.roomId)!;
    const leave = await emitAck(alphaOne, "rooms:leave", { actionId: unique("leave_retry"), stateVersion: latestAlpha.stateVersion });
    assert.equal(leave.ok, true);
    const leaveRetry = await emitAck(alphaTwo, "rooms:leave", { actionId: leave.actionId, stateVersion: latestAlpha.stateVersion });
    assert.deepEqual(leaveRetry, leave);
    await waitFor(() => alphaOneStates.at(-1) === null && alphaTwoStates.at(-1) === null);
    assert.deepEqual(alphaOneNullMetas.at(-1), { reason: "leave", roomId: first.roomId, roomEpoch: first.state.roomEpoch });
    assert.deepEqual(alphaTwoNullMetas.at(-1), { reason: "leave", roomId: first.roomId, roomEpoch: first.state.roomEpoch });
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("mutable room socket events require an exact stateVersion", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_version_required");
    const beta = await register(server.port, "beta_version_required");
    const alphaSocket = await connectPlayer(server.port, alpha.token);
    const betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(alphaSocket, betaSocket);

    const created = await emitAck(alphaSocket, "rooms:create", { actionId: unique("create") });
    assert.equal(created.ok, true);
    assert.equal((await emitAck(betaSocket, "rooms:join", { actionId: unique("join"), roomId: created.roomId })).ok, true);
    for (const [event, payload] of [
      ["seat:sit", { seat: 0, buyIn: 1000 }],
      ["seat:leave", {}],
      ["seat:ready", { ready: true }],
      ["game:start", {}],
      ["game:action", { type: "check" }],
      ["rooms:leave", {}]
    ] as const) {
      const result = await emitAck(alphaSocket, event, { actionId: unique(`missing_${event.replace(":", "_")}`), ...payload });
      assert.equal(result.ok, false, event);
      assert.equal(result.code, "STATE_VERSION_REQUIRED", event);
    }
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("stale actionId failures are cached and different stateVersions conflict", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_stale_retry");
    const beta = await register(server.port, "beta_stale_retry");
    const alphaSocket = await connectPlayer(server.port, alpha.token);
    const betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(alphaSocket, betaSocket);

    const created = await emitAck(alphaSocket, "rooms:create", { actionId: unique("create") });
    assert.equal(created.ok, true);
    const actionId = unique("stale_sit");
    const stale = await emitAck(alphaSocket, "seat:sit", { actionId, seat: 0, buyIn: 1000, stateVersion: created.stateVersion - 1 });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "STATE_VERSION_STALE");

    const joined = await emitAck(betaSocket, "rooms:join", { actionId: unique("join"), roomId: created.roomId });
    assert.equal(joined.ok, true);
    const retry = await emitAck(alphaSocket, "seat:sit", { actionId, seat: 0, buyIn: 1000, stateVersion: created.stateVersion - 1 });
    assert.deepEqual(retry, stale);

    const conflict = await emitAck(alphaSocket, "seat:sit", { actionId, seat: 0, buyIn: 1000, stateVersion: joined.stateVersion });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "ACTION_ID_CONFLICT");
    assert.equal(seat(joined.state, alpha.user.id), null);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

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

    const changedAmount = await emitAck(alphaSocket, "game:action", { actionId, type: "call", amount: 1, stateVersion: start.stateVersion });
    assert.equal(changedAmount.ok, false);
    assert.equal(changedAmount.code, "ACTION_ID_CONFLICT");

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
    const build3 = await connectPlayer(server.port, user.token, 3);
    const build4 = await connectPlayer(server.port, user.token, 4);
    assert.equal(build3.connected, true);
    assert.equal(build4.connected, true);
    build3.disconnect();
    build4.disconnect();

    const staleSocket = connectSocket(`http://127.0.0.1:${server.port}`, {
      auth: { token: user.token, clientBuild: 2 },
      autoConnect: false,
      reconnection: false,
      timeout: 2000,
      transports: ["websocket"]
    });
    let sessions = 0;
    let roomStates = 0;
    staleSocket.on("session", () => {
      sessions += 1;
    });
    staleSocket.on("room:state", () => {
      roomStates += 1;
    });
    await assert.rejects(
      () => connectPreparedSocket(staleSocket),
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
    assert.equal(staleSocket.connected, false);
    assert.equal(sessions, 0);
    assert.equal(roomStates, 0);
    staleSocket.disconnect();
  } finally {
    await server.close();
  }
});

test("guest auth cookie reuses the guest account when local token storage is unavailable", async () => {
  const server = await startServer();
  try {
    const first = await request(server.port, "POST", "/auth/guest", {}, "3");
    assert.equal(first.status, 200);
    const cookie = first.headers.get("set-cookie");
    assert.match(cookie ?? "", /holdem_guest=/);

    const second = await request(server.port, "POST", "/auth/guest", {}, "3", { cookie: cookie!.split(";")[0] });
    assert.equal(second.status, 200);
    assert.equal(second.body.user.id, first.body.user.id);
    assert.equal(second.body.token, first.body.token);
  } finally {
    await server.close();
  }
});

test("explicit minimum client build can require a future app build", async () => {
  const server = await startServer({ MIN_CLIENT_BUILD: "4" });
  try {
    const version = await request(server.port, "GET", "/client-version");
    assert.equal(version.status, 200);
    assert.equal(version.body.minimumBuild, 4);

    const blocked = await request(server.port, "POST", "/auth/guest", {}, "3");
    assert.equal(blocked.status, 426);
    assert.equal(blocked.body.code, "CLIENT_UPGRADE_REQUIRED");
    assert.equal(blocked.body.minimumBuild, 4);
    assert.equal(blocked.body.currentBuild, 3);

    const user = await register(server.port, "future_socket", "4");
    const okSocket = await connectPlayer(server.port, user.token, 4);
    assert.equal(okSocket.connected, true);
    okSocket.disconnect();

    await assert.rejects(
      () => connectPlayer(server.port, user.token, 3),
      (error: Error & { data?: Json }) => {
        assert.equal(error.data?.code, "CLIENT_UPGRADE_REQUIRED");
        assert.equal(error.data?.minimumBuild, 4);
        assert.equal(error.data?.currentBuild, 3);
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("auth rate limiter trusts forwarded addresses only with explicit proxy hops", async () => {
  const noTrust = await startServer();
  try {
    let status = 0;
    for (let index = 0; index < 21; index += 1) {
      status = (await request(noTrust.port, "POST", "/auth/login", { username: `xff_plain_${index}`, password: "secret1" }, "3", { "x-forwarded-for": `198.51.100.${index}` })).status;
    }
    assert.equal(status, 429);
  } finally {
    await noTrust.close();
  }

  const trusted = await startServer({ TRUST_PROXY_HOPS: "1" });
  try {
    let status = 0;
    for (let index = 0; index < 21; index += 1) {
      status = (await request(trusted.port, "POST", "/auth/login", { username: `xff_trusted_${index}`, password: "secret1" }, "3", { "x-forwarded-for": `198.51.100.${index}` })).status;
    }
    assert.equal(status, 401);

    for (let index = 0; index < 21; index += 1) {
      status = (await request(trusted.port, "POST", "/auth/login", { username: `xff_bad_${index}`, password: "secret1" }, "3", { "x-forwarded-for": "not-an-ip" })).status;
    }
    assert.equal(status, 429);
  } finally {
    await trusted.close();
  }
});

test("legacy socket room recovery without ack emits one state to the requesting socket", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_legacy_resume");
    const beta = await register(server.port, "beta_legacy_resume");
    const alphaOld = await connectPlayer(server.port, alpha.token);
    const betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(alphaOld, betaSocket);

    const created = await emitAck(alphaOld, "rooms:create", { actionId: unique("create") });
    assert.equal(created.ok, true);
    const joined = await emitAck(betaSocket, "rooms:join", { actionId: unique("join"), roomId: created.roomId });
    assert.equal(joined.ok, true);
    alphaOld.disconnect();
    await delay(80);

    const coldSocket = connectSocket(`http://127.0.0.1:${server.port}`, {
      auth: { token: alpha.token, clientBuild: 3 },
      autoConnect: false,
      reconnection: false,
      timeout: 2000,
      transports: ["websocket"]
    });
    sockets.push(coldSocket);
    const coldStates: Json[] = [];
    const betaStates: Json[] = [];
    coldSocket.on("room:state", (state) => coldStates.push(state));
    betaSocket.on("room:state", (state) => betaStates.push(state));

    await connectPreparedSocket(coldSocket);
    await delay(100);
    assert.equal(coldStates.length, 0);

    coldSocket.emit("rooms:resume");
    await waitFor(() => coldStates.length === 1);
    await delay(100);
    assert.equal(betaStates.length, 0);
    assert.equal(coldStates[0].id, created.roomId);
    assert.equal(coldStates[0].roomEpoch, joined.state.roomEpoch);
    assert.equal(coldStates[0].handId, joined.state.handId);
    assert.equal(coldStates[0].stateVersion, joined.stateVersion);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("legacy socket room recovery without a room emits one null state", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_legacy_no_room");
    const alphaSocket = await connectPlayer(server.port, alpha.token);
    sockets.push(alphaSocket);
    const states: Json[] = [];
    alphaSocket.on("room:state", (state) => states.push(state));

    await delay(100);
    assert.equal(states.length, 0);
    alphaSocket.emit("rooms:resume");
    await waitFor(() => states.length === 1);
    await delay(100);
    assert.equal(states.length, 1);
    assert.equal(states[0], null);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("socket room recovery is explicit and returns one ack snapshot", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_explicit_resume");
    const alphaSocket = await connectPlayer(server.port, alpha.token);
    sockets.push(alphaSocket);

    const created = await emitAck(alphaSocket, "rooms:create", { actionId: unique("create") });
    assert.equal(created.ok, true);
    const sat = await emitAck(alphaSocket, "seat:sit", { actionId: unique("sit"), seat: 0, buyIn: 1000, stateVersion: created.stateVersion });
    assert.equal(sat.ok, true);
    alphaSocket.disconnect();
    await delay(100);

    const coldSocket = connectSocket(`http://127.0.0.1:${server.port}`, {
      auth: { token: alpha.token, clientBuild: 3 },
      autoConnect: false,
      reconnection: false,
      timeout: 2000,
      transports: ["websocket"]
    });
    sockets.push(coldSocket);
    const unsolicitedStates: Json[] = [];
    coldSocket.on("room:state", (state) => unsolicitedStates.push(state));
    await connectPreparedSocket(coldSocket);
    await delay(100);
    assert.equal(unsolicitedStates.length, 0);

    let ackCount = 0;
    const resume = await new Promise<Json>((resolve, reject) => {
      coldSocket.timeout(2000).emit("rooms:resume", { reason: "socket-connect" }, (error: Error | null, result?: Json) => {
        ackCount += 1;
        if (error) reject(error);
        else resolve(result ?? {});
      });
    });
    assert.equal(resume.ok, true);
    assert.equal(ackCount, 1);
    assert.equal(resume.state.id, created.roomId);
    assert.equal(resume.stateVersion, resume.state.stateVersion);
    assert.equal(seat(resume.state, alpha.user.id)?.connected, true);
    await delay(100);
    assert.equal(unsolicitedStates.length, 0);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("socket room recovery returns null when the authenticated user has no room", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_resume_no_room");
    const alphaSocket = await connectPlayer(server.port, alpha.token);
    sockets.push(alphaSocket);
    const states: Json[] = [];
    alphaSocket.on("room:state", (state) => states.push(state));

    const resume = await emitAck(alphaSocket, "rooms:resume", { reason: "socket-connect" });
    assert.equal(resume.ok, true);
    assert.equal(resume.state, null);
    await delay(100);
    assert.equal(states.length, 0);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("same user reconnect keeps the new socket online when the old socket disconnects", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_reconnect");
    const beta = await register(server.port, "beta_reconnect");
    const alphaOld = await connectPlayer(server.port, alpha.token);
    const betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(alphaOld, betaSocket);
    let betaState: Json | null = null;
    betaSocket.on("room:state", (state) => {
      if (state) betaState = state;
    });

    const created = await emitAck(alphaOld, "rooms:create", { actionId: unique("create") });
    assert.equal(created.ok, true);
    const joined = await emitAck(betaSocket, "rooms:join", { actionId: unique("join"), roomId: created.roomId });
    assert.equal(joined.ok, true);
    assert.equal((await emitAck(alphaOld, "seat:sit", { actionId: unique("sit_a"), seat: 0, buyIn: 1000, stateVersion: joined.stateVersion })).ok, true);
    await waitFor(() => betaState !== null && seat(betaState, alpha.user.id)?.connected === true);

    const alphaNew = await connectPlayer(server.port, alpha.token);
    sockets.push(alphaNew);
    await waitFor(() => betaState !== null && seat(betaState, alpha.user.id)?.connected === true);
    alphaOld.disconnect();
    await delay(80);
    assert.equal(seat(betaState, alpha.user.id)?.connected, true);

    alphaNew.disconnect();
    await waitFor(() => betaState !== null && seat(betaState, alpha.user.id)?.connected === false);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("game action ack and broadcast share the same authoritative snapshot", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_ack_broadcast");
    const beta = await register(server.port, "beta_ack_broadcast");
    const alphaSocket = await connectPlayer(server.port, alpha.token);
    const betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(alphaSocket, betaSocket);
    const alphaStates: Json[] = [];
    const betaStates: Json[] = [];
    alphaSocket.on("room:state", (state) => {
      if (state) alphaStates.push(state);
    });
    betaSocket.on("room:state", (state) => {
      if (state) betaStates.push(state);
    });

    const started = await startHeadsUpRoom(alphaSocket, betaSocket);
    await delay(50);
    alphaStates.length = 0;

    const actionId = unique("ack_broadcast");
    const ack = await emitAck(alphaSocket, "game:action", { actionId, type: "call", stateVersion: started.stateVersion });
    assert.equal(ack.ok, true);
    const broadcast = await waitForState(alphaStates, ack.stateVersion);
    assert.deepEqual(ack.state, broadcast);
    assert.equal(typeof ack.state.actionDeadlineAt, "number");
    const betaBroadcast = await waitForState(betaStates, ack.stateVersion);
    assertPublicFieldsMatch(ack.state, betaBroadcast);
    assert.equal(betaBroadcast.actionDeadlineAt, ack.state.actionDeadlineAt);

    const broadcastCount = alphaStates.filter((state) => state.stateVersion === ack.stateVersion).length;
    assert.equal(broadcastCount, 1);
    assert.equal(betaStates.filter((state) => state.stateVersion === ack.stateVersion).length, 1);
    assertDuplicate(acceptAuthoritativeRoomState(asRoomState(ack.state), asRoomState(broadcast), "room:state"));
    assertDuplicate(acceptAuthoritativeRoomState(asRoomState(broadcast), asRoomState(ack.state), "ack"));
    const ackLost = acceptAuthoritativeRoomState(asRoomState(started), asRoomState(broadcast), "room:state");
    assert.equal(ackLost.accepted, true);
    assertDuplicate(acceptAuthoritativeRoomState(ackLost.room!, asRoomState(broadcast), "room:state"));

    const retry = await emitAck(alphaSocket, "game:action", { actionId, type: "call", stateVersion: started.stateVersion });
    await delay(50);
    assert.deepEqual(retry, ack);
    assert.equal(alphaStates.filter((state) => state.stateVersion === ack.stateVersion).length, broadcastCount);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("non-current player reconnect does not orphan or duplicate the action timer", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_timer_reconnect");
    const beta = await register(server.port, "beta_timer_reconnect");
    const alphaSocket = await connectPlayer(server.port, alpha.token);
    let betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(alphaSocket, betaSocket);
    let latestAlpha: Json | null = null;
    alphaSocket.on("room:state", (state) => {
      if (state) latestAlpha = state;
    });

    const started = await startHeadsUpRoom(alphaSocket, betaSocket, { actionTimeoutSeconds: 1 });
    latestAlpha = started;
    assert.equal(started.game.currentTurnSeat, seat(started, alpha.user.id)?.seat);

    betaSocket.disconnect();
    await waitFor(() => latestAlpha !== null && seat(latestAlpha, beta.user.id)?.connected === false);
    betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(betaSocket);
    const resume = await emitAck(betaSocket, "rooms:resume", { reason: "socket-connect" });
    assert.equal(resume.ok, true);
    await waitFor(() => latestAlpha !== null && seat(latestAlpha, beta.user.id)?.connected === true);

    const versionAfterReconnect = latestAlpha!.stateVersion;
    await waitFor(() => latestAlpha !== null && latestAlpha.stateVersion > versionAfterReconnect, 2500);
    const versionAfterTimeout = latestAlpha!.stateVersion;
    assert.equal(latestAlpha!.status, "finished");
    assert.ok(latestAlpha!.game);

    await delay(300);
    assert.equal(latestAlpha!.stateVersion, versionAfterTimeout);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

test("two socket clients keep public state synchronized through a hand and reconnect", async () => {
  const server = await startServer();
  const sockets: ClientSocket[] = [];
  try {
    const alpha = await register(server.port, "alpha_sync");
    const beta = await register(server.port, "beta_sync");
    const alphaSocket = await connectPlayer(server.port, alpha.token);
    let betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(alphaSocket, betaSocket);
    const latest: Record<string, Json | null> = { alpha: null, beta: null };
    alphaSocket.on("room:state", (state) => {
      if (state) latest.alpha = state;
    });
    betaSocket.on("room:state", (state) => {
      if (state) latest.beta = state;
    });

    const started = await startHeadsUpRoom(alphaSocket, betaSocket);
    latest.alpha = started;
    await waitForSync(latest, started.stateVersion);
    assertPublicFieldsMatch(latest.alpha!, latest.beta!);

    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "call");
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "check");
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "check");
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "bet", 40);
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "raise", 80);
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "call");
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "check");
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "check");
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "check");
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "check");
    assert.equal(latest.alpha!.status, "finished");

    await ready(latest, alphaSocket, betaSocket);
    const nextHand = await emitAck(alphaSocket, "game:start", { actionId: unique("next"), stateVersion: latest.alpha!.stateVersion });
    assert.equal(nextHand.ok, true);
    latest.alpha = nextHand.state;
    await waitForSync(latest, nextHand.stateVersion);
    assert.equal(latest.alpha!.handId, 2);
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "all-in");
    await actCurrent(latest, alpha, beta, alphaSocket, betaSocket, "fold");

    betaSocket.disconnect();
    await waitFor(() => latest.alpha !== null && seat(latest.alpha, beta.user.id)?.connected === false);
    const alphaReady = await emitAck(alphaSocket, "seat:ready", { actionId: unique("alpha_ready"), ready: true, stateVersion: latest.alpha!.stateVersion });
    assert.equal(alphaReady.ok, true);
    latest.alpha = alphaReady.state;

    betaSocket = await connectPlayer(server.port, beta.token);
    sockets.push(betaSocket);
    betaSocket.on("room:state", (state) => {
      if (state) latest.beta = state;
    });
    const betaResume = await emitAck(betaSocket, "rooms:resume", { reason: "socket-connect" });
    assert.equal(betaResume.ok, true);
    latest.beta = betaResume.state;
    await waitFor(() => latest.beta !== null && latest.beta.stateVersion >= latest.alpha!.stateVersion && seat(latest.beta, beta.user.id)?.connected === true);
    assertPublicFieldsMatch(latest.alpha!, latest.beta!);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  }
});

async function startHeadsUpRoom(alpha: ClientSocket, beta: ClientSocket, rules: Json = {}): Promise<Json> {
  const created = await emitAck(alpha, "rooms:create", { actionId: unique("create"), rules });
  assert.equal(created.ok, true);
  const roomId = created.roomId;
  const joined = await emitAck(beta, "rooms:join", { actionId: unique("join"), roomId });
  assert.equal(joined.ok, true);
  const sitAlpha = await emitAck(alpha, "seat:sit", { actionId: unique("sit_a"), seat: 0, buyIn: 1000, stateVersion: joined.stateVersion });
  assert.equal(sitAlpha.ok, true);
  const sitBeta = await emitAck(beta, "seat:sit", { actionId: unique("sit_b"), seat: 1, buyIn: 1000, stateVersion: sitAlpha.stateVersion });
  assert.equal(sitBeta.ok, true);
  const readyAlpha = await emitAck(alpha, "seat:ready", { actionId: unique("ready_a"), ready: true, stateVersion: sitBeta.stateVersion });
  assert.equal(readyAlpha.ok, true);
  const readyBeta = await emitAck(beta, "seat:ready", { actionId: unique("ready_b"), ready: true, stateVersion: readyAlpha.stateVersion });
  assert.equal(readyBeta.ok, true);
  const started = await emitAck(alpha, "game:start", { actionId: unique("start"), stateVersion: readyBeta.stateVersion });
  assert.equal(started.ok, true);
  return started.state;
}

async function register(port: number, username: string, clientBuild = "3"): Promise<Json> {
  const response = await request(port, "POST", "/auth/register", { username, password: "secret1", nickname: username }, clientBuild);
  assert.equal(response.status, 200);
  return response.body;
}

async function request(port: number, method: string, path: string, body?: Json, clientBuild?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Json; headers: Headers }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(clientBuild ? { "x-client-build": clientBuild } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() as Json, headers: response.headers };
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

async function connectPreparedSocket(socket: ClientSocket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("socket connect timeout"));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect();
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

async function startServer(env: Record<string, string> = {}): Promise<{ port: number; close: () => Promise<void> }> {
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
      CLIENT_DOWNLOAD_URL: "https://example.invalid/git-okami.apk",
      ...env
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

function seat(state: Json | null, userId: string): Json | null {
  return state?.seats.find((candidate: Json | null) => candidate?.id === userId) ?? null;
}

async function ready(latest: Record<string, Json | null>, alpha: ClientSocket, beta: ClientSocket): Promise<void> {
  const first = await emitAck(alpha, "seat:ready", { actionId: unique("ready_alpha"), ready: true, stateVersion: latest.alpha!.stateVersion });
  assert.equal(first.ok, true);
  latest.alpha = first.state;
  await waitForSync(latest, first.stateVersion);
  const second = await emitAck(beta, "seat:ready", { actionId: unique("ready_beta"), ready: true, stateVersion: latest.beta!.stateVersion });
  assert.equal(second.ok, true);
  latest.beta = second.state;
  await waitForSync(latest, second.stateVersion);
}

async function actCurrent(latest: Record<string, Json | null>, alpha: Json, beta: Json, alphaSocket: ClientSocket, betaSocket: ClientSocket, type: string, amount?: number): Promise<void> {
  const state = latest.alpha!;
  const actor = state.game.players.find((candidate: Json) => candidate.seat === state.game.currentTurnSeat);
  assert.ok(actor);
  const socket = actor.id === alpha.user.id ? alphaSocket : betaSocket;
  const key = actor.id === alpha.user.id ? "alpha" : "beta";
  const result = await emitAck(socket, "game:action", { actionId: unique(type.replace("-", "_")), type, ...(amount === undefined ? {} : { amount }), stateVersion: latest[key]!.stateVersion });
  assert.equal(result.ok, true);
  latest[key] = result.state;
  await waitForSync(latest, result.stateVersion);
  assertPublicFieldsMatch(latest.alpha!, latest.beta!);
}

async function waitForSync(latest: Record<string, Json | null>, stateVersion: number): Promise<void> {
  await waitFor(() => Boolean(latest.alpha && latest.beta && latest.alpha.stateVersion >= stateVersion && latest.beta.stateVersion >= stateVersion));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.equal(predicate(), true);
}

async function waitForState(states: Json[], stateVersion: number): Promise<Json> {
  await waitFor(() => states.some((state) => state?.stateVersion === stateVersion));
  const state = states.find((candidate) => candidate?.stateVersion === stateVersion);
  assert.ok(state);
  return state;
}

function assertDuplicate(decision: ReturnType<typeof acceptAuthoritativeRoomState>): void {
  assert.equal(decision.accepted, true);
  assert.equal(decision.duplicate, true);
}

function asRoomState(state: Json): AuthoritativeRoomState {
  return state as AuthoritativeRoomState;
}

function assertPublicFieldsMatch(left: Json, right: Json): void {
  assert.deepEqual(publicFields(left), publicFields(right));
  const leftHands = left.game?.players.map((candidate: Json) => candidate.hand).filter(Boolean) ?? [];
  const rightHands = right.game?.players.map((candidate: Json) => candidate.hand).filter(Boolean) ?? [];
  if (!left.game?.showdown) assert.equal(leftHands.length <= 1, true);
  if (!right.game?.showdown) assert.equal(rightHands.length <= 1, true);
}

function publicFields(state: Json): Json {
  return {
    roomId: state.id,
    roomEpoch: state.roomEpoch,
    handId: state.handId,
    stateVersion: state.stateVersion,
    status: state.status,
    street: state.game?.street ?? null,
    dealer: state.game?.dealerSeat ?? null,
    currentPlayer: state.game?.currentTurnSeat ?? null,
    board: state.game?.board ?? [],
    pot: state.game?.pot ?? 0,
    sidePots: state.game?.sidePots ?? [],
    seats: state.seats.map((candidate: Json | null) =>
      candidate
        ? {
            id: candidate.id,
            seat: candidate.seat,
            chips: candidate.chips,
            ready: candidate.ready,
            connected: candidate.connected
          }
        : null
    ),
    players: (state.game?.players ?? []).map((candidate: Json) => ({
      id: candidate.id,
      seat: candidate.seat,
      chips: candidate.chips,
      bet: candidate.bet,
      folded: candidate.folded,
      allIn: candidate.allIn,
      connected: candidate.connected
    }))
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
