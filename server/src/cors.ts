export type CorsOrigins = "*" | string[];

export function readCorsOrigins(name: string, env: NodeJS.ProcessEnv = process.env): CorsOrigins {
  const value = env[name] ?? (env.NODE_ENV === "production" ? "" : "*");
  const origins = parseCorsOrigins(value, name);
  if (env.NODE_ENV === "production" && (origins === "*" || origins.length === 0)) {
    throw new Error(`${name} must be set to explicit trusted origins in production`);
  }
  return origins;
}

export function parseCorsOrigins(value: unknown, name = "CORS_ORIGIN"): CorsOrigins {
  if (typeof value !== "string" || !value.trim()) return [];
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.includes("*")) {
    if (entries.length !== 1) throw new Error(`${name} cannot combine * with explicit origins`);
    return "*";
  }
  return [...new Set(entries.map((entry) => normalizeOrigin(entry, name)))];
}

export function chooseCorsOrigin(origins: CorsOrigins, origin: string | undefined): string | null {
  if (origins === "*") return "*";
  if (!origin) return origins[0] ?? null;
  return origins.includes(origin) ? origin : null;
}

function normalizeOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must contain valid origins`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must contain HTTP(S) origins`);
  }
  return url.origin;
}
