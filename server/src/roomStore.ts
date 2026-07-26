import { randomUUID } from "node:crypto";
import type { AppDatabase, TableHandStack, UserRecord } from "./db.js";
import { GameEngine, type BettingMode, type PlayerAction, type PublicGameState, type StartPlayer } from "./game/gameEngine.js";

export type RoomStatus = "lobby" | "playing" | "finished";
export type RoomRules = {
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxPlayers: number;
  bettingMode: BettingMode;
  minRaise: number;
  maxBetPerRound?: number;
  actionTimeoutSeconds: number;
  allowSpectators: boolean;
};

export type RoomSeat = {
  id: string;
  nickname: string;
  avatar: string;
  chips: number;
  seat: number;
  ready: boolean;
  connected: boolean;
  handStartChips?: number;
};

export type Room = {
  id: string;
  roomEpoch: string;
  name: string;
  ownerId: string;
  status: RoomStatus;
  version: number;
  handId: number;
  timerGeneration: number;
  turnGeneration: number;
  actionDeadlineAt: number | null;
  timerTurnSeat: number | null;
  timerHandId: number | null;
  seats: Array<RoomSeat | null>;
  members: Set<string>;
  voice: Map<string, { muted: boolean; speaking: boolean }>;
  engine: GameEngine | null;
  lastDealerSeat: number | null;
  rules: RoomRules;
  lastSettledHandId: number | null;
};

export type PublicRoom = {
  id: string;
  roomEpoch: string;
  name: string;
  ownerId: string;
  status: RoomStatus;
  handId: number;
  actionDeadlineAt: number | null;
  stateVersion: number;
  rules: RoomRules;
  seats: Array<RoomSeat | null>;
  voice: Array<{ userId: string; nickname: string; muted: boolean; speaking: boolean }>;
  game: PublicGameState | null;
};

