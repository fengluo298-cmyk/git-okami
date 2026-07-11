export function parseChipAmount(value: unknown, label = "Amount"): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
    return value;
  }
  if (typeof value !== "string") throw new Error(`${label} must be a positive integer`);
  const text = value.trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${label} must be a positive integer`);
  const amount = Number(text);
  if (!Number.isSafeInteger(amount)) throw new Error(`${label} is too large`);
  return amount;
}
