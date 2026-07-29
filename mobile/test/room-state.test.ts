import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptAuthoritativeRoomState,
  clearPendingSocketAction,
  consumeRoomEntryContext,
  createRoomEntryContext,
  isRoomEntryContextActive,
  prepareSocketAction,
  type AuthoritativeRoomState,
  type PendingSocketAction,
  type RoomEntryContext,
  type RoomEntryEvent
} from "../src/roomState";

test("authoritative room state rejects stale duplicate and conflicting updates", () => {
  const current = room({ stateVersion: 5, handId: 1, board: [] });
  const stale = acceptAuthoritativeRoomState(current, room({ stateVersion: 4, handId: 1, board: [] }), "room:state");
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "stale-state-version");
  assert.equal(stale.room, current);

  const duplicate = acceptAuthoritativeRoomState(current, room({ stateVersion: 5, handId: 1, board: [] }), "room:state");
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.room, current);

  const conflict = acceptAuthoritativeRoomState(current, room({ stateVersion: 5, handId: 1, board: [{ rank: 10, suit: "H" }] }), "room:state");
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.needsResume, true);
  assert.equal(conflict.reason, "same-version-conflict");
  assert.equal(conflict.room, current);
});

test("authoritative room state uses room epoch hand id and source before accepting", () => {
  const current = room({ stateVersion: 7, handId: 2, roomEpoch: "epoch-a" });
  assert.equal(acceptAuthoritativeRoomState(null, room({ stateVersion: 1 }), "room:state").accepted, false);
  assert.equal(acceptAuthoritativeRoomState(null, room({ stateVersion: 1 }), "resume", { resumeInFlight: true }).accepted, true);
  assert.equal(acceptAuthoritativeRoomState(current, room({ stateVersion: 8, handId: 3, roomEpoch: "epoch-a" }), "room:state").accepted, true);
  assert.equal(acceptAuthoritativeRoomState(current, room({ stateVersion: 8, handId: 1, roomEpoch: "epoch-a" }), "room:state").accepted, false);
  assert.equal(acceptAuthoritativeRoomState(current, room({ stateVersion: 1, handId: 1, roomEpoch: "epoch-b" }), "resume", { resumeInFlight: true }).accepted, true);
  assert.equal(acceptAuthoritativeRoomState(current, room({ id: "other", stateVersion: 8 }), "room:state").accepted, false);
});

test("authoritative room state accepts null only from leave, resume, or matching room null broadcast", () => {
  const current = room({ roomEpoch: "epoch-a", stateVersion: 2 });
  const lateNull = acceptAuthoritativeRoomState(current, null, "room:state");
  assert.equal(lateNull.accepted, false);
  assert.equal(lateNull.room, current);

  const matchingBroadcast = acceptAuthoritativeRoomState(current, null, "room:state", { nullRoomId: current.id, nullRoomEpoch: "epoch-a" });
  assert.equal(matchingBroadcast.accepted, true);
  assert.equal(matchingBroadcast.room, null);

  const oldRoomBroadcast = acceptAuthoritativeRoomState(current, null, "room:state", { nullRoomId: "old-room", nullRoomEpoch: "epoch-a" });
  assert.equal(oldRoomBroadcast.accepted, false);
  assert.equal(oldRoomBroadcast.room, current);

  const oldEpochBroadcast = acceptAuthoritativeRoomState(current, null, "room:state", { nullRoomId: current.id, nullRoomEpoch: "old-epoch" });
  assert.equal(oldEpochBroadcast.accepted, false);
  assert.equal(oldEpochBroadcast.room, current);

  const resumeNull = acceptAuthoritativeRoomState(current, null, "resume", { resumeInFlight: true });
  assert.equal(resumeNull.accepted, true);
  assert.equal(resumeNull.room, null);

  const leave = acceptAuthoritativeRoomState(current, null, "leave");
  assert.equal(leave.accepted, true);
  assert.equal(leave.room, null);
});

