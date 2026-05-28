import assert from "node:assert/strict";
import test from "node:test";
import { FlowWindow } from "./orderflow.js";

const options = {
  minNotional: 1_000,
  absorptionRatio: 1.1,
  initiativeRatio: 1.1,
  absorptionWindowMs: 5 * 60_000,
  confirmationWindowMs: 3 * 60_000,
  maxAbsorptionDriftBps: 10
};

function add(flow: FlowWindow, time: number, price: number, quoteQty: number, side: "buy" | "sell") {
  flow.add({ time, price, quoteQty, side });
}

test("long: accepts sell absorption followed by buyer initiative", () => {
  const f = new FlowWindow();
  add(f, 0, 100, 800, "buy");
  add(f, 60_000, 99.95, 2_000, "sell");
  add(f, 4 * 60_000, 100, 1_000, "sell");
  add(f, 12 * 60_000, 100, 700, "sell");
  add(f, 13 * 60_000, 100.2, 2_000, "buy");
  const result = f.evaluate("long", 0, 15 * 60_000, options);
  assert.equal(result.absorptionConfirmed, true);
  assert.equal(result.initiativeConfirmed, true);
  assert.equal(result.valid, true);
});

test("long: rejects when sellers still dominate confirmation phase", () => {
  const f = new FlowWindow();
  add(f, 0, 100, 800, "buy");
  add(f, 60_000, 99.95, 2_000, "sell");
  add(f, 4 * 60_000, 100, 1_000, "sell");
  add(f, 12 * 60_000, 100, 2_000, "sell");
  add(f, 13 * 60_000, 99.9, 500, "buy");
  const result = f.evaluate("long", 0, 15 * 60_000, options);
  assert.equal(result.absorptionConfirmed, true);
  assert.equal(result.initiativeConfirmed, false);
  assert.equal(result.valid, false);
});

test("short: accepts buy absorption followed by seller initiative", () => {
  const f = new FlowWindow();
  add(f, 0, 100, 700, "sell");
  add(f, 60_000, 100.05, 2_000, "buy");
  add(f, 4 * 60_000, 100, 1_000, "buy");
  add(f, 12 * 60_000, 100, 700, "buy");
  add(f, 13 * 60_000, 99.8, 2_000, "sell");
  const result = f.evaluate("short", 0, 15 * 60_000, options);
  assert.equal(result.valid, true);
});
