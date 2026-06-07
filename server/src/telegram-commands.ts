import { config } from "./config.js";
import { TelegramNotifier } from "./telegram.js";
import type { SandboxResult } from "./sandbox.js";
import type { Direction } from "./types.js";

interface SymbolDiagnostics {
  symbol: string;
  lastPrice?: number;
  zones?: Record<string, number>;
  activeZones?: number;
  bookUpdatedAt?: number;
}

interface AdminSymbolsPayload {
  requested: string[];
  active: string[];
  skipped: Array<{ symbol: string; reason: string }>;
  updating: boolean;
  symbols: Array<{
    symbol: string;
    active: boolean;
    skipped?: string;
    diagnostics?: SymbolDiagnostics;
  }>;
}

interface HealthPayload {
  ok: boolean;
  execution: string;
  symbols: string[];
  requestedSymbols: string[];
  skippedSymbols: Array<{ symbol: string; reason: string }>;
  updatingSymbols: boolean;
  telegram: boolean;
}

interface AvailableSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  active: boolean;
  requested: boolean;
}

interface PaperSnapshot {
  summary: {
    count: number;
    wins: number;
    losses: number;
    open: number;
    winRate: number;
    totalR: number;
    avgR: number;
    bySymbol: Record<string, { count: number; wins: number; losses: number; open: number; totalR: number }>;
  };
  recent: Array<{
    signalId: string;
    symbol: string;
    direction: Direction;
    outcome: "tp" | "sl";
    pnlR: number;
    minutesToClose: number;
  }>;
  open: Array<{
    signalId: string;
    symbol: string;
    direction: Direction;
    openedAt: number;
    entry: number;
    stop: number;
    takeProfit: number;
    rr: number;
  }>;
}

interface StrategySettings {
  minTargetRR: number;
  targetBufferBps: number;
  fvgBoundaryProximityBps: number;
  fvgStopBufferBps: number;
  swingMinZoneWidthBps: number;
  swingMinRiskBps: number;
  swingMinRewardBps: number;
  orderbookImbalanceRatio: number;
  minFlowNotionalUsdt: number;
  adaptiveStopExtraBps: number;
  adaptiveTargetBufferMinBps: number;
  adaptiveTargetBufferMaxBps: number;
}

export interface TelegramCommandContext {
  status: () => HealthPayload;
  symbols: () => AdminSymbolsPayload;
  setSymbols: (symbols: string[]) => Promise<AdminSymbolsPayload>;
  searchSymbols: (search: string) => Promise<AvailableSymbol[]>;
  paper: () => Promise<PaperSnapshot>;
  settings: () => StrategySettings;
  sandbox: (symbols: string[], days: number) => Promise<SandboxResult>;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number | string };
    text?: string;
  };
}

