import { config } from "./config.js";
import { detectFvgs, refreshValidZones, isPriceInsideZone } from "./fvg.js";
import { FlowWindow } from "./orderflow.js";
import { selectTarget } from "./targets.js";
import { composeCommentary } from "./gpt.js";
import { recordSignal } from "./journal.js";
import { TelegramNotifier } from "./telegram.js";
import { BingXDemoExecutor } from "./bingx-demo.js";
import type { BookSnapshot, Candle, Direction, FlowPhase, FlowSummary, FvgZone, Signal, TradeTick } from "./types.js";

interface SymbolState {
  h1: Candle[];
  m15: Candle[];
  zones: FvgZone[];
  book?: BookSnapshot;
  flow: FlowWindow;
  lastPrice?: number;
}

export class StrategyEngine {
  private readonly states = new Map<string, SymbolState>();
  private readonly boundaryRejectLogged = new Set<string>();
  constructor(private readonly telegram: TelegramNotifier, private readonly executor: BingXDemoExecutor) {}

  bootstrap(symbol: string, h1: Candle[], m15: Candle[]): void {
    const found = detectFvgs(symbol, h1, config.MIN_FVG_BPS);
    const zones = refreshValidZones(found, h1, config.ZONE_MAX_AGE_HOURS).slice(-12);
    this.states.set(symbol, { h1, m15, zones, flow: new FlowWindow() });
    console.log(`[${symbol}] bootstrap: ${zones.length} valid H1 FVG zones`);
  }

  onBook(symbol: string, book: BookSnapshot): void {
    const state = this.states.get(symbol);
    if (state) state.book = book;
  }

  async onTrade(symbol: string, tick: TradeTick): Promise<void> {
    const state = this.states.get(symbol);
    if (!state) return;
    state.flow.add(tick);
    state.lastPrice = tick.price;
    for (const zone of state.zones.filter((z) => z.status === "watching")) {
      if (isPriceInsideZone(tick.price, zone)) {
        zone.status = "touched";
        zone.touchedAt = tick.time;
        await this.telegram.zoneTouched(zone, tick.price);
      }
    }
    for (const zone of state.zones.filter((z) => z.status === "touched" && z.touchedAt)) {
      await this.trySignalFromBoundaryBook(state, zone, tick);
    }
  }

  async onClosedCandle(symbol: string, interval: "1h" | "15m", candle: Candle): Promise<void> {
    const state = this.states.get(symbol);
    if (!state) return;
    if (interval === "1h") {
      state.h1 = upsertCandle(state.h1, candle, 400);
      const zones = refreshValidZones(detectFvgs(symbol, state.h1, config.MIN_FVG_BPS), state.h1, config.ZONE_MAX_AGE_HOURS).slice(-12);
      const statuses = new Map(state.zones.map((z) => [z.id, z]));
      state.zones = zones.map((z) => statuses.get(z.id) ?? z);
      return;
    }

    state.m15 = upsertCandle(state.m15, candle, 500);
  }

  snapshot() {
    return [...this.states.entries()].map(([symbol, state]) => ({ symbol, lastPrice: state.lastPrice, zones: state.zones, bookUpdatedAt: state.book?.eventTime }));
  }

  private async trySignalFromBoundaryBook(state: SymbolState, zone: FvgZone, tick: TradeTick): Promise<void> {
    if (!isNearConfirmationBoundary(tick.price, zone)) return;
    const flow = evaluateBoundaryBook(zone.direction, tick, zone, state.book);
    if (!flow.valid) {
      const key = `${zone.id}:${flow.rejectionReason}`;
      if (!this.boundaryRejectLogged.has(key)) {
        this.boundaryRejectLogged.add(key);
        console.log(`[${zone.symbol}] ${zone.direction} rejected: ${flow.rejectionReason}`);
      }
      return;
    }

    const entry = tick.price;
    const stop = stopForBoundary(zone, entry);
    const target = selectTarget(zone.direction, entry, stop, state.book, state.h1, {
      minRR: config.MIN_TARGET_RR,
      minScore: config.MIN_TARGET_SCORE,
      bufferBps: config.TARGET_BUFFER_BPS,
      wallMultiplier: config.WALL_MULTIPLIER
    });
    if (!target) {
      console.log(`[${zone.symbol}] ${zone.direction} rejected: target cluster below MIN_TARGET_RR`);
      return;
    }

    const base = { id: `${zone.id}-${tick.time}`, timestamp: tick.time, symbol: zone.symbol, direction: zone.direction, zone, entry, stop, target, flow };
    const gpt = await composeCommentary(base);
    const signal: Signal = { ...base, ...gpt };
    zone.status = "signaled";
    signal.execution = await this.executor.execute(signal);
    await recordSignal(signal);
    await this.telegram.signal(signal);
    console.log(`[${zone.symbol}] signal ${signal.direction} ${signal.target.rr.toFixed(2)}R`);
  }
}

