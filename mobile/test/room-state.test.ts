import test from "node:test";
import assert from "node:assert/strict";
import { acceptAuthoritativeRoomState, type AuthoritativeRoomState } from "../src/roomState";

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

test("authoritative room state accepts null only from leave", () => {
  const current = room({ stateVersion: 2 });
  const lateNull = acceptAuthoritativeRoomState(current, null, "room:state");
  assert.equal(lateNull.accepted, false);
  assert.equal(lateNull.room, current);

  const leave = acceptAuthoritativeRoomState(current, null, "leave");
  assert.equal(leave.accepted, true);
  assert.equal(leave.room, null);
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

function assertDuplicate(decision: ReturnType<typeof acceptAuthoritativeRoomState>): void {
  assert.equal(decision.accepted, true);
  assert.equal(decision.duplicate, true);
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