test("finished authoritative room state preserves final game snapshot", () => {
  const current = room({ stateVersion: 20 });
  const finished = room({
    stateVersion: 21,
    status: "finished",
    game: {
      handId: 1,
      street: "finished",
      board: [{ rank: 14, suit: "S" }],
      pot: 100,
      winners: [{ playerId: "alpha", amount: 100, handName: "Pair" }],
      currentTurnSeat: null,
      players: []
    }
  });

  const decision = acceptAuthoritativeRoomState(current, finished, "room:state");
  assert.equal(decision.accepted, true);
  assert.notEqual(decision.room?.game, null);
  assert.deepEqual(decision.room?.game?.winners, [{ playerId: "alpha", amount: 100, handName: "Pair" }]);
});

test("authoritative room state accepts legal hand transitions without allowing stale hands", () => {
  const handA = room({ roomEpoch: "epoch-a", handId: 1, stateVersion: 40 });
  const handB = room({ roomEpoch: "epoch-a", handId: 2, stateVersion: 41 });
  assert.equal(acceptAuthoritativeRoomState(handA, handB, "room:state").accepted, true);

  const lateHandA = acceptAuthoritativeRoomState(handB, handA, "room:state");
  assert.equal(lateHandA.accepted, false);
  assert.equal(lateHandA.reason, "stale-state-version");

  const waiting = room({ roomEpoch: "epoch-a", handId: null, stateVersion: 50, status: "lobby", game: null });
  const newHand = room({ roomEpoch: "epoch-a", handId: 3, stateVersion: 51, status: "playing" });
  assert.equal(acceptAuthoritativeRoomState(waiting, newHand, "room:state").accepted, true);

  const showdown = room({ roomEpoch: "epoch-a", handId: 3, stateVersion: 70, status: "playing", street: "showdown" });
  const returnedToLobby = room({ roomEpoch: "epoch-a", handId: null, stateVersion: 71, status: "lobby", game: null });
  assert.equal(acceptAuthoritativeRoomState(showdown, returnedToLobby, "room:state").accepted, true);
});

test("authoritative room state rejects stale epochs and late states after leaving", () => {
  const current = room({ roomEpoch: "new-epoch", handId: 1, stateVersion: 5 });
  const oldEpochHighVersion = acceptAuthoritativeRoomState(current, room({ roomEpoch: "old-epoch", handId: 7, stateVersion: 999 }), "room:state");
  assert.equal(oldEpochHighVersion.accepted, false);
  assert.equal(oldEpochHighVersion.reason, "room-epoch-mismatch");

  const randomRoomState = acceptAuthoritativeRoomState(null, room({ roomEpoch: "random-new-epoch", stateVersion: 1 }), "room:state");
  assert.equal(randomRoomState.accepted, false);
  assert.equal(randomRoomState.reason, "late-room-state");

  const randomAck = acceptAuthoritativeRoomState(null, room({ roomEpoch: "random-new-epoch", stateVersion: 1 }), "ack");
  assert.equal(randomAck.accepted, false);
  assert.equal(randomAck.reason, "late-room-state");
});

test("ordinary room broadcasts remain rejected without create or join pending entry", () => {
  const incoming = room({ stateVersion: 1 });
  const unexpected = acceptAuthoritativeRoomState(null, incoming, "room:state");
  assert.equal(unexpected.accepted, false);
  assert.equal(unexpected.reason, "late-room-state");
});

test("create and join broadcast-before-ack snapshots enter only with active pending context", () => {
  for (const event of ["rooms:create", "rooms:join"] as const) {
    const context = roomEntryContext(event);
    const incoming = room({ stateVersion: 1 });

    const pendingEntry = acceptAuthoritativeRoomState(null, incoming, "room:state", {
      roomEntryInFlight: isRoomEntryContextActive(context, 1, 1)
    });

    assert.equal(pendingEntry.accepted, true);
    assert.equal(pendingEntry.room, incoming);
    assert.equal(consumeRoomEntryContext(context, 1, 1), true);
    assert.equal(isRoomEntryContextActive(context, 1, 1), false);
  }
});