function isNearConfirmationBoundary(price: number, zone: FvgZone): boolean {
  const boundary = zone.direction === "long" ? zone.low : zone.high;
  const tolerance = boundary * (config.FVG_BOUNDARY_PROXIMITY_BPS / 10_000);
  return Math.abs(price - boundary) <= tolerance;
}

function evaluateBoundaryBook(direction: Direction, tick: TradeTick, zone: FvgZone, book: BookSnapshot | undefined): FlowSummary {
  if (!book) return invalidFlow(tick, "Нет актуального orderbook для подтверждения FVG.");
  const buyNotional = notional(book.bids);
  const sellNotional = notional(book.asks);
  const enoughVolume = Math.max(buyNotional, sellNotional) >= config.MIN_FLOW_NOTIONAL_USDT;
  const dominance = direction === "long"
    ? buyNotional >= sellNotional * config.ORDERBOOK_IMBALANCE_RATIO
    : sellNotional >= buyNotional * config.ORDERBOOK_IMBALANCE_RATIO;
  const valid = enoughVolume && dominance;
  const boundary = direction === "long" ? zone.low : zone.high;
  const phase: FlowPhase = {
    from: tick.time,
    to: tick.time,
    buyNotional,
    sellNotional,
    delta: buyNotional - sellNotional,
    openPrice: tick.price,
    closePrice: tick.price,
    priceChangeBps: ((tick.price - boundary) / boundary) * 10_000,
    dominantAggression: buyNotional > sellNotional * 1.05 ? "buyers" : sellNotional > buyNotional * 1.05 ? "sellers" : "balanced"
  };
  return {
    absorption: phase,
    confirmation: phase,
    absorptionConfirmed: enoughVolume,
    initiativeConfirmed: dominance,
    valid,
    rejectionReason: valid ? undefined : bookRejectionReason(direction, enoughVolume, buyNotional, sellNotional)
  };
}

function invalidFlow(tick: TradeTick, reason: string): FlowSummary {
  const phase: FlowPhase = {
    from: tick.time,
    to: tick.time,
    buyNotional: 0,
    sellNotional: 0,
    delta: 0,
    openPrice: tick.price,
    closePrice: tick.price,
    priceChangeBps: 0,
    dominantAggression: "balanced"
  };
  return { absorption: phase, confirmation: phase, absorptionConfirmed: false, initiativeConfirmed: false, valid: false, rejectionReason: reason };
}

function bookRejectionReason(direction: Direction, enoughVolume: boolean, buyNotional: number, sellNotional: number): string {
  if (!enoughVolume) return `Недостаточный объём в orderbook: bids $${Math.round(buyNotional)}, asks $${Math.round(sellNotional)}.`;
  const needed = direction === "long" ? "покупателей/bids" : "продавцов/asks";
  return `Нет перевеса ${needed} в orderbook: bids $${Math.round(buyNotional)}, asks $${Math.round(sellNotional)}.`;
}

function stopForBoundary(zone: FvgZone, entry: number): number {
  const buffer = (zone.direction === "long" ? zone.low : zone.high) * (config.FVG_STOP_BUFFER_BPS / 10_000);
  return zone.direction === "long"
    ? Math.min(zone.low, entry) - buffer
    : Math.max(zone.high, entry) + buffer;
}

function notional(levels: BookSnapshot["bids"]): number {
  return levels.reduce((result, level) => result + level.price * level.quantity, 0);
}

function upsertCandle(list: Candle[], candle: Candle, limit: number): Candle[] {
  const next = list.filter((item) => item.openTime !== candle.openTime);
  next.push(candle);
  return next.sort((a, b) => a.openTime - b.openTime).slice(-limit);
}