export type RoomTimerToken = {
  roomId: string;
  roomEpoch: string;
  handId: number;
  currentTurnSeat: number | null;
  turnGeneration: number;
  actionDeadlineAt: number;
};

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly userRoom = new Map<string, string>();

  constructor(private readonly db: AppDatabase) {}

  listRooms(): Array<Pick<Room, "id" | "name" | "ownerId" | "status"> & RoomRules & { seated: number }> {
    return [...this.rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      status: room.status,
      ...room.rules,
      seated: room.seats.filter(Boolean).length,
    }));
  }

  createRoom(owner: UserRecord, name?: string, rules: Partial<RoomRules> = {}): Room {
    if (this.userRoom.has(owner.id)) throw new Error("Already in a room");
    const fullRules = normalizeRules(rules);
    const room: Room = {
      id: randomUUID().slice(0, 8),
      roomEpoch: randomUUID(),
      name: (name ?? "").trim().slice(0, 24) || `${owner.nickname}的牌桌`,
      ownerId: owner.id,
      status: "lobby",
      version: 1,
      handId: 0,
      timerGeneration: 0,
      turnGeneration: 0,
      actionDeadlineAt: null,
      timerTurnSeat: null,
      timerHandId: null,
      seats: Array.from({ length: fullRules.maxPlayers }, () => null),
      members: new Set([owner.id]),
      voice: new Map(),
      engine: null,
      lastDealerSeat: null,
      rules: fullRules,
      lastSettledHandId: null
    };
    this.rooms.set(room.id, room);
    this.userRoom.set(owner.id, room.id);
    return room;
  }

  joinRoom(user: UserRecord, roomId: string): Room {
    const room = this.mustRoom(roomId);
    const oldRoomId = this.userRoom.get(user.id);
    if (oldRoomId === roomId) return room;
    if (oldRoomId) throw new Error("Already in a room");
    if (room.status === "playing" && !room.rules.allowSpectators) throw new Error("Spectators are not allowed");
    room.members.add(user.id);
    this.userRoom.set(user.id, room.id);
    this.touch(room);
    return room;
  }

  leaveRoom(userId: string): Room | null {
    const room = this.currentRoom(userId);
    if (!room) return null;
    if (room.status === "playing") throw new Error("Cannot leave during a hand");
    const seated = room.seats.find((seat) => seat?.id === userId);
    if (seated) this.cashOutSeat(room, seated);
    room.voice.delete(userId);
    room.members.delete(userId);
    this.userRoom.delete(userId);
    if (room.ownerId === userId) room.ownerId = room.seats.find(Boolean)?.id ?? [...room.members][0] ?? "";
    this.touch(room);
    if (room.members.size === 0 || !room.ownerId) this.rooms.delete(room.id);
    return room;
  }

  sit(user: UserRecord, seatNumber: number, buyIn: number): Room {
    const room = this.mustCurrentRoom(user.id);
    if (room.status === "playing") throw new Error("Cannot change seats during a hand");
    if (seatNumber < 0 || seatNumber >= room.rules.maxPlayers) throw new Error(`Seat must be 0-${room.rules.maxPlayers - 1}`);
    if (room.seats[seatNumber] && room.seats[seatNumber]?.id !== user.id) throw new Error("Seat is taken");
    const existing = room.seats.find((seat) => seat?.id === user.id);
    if (existing) {
      if (existing.seat === seatNumber) return room;
      room.seats[existing.seat] = null;
      existing.seat = seatNumber;
      room.seats[seatNumber] = existing;
      return this.touch(room);
    }
    if (buyIn < room.rules.minBuyIn || buyIn > room.rules.maxBuyIn) throw new Error(`Buy-in must be ${room.rules.minBuyIn}-${room.rules.maxBuyIn}`);
    this.db.openTableEscrow(user.id, room.id, buyIn);
    room.seats[seatNumber] = {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      chips: buyIn,
      seat: seatNumber,
      ready: false,
      connected: true
    };
    return this.touch(room);
  }

  leaveSeat(userId: string): Room {
    const room = this.mustCurrentRoom(userId);
    if (room.status === "playing") throw new Error("Cannot leave seat during a hand");
    const seat = room.seats.find((candidate) => candidate?.id === userId);
    if (seat) this.cashOutSeat(room, seat);
    room.voice.delete(userId);
    return this.touch(room);
  }

  setReady(userId: string, ready: boolean): Room {
    const room = this.mustCurrentRoom(userId);
    if (room.status === "playing") throw new Error("Hand is already running");
    const seat = room.seats.find((candidate) => candidate?.id === userId);
    if (!seat) throw new Error("Sit down first");
    seat.ready = ready;
    return this.touch(room);
  }

  startGame(userId: string): Room {
    const room = this.mustCurrentRoom(userId);
    if (room.ownerId !== userId) throw new Error("Only the owner can start");
    if (room.status === "playing") throw new Error("Hand is already running");
    const players = room.seats.filter((seat): seat is RoomSeat => Boolean(seat && seat.ready && seat.chips > 0));
    if (players.length < 2) throw new Error("Need at least two ready players");
    const dealerSeat = nextDealerSeat(players, room.lastDealerSeat);
    const nextHandId = room.handId + 1;
    const engine = new GameEngine(room.rules);
    engine.startHand(players.map(toStartPlayer), { dealerSeat });
    engine.state.handId = nextHandId;
    room.engine = engine;
    room.handId = nextHandId;
    room.status = "playing";
    room.lastDealerSeat = dealerSeat;
    for (const seat of room.seats) {
      if (seat) {
        seat.ready = false;
        seat.handStartChips = seat.chips;
      }
    }
    return this.touch(room);
  }

  action(userId: string, type: PlayerAction, amount?: number): Room {
    const room = this.mustCurrentRoom(userId);
    if (!room.engine) throw new Error("No active hand");
    const snapshot = snapshotMutableRoom(room);
    try {
      room.engine.executeAction(userId, type, amount);
      if (room.engine.state.street === "finished") {
        room.status = "finished";
        this.syncFinishedHand(room);
      }
      this.invalidateTurnDeadline(room);
      return this.touch(room);
    } catch (error) {
      restoreMutableRoom(room, snapshot);
      throw error;
    }
  }

  autoAction(roomId: string): Room {
    const room = this.mustRoom(roomId);
    if (!room.engine || room.engine.state.street === "finished") return room;
    const snapshot = snapshotMutableRoom(room);
    try {
      room.engine.autoAction();
      const street = room.engine.state.street as string;
      if (street === "finished") {
        room.status = "finished";
        this.syncFinishedHand(room);
      }
      this.invalidateTurnDeadline(room);
      return this.touch(room);
    } catch (error) {
      restoreMutableRoom(room, snapshot);
      throw error;
    }
  }

  markConnected(userId: string, connected: boolean): Room | null {
    const room = this.currentRoom(userId);
    if (!room) return null;
    const seat = room.seats.find((candidate) => candidate?.id === userId);
    const seatChanged = Boolean(seat && seat.connected !== connected);
    if (seat) seat.connected = connected;
    const engineChanged = room.engine?.updateConnection(userId, connected) ?? false;
    return seatChanged || engineChanged ? this.touch(room) : room;
  }

  currentRoom(userId: string): Room | null {
    const roomId = this.userRoom.get(userId);
    return roomId ? this.rooms.get(roomId) ?? null : null;
  }

  publicRoom(roomId: string, viewerId: string): PublicRoom {
    return createRoomSnapshot(this.mustRoom(roomId), viewerId);
  }

  createActionTimerToken(room: Room, deadline: number): RoomTimerToken | null {
    if (room.status !== "playing" || !room.engine || room.engine.state.currentTurnSeat === null) return null;
    if (room.timerHandId !== room.handId || room.timerTurnSeat !== room.engine.state.currentTurnSeat || room.actionDeadlineAt === null) {
      room.timerGeneration += 1;
      room.turnGeneration += 1;
      room.actionDeadlineAt = deadline;
      room.timerTurnSeat = room.engine.state.currentTurnSeat;
      room.timerHandId = room.handId;
    }
    return {
      roomId: room.id,
      roomEpoch: room.roomEpoch,
      handId: room.handId,
      currentTurnSeat: room.engine.state.currentTurnSeat,
      turnGeneration: room.turnGeneration,
      actionDeadlineAt: room.actionDeadlineAt
    };
  }

  autoActionIfCurrent(token: RoomTimerToken): Room | null {
    if (!this.isActionTimerCurrent(token)) return null;
    return this.autoAction(token.roomId);
  }

  isActionTimerCurrent(token: RoomTimerToken): boolean {
    const room = this.rooms.get(token.roomId);
    return Boolean(
      room &&
        room.roomEpoch === token.roomEpoch &&
        room.handId === token.handId &&
        room.turnGeneration === token.turnGeneration &&
        room.actionDeadlineAt === token.actionDeadlineAt &&
        room.engine &&
        room.engine.state.currentTurnSeat === token.currentTurnSeat &&
        room.status === "playing"
    );
  }

  roomById(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  joinVoice(userId: string): Room {
    const room = this.mustCurrentRoom(userId);
    if (!room.members.has(userId)) throw new Error("Join the room first");
    room.voice.set(userId, room.voice.get(userId) ?? { muted: false, speaking: false });
    return this.touch(room);
  }

  leaveVoice(userId: string): Room {
    const room = this.mustCurrentRoom(userId);
    room.voice.delete(userId);
    return this.touch(room);
  }

  setVoiceMuted(userId: string, muted: boolean): Room {
    const room = this.mustCurrentRoom(userId);
    const state = room.voice.get(userId);
    if (!state) throw new Error("Join voice first");
    room.voice.set(userId, { ...state, muted, speaking: muted ? false : state.speaking });
    return this.touch(room);
  }

  setVoiceSpeaking(userId: string, speaking: boolean): Room {
    const room = this.mustCurrentRoom(userId);
    const state = room.voice.get(userId);
    if (!state) throw new Error("Join voice first");
    room.voice.set(userId, { ...state, speaking: state.muted ? false : speaking });
    return this.touch(room);
  }

  private syncFinishedHand(room: Room): void {
    const engine = room.engine;
    if (!engine) return;
    const handId = engine.state.handId;
    if (room.lastSettledHandId !== handId) {
      const stacks: TableHandStack[] = engine.state.players.map((player) => {
        const seat = room.seats[player.seat];
        if (!seat) throw new Error("Table escrow missing");
        return { userId: player.id, beforeChips: seat.handStartChips ?? seat.chips, chips: player.chips };
      });
      this.db.settleTableHand(room.id, handId, stacks);
      for (const player of engine.state.players) {
        const seat = room.seats[player.seat];
        if (!seat) continue;
        seat.chips = player.chips;
        seat.handStartChips = player.chips;
      }
      room.lastSettledHandId = handId;
    }
    this.clearTurnDeadline(room);
  }

  private cashOutSeat(room: Room, seat: RoomSeat): void {
    this.db.cashOutTableEscrow(seat.id, room.id);
    room.seats[seat.seat] = null;
  }

  private mustCurrentRoom(userId: string): Room {
    const room = this.currentRoom(userId);
    if (!room) throw new Error("Join a room first");
    return room;
  }

  private mustRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("Room not found");
    return room;
  }

  assertFresh(userId: string, stateVersion: unknown): void {
    if (stateVersion === undefined) throw new Error("State version is required");
    const room = this.mustCurrentRoom(userId);
    if (!Number.isSafeInteger(stateVersion) || Number(stateVersion) < 0) throw new Error("State version is invalid");
    if (stateVersion !== room.version) throw new Error("State version is stale");
  }

  private touch(room: Room): Room {
    room.version += 1;
    return room;
  }

  private invalidateTurnDeadline(room: Room): void {
    room.actionDeadlineAt = null;
    room.timerTurnSeat = null;
    room.timerHandId = null;
  }

  private clearTurnDeadline(room: Room): void {
    room.timerGeneration += 1;
    room.turnGeneration += 1;
    room.actionDeadlineAt = null;
    room.timerTurnSeat = null;
    room.timerHandId = null;
  }
}

