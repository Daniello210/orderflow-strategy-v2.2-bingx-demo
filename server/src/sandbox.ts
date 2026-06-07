import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { confirmTimeframeReaction, detectFvgs } from "./fvg.js";
import { selectTarget } from "./targets.js";
import type { Candle, Direction, FvgZone, TargetCandidate } from "./types.js";

export interface SandboxOptions {
  symbols: string[];
  days: number;
}

export interface SandboxTrade {
  id: string;
  symbol: string;
  direction: Direction;
  openedAt: number;
  entry: number;
  stop: number;
  takeProfit: number;
  rr: number;
  outcome: "tp" | "sl" | "open";
  closedAt?: number;
  pnlR: number;
  minutesToClose?: number;
  targetFeatures: string[];
}

export interface SandboxResult {
  generatedAt: number;
  days: number;
  symbols: string[];
  summary: ReturnType<typeof summarize>;
  trades: SandboxTrade[];
}

interface SimulatedZone extends FvgZone {
  status: FvgZone["status"];
}

export async function runSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const days = clamp(Math.floor(options.days || 30), 1, 120);
  const symbols = [...new Set(options.symbols.map((symbol) => symbol.trim().toUpperCase().replace("-", "")).filter(Boolean))];
  if (!symbols.length) throw new Error("Sandbox needs at least one symbol.");

  const now = Date.now();
  const from = now - days * 24 * 60 * 60 * 1000;
  const trades: SandboxTrade[] = [];
  for (const symbol of symbols) {
    const [h4, h1] = await Promise.all([
      fetchHistoricalKlines(symbol, "4h", from, now),
      fetchHistoricalKlines(symbol, "1h", from, now)
    ]);
    trades.push(...simulateSymbol(symbol, h4, h1));
  }

  return {
    generatedAt: now,
    days,
    symbols,
    summary: summarize(trades),
    trades: trades.sort((left, right) => left.openedAt - right.openedAt)
  };
}

