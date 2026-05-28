import { createServer } from "node:http";
import { config } from "./config.js";
import { fetchKlines, BinanceSpotStream } from "./binance.js";
import { StrategyEngine } from "./strategy.js";
import { TelegramNotifier } from "./telegram.js";
import { BingXDemoExecutor } from "./bingx-demo.js";

async function main(): Promise<void> {
  const telegram = new TelegramNotifier();
  const executor = new BingXDemoExecutor();
  const engine = new StrategyEngine(telegram, executor);
  for (const symbol of config.symbols) {
    const [h1, m15] = await Promise.all([fetchKlines(symbol, "1h", 400), fetchKlines(symbol, "15m", 500)]);
    engine.bootstrap(symbol, h1, m15);
  }

  const stream = new BinanceSpotStream(config.symbols, {
    onTrade: (symbol, tick) => engine.onTrade(symbol, tick),
    onBook: (symbol, book) => engine.onBook(symbol, book),
    onClosedCandle: (symbol, interval, candle) => engine.onClosedCandle(symbol, interval, candle),
    onStatus: (message) => console.log(`[market] ${message}`)
  }, config.DEPTH_LEVELS);
  stream.start();

  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/health") {
      response.end(JSON.stringify({ ok: true, mode: "binance_orderflow", execution: config.BINGX_DEMO_EXECUTION ? "bingx_vst" : "disabled", symbols: config.symbols, telegram: telegram.enabled }));
      return;
    }
    if (request.url === "/state") {
      response.end(JSON.stringify(engine.snapshot()));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(config.PORT, () => console.log(`Strategy health endpoint: http://0.0.0.0:${config.PORT}/health`));

  const shutdown = () => {
    stream.stop();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await telegram.send(`🤖 <b>Orderflow Strategy запущена</b>\nOrderflow: Binance public streams\nИсполнение: ${config.BINGX_DEMO_EXECUTION ? "BingX Demo Trading (VST)" : "выключено, только сигналы"}\nПары: ${config.symbols.join(", ")}\nЛогика: любой H1 FVG без фильтра тренда → M15 реакция → orderflow → цель по кластеру`);
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
