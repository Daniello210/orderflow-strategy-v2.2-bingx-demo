import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  SYMBOLS: z.string().default("ETHUSDT,BTCUSDT"),
  PORT: z.coerce.number().int().positive().default(8787),
  TIMEZONE: z.string().default("Europe/Warsaw"),
  MIN_FVG_BPS: z.coerce.number().positive().default(4),
  ZONE_MAX_AGE_HOURS: z.coerce.number().positive().default(240),
  MIN_TARGET_RR: z.coerce.number().positive().default(2.5),
  MIN_TARGET_SCORE: z.coerce.number().nonnegative().default(4),
  TARGET_BUFFER_BPS: z.coerce.number().positive().default(3),
  FVG_BOUNDARY_PROXIMITY_BPS: z.coerce.number().nonnegative().default(5),
  FVG_STOP_BUFFER_BPS: z.coerce.number().nonnegative().default(2),
  ORDERBOOK_IMBALANCE_RATIO: z.coerce.number().positive().default(1.15),
  MIN_FLOW_NOTIONAL_USDT: z.coerce.number().nonnegative().default(25_000),
  ABSORPTION_RATIO: z.coerce.number().positive().default(1.15),
  INITIATIVE_RATIO: z.coerce.number().positive().default(1.15),
  ABSORPTION_WINDOW_MINUTES: z.coerce.number().positive().default(5),
  CONFIRMATION_WINDOW_MINUTES: z.coerce.number().positive().default(3),
  MAX_ABSORPTION_DRIFT_BPS: z.coerce.number().nonnegative().default(10),
  WALL_MULTIPLIER: z.coerce.number().positive().default(3),
  DEPTH_LEVELS: z.coerce.number().int().refine((n) => [5, 10, 20].includes(n), "DEPTH_LEVELS must be 5, 10 or 20").default(20),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  SIGNALS_ONLY: z.enum(["true", "false"]).default("true"),
  DATA_DIR: z.string().default("./data"),
  // Исполнение только на BingX Demo Trading (VST). Market data/orderflow остаются Binance.
  BINGX_DEMO_EXECUTION: z.enum(["true", "false"]).default("false"),
  BINGX_API_KEY: z.string().default(""),
  BINGX_API_SECRET: z.string().default(""),
  BINGX_DEMO_QUANTITIES_JSON: z.string().default('{"ETHUSDT":0.01,"BTCUSDT":0.001}'),
  BINGX_RECV_WINDOW: z.coerce.number().int().positive().max(60000).default(5000)
});

const parsed = envSchema.parse(process.env);

export const config = {
  ...parsed,
  symbols: parsed.SYMBOLS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  signalsOnly: parsed.SIGNALS_ONLY === "true",
  BINGX_DEMO_EXECUTION: parsed.BINGX_DEMO_EXECUTION === "true",
  bingxDemoQuantities: parseQuantities(parsed.BINGX_DEMO_QUANTITIES_JSON),
  absorptionWindowMs: parsed.ABSORPTION_WINDOW_MINUTES * 60_000,
  confirmationWindowMs: parsed.CONFIRMATION_WINDOW_MINUTES * 60_000
};

if (!config.signalsOnly) {
  throw new Error("SIGNALS_ONLY=false запрещён: эта версия не поддерживает реальные ордера.");
}
if (config.BINGX_DEMO_EXECUTION && (!config.BINGX_API_KEY || !config.BINGX_API_SECRET)) {
  throw new Error("Для BINGX_DEMO_EXECUTION=true нужны BINGX_API_KEY и BINGX_API_SECRET от BingX Demo Trading (VST)." );
}

function parseQuantities(value: string): Record<string, number> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("BINGX_DEMO_QUANTITIES_JSON должен быть JSON, например {\"ETHUSDT\":0.01}." ); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BINGX_DEMO_QUANTITIES_JSON должен быть объектом JSON." );
  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Неверный демо-объём для ${key}.`);
    output[key.toUpperCase().replace("-", "")] = amount;
  }
  return output;
}