export class TelegramCommandBot {
  private offset = 0;
  private stopped = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly notifier: TelegramNotifier, private readonly context: TelegramCommandContext) {}

  start(): void {
    if (!this.notifier.enabled) {
      console.log("[telegram-bot] commands disabled: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured");
      return;
    }
    console.log("[telegram-bot] commands enabled; polling Telegram getUpdates");
    void this.configureCommands().catch((error) => {
      console.warn("[telegram-bot] setMyCommands failed:", error instanceof Error ? error.message : String(error));
    });
    void this.primeAndLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async primeAndLoop(): Promise<void> {
    try {
      const pending = await this.fetchUpdates(0);
      if (pending.length) this.offset = Math.max(...pending.map((item) => item.update_id)) + 1;
    } catch (error) {
      console.warn("[telegram-bot] initial getUpdates failed:", error instanceof Error ? error.message : String(error));
    }
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.fetchUpdates(25);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handle(update);
        }
      } catch (error) {
        console.warn("[telegram-bot] polling failed:", error instanceof Error ? error.message : String(error));
        await sleep(3000);
      }
    }
  }

  private async fetchUpdates(timeout: number): Promise<TelegramUpdate[]> {
    const url = new URL(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates`);
    url.searchParams.set("timeout", String(timeout));
    url.searchParams.set("offset", String(this.offset));
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telegram getUpdates ${response.status}: ${await response.text()}`);
    const body = await response.json() as { ok?: boolean; result?: TelegramUpdate[]; description?: string };
    if (!body.ok) throw new Error(body.description ?? "Telegram getUpdates returned ok=false");
    return body.result ?? [];
  }

  private async configureCommands(): Promise<void> {
    const commands = [
      { command: "status", description: "Статус сервера" },
      { command: "pairs", description: "Пары в watchlist" },
      { command: "addpair", description: "Добавить пару" },
      { command: "removepair", description: "Удалить пару" },
      { command: "setpairs", description: "Заменить список пар" },
      { command: "search", description: "Найти USDT пары" },
      { command: "paper", description: "Paper TP/SL статистика" },
      { command: "settings", description: "Параметры стратегии" },
      { command: "sandbox", description: "Исторический sandbox тест" },
      { command: "help", description: "Команды бота" }
    ];
    const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands })
    });
    if (!response.ok) {
      console.warn("[telegram-bot] setMyCommands failed:", await response.text());
    }
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const chatId = update.message?.chat.id;
    const text = update.message?.text?.trim();
    if (!text || String(chatId) !== config.TELEGRAM_CHAT_ID) return;
    if (!text.startsWith("/")) return;

    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split("@")[0]?.toLowerCase();
    try {
      if (command === "/start" || command === "/help") {
        await this.notifier.send(helpText());
      } else if (command === "/status") {
        await this.notifier.send(statusText(this.context.status()));
      } else if (command === "/pairs") {
        await this.notifier.send(pairsText(this.context.symbols()));
      } else if (command === "/addpair") {
        await this.addPair(args[0]);
      } else if (command === "/removepair") {
        await this.removePair(args[0]);
      } else if (command === "/setpairs") {
        await this.setPairs(args.join(" "));
      } else if (command === "/search") {
        await this.search(args.join(" "));
      } else if (command === "/paper") {
        await this.notifier.send(paperText(await this.context.paper()));
      } else if (command === "/settings") {
        await this.notifier.send(settingsText(this.context.settings()));
      } else if (command === "/sandbox") {
        await this.sandbox(args);
      } else {
        await this.notifier.send(`Не знаю команду <code>${escapeHtml(command ?? "")}</code>.\n\n${helpText()}`);
      }
    } catch (error) {
      await this.notifier.send(`Ошибка команды: ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private async addPair(raw: string | undefined): Promise<void> {
    const symbol = normalizeSymbol(raw);
    if (!symbol) throw new Error("Напиши пару: /addpair SOLUSDT");
    const current = this.context.symbols().requested;
    if (current.includes(symbol)) {
      await this.notifier.send(`<code>${symbol}</code> уже в списке.`);
      return;
    }
    const next = await this.context.setSymbols([...current, symbol]);
    await this.notifier.send(`Добавил <code>${symbol}</code>.\n\n${pairsText(next)}`);
  }

  private async removePair(raw: string | undefined): Promise<void> {
    const symbol = normalizeSymbol(raw);
    if (!symbol) throw new Error("Напиши пару: /removepair SOLUSDT");
    const current = this.context.symbols().requested;
    if (!current.includes(symbol)) {
      await this.notifier.send(`<code>${symbol}</code> нет в списке.`);
      return;
    }
    if (current.length <= 1) throw new Error("Нельзя удалить последнюю пару.");
    const next = await this.context.setSymbols(current.filter((item) => item !== symbol));
    await this.notifier.send(`Удалил <code>${symbol}</code>.\n\n${pairsText(next)}`);
  }

  private async setPairs(raw: string): Promise<void> {
    const symbols = raw.split(/[,\s]+/).map(normalizeSymbol).filter(Boolean);
    if (!symbols.length) throw new Error("Напиши список: /setpairs ETHUSDT,BTCUSDT,SOLUSDT");
    const next = await this.context.setSymbols(symbols);
    await this.notifier.send(`Список пар обновлён.\n\n${pairsText(next)}`);
  }

  private async search(raw: string): Promise<void> {
    const query = raw.trim().toUpperCase();
    if (!query) throw new Error("Напиши поиск: /search SOL");
    const symbols = (await this.context.searchSymbols(query)).slice(0, 15);
    if (!symbols.length) {
      await this.notifier.send(`По запросу <code>${escapeHtml(query)}</code> ничего не найдено на Binance Spot USDT.`);
      return;
    }
    await this.notifier.send([
      `<b>Доступные пары Binance Spot по запросу ${escapeHtml(query)}</b>`,
      ...symbols.map((item) => `${item.requested ? "•" : "+"} <code>${item.symbol}</code>${item.requested ? " уже в watchlist" : ""}`)
    ].join("\n"));
  }

  private async sandbox(args: string[]): Promise<void> {
    const last = args.at(-1);
    const maybeDays = last ? Number(last) : Number.NaN;
    const days = Number.isFinite(maybeDays) ? maybeDays : 30;
    const symbolText = Number.isFinite(maybeDays) ? args.slice(0, -1).join(" ") : args.join(" ");
    const symbols = symbolText.trim()
      ? symbolText.split(/[,\s]+/).map(normalizeSymbol).filter(Boolean)
      : this.context.symbols().active;
    if (!symbols.length) throw new Error("Нет символов для sandbox. Пример: /sandbox ETHUSDT,SOLUSDT 30");
    await this.notifier.send(`Запускаю sandbox: <code>${symbols.join(", ")}</code>, ${Math.floor(days)}d. Это может занять немного времени.`);
    await this.notifier.send(sandboxText(await this.context.sandbox(symbols, days)));
  }
}

function helpText(): string {
  return [
    "<b>Orderflow Telegram Bot</b>",
    "",
    "/status - состояние сервера",
    "/pairs - watchlist и активные пары",
    "/addpair SOLUSDT - добавить пару",
    "/removepair SOLUSDT - удалить пару",
    "/setpairs ETHUSDT,BTCUSDT - заменить список",
    "/search SOL - найти доступные USDT пары",
    "/paper - paper TP/SL статистика",
    "/settings - параметры стратегии",
    "/sandbox ETHUSDT,SOLUSDT 30 - исторический swing sandbox"
  ].join("\n");
}

function statusText(status: HealthPayload): string {
  return [
    "<b>Статус</b>",
    `Сервер: ${status.ok ? "ok" : "problem"}`,
    `Исполнение: <code>${escapeHtml(status.execution)}</code>`,
    `Telegram: ${status.telegram ? "on" : "off"}`,
    `Обновление пар: ${status.updatingSymbols ? "идёт" : "нет"}`,
    `Активные: <code>${status.symbols.join(", ")}</code>`,
    status.skippedSymbols.length ? `Пропущены: ${status.skippedSymbols.map((item) => `<code>${item.symbol}</code>`).join(", ")}` : "Пропущены: нет"
  ].join("\n");
}

function pairsText(payload: AdminSymbolsPayload): string {
  return [
    "<b>Watchlist</b>",
    `Запрошены: <code>${payload.requested.join(", ")}</code>`,
    `Активны: <code>${payload.active.join(", ")}</code>`,
    payload.skipped.length ? "<b>Пропущены</b>" : "Пропущены: нет",
    ...payload.skipped.map((item) => `<code>${item.symbol}</code>: ${escapeHtml(item.reason)}`)
  ].join("\n");
}

function paperText(snapshot: PaperSnapshot): string {
  const summary = snapshot.summary;
  const bySymbol = Object.entries(summary.bySymbol)
    .sort(([, left], [, right]) => Math.abs(right.totalR) - Math.abs(left.totalR))
    .slice(0, 8);
  const recent = snapshot.recent.slice(0, 5);
  return [
    "<b>Paper trading</b>",
    `Сделок: ${summary.count} | открыто: ${summary.open}`,
    `Winrate: ${(summary.winRate * 100).toFixed(1)}% | Total: ${formatR(summary.totalR)} | Avg: ${formatR(summary.avgR)}`,
    "",
    bySymbol.length ? "<b>По парам</b>" : "По парам: пока пусто",
    ...bySymbol.map(([symbol, item]) => `<code>${symbol}</code>: ${formatR(item.totalR)} | W/L/O ${item.wins}/${item.losses}/${item.open}`),
    "",
    recent.length ? "<b>Последние исходы</b>" : "Последние исходы: пока нет",
    ...recent.map((item) => `${item.outcome === "tp" ? "TP" : "SL"} <code>${item.symbol}</code> ${item.direction.toUpperCase()} ${formatR(item.pnlR)} за ${item.minutesToClose}m`)
  ].join("\n");
}

function settingsText(settings: StrategySettings): string {
  return [
    "<b>Параметры стратегии</b>",
    `Min RR: <code>${settings.minTargetRR}</code>`,
    `Target buffer: <code>${settings.targetBufferBps} bps</code>`,
    `FVG boundary proximity: <code>${settings.fvgBoundaryProximityBps} bps</code>`,
    `Base SL buffer: <code>${settings.fvgStopBufferBps} bps</code>`,
    `Swing zone/risk/reward: <code>${settings.swingMinZoneWidthBps}/${settings.swingMinRiskBps}/${settings.swingMinRewardBps} bps</code>`,
    `Orderbook imbalance: <code>${settings.orderbookImbalanceRatio}x</code>`,
    `Min flow: <code>$${Math.round(settings.minFlowNotionalUsdt).toLocaleString("en-US")}</code>`,
    `Adaptive SL extra: <code>${settings.adaptiveStopExtraBps} bps</code>`,
    `Adaptive TP buffer min/max: <code>${settings.adaptiveTargetBufferMinBps}/${settings.adaptiveTargetBufferMaxBps} bps</code>`
  ].join("\n");
}

function sandboxText(result: SandboxResult): string {
  const summary = result.summary;
  const bySymbol = Object.entries(summary.bySymbol)
    .sort(([, left], [, right]) => Math.abs(right.totalR) - Math.abs(left.totalR))
    .slice(0, 10);
  const recent = result.trades.slice(-5).reverse();
  return [
    `<b>Swing sandbox ${result.days}d</b>`,
    `Пары: <code>${result.symbols.join(", ")}</code>`,
    `Сетапов: ${summary.count} | закрыто: ${summary.closed} | открыто: ${summary.open}`,
    `Winrate: ${(summary.winRate * 100).toFixed(1)}% | Total: ${formatR(summary.totalR)} | Avg: ${formatR(summary.avgR)}`,
    "",
    bySymbol.length ? "<b>По парам</b>" : "По парам: пусто",
    ...bySymbol.map(([symbol, item]) => `<code>${symbol}</code>: ${formatR(item.totalR)} | W/L/O ${item.wins}/${item.losses}/${item.open}`),
    "",
    recent.length ? "<b>Последние сетапы</b>" : "Сетапов пока нет",
    ...recent.map((trade) => `${trade.outcome.toUpperCase()} <code>${trade.symbol}</code> ${trade.direction.toUpperCase()} ${formatR(trade.pnlR)} RR ${trade.rr.toFixed(2)}`)
  ].join("\n");
}

function normalizeSymbol(raw: string | undefined): string {
  return (raw ?? "").trim().toUpperCase().replace("-", "");
}

function formatR(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