export function createRoomSnapshot(room: Room, viewerId: string): PublicRoom {
  return {
    id: room.id,
    roomEpoch: room.roomEpoch,
    name: room.name,
    ownerId: room.ownerId,
    status: room.status,
    handId: room.handId,
    actionDeadlineAt: room.actionDeadlineAt,
    stateVersion: room.version,
    rules: { ...room.rules },
    seats: room.seats.map((seat) => (seat ? { ...seat } : null)),
    voice: [...room.voice.entries()].map(([userId, state]) => ({
      userId,
      nickname: room.seats.find((seat) => seat?.id === userId)?.nickname ?? "Player",
      ...state
    })),
    game: room.engine ? room.engine.getPublicState(viewerId) : null
  };
}

function toStartPlayer(seat: RoomSeat): StartPlayer {
  return {
    id: seat.id,
    nickname: seat.nickname,
    avatar: seat.avatar,
    chips: seat.chips,
    connected: seat.connected,
    seat: seat.seat
  };
}

function nextDealerSeat(players: RoomSeat[], lastDealerSeat: number | null): number {
  const seats = players.map((player) => player.seat).sort((a, b) => a - b);
  if (lastDealerSeat === null) return seats[0];
  return seats.find((seat) => seat > lastDealerSeat) ?? seats[0];
}

