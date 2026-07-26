export type AckResult = { ok: boolean; error?: string; [key: string]: unknown };
type CacheDecision = (result: AckResult) => boolean;
export type OperationScope = {
  userId: string;
  roomId: string;
  actionId: string;
  fingerprint: string;
};

export class OperationDeduper {
  private readonly cache = new Map<string, { roomId: string; fingerprint: string; result?: AckResult; promise?: Promise<AckResult>; expiresAt: number }>();

  constructor(private readonly ttlMs = 120_000, private readonly maxEntries = 1000, private readonly now = Date.now) {}

  scope(input: { userId: string; roomId?: string | null; actionId: unknown; event: string; payload: Record<string, unknown> }): OperationScope {
    this.prune();
    const actionId = cleanActionId(input.actionId);
    const roomId = input.roomId ?? "lobby";
    const scope = {
      userId: input.userId,
      roomId,
      actionId,
      fingerprint: stableJson({
        event: input.event,
        payload: Object.fromEntries(Object.entries(input.payload).filter(([key]) => key !== "actionId" && key !== "operationId"))
      })
    };
    this.assertCompatible(scope);
    return scope;
  }

  async run(scope: OperationScope, work: () => AckResult | Promise<AckResult>, shouldCache: CacheDecision = (result) => result.ok): Promise<AckResult> {
    this.prune();
    const key = this.key(scope);
    const existing = this.cache.get(key);
    if (existing) {
      if (existing.fingerprint !== scope.fingerprint) throw new Error("Action id was already used with different parameters");
      if (existing.result) return existing.result;
      if (existing.promise) return existing.promise;
    }
    this.trim(this.maxEntries - 1);
    if (this.cache.size >= this.maxEntries) throw new Error("Room is busy");
    const promise = Promise.resolve().then(work);
    this.cache.set(key, { roomId: scope.roomId, fingerprint: scope.fingerprint, promise, expiresAt: this.now() + this.ttlMs });
    try {
      const result = await promise;
      const entry = this.cache.get(key);
      if (entry?.promise === promise) {
        if (shouldCache(result)) {
          this.cache.set(key, { roomId: scope.roomId, fingerprint: scope.fingerprint, result, expiresAt: this.now() + this.ttlMs });
          this.trim(this.maxEntries);
        } else {
          this.cache.delete(key);
        }
      }
      return result;
    } catch (error) {
      if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
      throw error;
    }
  }

  get(scope: OperationScope): AckResult | null {
    this.prune();
    const entry = this.cache.get(this.key(scope));
    if (!entry) return null;
    if (entry.fingerprint !== scope.fingerprint) throw new Error("Action id was already used with different parameters");
    return entry.result ?? null;
  }

  set(scope: OperationScope, result: AckResult): void {
    this.prune();
    const key = this.key(scope);
    if (this.cache.has(key)) return;
    this.cache.set(key, { roomId: scope.roomId, fingerprint: scope.fingerprint, result, expiresAt: this.now() + this.ttlMs });
    this.trim(this.maxEntries);
  }

  private trim(limit: number): void {
    while (this.cache.size > Math.max(0, limit)) {
      const oldest = [...this.cache.entries()].find(([, entry]) => !entry.promise)?.[0];
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
    return `${scope.userId}:${scope.actionId}`;
  }

  private assertCompatible(scope: OperationScope): void {
    const entry = this.cache.get(this.key(scope));
    if (entry && entry.fingerprint !== scope.fingerprint) throw new Error("Action id was already used with different parameters");
  }

  private prune(): void {
    const now = this.now();
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
