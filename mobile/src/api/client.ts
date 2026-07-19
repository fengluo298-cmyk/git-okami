export class AuthExpiredError extends Error {}
export class NetworkError extends Error {}
export class TimeoutError extends Error {}
export class ServerError extends Error {}
export class InvalidResponseError extends Error {}
export class UpgradeRequiredError extends Error {
  readonly code = "CLIENT_UPGRADE_REQUIRED";
  readonly downloadUrl: string | null;

  constructor(
    message: string,
    readonly minimumBuild: number | null,
    readonly currentBuild: number | null,
    readonly latestVersion: string | null,
    downloadUrl: string | null,
    readonly requestId: string | null
  ) {
    super(message);
    this.downloadUrl = validateDownloadUrl(downloadUrl);
  }
}

export type ApiOptions = {
  token?: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
  clientBuild?: number;
  fetchImpl?: typeof fetch;
};

const allowedHosts = new Set((process.env.EXPO_PUBLIC_ALLOWED_HOSTS || "git-okami.onrender.com").split(",").map((host: string) => host.trim()).filter(Boolean));
const allowedDownloadHosts = new Set(
  (process.env.EXPO_PUBLIC_ALLOWED_DOWNLOAD_HOSTS || "git-okami.onrender.com,github.com,github-releases.githubusercontent.com,objects.githubusercontent.com")
    .split(",")
    .map((host: string) => host.trim())
    .filter(Boolean)
);

export function validateHttpBaseUrl(value: string, dev = typeof __DEV__ !== "undefined" && __DEV__): string {
  const url = new URL(value.trim());
  if (dev) {
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("API 地址必须是 HTTP 或 HTTPS");
    return url.origin;
  }
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) throw new Error("生产环境只允许连接受信任 HTTPS 服务");
  return url.origin;
}

export function validateSocketUrl(value: string, dev = typeof __DEV__ !== "undefined" && __DEV__): string {
  const url = new URL(value.trim());
  if (dev) {
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error("Socket 地址不合法");
    return url.origin;
  }
  if (!["https:", "wss:"].includes(url.protocol) || !allowedHosts.has(url.hostname)) throw new Error("生产环境只允许连接受信任 WSS/HTTPS 服务");
  return url.origin;
}

export function validateDownloadUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !allowedDownloadHosts.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function apiRequest<T = Record<string, unknown>>(baseUrl: string, path: string, options: ApiOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const res = await (options.fetchImpl ?? fetch)(`${validateHttpBaseUrl(baseUrl)}${path}`, {
      method: options.body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(options.clientBuild ? { "x-client-build": String(options.clientBuild) } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    return await readResponse<T>(res);
  } catch (error) {
    if (error instanceof AuthExpiredError || error instanceof ServerError || error instanceof InvalidResponseError || error instanceof UpgradeRequiredError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new TimeoutError("请求超时");
    throw new NetworkError("网络连接失败");
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError("登录已失效");
  if (res.status >= 500) throw new ServerError("服务暂不可用");
  if (res.status === 204 || !text) {
    if (res.ok) return {} as T;
    throw new InvalidResponseError("服务响应为空");
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) throw new InvalidResponseError("服务响应格式错误");
  let json: { ok?: boolean; error?: string; message?: string; [key: string]: unknown };
  try {
    json = JSON.parse(text) as { ok?: boolean; error?: string; [key: string]: unknown };
  } catch {
    throw new InvalidResponseError("服务响应不是有效 JSON");
  }
  if (res.status === 426 || json.code === "CLIENT_UPGRADE_REQUIRED") {
    throw new UpgradeRequiredError(
      safeMessage(json.message),
      safeNumber(json.minimumBuild),
      safeNumber(json.currentBuild),
      typeof json.latestVersion === "string" ? json.latestVersion : null,
      validateDownloadUrl(json.downloadUrl),
      typeof json.requestId === "string" ? json.requestId : null
    );
  }
  if (!res.ok || json.ok === false) throw new InvalidResponseError(safeMessage(json.message ?? json.error));
  return json as T;
}

function safeMessage(message: unknown): string {
  if (typeof message !== "string" || message.length > 120 || looksInternal(message)) return "请求失败";
  return message;
}

function looksInternal(message: string): boolean {
  return /DOMException|ReferenceError|TypeError|SyntaxError|SQLITE|stack|JW[T]_[S]ECRET|Authorization|Bearer|token|password/i.test(message);
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