function normalizeRules(rules: Partial<RoomRules>): RoomRules {
  if (!isPlainRules(rules)) throw new Error("Room rules are invalid");
  const smallBlind = readRuleInt(rules, "smallBlind", envInt("DEFAULT_SMALL_BLIND", 10), 1, 1_000_000_000);
  const bigBlind = readRuleInt(rules, "bigBlind", envInt("DEFAULT_BIG_BLIND", 20), 1, 1_000_000_000);
  if (bigBlind < smallBlind * 2) throw new Error("Room rules are invalid");
  const minBuyIn = readRuleInt(rules, "minBuyIn", envInt("DEFAULT_MIN_BUY_IN", 1000), 1, 1_000_000_000);
  const maxBuyIn = readRuleInt(rules, "maxBuyIn", envInt("DEFAULT_MAX_BUY_IN", 10000), 1, 1_000_000_000);
  if (maxBuyIn < minBuyIn) throw new Error("Room rules are invalid");
  const maxPlayers = readRuleInt(rules, "maxPlayers", envInt("DEFAULT_MAX_PLAYERS", 6), 2, 6);
  const bettingMode = rules.bettingMode ?? "no_limit";
  if (bettingMode !== "no_limit" && bettingMode !== "pot_limit" && bettingMode !== "fixed_limit") throw new Error("Room rules are invalid");
  if (rules.allowSpectators !== undefined && typeof rules.allowSpectators !== "boolean") throw new Error("Room rules are invalid");
  const maxBetPerRound = rules.maxBetPerRound === undefined ? undefined : readRuleInt(rules, "maxBetPerRound", 0, bigBlind, 1_000_000_000);
  return {
    smallBlind,
    bigBlind,
    minBuyIn,
    maxBuyIn,
    maxPlayers,
    bettingMode,
    minRaise: readRuleInt(rules, "minRaise", bigBlind, bigBlind, 1_000_000_000),
    maxBetPerRound,
    actionTimeoutSeconds: readRuleInt(rules, "actionTimeoutSeconds", envInt("DEFAULT_ACTION_TIMEOUT_SECONDS", 30), 1, 300),
    allowSpectators: rules.allowSpectators ?? true
  };
}

