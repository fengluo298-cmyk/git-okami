export type RoomStateSource = "room:state" | "create" | "join" | "resume" | "ack" | "leave";

export type AuthoritativeRoomState = {
  id: string;
  roomEpoch?: string;
  handId?: number | null;
  actionDeadlineAt?: number | null;
  status: string;
  stateVersion?: number;
  game?: null | { handId?: number | null; [key: string]: unknown };
  [key: string]: unknown;
};

export type RoomStateDecision<T> = {
  accepted: boolean;
  room: T | null;
  reason?: string;
  duplicate?: boolean;
  needsResume?: boolean;
};

export type RoomStateOptions = {
  resumeInFlight?: boolean;
  nullRoomId?: string;
  nullRoomEpoch?: string;
};

export type PendingSocketAction = {
  event: string;
  payload: Record<string, unknown>;
};

export function prepareSocketAction(
  pending: Record<string, PendingSocketAction>,
  key: string,
  event: string,
  payload: Record<string, unknown>,
  stateVersion: unknown,
  createActionId: () => string
): { event: string; payload: Record<string, unknown>; retry: boolean } {
  const existing = pending[key];
  if (existing) return { event: existing.event, payload: { ...existing.payload }, retry: true };

  const outbound = {
    ...payload,
    ...(typeof stateVersion === "number" ? { stateVersion } : {}),
    actionId: createActionId()
  };
  pending[key] = { event, payload: outbound };
  return { event, payload: { ...outbound }, retry: false };
}

export function clearPendingSocketAction(pending: Record<string, PendingSocketAction>, key: string): void {
  delete pending[key];
}

export function acceptAuthoritativeRoomState<T extends AuthoritativeRoomState>(
  current: T | null,
  incoming: T | null,
  source: RoomStateSource,
  options: RoomStateOptions = {}
): RoomStateDecision<T> {
  if (incoming === null) {
    if (source === "leave" || source === "resume") return { accepted: true, room: null };
    if (
      source === "room:state" &&
      current &&
      options.nullRoomId === current.id &&
      (!options.nullRoomEpoch || !current.roomEpoch || options.nullRoomEpoch === current.roomEpoch)
    ) {
      return { accepted: true, room: null };
    }
    return { accepted: false, room: current, reason: "late-null-state" };
  }
  if (!isValidRoomState(incoming)) return { accepted: false, room: current, reason: "invalid-room-state" };

  const next = normalizeRoomState(incoming);
  if (!current) {
    return canEnterRoom(source, options) ? { accepted: true, room: next } : { accepted: false, room: current, reason: "late-room-state" };
  }

  if (next.id !== current.id) {
    return canReplaceRoom(source) ? { accepted: true, room: next } : { accepted: false, room: current, reason: "room-id-mismatch" };
  }

  const currentKey = stateKey(current);
  const nextKey = stateKey(next);
  if (currentKey.roomEpoch && nextKey.roomEpoch && currentKey.roomEpoch !== nextKey.roomEpoch) {
    return canReplaceRoom(source)
      ? { accepted: true, room: next }
      : { accepted: false, room: current, reason: "room-epoch-mismatch", needsResume: options.resumeInFlight ? false : true };
  }

  if (nextKey.stateVersion < currentKey.stateVersion) return { accepted: false, room: current, reason: "stale-state-version" };
  if (nextKey.stateVersion === currentKey.stateVersion) {
    if (sameRoomState(current, next)) return { accepted: true, room: current, duplicate: true };
    return { accepted: false, room: current, reason: "same-version-conflict", needsResume: options.resumeInFlight ? false : true };
  }
  if (currentKey.hasHandId && nextKey.hasHandId && nextKey.handId < currentKey.handId) return { accepted: false, room: current, reason: "stale-hand-id" };

  return { accepted: true, room: next };
}

export function normalizeRoomState<T extends AuthoritativeRoomState>(room: T): T {
  return room;
}

function isValidRoomState(room: AuthoritativeRoomState): boolean {
  return typeof room.id === "string" && room.id.length > 0 && Number.isSafeInteger(room.stateVersion);
}

function canEnterRoom(source: RoomStateSource, options: { resumeInFlight?: boolean }): boolean {
  return source === "create" || source === "join" || source === "resume" || (source === "room:state" && options.resumeInFlight === true);
}

function canReplaceRoom(source: RoomStateSource): boolean {
  return source === "create" || source === "join" || source === "resume";
}

