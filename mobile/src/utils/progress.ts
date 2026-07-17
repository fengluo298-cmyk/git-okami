export function progressLabelFor(authState: string, authMode: string, ops: Record<string, boolean>): string {
  if (authState === "restoring") return "正在恢复登录...";
  if (authState === "authenticating") return authMode === "login" ? "正在登录..." : "正在创建账号...";
  return pendingLabel(ops);
}

function pendingLabel(ops: Record<string, boolean>): string {
  const key = Object.keys(ops).find((name) => ops[name]);
  if (!key) return "";
  if (key === "rooms:create") return "正在创建牌桌...";
  if (key.startsWith("rooms:join:")) return "正在进入房间...";
  if (key === "rooms:leave") return "正在离开房间...";
  if (key.startsWith("seat:sit:")) return "正在坐下...";
  if (key === "seat:leave") return "正在起身...";
  if (key === "seat:ready") return "正在更新准备状态...";
  if (key === "game:start") return "正在开局...";
  if (key === "game:action") return "正在提交操作...";
  return "正在处理...";
}
