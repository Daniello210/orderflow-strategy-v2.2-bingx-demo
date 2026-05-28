import type { Direction, FlowPhase, FlowSummary, TradeTick } from "./types.js";

export interface EvaluateFlowOptions {
  minNotional: number;
  absorptionRatio: number;
  initiativeRatio: number;
  absorptionWindowMs: number;
  confirmationWindowMs: number;
  maxAbsorptionDriftBps: number;
}

export class FlowWindow {
  private readonly ticks: TradeTick[] = [];
  constructor(private readonly retentionMs = 30 * 60 * 1000) {}

  add(tick: TradeTick): void {
    this.ticks.push(tick);
    this.prune(tick.time);
  }

  evaluate(direction: Direction, touchedAt: number, reactionCloseAt: number, options: EvaluateFlowOptions): FlowSummary {
    this.prune(reactionCloseAt);
    const absorptionTo = Math.min(reactionCloseAt, touchedAt + options.absorptionWindowMs);
    const confirmationFrom = Math.max(absorptionTo, reactionCloseAt - options.confirmationWindowMs);
    const absorption = this.phase(touchedAt, absorptionTo);
    const confirmation = this.phase(confirmationFrom, reactionCloseAt);

    const absorptionVolumeOk = maxNotional(absorption) >= options.minNotional;
    const confirmationVolumeOk = maxNotional(confirmation) >= options.minNotional;
    const absorptionAttack = direction === "long"
      ? absorption.sellNotional >= absorption.buyNotional * options.absorptionRatio
      : absorption.buyNotional >= absorption.sellNotional * options.absorptionRatio;
    const priceHeld = direction === "long"
      ? (absorption.priceChangeBps ?? Number.NEGATIVE_INFINITY) >= -options.maxAbsorptionDriftBps
      : (absorption.priceChangeBps ?? Number.POSITIVE_INFINITY) <= options.maxAbsorptionDriftBps;
    const absorptionConfirmed = absorptionVolumeOk && absorptionAttack && priceHeld;

    // Жёсткое правило: после поглощения сторона сделки обязана реально перехватить поток и цену.
    const confirmationDominance = direction === "long"
      ? confirmation.buyNotional >= confirmation.sellNotional * options.initiativeRatio && confirmation.delta > 0
      : confirmation.sellNotional >= confirmation.buyNotional * options.initiativeRatio && confirmation.delta < 0;
    const confirmationPriceMove = direction === "long"
      ? (confirmation.priceChangeBps ?? 0) > 0
      : (confirmation.priceChangeBps ?? 0) < 0;
    const initiativeConfirmed = confirmationVolumeOk && confirmationDominance && confirmationPriceMove;
    const valid = absorptionConfirmed && initiativeConfirmed;

    return {
      absorption,
      confirmation,
      absorptionConfirmed,
      initiativeConfirmed,
      valid,
      rejectionReason: valid ? undefined : reason(direction, absorptionConfirmed, initiativeConfirmed, confirmation)
    };
  }

  private phase(from: number, to: number): FlowPhase {
    const active = this.ticks.filter((t) => t.time >= from && t.time <= to);
    const buyNotional = sum(active, "buy");
    const sellNotional = sum(active, "sell");
    const openPrice = active[0]?.price;
    const closePrice = active.at(-1)?.price;
    const priceChangeBps = openPrice && closePrice ? ((closePrice - openPrice) / openPrice) * 10_000 : undefined;
    const dominantAggression = buyNotional > sellNotional * 1.05
      ? "buyers"
      : sellNotional > buyNotional * 1.05
        ? "sellers"
        : "balanced";
    return { from, to, buyNotional, sellNotional, delta: buyNotional - sellNotional, openPrice, closePrice, priceChangeBps, dominantAggression };
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs;
    while (this.ticks[0] && this.ticks[0].time < cutoff) this.ticks.shift();
  }
}

function sum(ticks: TradeTick[], side: "buy" | "sell"): number {
  return ticks.filter((t) => t.side === side).reduce((result, t) => result + t.quoteQty, 0);
}
function maxNotional(phase: FlowPhase): number { return Math.max(phase.buyNotional, phase.sellNotional); }
function reason(direction: Direction, absorption: boolean, initiative: boolean, confirmation: FlowPhase): string {
  if (!absorption) return "Нет подтверждённого поглощения в зоне FVG.";
  if (!initiative) {
    const side = direction === "long" ? "покупатель" : "продавец";
    return `${side} не перехватил инициативу после поглощения: delta подтверждающей фазы ${confirmation.delta.toFixed(2)}.`;
  }
  return "Условия orderflow не выполнены.";
}
