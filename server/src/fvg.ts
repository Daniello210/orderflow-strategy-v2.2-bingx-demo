import type { Candle, Direction, FvgZone, Reaction } from "./types.js";

// FVG определяет направление сценария, а не фильтр рыночного тренда.
// Мы намеренно не проверяем bullish/bearish bias: контртрендовый FVG допустим,
// если позже выполнены M15 reaction, orderflow и target/RR-фильтры.
export function detectFvgs(symbol: string, candles: Candle[], minBps: number): FvgZone[] {
  const zones: FvgZone[] = [];
  for (let i = 2; i < candles.length; i += 1) {
    const first = candles[i - 2];
    const third = candles[i];
    if (!first.closed || !third.closed) continue;

    if (first.high < third.low) {
      const gapBps = ((third.low - first.high) / first.high) * 10_000;
      if (gapBps >= minBps) zones.push(createZone(symbol, "long", first.high, third.low, third.closeTime));
    }
    if (first.low > third.high) {
      const gapBps = ((first.low - third.high) / third.high) * 10_000;
      if (gapBps >= minBps) zones.push(createZone(symbol, "short", third.high, first.low, third.closeTime));
    }
  }
  return zones;
}

function createZone(symbol: string, direction: Direction, low: number, high: number, createdAt: number): FvgZone {
  return {
    id: `${symbol}-${direction}-${createdAt}-${low}-${high}`,
    symbol,
    direction,
    low,
    high,
    createdAt,
    status: "watching"
  };
}

export function refreshValidZones(zones: FvgZone[], candles: Candle[], maxAgeHours: number, now = Date.now()): FvgZone[] {
  const cutoff = now - maxAgeHours * 60 * 60 * 1000;
  return zones.filter((zone) => {
    if (zone.createdAt < cutoff) return false;
    const laterCandles = candles.filter((c) => c.closeTime > zone.createdAt && c.closed);
    const invalidated = laterCandles.some((c) =>
      zone.direction === "long" ? c.close < zone.low : c.close > zone.high
    );
    return !invalidated;
  });
}

export function isPriceInsideZone(price: number, zone: FvgZone): boolean {
  return price >= zone.low && price <= zone.high;
}

export function confirmM15Reaction(zone: FvgZone, candle: Candle): Reaction {
  if (!candle.closed || zone.status !== "touched") {
    return { confirmed: false, type: "none", candleCloseTime: candle.closeTime, close: candle.close };
  }
  const mid = (zone.low + zone.high) / 2;
  if (zone.direction === "long") {
    const confirmed = candle.low <= zone.high && candle.close > mid && candle.close > candle.open;
    return { confirmed, type: confirmed ? "bullish_reclaim" : "none", candleCloseTime: candle.closeTime, close: candle.close };
  }
  const confirmed = candle.high >= zone.low && candle.close < mid && candle.close < candle.open;
  return { confirmed, type: confirmed ? "bearish_reclaim" : "none", candleCloseTime: candle.closeTime, close: candle.close };
}

export function stopForReaction(zone: FvgZone, reactionCandle: Candle): number {
  return zone.direction === "long"
    ? Math.min(reactionCandle.low, zone.low)
    : Math.max(reactionCandle.high, zone.high);
}
