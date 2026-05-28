import assert from "node:assert/strict";
import test from "node:test";
import { selectTarget } from "./targets.js";
import type { BookSnapshot, Candle } from "./types.js";

const candles: Candle[] = [];
const book: BookSnapshot = {
  eventTime: 1,
  bids: [],
  asks: [
    { price: 102, quantity: 1000 },
    { price: 106, quantity: 1 },
    { price: 112, quantity: 1000 },
    { price: 115, quantity: 1 }
  ]
};

test("does not skip nearest significant opposing wall to chase higher RR", () => {
  const target = selectTarget("long", 100, 99, book, candles, { minRR: 2.5, minScore: 4, bufferBps: 0.1, wallMultiplier: 1.5 });
  assert.equal(target, undefined);
});

test("uses nearest significant wall when its RR is sufficient", () => {
  const target = selectTarget("long", 100, 99, book, candles, { minRR: 1.5, minScore: 4, bufferBps: 0.1, wallMultiplier: 1.5 });
  assert.ok(target);
  assert.equal(target?.price, 102);
});