test("pending room entry permission is consumed once before room id rules resume", () => {
  const context = roomEntryContext("rooms:create");
  const firstRoom = room({ id: "room-1", stateVersion: 1 });
  const secondRoom = room({ id: "room-2", roomEpoch: "epoch-b", stateVersion: 1 });

  const accepted = acceptAuthoritativeRoomState(null, firstRoom, "room:state", {
    roomEntryInFlight: isRoomEntryContextActive(context, 1, 1)
  });
  assert.equal(accepted.accepted, true);
  assert.equal(consumeRoomEntryContext(context, 1, 1), true);

  const rejected = acceptAuthoritativeRoomState(accepted.room, secondRoom, "room:state", {
    roomEntryInFlight: isRoomEntryContextActive(context, 1, 1)
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "room-id-mismatch");
  assert.equal(rejected.room, firstRoom);
});

test("create and join ack failure clear pending room entry before late state arrives", () => {
  for (const event of ["rooms:create", "rooms:join"] as const) {
    let context: RoomEntryContext | null = roomEntryContext(event);
    context = null;

    const lateState = acceptAuthoritativeRoomState(null, room({ stateVersion: 1 }), "room:state", {
      roomEntryInFlight: isRoomEntryContextActive(context, 1, 1)
    });
    assert.equal(lateState.accepted, false);
    assert.equal(lateState.reason, "late-room-state");
  }
});

test("create and join timeout clear pending room entry before late state arrives", () => {
  for (const event of ["rooms:create", "rooms:join"] as const) {
    let context: RoomEntryContext | null = roomEntryContext(event);
    context = null;

    const lateState = acceptAuthoritativeRoomState(null, room({ stateVersion: 1 }), "room:state", {
      roomEntryInFlight: isRoomEntryContextActive(context, 1, 1)
    });
    assert.equal(lateState.accepted, false);
    assert.equal(lateState.reason, "late-room-state");
  }
});

test("stale session or socket rejects pending room entry snapshots", () => {
  const sessionContext = roomEntryContext("rooms:create", "action-session", 1, 1);
  const staleSession = acceptAuthoritativeRoomState(null, room({ stateVersion: 1 }), "room:state", {
    roomEntryInFlight: isRoomEntryContextActive(sessionContext, 2, 1)
  });
  assert.equal(staleSession.accepted, false);
  assert.equal(staleSession.reason, "late-room-state");

  const socketContext = roomEntryContext("rooms:join", "action-socket", 1, 1);
  const staleSocket = acceptAuthoritativeRoomState(null, room({ stateVersion: 1 }), "room:state", {
    roomEntryInFlight: isRoomEntryContextActive(socketContext, 1, 2)
  });
  assert.equal(staleSocket.accepted, false);
  assert.equal(staleSocket.reason, "late-room-state");
});

test("pending room entry never accepts null room state", () => {
  const context = roomEntryContext("rooms:create");
  const lateNull = acceptAuthoritativeRoomState(null, null, "room:state", {
    roomEntryInFlight: isRoomEntryContextActive(context, 1, 1)
  });
  assert.equal(lateNull.accepted, false);
  assert.equal(lateNull.reason, "late-null-state");
});

test("explicit resume still restores from null without room entry pending", () => {
  const incoming = room({ stateVersion: 1 });
  const resumed = acceptAuthoritativeRoomState(null, incoming, "resume", { resumeInFlight: true });
  assert.equal(resumed.accepted, true);
  assert.equal(resumed.room, incoming);
});

test("leave metadata still clears only the matching current room", () => {
  const current = room({ id: "room-1", roomEpoch: "epoch-a", stateVersion: 4 });

  const matchingLeave = acceptAuthoritativeRoomState(current, null, "room:state", {
    nullRoomId: "room-1",
    nullRoomEpoch: "epoch-a"
  });
  assert.equal(matchingLeave.accepted, true);
  assert.equal(matchingLeave.room, null);

  const oldRoomLeave = acceptAuthoritativeRoomState(current, null, "room:state", {
    nullRoomId: "old-room",
    nullRoomEpoch: "epoch-a"
  });
  assert.equal(oldRoomLeave.accepted, false);
  assert.equal(oldRoomLeave.reason, "late-null-state");
  assert.equal(oldRoomLeave.room, current);

  const oldEpochLeave = acceptAuthoritativeRoomState(current, null, "room:state", {
    nullRoomId: "room-1",
    nullRoomEpoch: "old-epoch"
  });
  assert.equal(oldEpochLeave.accepted, false);
  assert.equal(oldEpochLeave.reason, "late-null-state");
  assert.equal(oldEpochLeave.room, current);
});

test("same version comparison ignores transport-only differences and detects business conflicts", () => {
  const current = room({ stateVersion: 9, serverTime: 1000 });
  const reordered = room({ stateVersion: 9, serverTime: 2000, rules: { maxPlayers: 6, bigBlind: 20, smallBlind: 10 } });
  assertDuplicate(acceptAuthoritativeRoomState(current, reordered, "room:state"));

  const sameBusiness = room({ stateVersion: 9, board: [], extraTransport: { socketId: "later" } });
  assertDuplicate(acceptAuthoritativeRoomState(current, sameBusiness, "room:state"));

  const potConflict = acceptAuthoritativeRoomState(current, room({ stateVersion: 9, pot: 75 }), "room:state");
  assert.equal(potConflict.accepted, false);
  assert.equal(potConflict.reason, "same-version-conflict");
  assert.equal(potConflict.needsResume, true);

  const boardConflict = acceptAuthoritativeRoomState(current, room({ stateVersion: 9, board: [{ rank: 10, suit: "H" }] }), "room:state");
  assert.equal(boardConflict.accepted, false);
  assert.equal(boardConflict.reason, "same-version-conflict");
});

test("same version comparison includes viewer-private cards and action controls", () => {
  const current = room({ stateVersion: 9 });
  const missingHand = room({ stateVersion: 9 });
  const currentGame = current.game as Record<string, any>;
  const missingGame = missingHand.game as Record<string, any>;
  currentGame.availableActions = { toCall: 20, minRaiseTo: 40, maxRaiseTo: 1000, canCheck: false, canCall: true, canBet: false, canRaise: true, canAllIn: true };
  missingGame.availableActions = { toCall: 20, minRaiseTo: 40, maxRaiseTo: 1000, canCheck: false, canCall: true, canBet: false, canRaise: true, canAllIn: true };
  currentGame.players[0].hand = [{ rank: 10, suit: "H" }, { rank: 11, suit: "H" }];

  const handConflict = acceptAuthoritativeRoomState(current, missingHand, "room:state");
  assert.equal(handConflict.accepted, false);
  assert.equal(handConflict.reason, "same-version-conflict");

  const changedAction = room({ stateVersion: 9 });
  const changedGame = changedAction.game as Record<string, any>;
  changedGame.availableActions = { toCall: 0, minRaiseTo: 40, maxRaiseTo: 1000, canCheck: true, canCall: false, canBet: true, canRaise: false, canAllIn: true };
  const actionConflict = acceptAuthoritativeRoomState(current, changedAction, "ack");
  assert.equal(actionConflict.accepted, false);
  assert.equal(actionConflict.reason, "same-version-conflict");
});

test("same version comparison includes the authoritative action deadline", () => {
  const current = room({ stateVersion: 9, actionDeadlineAt: 1000 });
  const changed = room({ stateVersion: 9, actionDeadlineAt: 2000 });

  const conflict = acceptAuthoritativeRoomState(current, changed, "room:state");
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.reason, "same-version-conflict");
});

