import { config } from "./config.js";
import { confirmTimeframeReaction, detectFvgs, refreshValidZones, isPriceInsideZone } from "./fvg.js";
import { FlowWindow } from "./orderflow.js";
import { selectTarget } from "./targets.js";
import { composeCommentary } from "./gpt.js";
import { recordSignal } from "./journal.js";
import { TelegramNotifier } from "./telegram.js";
import { BingXDemoExecutor } from "./bingx-demo.js";
import type { KlineInterval } from "./binance.js";
import type { BookSnapshot, Candle, Direction, FlowPhase, FlowSummary, FvgZone, RiskProfile, Signal, TradeTick } from "./types.js";

interface SymbolState {
  h4: Candle[];
  h1: Candle[];
  zones: FvgZone[];
  book?: BookSnapshot;
  flow: FlowWindow;
  lastPrice?: number;
}

interface PaperSignalTracker {
  track(signal: Signal): Promise<void>;
}

export class StrategyEngine {
  private readonly states = new Map<string, SymbolState>();
  private readonly loggedRejections = new Set<string>();
  constructor(private readonly telegram: TelegramNotifier, private readonly executor: BingXDemoExecutor, private readonly paper?: PaperSignalTracker) {}

  bootstrap(symbol: string, h4: Candle[], h1: Candle[]): void {
    const found = detectFvgs(symbol, h4, config.MIN_FVG_BPS);
    const zones = refreshValidZones(found, h4, config.ZONE_MAX_AGE_HOURS).slice(-12);
    this.states.set(symbol, { h4, h1, zones, flow: new FlowWindow() });
    console.log(`[${symbol}] bootstrap: ${zones.length} valid H4 FVG zones`);
  }

