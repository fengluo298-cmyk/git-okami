export type RateLimiter = {
  allow(key: string): boolean;
  size(): number;
};

export function createRateLimiter(maxHits: number, windowMs: number, options: { maxKeys?: number; now?: () => number } = {}): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  return {
    allow(key: string): boolean {
      const current = now();
      for (const [entryKey, entry] of hits) {
        if (entry.resetAt <= current) hits.delete(entryKey);
      }
      let entry = hits.get(key);
      if (!entry && hits.size >= maxKeys) return false;
      if (!entry || entry.resetAt <= current) {
        entry = { count: 0, resetAt: current + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (typeof oldest !== "string") break;
        hits.delete(oldest);
      }
      return entry.count <= maxHits;
    },
    size(): number {
      return hits.size;
    }
  };
}
