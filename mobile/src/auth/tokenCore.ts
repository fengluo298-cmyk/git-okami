export type TokenStores = {
  legacy: {
    getItem(key: string): Promise<string | null>;
    removeItem(key: string): Promise<void>;
  };
  secure: {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
    deleteItemAsync(key: string): Promise<void>;
    isAvailableAsync?: () => Promise<boolean>;
  };
};

export const legacyTokenKey = "holdem.jwt";
export const secureTokenKey = "holdem.jwt.secure";

export function isValidTokenShape(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const token = value.trim();
  if (!token || token === "undefined" || token === "null" || token.length > 4096) return false;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export async function readStoredToken(stores: TokenStores): Promise<string | null> {
  const secure = await stores.secure.getItemAsync(secureTokenKey).catch(() => null);
  if (isValidTokenShape(secure)) return secure.trim();

  const legacy = await stores.legacy.getItem(legacyTokenKey).catch(() => null);
  if (!isValidTokenShape(legacy)) return null;
  const token = legacy.trim();
  const available = stores.secure.isAvailableAsync ? await stores.secure.isAvailableAsync().catch(() => false) : true;
  if (!available) return token;
  await stores.secure.setItemAsync(secureTokenKey, token);
  await stores.legacy.removeItem(legacyTokenKey).catch(() => undefined);
  return token;
}

export async function writeStoredToken(stores: TokenStores, token: string): Promise<void> {
  if (!isValidTokenShape(token)) throw new Error("Invalid token");
  const available = stores.secure.isAvailableAsync ? await stores.secure.isAvailableAsync() : true;
  if (!available) throw new Error("Secure storage is not available");
  await stores.secure.setItemAsync(secureTokenKey, token.trim());
  await stores.legacy.removeItem(legacyTokenKey).catch(() => undefined);
}

export async function clearStoredToken(stores: TokenStores): Promise<void> {
  await Promise.allSettled([stores.secure.deleteItemAsync(secureTokenKey), stores.legacy.removeItem(legacyTokenKey)]);
}