  keepOnly(symbols: string[]): void {
    const keep = new Set(symbols);
    for (const symbol of this.states.keys()) {
      if (!keep.has(symbol)) this.states.delete(symbol);
    }
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

  async onClosedCandle(symbol: string, interval: KlineInterval, candle: Candle): Promise<void> {
    const state = this.states.get(symbol);
    if (!state) return;
    if (interval === "4h") {
      state.h4 = upsertCandle(state.h4, candle, 400);
      const zones = refreshValidZones(detectFvgs(symbol, state.h4, config.MIN_FVG_BPS), state.h4, config.ZONE_MAX_AGE_HOURS).slice(-12);
      const statuses = new Map(state.zones.map((z) => [z.id, z]));
      state.zones = zones.map((z) => statuses.get(z.id) ?? z);
      return;
    }
    state.h1 = upsertCandle(state.h1, candle, 500);
    for (const zone of state.zones.filter((z) => z.status === "touched")) {
      const reaction = confirmTimeframeReaction(zone, candle);
      if (reaction.confirmed) zone.reaction = reaction;
    }
  }

  snapshot() {
    return [...this.states.entries()].map(([symbol, state]) => ({ symbol, lastPrice: state.lastPrice, zones: state.zones, bookUpdatedAt: state.book?.eventTime }));
  }

  symbolDiagnostics() {
    return [...this.states.entries()].map(([symbol, state]) => {
      const counts = state.zones.reduce<Record<string, number>>((result, zone) => {
        result[zone.status] = (result[zone.status] ?? 0) + 1;
        return result;
      }, {});
      return {
        symbol,
        lastPrice: state.lastPrice,
        zones: counts,
        activeZones: state.zones.length,
        bookUpdatedAt: state.book?.eventTime
      };
    });
  }

  private async trySignalFromBoundaryBook(state: SymbolState, zone: FvgZone, tick: TradeTick): Promise<void> {
    if (zone.status !== "touched") return;
    if (!zone.reaction?.confirmed) return;
    if (!isNearConfirmationBoundary(tick.price, zone)) return;
    const flow = evaluateBoundaryBook(zone.direction, tick, zone, state.book);
    if (!flow.valid) {
      this.logRejection(zone, "orderbook", flow.rejectionReason ?? "Orderbook confirmation failed.");
      return;
    }

    const entry = tick.price;
    const riskProfile = buildRiskProfile(zone.direction, zone, entry, flow);
    const stop = stopForBoundary(zone, entry, riskProfile.stopBufferBps);
    const preTargetCheck = validateSwingSetup(zone, entry, stop);
    if (!preTargetCheck.valid) {
      this.logRejection(zone, preTargetCheck.key, preTargetCheck.reason);
      return;
    }

    const target = selectTarget(zone.direction, entry, stop, state.book, state.h4, {
      minRR: riskProfile.minRR,
      minScore: config.MIN_TARGET_SCORE,
      bufferBps: riskProfile.targetBufferBps,
      wallMultiplier: config.WALL_MULTIPLIER
    });
    if (!target) {
      this.logRejection(zone, "target-rr", "target cluster below MIN_TARGET_RR");
      return;
    }

    const postTargetCheck = validateSwingTarget(entry, target.takeProfit);
    if (!postTargetCheck.valid) {
      this.logRejection(zone, postTargetCheck.key, postTargetCheck.reason);
      return;
    }

    const base = { id: `${zone.id}-${tick.time}`, timestamp: tick.time, symbol: zone.symbol, direction: zone.direction, zone, entry, stop, target, flow, riskProfile };
    zone.status = "signaled";
    const gpt = await composeCommentary(base);
    const signal: Signal = { ...base, ...gpt };
    signal.execution = await this.executor.execute(signal);
    await recordSignal(signal);
    await this.paper?.track(signal);
    await this.telegram.signal(signal);
    console.log(`[${zone.symbol}] signal ${signal.direction} ${signal.target.rr.toFixed(2)}R`);
  }

  private logRejection(zone: FvgZone, reasonKey: string, reason: string): void {
    const key = `${zone.id}:${reasonKey}`;
    if (this.loggedRejections.has(key)) return;
    this.loggedRejections.add(key);
    console.log(`[${zone.symbol}] ${zone.direction} rejected: ${reason}`);
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

function stopForBoundary(zone: FvgZone, entry: number, stopBufferBps: number): number {
  const buffer = (zone.direction === "long" ? zone.low : zone.high) * (stopBufferBps / 10_000);
  return zone.direction === "long"
    ? Math.min(zone.low, entry) - buffer
    : Math.max(zone.high, entry) + buffer;
}

function notional(levels: BookSnapshot["bids"]): number {
  return levels.reduce((result, level) => result + level.price * level.quantity, 0);
}

function buildRiskProfile(direction: Direction, zone: FvgZone, entry: number, flow: FlowSummary): RiskProfile {
  const signalSide = direction === "long" ? flow.confirmation.buyNotional : flow.confirmation.sellNotional;
  const opposingSide = direction === "long" ? flow.confirmation.sellNotional : flow.confirmation.buyNotional;
  const imbalanceRatio = opposingSide > 0 ? signalSide / opposingSide : signalSide > 0 ? 99 : 1;
  const volumeRatio = signalSide / Math.max(config.MIN_FLOW_NOTIONAL_USDT, 1);
  const boundary = direction === "long" ? zone.low : zone.high;
  const boundaryDeviationBps = ((entry - boundary) / boundary) * 10_000;
  const falseBreakoutBps = direction === "long" ? Math.max(0, -boundaryDeviationBps) : Math.max(0, boundaryDeviationBps);
  const imbalanceScore = clamp((imbalanceRatio - config.ORDERBOOK_IMBALANCE_RATIO) / config.ORDERBOOK_IMBALANCE_RATIO, 0, 1);
  const volumeScore = clamp((volumeRatio - 1) / 3, 0, 1);
  const falseBreakoutPenalty = clamp(falseBreakoutBps / Math.max(config.FVG_BOUNDARY_PROXIMITY_BPS, 1), 0, 1);
  const confirmationScore = Math.round(clamp(45 + imbalanceScore * 35 + volumeScore * 20 - falseBreakoutPenalty * 18, 1, 100));
  const strength = confirmationScore / 100;
  const stopBufferBps = roundBps(config.FVG_STOP_BUFFER_BPS + config.ADAPTIVE_STOP_EXTRA_BPS * (1 - strength) + falseBreakoutBps * 1.25);
  const targetBufferBps = roundBps(clamp(
    config.TARGET_BUFFER_BPS * (1.45 - strength * 0.75) + falseBreakoutBps * 0.35,
    config.ADAPTIVE_TARGET_BUFFER_MIN_BPS,
    config.ADAPTIVE_TARGET_BUFFER_MAX_BPS
  ));
  const minRR = roundBps(clamp(config.MIN_TARGET_RR + falseBreakoutPenalty * 0.35 - strength * 0.25, 1.2, config.MIN_TARGET_RR + 0.5));
  const label = confirmationScore >= 75 ? "strong" : confirmationScore >= 55 ? "balanced" : "fragile";
  const notes = [
    `перевес ${imbalanceRatio.toFixed(2)}x`,
    `score ${confirmationScore}/100`,
    falseBreakoutBps > 0 ? `ложный прокол ${falseBreakoutBps.toFixed(2)} bps` : "без прокола границы",
    `SL buffer ${stopBufferBps.toFixed(2)} bps`,
    `TP buffer ${targetBufferBps.toFixed(2)} bps`
  ];

  return {
    label,
    confirmationScore,
    imbalanceRatio,
    sideNotional: signalSide,
    opposingNotional: opposingSide,
    falseBreakoutBps,
    stopBufferBps,
    targetBufferBps,
    minRR,
    notes
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundBps(value: number): number {
  return Math.round(value * 100) / 100;
}

function validateSwingSetup(zone: FvgZone, entry: number, stop: number): { valid: true } | { valid: false; key: string; reason: string } {
  const zoneWidthBps = ((zone.high - zone.low) / entry) * 10_000;
  if (zoneWidthBps < config.SWING_MIN_ZONE_WIDTH_BPS) {
    return {
      valid: false,
      key: "swing-zone-width",
      reason: `FVG слишком узкая для swing: ${zoneWidthBps.toFixed(2)} bps < ${config.SWING_MIN_ZONE_WIDTH_BPS} bps.`
    };
  }

  const riskBps = (Math.abs(entry - stop) / entry) * 10_000;
  if (riskBps < config.SWING_MIN_RISK_BPS) {
    return {
      valid: false,
      key: "swing-risk",
      reason: `Стоп слишком близкий для swing: ${riskBps.toFixed(2)} bps < ${config.SWING_MIN_RISK_BPS} bps.`
    };
  }

  return { valid: true };
}

function validateSwingTarget(entry: number, takeProfit: number): { valid: true } | { valid: false; key: string; reason: string } {
  const rewardBps = (Math.abs(takeProfit - entry) / entry) * 10_000;
  if (rewardBps < config.SWING_MIN_REWARD_BPS) {
    return {
      valid: false,
      key: "swing-reward",
      reason: `Цель слишком близкая для swing: ${rewardBps.toFixed(2)} bps < ${config.SWING_MIN_REWARD_BPS} bps.`
    };
  }

  return { valid: true };
}

function upsertCandle(list: Candle[], candle: Candle, limit: number): Candle[] {
  const next = list.filter((item) => item.openTime !== candle.openTime);
  next.push(candle);
  return next.sort((a, b) => a.openTime - b.openTime).slice(-limit);
}
