export type AckResult = { ok: boolean; error?: string; [key: string]: unknown };

export class OperationDeduper {
  private readonly cache = new Map<string, { result: AckResult; expiresAt: number }>();

  constructor(private readonly ttlMs = 120_000) {}

  get(userId: string, operationId: unknown): AckResult | null {
    const id = cleanOperationId(operationId);
    if (!id) return null;
    this.prune();
    return this.cache.get(`${userId}:${id}`)?.result ?? null;
  }

  set(userId: string, operationId: unknown, result: AckResult): void {
    const id = cleanOperationId(operationId);
    if (!id) return;
    const key = `${userId}:${id}`;
    if (this.cache.has(key)) return;
    this.cache.set(key, { result, expiresAt: Date.now() + this.ttlMs });
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}

function cleanOperationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : null;
}
