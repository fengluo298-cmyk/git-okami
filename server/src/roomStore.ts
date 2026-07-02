import { randomUUID } from "node:crypto";
import type { AppDatabase, UserRecord } from "./db.js";
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
  name: string;
  ownerId: string;
  status: RoomStatus;
  seats: Array<RoomSeat | null>;
  members: Set<string>;
  voice: Map<string, { muted: boolean; speaking: boolean }>;
  engine: GameEngine | null;
  lastDealerSeat: number | null;
  rules: RoomRules;
  settledHandIds: Set<number>;
};

export type PublicRoom = {
  id: string;
  name: string;
  ownerId: string;
  status: RoomStatus;
  rules: RoomRules;
  seats: Array<RoomSeat | null>;
  voice: Array<{ userId: string; nickname: string; muted: boolean; speaking: boolean }>;
  game: PublicGameState | null;
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
    const fullRules = normalizeRules(rules);
    const room: Room = {
      id: randomUUID().slice(0, 8),
      name: (name ?? "").trim().slice(0, 24) || `${owner.nickname}'s table`,
      ownerId: owner.id,
      status: "lobby",
      seats: Array.from({ length: fullRules.maxPlayers }, () => null),
      members: new Set([owner.id]),
      voice: new Map(),
      engine: null,
      lastDealerSeat: null,
      rules: fullRules,
      settledHandIds: new Set()
    };
    this.rooms.set(room.id, room);
    this.userRoom.set(owner.id, room.id);
    return room;
  }

  joinRoom(user: UserRecord, roomId: string): Room {
    const room = this.mustRoom(roomId);
    const oldRoomId = this.userRoom.get(user.id);
    if (oldRoomId && oldRoomId !== roomId) this.leaveRoom(user.id);
    room.members.add(user.id);
    this.userRoom.set(user.id, room.id);
    this.markConnected(user.id, true);
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
      room.seats[existing.seat] = null;
      existing.seat = seatNumber;
      room.seats[seatNumber] = existing;
      return room;
    }
    if (buyIn < room.rules.minBuyIn || buyIn > room.rules.maxBuyIn) throw new Error(`Buy-in must be ${room.rules.minBuyIn}-${room.rules.maxBuyIn}`);
    this.db.adjustUserChips(user.id, -buyIn, "buy_in", room.id);
    room.seats[seatNumber] = {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      chips: buyIn,
      seat: seatNumber,
      ready: false,
      connected: true
    };
    return room;
  }

  leaveSeat(userId: string): Room {
    const room = this.mustCurrentRoom(userId);
    if (room.status === "playing") throw new Error("Cannot leave seat during a hand");
    const seat = room.seats.find((candidate) => candidate?.id === userId);
    if (seat) this.cashOutSeat(room, seat);
    room.voice.delete(userId);
    return room;
  }

  setReady(userId: string, ready: boolean): Room {
    const room = this.mustCurrentRoom(userId);
    if (room.status === "playing") throw new Error("Hand is already running");
    const seat = room.seats.find((candidate) => candidate?.id === userId);
    if (!seat) throw new Error("Sit down first");
    seat.ready = ready;
    return room;
  }

  startGame(userId: string): Room {
    const room = this.mustCurrentRoom(userId);
    if (room.ownerId !== userId) throw new Error("Only the owner can start");
    if (room.status === "playing") throw new Error("Hand is already running");
    const players = room.seats.filter((seat): seat is RoomSeat => Boolean(seat && seat.ready && seat.chips > 0));
    if (players.length < 2) throw new Error("Need at least two ready players");
    const dealerSeat = nextDealerSeat(players, room.lastDealerSeat);
    const engine = new GameEngine(room.rules);
    engine.startHand(players.map(toStartPlayer), { dealerSeat });
    room.engine = engine;
    room.status = "playing";
    room.lastDealerSeat = dealerSeat;
    for (const seat of room.seats) {
      if (seat) {
        seat.ready = false;
        seat.handStartChips = seat.chips;
      }
    }
    return room;
  }

  action(userId: string, type: PlayerAction, amount?: number): Room {
    const room = this.mustCurrentRoom(userId);
    if (!room.engine) throw new Error("No active hand");
    room.engine.executeAction(userId, type, amount);
    if (room.engine.state.street === "finished") {
      room.status = "finished";
      this.syncFinishedHand(room);
    }
    return room;
  }

  autoAction(roomId: string): Room {
    const room = this.mustRoom(roomId);
    if (!room.engine || room.engine.state.street === "finished") return room;
    room.engine.autoAction();
    const street = room.engine.state.street as string;
    if (street === "finished") {
      room.status = "finished";
      this.syncFinishedHand(room);
    }
    return room;
  }

  markConnected(userId: string, connected: boolean): Room | null {
    const room = this.currentRoom(userId);
    if (!room) return null;
    const seat = room.seats.find((candidate) => candidate?.id === userId);
    if (seat) seat.connected = connected;
    room.engine?.updateConnection(userId, connected);
    return room;
  }

  currentRoom(userId: string): Room | null {
    const roomId = this.userRoom.get(userId);
    return roomId ? this.rooms.get(roomId) ?? null : null;
  }

  publicRoom(roomId: string, viewerId: string): PublicRoom {
    const room = this.mustRoom(roomId);
    return {
      id: room.id,
      name: room.name,
      ownerId: room.ownerId,
      status: room.status,
      rules: room.rules,
      seats: room.seats,
      voice: [...room.voice.entries()].map(([userId, state]) => ({
        userId,
        nickname: room.seats.find((seat) => seat?.id === userId)?.nickname ?? "Player",
        ...state
      })),
      game: room.engine ? room.engine.getPublicState(viewerId) : null
    };
  }

  roomById(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  joinVoice(userId: string): Room {
    const room = this.mustCurrentRoom(userId);
    if (!room.members.has(userId)) throw new Error("Join the room first");
    room.voice.set(userId, room.voice.get(userId) ?? { muted: false, speaking: false });
    return room;
  }

  leaveVoice(userId: string): Room {
    const room = this.mustCurrentRoom(userId);
    room.voice.delete(userId);
    return room;
  }

  setVoiceMuted(userId: string, muted: boolean): Room {
    const room = this.mustCurrentRoom(userId);
    const state = room.voice.get(userId);
    if (!state) throw new Error("Join voice first");
    room.voice.set(userId, { ...state, muted, speaking: muted ? false : state.speaking });
    return room;
  }

  setVoiceSpeaking(userId: string, speaking: boolean): Room {
    const room = this.mustCurrentRoom(userId);
    const state = room.voice.get(userId);
    if (!state) throw new Error("Join voice first");
    room.voice.set(userId, { ...state, speaking: state.muted ? false : speaking });
    return room;
  }

  private syncFinishedHand(room: Room): void {
    if (!room.engine) return;
    const handId = room.engine.state.handId;
    if (room.settledHandIds.has(handId)) return;
    room.settledHandIds.add(handId);
    for (const player of room.engine.state.players) {
      const seat = room.seats[player.seat];
      if (!seat) continue;
      const before = seat.handStartChips ?? seat.chips;
      seat.chips = player.chips;
      seat.handStartChips = player.chips;
      const delta = player.chips - before;
      if (delta !== 0) this.db.logChipTransaction(player.id, delta > 0 ? "win_pot" : "lose_bet", delta, before, player.chips, room.id, handId);
    }
  }

  private cashOutSeat(room: Room, seat: RoomSeat): void {
    if (seat.chips > 0) this.db.adjustUserChips(seat.id, seat.chips, "cash_out", room.id);
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
  const smallBlind = positiveInt(rules.smallBlind, envInt("DEFAULT_SMALL_BLIND", 10));
  const bigBlind = Math.max(positiveInt(rules.bigBlind, envInt("DEFAULT_BIG_BLIND", 20)), smallBlind * 2);
  const minBuyIn = positiveInt(rules.minBuyIn, envInt("DEFAULT_MIN_BUY_IN", 1000));
  const maxBuyIn = Math.max(positiveInt(rules.maxBuyIn, envInt("DEFAULT_MAX_BUY_IN", 10000)), minBuyIn);
  const maxPlayers = Math.min(6, Math.max(2, positiveInt(rules.maxPlayers, envInt("DEFAULT_MAX_PLAYERS", 6))));
  return {
    smallBlind,
    bigBlind,
    minBuyIn,
    maxBuyIn,
    maxPlayers,
    bettingMode: rules.bettingMode ?? "no_limit",
    minRaise: positiveInt(rules.minRaise, bigBlind),
    maxBetPerRound: rules.maxBetPerRound ? positiveInt(rules.maxBetPerRound, rules.maxBetPerRound) : undefined,
    actionTimeoutSeconds: positiveInt(rules.actionTimeoutSeconds, envInt("DEFAULT_ACTION_TIMEOUT_SECONDS", 30)),
    allowSpectators: rules.allowSpectators ?? true
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function envInt(name: string, fallback: number): number {
  return positiveInt(process.env[name], fallback);
}
