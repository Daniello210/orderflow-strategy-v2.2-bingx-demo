import { config } from "./config.js";
import { detectFvgs, refreshValidZones, isPriceInsideZone, confirmM15Reaction, stopForReaction } from "./fvg.js";
import { FlowWindow } from "./orderflow.js";
import { selectTarget } from "./targets.js";
import { composeCommentary } from "./gpt.js";
import { recordSignal } from "./journal.js";
import { TelegramNotifier } from "./telegram.js";
import { BingXDemoExecutor } from "./bingx-demo.js";
import type { BookSnapshot, Candle, FvgZone, Signal, TradeTick } from "./types.js";

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
    for (const zone of state.zones.filter((z) => z.status === "touched" && z.touchedAt && candle.closeTime >= z.touchedAt)) {
      const reaction = confirmM15Reaction(zone, candle);
      zone.reaction = reaction;
      if (!reaction.confirmed) continue;

      const entry = candle.close;
      const stop = stopForReaction(zone, candle);
      const flow = state.flow.evaluate(zone.direction, zone.touchedAt!, candle.closeTime, {
        minNotional: config.MIN_FLOW_NOTIONAL_USDT,
        absorptionRatio: config.ABSORPTION_RATIO,
        initiativeRatio: config.INITIATIVE_RATIO,
        absorptionWindowMs: config.absorptionWindowMs,
        confirmationWindowMs: config.confirmationWindowMs,
        maxAbsorptionDriftBps: config.MAX_ABSORPTION_DRIFT_BPS
      });
      if (!flow.valid) {
        console.log(`[${symbol}] ${zone.direction} rejected: ${flow.rejectionReason}`);
        continue;
      }

      const target = selectTarget(zone.direction, entry, stop, state.book, state.h1, {
        minRR: config.MIN_TARGET_RR,
        minScore: config.MIN_TARGET_SCORE,
        bufferBps: config.TARGET_BUFFER_BPS,
        wallMultiplier: config.WALL_MULTIPLIER
      });
      if (!target) {
        console.log(`[${symbol}] ${zone.direction} rejected: target cluster below MIN_TARGET_RR`);
        continue;
      }
      const base = { id: `${zone.id}-${candle.closeTime}`, timestamp: candle.closeTime, symbol, direction: zone.direction, zone, entry, stop, target, flow };
      const gpt = await composeCommentary(base);
      const signal: Signal = { ...base, ...gpt };
      zone.status = "signaled";
      signal.execution = await this.executor.execute(signal);
      await recordSignal(signal);
      await this.telegram.signal(signal);
      console.log(`[${symbol}] signal ${signal.direction} ${signal.target.rr.toFixed(2)}R`);
    }
  }

  snapshot() {
    return [...this.states.entries()].map(([symbol, state]) => ({ symbol, lastPrice: state.lastPrice, zones: state.zones, bookUpdatedAt: state.book?.eventTime }));
  }
}

function upsertCandle(list: Candle[], candle: Candle, limit: number): Candle[] {
  const next = list.filter((item) => item.openTime !== candle.openTime);
  next.push(candle);
  return next.sort((a, b) => a.openTime - b.openTime).slice(-limit);
}