function stateKey(room: AuthoritativeRoomState): { roomEpoch: string; handId: number; hasHandId: boolean; stateVersion: number } {
  const rawHandId = readRawHandId(room);
  return {
    roomEpoch: typeof room.roomEpoch === "string" ? room.roomEpoch : "",
    handId: readSafeInt(rawHandId),
    hasHandId: rawHandId !== null && rawHandId !== undefined,
    stateVersion: readSafeInt(room.stateVersion)
  };
}

function readRawHandId(room: AuthoritativeRoomState): unknown {
  if (Object.prototype.hasOwnProperty.call(room, "handId")) return room.handId;
  return room.game?.handId;
}

function readSafeInt(value: unknown): number {
  return Number.isSafeInteger(value) ? Number(value) : 0;
}

function sameRoomState(left: AuthoritativeRoomState, right: AuthoritativeRoomState): boolean {
  return stableJson(toBusinessState(left)) === stableJson(toBusinessState(right));
}

function toBusinessState(room: AuthoritativeRoomState): Record<string, unknown> {
  return compactObject({
    id: room.id,
    roomEpoch: typeof room.roomEpoch === "string" ? room.roomEpoch : null,
    handId: readRawHandId(room) ?? null,
    stateVersion: room.stateVersion,
    name: room.name,
    ownerId: room.ownerId,
    status: room.status,
    actionDeadlineAt: room.actionDeadlineAt ?? null,
    rules: normalizePlainObject(room.rules),
    seats: normalizeSeats(room.seats),
    voice: normalizeVoice(room.voice),
    game: normalizeGame(room.game)
  });
}

function normalizeGame(game: unknown): unknown {
  if (!isPlainRecord(game)) return game === null ? null : undefined;
  return compactObject({
    handId: game.handId ?? null,
    street: game.street,
    board: normalizeCards(game.board),
    pot: game.pot,
    sidePots: normalizePlainArray(game.sidePots),
    players: normalizePlayers(game.players),
    dealerSeat: game.dealerSeat,
    smallBlindSeat: game.smallBlindSeat,
    bigBlindSeat: game.bigBlindSeat,
    currentTurnSeat: game.currentTurnSeat,
    currentBet: game.currentBet,
    minRaise: game.minRaise,
    smallBlind: game.smallBlind,
    bigBlind: game.bigBlind,
    showdown: game.showdown,
    winners: normalizePlainArray(game.winners),
    availableActions: normalizeAvailableActions(game.availableActions)
  });
}

function normalizeSeats(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((seat) => {
    if (seat === null) return null;
    if (!isPlainRecord(seat)) return seat;
    return compactObject({
      id: seat.id,
      nickname: seat.nickname,
      avatar: seat.avatar,
      chips: seat.chips,
      seat: seat.seat,
      ready: seat.ready,
      connected: seat.connected,
      handStartChips: seat.handStartChips
    });
  });
}

function normalizeVoice(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => {
      if (!isPlainRecord(entry)) return entry;
      return compactObject({
        userId: entry.userId,
        nickname: entry.nickname,
        muted: entry.muted,
        speaking: entry.speaking
      });
    })
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function normalizePlayers(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((player) => {
    if (!isPlainRecord(player)) return player;
    return compactObject({
      id: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      chips: player.chips,
      seat: player.seat,
      bet: player.bet,
      totalBet: player.totalBet,
      folded: player.folded,
      allIn: player.allIn,
      acted: player.acted,
      connected: player.connected,
      hand: normalizeCards(player.hand),
      cardCount: player.cardCount,
      isTurn: player.isTurn
    });
  });
}

function normalizeAvailableActions(value: unknown): unknown {
  if (value === null) return null;
  if (!isPlainRecord(value)) return undefined;
  return compactObject({
    toCall: value.toCall,
    minRaiseTo: value.minRaiseTo,
    maxRaiseTo: value.maxRaiseTo,
    canCheck: value.canCheck,
    canCall: value.canCall,
    canBet: value.canBet,
    canRaise: value.canRaise,
    canAllIn: value.canAllIn
  });
}

function normalizeCards(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((card) => {
    if (!isPlainRecord(card)) return card;
    return compactObject({ rank: card.rank, suit: card.suit });
  });
}

function normalizePlainArray(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map(normalizePlainObject);
}

function normalizePlainObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePlainObject);
  if (!isPlainRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) output[key] = normalizePlainObject(value[key]);
  return compactObject(output);
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
