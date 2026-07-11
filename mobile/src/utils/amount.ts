export function parseChipAmount(value: string, label = "金额"): number {
  const text = value.trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${label}必须是正整数`);
  const amount = Number(text);
  if (!Number.isSafeInteger(amount)) throw new Error(`${label}过大`);
  return amount;
}

export function parseChipAmountInRange(value: string, min: number, max: number, label = "金额"): number {
  const amount = parseChipAmount(value, label);
  if (amount < min) throw new Error(`${label}不能低于 ${min}`);
  if (amount > max) throw new Error(`${label}不能高于 ${max}`);
  return amount;
}