async function fetchHistoricalKlines(symbol: string, interval: "1h" | "4h", startTime: number, endTime: number): Promise<Candle[]> {
  const output: Candle[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endTime));
    url.searchParams.set("limit", "1000");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Binance sandbox klines ${symbol} ${interval} ${response.status}: ${await response.text()}`);
    const rows = await response.json() as unknown[][];
    if (!rows.length) break;
    output.push(...rows.map(rowToCandle));
    const next = Number(rows.at(-1)?.[6]) + 1;
    if (!Number.isFinite(next) || next <= cursor) break;
    cursor = next;
  }
  return output;
}

function rowToCandle(row: unknown[]): Candle {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    closed: true
  };
}

function simulateSymbol(symbol: string, h4: Candle[], h1: Candle[]): SandboxTrade[] {
  const zones = detectFvgs(symbol, h4, config.MIN_FVG_BPS)
    .filter((zone) => zone.createdAt >= h1[0]?.openTime)
    .map((zone) => ({ ...zone })) as SimulatedZone[];
  const trades: SandboxTrade[] = [];

  for (let index = 0; index < h1.length; index += 1) {
    const candle = h1[index];
    const activeZones = zones.filter((zone) =>
      zone.status !== "signaled"
      && zone.status !== "invalidated"
      && zone.createdAt < candle.openTime
      && candle.closeTime - zone.createdAt <= config.ZONE_MAX_AGE_HOURS * 60 * 60 * 1000
    );

    for (const zone of activeZones) {
      if (zone.status === "watching" && candleTouchesZone(candle, zone)) {
        zone.status = "touched";
        zone.touchedAt = candle.openTime;
      }
      if (zone.status === "touched") {
        const reaction = confirmTimeframeReaction(zone, candle);
        if (reaction.confirmed) {
          const trade = createSandboxTrade(zone, candle, h4.filter((item) => item.closeTime < candle.closeTime), h1.slice(index + 1));
          if (trade) {
            trades.push(trade);
            zone.status = "signaled";
          }
        }
      }
      if (invalidatedByClose(zone, candle)) zone.status = "invalidated";
    }
  }

  return trades;
}

function createSandboxTrade(zone: FvgZone, candle: Candle, h4Before: Candle[], futureH1: Candle[]): SandboxTrade | undefined {
  const entry = candle.close;
  const stop = sandboxStop(zone, candle);
  if (!validSwingSetup(zone, entry, stop)) return undefined;
  const target = sandboxTarget(zone.direction, entry, stop, h4Before);
  if (!target || !validSwingReward(entry, target.takeProfit)) return undefined;
  const outcome = resolveOutcome(zone.direction, target, stop, futureH1);
  return {
    id: `${zone.id}-${candle.closeTime}`,
    symbol: zone.symbol,
    direction: zone.direction,
    openedAt: candle.closeTime,
    entry,
    stop,
    takeProfit: target.takeProfit,
    rr: target.rr,
    outcome: outcome?.outcome ?? "open",
    closedAt: outcome?.closedAt,
    pnlR: outcome ? (outcome.outcome === "tp" ? target.rr : -1) : 0,
    minutesToClose: outcome ? Math.max(0, Math.round((outcome.closedAt - candle.closeTime) / 60_000)) : undefined,
    targetFeatures: target.features
  };
}

function sandboxTarget(direction: Direction, entry: number, stop: number, h4Before: Candle[]): TargetCandidate | undefined {
  const target = selectTarget(direction, entry, stop, undefined, h4Before, {
    minRR: config.MIN_TARGET_RR,
    minScore: Math.min(config.MIN_TARGET_SCORE, 3),
    bufferBps: config.TARGET_BUFFER_BPS,
    wallMultiplier: config.WALL_MULTIPLIER
  });
  if (target) return target;

  const risk = Math.abs(entry - stop);
  if (risk <= 0) return undefined;
  const takeProfit = direction === "long" ? entry + risk * config.MIN_TARGET_RR : entry - risk * config.MIN_TARGET_RR;
  return {
    price: takeProfit,
    takeProfit,
    rr: config.MIN_TARGET_RR,
    score: 0,
    features: ["sandbox_rr_projection"]
  };
}

function resolveOutcome(direction: Direction, target: TargetCandidate, stop: number, candles: Candle[]): { outcome: "tp" | "sl"; closedAt: number } | undefined {
  for (const candle of candles) {
    const hitTp = direction === "long" ? candle.high >= target.takeProfit : candle.low <= target.takeProfit;
    const hitSl = direction === "long" ? candle.low <= stop : candle.high >= stop;
    if (hitTp && hitSl) return { outcome: "sl", closedAt: candle.closeTime };
    if (hitTp) return { outcome: "tp", closedAt: candle.closeTime };
    if (hitSl) return { outcome: "sl", closedAt: candle.closeTime };
  }
  return undefined;
}

function sandboxStop(zone: FvgZone, candle: Candle): number {
  const boundary = zone.direction === "long" ? Math.min(zone.low, candle.low) : Math.max(zone.high, candle.high);
  const buffer = boundary * ((config.FVG_STOP_BUFFER_BPS + config.ADAPTIVE_STOP_EXTRA_BPS) / 10_000);
  return zone.direction === "long" ? boundary - buffer : boundary + buffer;
}

function candleTouchesZone(candle: Candle, zone: FvgZone): boolean {
  return candle.high >= zone.low && candle.low <= zone.high;
}

function invalidatedByClose(zone: FvgZone, candle: Candle): boolean {
  if (zone.status === "signaled") return false;
  return zone.direction === "long" ? candle.close < zone.low : candle.close > zone.high;
}

function validSwingSetup(zone: FvgZone, entry: number, stop: number): boolean {
  const zoneWidthBps = ((zone.high - zone.low) / entry) * 10_000;
  const riskBps = (Math.abs(entry - stop) / entry) * 10_000;
  return zoneWidthBps >= config.SWING_MIN_ZONE_WIDTH_BPS && riskBps >= config.SWING_MIN_RISK_BPS;
}

function validSwingReward(entry: number, takeProfit: number): boolean {
  return (Math.abs(takeProfit - entry) / entry) * 10_000 >= config.SWING_MIN_REWARD_BPS;
}

function summarize(trades: SandboxTrade[]) {
  const wins = trades.filter((trade) => trade.outcome === "tp").length;
  const losses = trades.filter((trade) => trade.outcome === "sl").length;
  const open = trades.filter((trade) => trade.outcome === "open").length;
  const totalR = roundR(trades.reduce((result, trade) => result + trade.pnlR, 0));
  const closed = wins + losses;
  const bySymbol: Record<string, { count: number; wins: number; losses: number; open: number; totalR: number }> = {};
  for (const trade of trades) {
    const item = bySymbol[trade.symbol] ?? { count: 0, wins: 0, losses: 0, open: 0, totalR: 0 };
    item.count += 1;
    item.wins += trade.outcome === "tp" ? 1 : 0;
    item.losses += trade.outcome === "sl" ? 1 : 0;
    item.open += trade.outcome === "open" ? 1 : 0;
    item.totalR = roundR(item.totalR + trade.pnlR);
    bySymbol[trade.symbol] = item;
  }
  return {
    count: trades.length,
    wins,
    losses,
    open,
    closed,
    winRate: closed ? roundR(wins / closed) : 0,
    totalR,
    avgR: trades.length ? roundR(totalR / trades.length) : 0,
    bySymbol
  };
}

function parseCliArgs(argv: string[]): SandboxOptions {
  const symbolsArg = valueAfter(argv, "--symbols") ?? valueAfter(argv, "-s") ?? config.symbols.join(",");
  const daysArg = valueAfter(argv, "--days") ?? valueAfter(argv, "-d") ?? "30";
  return {
    symbols: symbolsArg.split(/[,\s]+/).filter(Boolean),
    days: Number(daysArg)
  };
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundR(value: number): number {
  return Math.round(value * 1000) / 1000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSandbox(parseCliArgs(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