test("ack and broadcast snapshots with the same version apply only once in either order", () => {
  const initial = room({ stateVersion: 10, pot: 20 });
  const ackSnapshot = room({ stateVersion: 11, pot: 40, serverTime: 1000 });
  const broadcastSnapshot = room({ stateVersion: 11, pot: 40, serverTime: 2000, rules: { maxPlayers: 6, smallBlind: 10, bigBlind: 20 } });

  const ackFirst = acceptAuthoritativeRoomState(initial, ackSnapshot, "ack");
  assert.equal(ackFirst.accepted, true);
  const broadcastSecond = acceptAuthoritativeRoomState(ackFirst.room, broadcastSnapshot, "room:state");
  assertDuplicate(broadcastSecond);

  const broadcastFirst = acceptAuthoritativeRoomState(initial, broadcastSnapshot, "room:state");
  assert.equal(broadcastFirst.accepted, true);
  const ackSecond = acceptAuthoritativeRoomState(broadcastFirst.room, ackSnapshot, "ack");
  assertDuplicate(ackSecond);
});

test("same version conflicts do not request another resume while one is already in flight", () => {
  const current = room({ stateVersion: 12, pot: 20 });
  const conflict = acceptAuthoritativeRoomState(current, room({ stateVersion: 12, pot: 45 }), "room:state", { resumeInFlight: true });
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.reason, "same-version-conflict");
  assert.equal(conflict.needsResume, false);
});

