import assert from "node:assert/strict";
import test from "node:test";
import { buildOrderParams, buildSignedQuery, toBingxSymbol } from "./bingx-demo.js";
import type { TargetCandidate } from "./types.js";

const target: TargetCandidate = { price: 3575, takeProfit: 3570, rr: 4.5, score: 8, features: ["wall"] };

test("maps Binance symbols to BingX perpetual symbols", () => {
  assert.equal(toBingxSymbol("ETHUSDT"), "ETH-USDT");
  assert.equal(toBingxSymbol("BTC-USDT"), "BTC-USDT");
});

test("creates LONG demo market order with attached protective TP and SL", () => {
  const params = buildOrderParams({ direction: "long", entry: 3498, stop: 3482, target, id: "eth-long" }, "ETH-USDT", 0.01);
  assert.equal(params.side, "BUY");
  assert.equal(params.positionSide, "LONG");
  assert.equal(params.type, "MARKET");
  assert.deepEqual(JSON.parse(params.stopLoss), { type: "STOP_MARKET", stopPrice: 3482, workingType: "MARK_PRICE" });
  assert.deepEqual(JSON.parse(params.takeProfit), { type: "TAKE_PROFIT_MARKET", stopPrice: 3570, workingType: "MARK_PRICE" });
});

test("creates deterministic signed query", () => {
  const result = buildSignedQuery({ symbol: "ETH-USDT", side: "BUY" }, 1000, "secret");
  assert.match(result, /^side=BUY&symbol=ETH-USDT&timestamp=1000&signature=[a-f0-9]{64}$/);
});
