import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import type { Direction, Signal, TradeTick } from "./types.js";

type PaperOutcome = "tp" | "sl";

export interface PaperOpenPosition {
  signalId: string;
  symbol: string;
  direction: Direction;
  openedAt: number;
  entry: number;
  stop: number;
  takeProfit: number;
  rr: number;
}

export interface PaperClosedOutcome extends PaperOpenPosition {
  outcome: PaperOutcome;
  closedAt: number;
  closePrice: number;
  pnlR: number;
  minutesToClose: number;
}

interface PaperSummaryItem {
  count: number;
  wins: number;
  losses: number;
  open: number;
  totalR: number;
}

const OPEN_FILE = "paper-open.json";
const OUTCOMES_FILE = "paper-outcomes.jsonl";

export class PaperOutcomeTracker {
  private readonly open = new Map<string, PaperOpenPosition>();

  async init(): Promise<void> {
    await mkdir(config.DATA_DIR, { recursive: true });
    for (const position of await readOpenPositions()) {
      this.open.set(position.signalId, position);
    }
  }

  async track(signal: Signal): Promise<void> {
    if (this.open.has(signal.id)) return;
    this.open.set(signal.id, {
      signalId: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      openedAt: signal.timestamp,
      entry: signal.entry,
      stop: signal.stop,
      takeProfit: signal.target.takeProfit,
      rr: signal.target.rr
    });
    await this.saveOpen();
  }

  async onTrade(symbol: string, tick: TradeTick): Promise<void> {
    const candidates = [...this.open.values()].filter((position) => position.symbol === symbol);
    for (const position of candidates) {
      const outcome = resolveOutcome(position, tick.price);
      if (!outcome) continue;

      this.open.delete(position.signalId);
      const closed: PaperClosedOutcome = {
        ...position,
        outcome,
        closedAt: tick.time,
        closePrice: tick.price,
        pnlR: outcome === "tp" ? position.rr : -1,
        minutesToClose: Math.max(0, Math.round((tick.time - position.openedAt) / 60_000))
      };
      await appendOutcome(closed);
      await this.saveOpen();
      console.log(`[${position.symbol}] paper ${outcome.toUpperCase()} ${closed.pnlR.toFixed(2)}R after ${closed.minutesToClose}m`);
    }
  }

  async snapshot() {
    const closed = await readClosedOutcomes();
    const open = [...this.open.values()].sort((left, right) => right.openedAt - left.openedAt);
    return {
      summary: summarize(closed, open),
      recent: closed.slice(-30).reverse(),
      open
    };
  }

  private async saveOpen(): Promise<void> {
    await mkdir(config.DATA_DIR, { recursive: true });
    const positions = [...this.open.values()].sort((left, right) => left.openedAt - right.openedAt);
    await writeFile(join(config.DATA_DIR, OPEN_FILE), JSON.stringify({ positions }, null, 2), "utf8");
  }
}

function resolveOutcome(position: PaperOpenPosition, price: number): PaperOutcome | undefined {
  if (position.direction === "long") {
    if (price >= position.takeProfit) return "tp";
    if (price <= position.stop) return "sl";
  } else {
    if (price <= position.takeProfit) return "tp";
    if (price >= position.stop) return "sl";
  }
  return undefined;
}

async function readOpenPositions(): Promise<PaperOpenPosition[]> {
  try {
    const raw = await readFile(join(config.DATA_DIR, OPEN_FILE), "utf8");
    const parsed = JSON.parse(raw) as { positions?: PaperOpenPosition[] };
    return Array.isArray(parsed.positions) ? parsed.positions : [];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function appendOutcome(outcome: PaperClosedOutcome): Promise<void> {
  await mkdir(config.DATA_DIR, { recursive: true });
  await appendFile(join(config.DATA_DIR, OUTCOMES_FILE), `${JSON.stringify(outcome)}\n`, "utf8");
}

async function readClosedOutcomes(): Promise<PaperClosedOutcome[]> {
  try {
    const raw = await readFile(join(config.DATA_DIR, OUTCOMES_FILE), "utf8");
    return raw.trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line) as PaperClosedOutcome);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function summarize(closed: PaperClosedOutcome[], open: PaperOpenPosition[]) {
  const summary = {
    count: closed.length,
    wins: closed.filter((item) => item.outcome === "tp").length,
    losses: closed.filter((item) => item.outcome === "sl").length,
    open: open.length,
    winRate: 0,
    totalR: roundR(closed.reduce((result, item) => result + item.pnlR, 0)),
    avgR: 0,
    bySymbol: {} as Record<string, PaperSummaryItem>
  };
  summary.winRate = summary.count ? roundR(summary.wins / summary.count) : 0;
  summary.avgR = summary.count ? roundR(summary.totalR / summary.count) : 0;

  for (const outcome of closed) {
    const item = summary.bySymbol[outcome.symbol] ?? createSummaryItem();
    item.count += 1;
    item.wins += outcome.outcome === "tp" ? 1 : 0;
    item.losses += outcome.outcome === "sl" ? 1 : 0;
    item.totalR = roundR(item.totalR + outcome.pnlR);
    summary.bySymbol[outcome.symbol] = item;
  }
  for (const position of open) {
    const item = summary.bySymbol[position.symbol] ?? createSummaryItem();
    item.open += 1;
    summary.bySymbol[position.symbol] = item;
  }
  return summary;
}

function createSummaryItem(): PaperSummaryItem {
  return { count: 0, wins: 0, losses: 0, open: 0, totalR: 0 };
}

function roundR(value: number): number {
  return Math.round(value * 1000) / 1000;
}
