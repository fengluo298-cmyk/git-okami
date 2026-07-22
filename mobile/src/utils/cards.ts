export type Card = {
  rank: number;
  suit: "S" | "H" | "D" | "C";
};

export function formatCardRank(rank: unknown): string {
  if (typeof rank !== "number" || !Number.isSafeInteger(rank)) return "?";
  if (rank >= 2 && rank <= 10) return String(rank);
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  if (rank === 14) return "A";
  return "?";
}

export function displayCardRank(card: Card | undefined, hidden = false): string {
  return hidden || !card ? "?" : formatCardRank(card.rank);
}
