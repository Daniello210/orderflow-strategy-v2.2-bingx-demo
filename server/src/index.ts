import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { fetchExchangeSymbols, fetchKlines, BinanceSpotStream, type MarketHandlers } from "./binance.js";
import { StrategyEngine } from "./strategy.js";
import { TelegramNotifier } from "./telegram.js";
import { BingXDemoExecutor } from "./bingx-demo.js";
import { loadAdminSymbols, normalizeSymbols, saveAdminSymbols } from "./admin-settings.js";
import { PaperOutcomeTracker } from "./paper-outcomes.js";
import { TelegramCommandBot } from "./telegram-commands.js";
import { runSandbox } from "./sandbox.js";

interface SkippedSymbol {
  symbol: string;
  reason: string;
}

async function main(): Promise<void> {
  const telegram = new TelegramNotifier();
  const executor = new BingXDemoExecutor();
  const paper = new PaperOutcomeTracker();
  await paper.init();
  const engine = new StrategyEngine(telegram, executor, paper);
  let requestedSymbols = await loadAdminSymbols();
  let activeSymbols: string[] = [];
  let skippedSymbols: SkippedSymbol[] = [];
  let stream: BinanceSpotStream | undefined;
  let updatingSymbols = false;

  const marketHandlers: MarketHandlers = {
    onTrade: async (symbol, tick) => {
      await paper.onTrade(symbol, tick);
      await engine.onTrade(symbol, tick);
    },
    onBook: (symbol, book) => engine.onBook(symbol, book),
    onClosedCandle: (symbol, interval, candle) => engine.onClosedCandle(symbol, interval, candle),
    onStatus: (message) => console.log(`[market] ${message}`)
  };

  async function applySymbols(symbols: string[], persist: boolean): Promise<void> {
    if (updatingSymbols) throw new Error("Список пар уже обновляется.");
    updatingSymbols = true;
    try {
      const normalized = persist ? await saveAdminSymbols(symbols) : normalizeSymbols(symbols);
      const nextActive: string[] = [];
      const nextSkipped: SkippedSymbol[] = [];
      for (const symbol of normalized) {
        try {
          const [h4, h1] = await Promise.all([fetchKlines(symbol, "4h", 400), fetchKlines(symbol, "1h", 500)]);
          engine.bootstrap(symbol, h4, h1);
          nextActive.push(symbol);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Unknown bootstrap error";
          nextSkipped.push({ symbol, reason });
          console.warn(`[${symbol}] skipped: ${reason}`);
        }
      }
      if (nextActive.length === 0) throw new Error("Нет активных Binance Spot символов после bootstrap.");

      stream?.stop();
      engine.keepOnly(nextActive);
      requestedSymbols = normalized;
      activeSymbols = nextActive;
      skippedSymbols = nextSkipped;
      stream = new BinanceSpotStream(activeSymbols, marketHandlers, config.DEPTH_LEVELS);
      stream.start();
    } finally {
      updatingSymbols = false;
    }
  }

  await applySymbols(requestedSymbols, false);

  const healthPayload = () => ({
    ok: true,
    mode: "binance_orderflow",
    execution: config.BINGX_DEMO_EXECUTION ? "bingx_vst" : "disabled",
    symbols: activeSymbols,
    requestedSymbols,
    skippedSymbols,
    updatingSymbols,
    telegram: telegram.enabled
  });
  const adminSymbolsPayload = () => {
    const diagnostics = engine.symbolDiagnostics();
    return {
      requested: requestedSymbols,
      active: activeSymbols,
      skipped: skippedSymbols,
      updating: updatingSymbols,
      symbols: requestedSymbols.map((symbol) => ({
        symbol,
        active: activeSymbols.includes(symbol),
        skipped: skippedSymbols.find((item) => item.symbol === symbol)?.reason,
        diagnostics: diagnostics.find((item) => item.symbol === symbol)
      }))
    };
  };
  const commandBot = new TelegramCommandBot(telegram, {
    status: healthPayload,
    symbols: adminSymbolsPayload,
    setSymbols: async (symbols) => {
      await applySymbols(symbols, true);
      return adminSymbolsPayload();
    },
    searchSymbols: async (search) => {
      const symbols = await fetchExchangeSymbols("USDT", search);
      return symbols.slice(0, 50).map((item) => ({
        symbol: item.symbol,
        baseAsset: item.baseAsset,
        quoteAsset: item.quoteAsset,
        active: activeSymbols.includes(item.symbol),
        requested: requestedSymbols.includes(item.symbol)
      }));
    },
    paper: () => paper.snapshot(),
    settings: () => ({
      minTargetRR: config.MIN_TARGET_RR,
      targetBufferBps: config.TARGET_BUFFER_BPS,
      fvgBoundaryProximityBps: config.FVG_BOUNDARY_PROXIMITY_BPS,
      fvgStopBufferBps: config.FVG_STOP_BUFFER_BPS,
      swingMinZoneWidthBps: config.SWING_MIN_ZONE_WIDTH_BPS,
      swingMinRiskBps: config.SWING_MIN_RISK_BPS,
      swingMinRewardBps: config.SWING_MIN_REWARD_BPS,
      orderbookImbalanceRatio: config.ORDERBOOK_IMBALANCE_RATIO,
      minFlowNotionalUsdt: config.MIN_FLOW_NOTIONAL_USDT,
      adaptiveStopExtraBps: config.ADAPTIVE_STOP_EXTRA_BPS,
      adaptiveTargetBufferMinBps: config.ADAPTIVE_TARGET_BUFFER_MIN_BPS,
      adaptiveTargetBufferMaxBps: config.ADAPTIVE_TARGET_BUFFER_MAX_BPS
    }),
    sandbox: (symbols, days) => runSandbox({ symbols, days })
  });
  commandBot.start();

  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type,x-admin-token");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, healthPayload());
      return;
    }
    if (request.method === "GET" && url.pathname === "/state") {
      sendJson(response, engine.snapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin/symbols") {
      sendJson(response, adminSymbolsPayload());
      return;
    }
    if (request.method === "POST" && url.pathname === "/admin/symbols") {
      if (!adminAuthorized(request)) {
        sendJson(response, { error: "unauthorized" }, 401);
        return;
      }
      try {
        const body = await readJsonBody<{ symbols?: string[] }>(request);
        if (!Array.isArray(body.symbols)) throw new Error("symbols должен быть массивом.");
        await applySymbols(body.symbols, true);
        sendJson(response, adminSymbolsPayload());
      } catch (error) {
        sendJson(response, { error: error instanceof Error ? error.message : "Unknown admin error" }, 400);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin/available-symbols") {
      try {
        const quote = url.searchParams.get("quote") ?? "USDT";
        const search = url.searchParams.get("search") ?? "";
        const symbols = await fetchExchangeSymbols(quote.toUpperCase(), search);
        sendJson(response, {
          quote,
          search,
          symbols: symbols.slice(0, 500).map((item) => ({
            symbol: item.symbol,
            baseAsset: item.baseAsset,
            quoteAsset: item.quoteAsset,
            status: item.status,
            active: activeSymbols.includes(item.symbol),
            requested: requestedSymbols.includes(item.symbol)
          }))
        });
      } catch (error) {
        sendJson(response, { error: error instanceof Error ? error.message : "Unknown Binance symbols error" }, 502);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin/paper-outcomes") {
      sendJson(response, await paper.snapshot());
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin/sandbox") {
      try {
        const symbols = (url.searchParams.get("symbols") ?? requestedSymbols.join(",")).split(/[,\s]+/).filter(Boolean);
        const days = Number(url.searchParams.get("days") ?? "30");
        sendJson(response, await runSandbox({ symbols, days }));
      } catch (error) {
        sendJson(response, { error: error instanceof Error ? error.message : "Unknown sandbox error" }, 502);
      }
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(config.PORT, () => console.log(`Strategy health endpoint: http://0.0.0.0:${config.PORT}/health`));

  const shutdown = () => {
    commandBot.stop();
    stream?.stop();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await telegram.send(`🤖 <b>Orderflow Strategy запущена</b>\nOrderflow: Binance public streams\nИсполнение: ${config.BINGX_DEMO_EXECUTION ? "BingX Demo Trading (VST)" : "выключено, только сигналы"}\nАктивные пары: ${activeSymbols.join(", ")}\nПропущены: ${skippedSymbols.length ? skippedSymbols.map((item) => item.symbol).join(", ") : "нет"}\nЛогика: H4 FVG → касание зоны → H1 подтверждение → граница FVG → перевес orderbook → swing-фильтры → цель по кластеру`);
}

function sendJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

function adminAuthorized(request: IncomingMessage): boolean {
  if (!config.ADMIN_TOKEN) return true;
  const header = request.headers["x-admin-token"];
  return typeof header === "string" && header === config.ADMIN_TOKEN;
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