test("socket action retry keeps the original action fingerprint until an ack arrives", () => {
  const pending: Record<string, PendingSocketAction> = {};
  let nextId = 1;
  const first = prepareSocketAction(pending, "game:action", "game:action", { type: "call" }, 10, () => `action_${nextId++}`);
  assert.equal(first.retry, false);
  assert.deepEqual(first.payload, { type: "call", stateVersion: 10, actionId: "action_1" });

  const timeoutRetry = prepareSocketAction(pending, "game:action", "game:action", { type: "raise", amount: 100 }, 11, () => `action_${nextId++}`);
  assert.equal(timeoutRetry.retry, true);
  assert.deepEqual(timeoutRetry.payload, first.payload);

  clearPendingSocketAction(pending, "game:action");
  const afterStaleResume = prepareSocketAction(pending, "game:action", "game:action", { type: "raise", amount: 100 }, 11, () => `action_${nextId++}`);
  assert.equal(afterStaleResume.retry, false);
  assert.deepEqual(afterStaleResume.payload, { type: "raise", amount: 100, stateVersion: 11, actionId: "action_2" });
});

function assertDuplicate(decision: ReturnType<typeof acceptAuthoritativeRoomState>): void {
  assert.equal(decision.accepted, true);
  assert.equal(decision.duplicate, true);
}

function roomEntryContext(event: RoomEntryEvent, actionId = "action-1", sessionGeneration = 1, socketGeneration = 1): RoomEntryContext {
  const context = createRoomEntryContext({ event, payload: { actionId } }, sessionGeneration, socketGeneration);
  assert.ok(context);
  return context;
}

function room(
  overrides: Partial<AuthoritativeRoomState> & {
    board?: Array<{ rank: number; suit: string }>;
    pot?: number;
    street?: string;
    rules?: Record<string, unknown>;
    serverTime?: number;
    extraTransport?: Record<string, unknown>;
  }
): AuthoritativeRoomState {
  const board = overrides.board ?? [];
  const handId = Object.prototype.hasOwnProperty.call(overrides, "handId") ? overrides.handId : 1;
  const game = Object.prototype.hasOwnProperty.call(overrides, "game")
    ? overrides.game
    : {
        handId,
        street: overrides.street ?? "flop",
        board,
        pot: overrides.pot ?? 20,
        currentTurnSeat: 0,
        players: [
          { id: "alpha", nickname: "Alpha", avatar: "A", seat: 0, chips: 980, bet: 20, totalBet: 20, folded: false, allIn: false, acted: true, connected: true, cardCount: 2, isTurn: true },
          { id: "beta", nickname: "Beta", avatar: "B", seat: 1, chips: 980, bet: 20, totalBet: 20, folded: false, allIn: false, acted: true, connected: true, cardCount: 2, isTurn: false }
        ]
      };
  return {
    id: overrides.id ?? "room-1",
    roomEpoch: overrides.roomEpoch ?? "epoch-a",
    handId,
    stateVersion: overrides.stateVersion ?? 1,
    status: overrides.status ?? "playing",
    actionDeadlineAt: Object.prototype.hasOwnProperty.call(overrides, "actionDeadlineAt") ? overrides.actionDeadlineAt : null,
    name: "Test Room",
    ownerId: "alpha",
    rules: overrides.rules ?? { smallBlind: 10, bigBlind: 20, maxPlayers: 6 },
    seats: [
      { id: "alpha", nickname: "Alpha", avatar: "A", chips: 1000, seat: 0, ready: false, connected: true },
      { id: "beta", nickname: "Beta", avatar: "B", chips: 1000, seat: 1, ready: false, connected: true }
    ],
    voice: [],
    game,
    serverTime: overrides.serverTime,
    ...(overrides.extraTransport ?? {})
  };
}
