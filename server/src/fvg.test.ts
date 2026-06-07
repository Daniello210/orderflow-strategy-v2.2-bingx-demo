import test from "node:test";
import assert from "node:assert/strict";
import { confirmTimeframeReaction, detectFvgs } from "./fvg.js";
import type { Candle, FvgZone } from "./types.js";

function candle(open: number, high: number, low: number, close: number, time: number): Candle {
  return { openTime: time, closeTime: time + 1, open, high, low, close, volume: 1, closed: true };
}

test("detects bullish FVG", () => {
  const zones = detectFvgs("ETHUSDT", [candle(100, 101, 99, 100, 1), candle(100, 102, 100, 101, 2), candle(104, 105, 103, 104, 3)], 1);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].direction, "long");
  assert.equal(zones[0].low, 101);
  assert.equal(zones[0].high, 103);
});

test("confirms bullish reaction candle reclaim after touch", () => {
  const zone: FvgZone = { id: "x", symbol: "ETHUSDT", direction: "long", low: 100, high: 102, createdAt: 1, touchedAt: 2, status: "touched" };
  const result = confirmTimeframeReaction(zone, candle(100.5, 103, 100, 102.5, 3));
  assert.equal(result.confirmed, true);
  assert.equal(result.type, "bullish_reclaim");
});


test("accepts bullish FVG even after bearish context because trend is not a filter", () => {
  const descendingContext = [
    candle(120, 121, 118, 119, 1),
    candle(118, 119, 116, 117, 2),
    candle(116, 117, 114, 115, 3),
    candle(100, 101, 99, 100, 4),
    candle(100, 102, 100, 101, 5),
    candle(104, 105, 103, 104, 6)
  ];
  const zones = detectFvgs("ETHUSDT", descendingContext, 1);
  assert.ok(zones.some((zone) => zone.direction === "long" && zone.low === 101 && zone.high === 103));
});

test("accepts bearish FVG even after bullish context because trend is not a filter", () => {
  const ascendingContext = [
    candle(90, 92, 89, 91, 1),
    candle(92, 94, 91, 93, 2),
    candle(94, 96, 93, 95, 3),
    candle(110, 111, 109, 110, 4),
    candle(108, 110, 107, 108, 5),
    candle(104, 105, 103, 104, 6)
  ];
  const zones = detectFvgs("ETHUSDT", ascendingContext, 1);
  assert.ok(zones.some((zone) => zone.direction === "short" && zone.low === 105 && zone.high === 109));
});