function readRuleInt(rules: Partial<RoomRules>, key: keyof RoomRules, fallback: number, min: number, max: number): number {
  const raw = (rules as Record<string, unknown>)[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) throw new Error("Room rules are invalid");
  return raw;
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function envInt(name: string, fallback: number): number {
  return positiveInt(process.env[name], fallback);
}

function isPlainRules(value: unknown): value is Partial<RoomRules> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function snapshotMutableRoom(room: Room) {
  return {
    status: room.status,
    version: room.version,
    handId: room.handId,
    turnGeneration: room.turnGeneration,
    actionDeadlineAt: room.actionDeadlineAt,
    timerTurnSeat: room.timerTurnSeat,
    timerHandId: room.timerHandId,
    lastSettledHandId: room.lastSettledHandId,
    seats: room.seats.map((seat) => (seat ? { ...seat } : null)),
    engineState: room.engine ? structuredClone(room.engine.state) : null
  };
}

function restoreMutableRoom(room: Room, snapshot: ReturnType<typeof snapshotMutableRoom>): void {
  room.status = snapshot.status;
  room.version = snapshot.version;
  room.handId = snapshot.handId;
  room.turnGeneration = snapshot.turnGeneration;
  room.actionDeadlineAt = snapshot.actionDeadlineAt;
  room.timerTurnSeat = snapshot.timerTurnSeat;
  room.timerHandId = snapshot.timerHandId;
  room.lastSettledHandId = snapshot.lastSettledHandId;
  room.seats = snapshot.seats.map((seat) => (seat ? { ...seat } : null));
  if (room.engine && snapshot.engineState) room.engine.state = structuredClone(snapshot.engineState);
  else room.engine = null;
}
