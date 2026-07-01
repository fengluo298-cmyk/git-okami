import type { Card } from "./cards.js";

export type HandValue = {
  category: number;
  name: string;
  ranks: number[];
};

export const HAND_NAMES: Record<number, string> = {
  10: "Royal flush",
  9: "Straight flush",
  8: "Four of a kind",
  7: "Full house",
  6: "Flush",
  5: "Straight",
  4: "Three of a kind",
  3: "Two pair",
  2: "One pair",
  1: "High card"
};

export function compareHands(a: HandValue, b: HandValue): number {
  const left = [a.category, ...a.ranks];
  const right = [b.category, ...b.ranks];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function evaluateHand(cards: Card[]): HandValue {
  if (cards.length < 5) throw new Error("At least five cards are required");

  const counts = new Map<number, number>();
  const suits = new Map<string, number[]>();
  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
    suits.set(card.suit, [...(suits.get(card.suit) ?? []), card.rank]);
  }

  const ranksDesc = [...counts.keys()].sort((a, b) => b - a);
  const straight = straightHigh(ranksDesc);
  const flushRanks = [...suits.values()]
    .filter((ranks) => ranks.length >= 5)
    .map((ranks) => [...new Set(ranks)].sort((a, b) => b - a))
    .sort(compareRankLists)[0];

  if (flushRanks) {
    const high = straightHigh(flushRanks);
    if (high) return value(high === 14 ? 10 : 9, [high]);
  }

  const quads = ranksByCount(counts, 4)[0];
  if (quads) return value(8, [quads, ...kickers(ranksDesc, [quads], 1)]);

  const trips = ranksByCount(counts, 3);
  const pairs = ranksByCount(counts, 2);
  const housePair = trips.length > 1 ? trips[1] : pairs[0];
  if (trips[0] && housePair) return value(7, [trips[0], housePair]);

  if (flushRanks) return value(6, flushRanks.slice(0, 5));
  if (straight) return value(5, [straight]);
  if (trips[0]) return value(4, [trips[0], ...kickers(ranksDesc, [trips[0]], 2)]);
  if (pairs.length >= 2) return value(3, [pairs[0], pairs[1], ...kickers(ranksDesc, pairs.slice(0, 2), 1)]);
  if (pairs[0]) return value(2, [pairs[0], ...kickers(ranksDesc, [pairs[0]], 3)]);
  return value(1, ranksDesc.slice(0, 5));
}

function value(category: number, ranks: number[]): HandValue {
  return { category, name: HAND_NAMES[category], ranks };
}

function straightHigh(ranks: number[]): number | null {
  const set = new Set(ranks);
  if (set.has(14)) set.add(1);
  for (let high = 14; high >= 5; high -= 1) {
    if ([0, 1, 2, 3, 4].every((offset) => set.has(high - offset))) return high;
  }
  return null;
}

function ranksByCount(counts: Map<number, number>, count: number): number[] {
  return [...counts.entries()]
    .filter(([, seen]) => seen === count)
    .map(([rank]) => rank)
    .sort((a, b) => b - a);
}

function kickers(ranksDesc: number[], used: number[], take: number): number[] {
  return ranksDesc.filter((rank) => !used.includes(rank)).slice(0, take);
}

function compareRankLists(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
