import type { BookSnapshot, Candle, Direction, TargetCandidate } from "./types.js";

interface TargetOptions {
  minRR: number;
  minScore: number;
  bufferBps: number;
  wallMultiplier: number;
}

export function selectTarget(direction: Direction, entry: number, stop: number, book: BookSnapshot | undefined, candles: Candle[], options: TargetOptions): TargetCandidate | undefined {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return undefined;
  const raw: Array<{ price: number; score: number; features: string[] }> = [];

  if (book) {
    const levels = direction === "long" ? book.asks : book.bids;
    const averageQty = levels.reduce((acc, level) => acc + level.quantity, 0) / Math.max(levels.length, 1);
    for (const level of levels) {
      const ahead = direction === "long" ? level.price > entry : level.price < entry;
      if (ahead && level.quantity >= averageQty * options.wallMultiplier) {
        raw.push({ price: level.price, score: 4, features: [direction === "long" ? "ask_wall" : "bid_wall"] });
      }
    }
  }

  const recent = candles.filter((c) => c.closed).slice(-80);
  const pivots = direction === "long" ? swingHighs(recent) : swingLows(recent);
  for (const price of pivots) {
    const ahead = direction === "long" ? price > entry : price < entry;
    if (ahead) raw.push({ price, score: 3, features: [direction === "long" ? "h1_swing_high" : "h1_swing_low"] });
  }

  const significant = mergeNearby(raw, entry * 0.0008)
    .filter((candidate) => candidate.score >= options.minScore)
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

  // Выход выбирается перед первой сильной встречной зоной. Нельзя перескочить через неё к далёкой красивой цели.
  const nearest = significant[0];
  if (!nearest) return undefined;
  const buffer = nearest.price * (options.bufferBps / 10_000);
  const takeProfit = direction === "long" ? nearest.price - buffer : nearest.price + buffer;
  const reward = direction === "long" ? takeProfit - entry : entry - takeProfit;
  const target = { ...nearest, takeProfit, rr: reward / risk };
  return target.rr >= options.minRR ? target : undefined;
}

function swingHighs(candles: Candle[]): number[] {
  return candles.flatMap((c, i) => i > 0 && i < candles.length - 1 && c.high > candles[i - 1].high && c.high >= candles[i + 1].high ? [c.high] : []);
}
function swingLows(candles: Candle[]): number[] {
  return candles.flatMap((c, i) => i > 0 && i < candles.length - 1 && c.low < candles[i - 1].low && c.low <= candles[i + 1].low ? [c.low] : []);
}
function mergeNearby(items: Array<{ price: number; score: number; features: string[] }>, tolerance: number) {
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const result: Array<{ price: number; score: number; features: string[] }> = [];
  for (const item of sorted) {
    const existing = result.find((x) => Math.abs(x.price - item.price) <= tolerance);
    if (existing) {
      existing.score += item.score;
      existing.features = [...new Set([...existing.features, ...item.features, "cluster_confluence"])];
    } else {
      result.push({ ...item });
    }
  }
  return result;
}
