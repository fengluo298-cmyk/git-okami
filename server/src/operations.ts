export type AckResult = { ok: boolean; error?: string; [key: string]: unknown };
export type OperationScope = {
  userId: string;
  roomId: string;
  actionId: string;
  fingerprint: string;
};

export class OperationDeduper {
  private readonly cache = new Map<string, { roomId: string; fingerprint: string; result: AckResult; expiresAt: number }>();

  constructor(private readonly ttlMs = 120_000, private readonly maxEntries = 1000) {}

  scope(input: { userId: string; roomId?: string | null; actionId: unknown; event: string; payload: Record<string, unknown> }): OperationScope {
    const actionId = cleanActionId(input.actionId);
    const roomId = input.roomId ?? "lobby";
    return {
      userId: input.userId,
      roomId,
      actionId,
      fingerprint: stableJson({
        event: input.event,
        payload: Object.fromEntries(Object.entries(input.payload).filter(([key]) => key !== "actionId" && key !== "operationId" && key !== "stateVersion"))
      })
    };
  }

  get(scope: OperationScope): AckResult | null {
    this.prune();
    const entry = this.cache.get(this.key(scope));
    if (!entry) return null;
    if (entry.fingerprint !== scope.fingerprint) throw new Error("Action id was already used with different parameters");
    return entry.result;
  }

  set(scope: OperationScope, result: AckResult): void {
    this.prune();
    const key = this.key(scope);
    if (this.cache.has(key)) return;
    this.cache.set(key, { roomId: scope.roomId, fingerprint: scope.fingerprint, result, expiresAt: Date.now() + this.ttlMs });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.cache.delete(oldest);
    }
  }

  size(): number {
    this.prune();
    return this.cache.size;
  }

  deleteRoom(roomId: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.roomId === roomId) this.cache.delete(key);
    }
  }

  private key(scope: OperationScope): string {
    return `${scope.userId}:${scope.roomId}:${scope.actionId}`;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}

export class RoomActionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(roomId: string, work: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(roomId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(roomId) === tail) this.tails.delete(roomId);
    }
  }

  size(): number {
    return this.tails.size;
  }
}

function cleanActionId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Action id is required");
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("Action id is invalid");
  return id;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
