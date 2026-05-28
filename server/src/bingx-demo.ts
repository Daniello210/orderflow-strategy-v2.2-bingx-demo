import { createHmac } from "node:crypto";
import { config } from "./config.js";
import type { DemoExecutionReceipt, Direction, Signal } from "./types.js";

/**
 * Execution client for BingX Demo Trading (VST) only.
 * This client deliberately has no configuration for the live-trading domain.
 */
const BINGX_VST_BASE_URL = "https://open-api-vst.bingx.com";
const ORDER_PATH = "/openApi/swap/v2/trade/order";

interface BingXEnvelope {
  code?: number;
  msg?: string;
  data?: {
    order?: { orderId?: string | number };
    orderId?: string | number;
  };
}

export class BingXDemoExecutor {
  get enabled(): boolean {
    return config.BINGX_DEMO_EXECUTION;
  }

  async execute(signal: Signal): Promise<DemoExecutionReceipt> {
    if (!this.enabled) {
      return { mode: "disabled", status: "not_sent", message: "BingX Demo execution выключен." };
    }

    const quantity = config.bingxDemoQuantities[signal.symbol];
    if (!quantity || quantity <= 0) {
      return {
        mode: "vst",
        status: "rejected",
        bingxSymbol: toBingxSymbol(signal.symbol),
        message: `Не задан объём демо-сделки для ${signal.symbol} в BINGX_DEMO_QUANTITIES_JSON.`
      };
    }

    const bingxSymbol = toBingxSymbol(signal.symbol);
    const params = buildOrderParams(signal, bingxSymbol, quantity);
    try {
      const raw = await signedPost(ORDER_PATH, params);
      const orderId = String(raw.data?.order?.orderId ?? raw.data?.orderId ?? "");
      return {
        mode: "vst",
        status: "submitted",
        bingxSymbol,
        quantity,
        orderId: orderId || undefined,
        message: "Демо-ордер отправлен в BingX VST вместе с TP/SL.",
      };
    } catch (error) {
      return {
        mode: "vst",
        status: "rejected",
        bingxSymbol,
        quantity,
        message: error instanceof Error ? error.message : "Неизвестная ошибка BingX Demo."
      };
    }
  }
}

export function toBingxSymbol(sourceSymbol: string): string {
  const symbol = sourceSymbol.trim().toUpperCase();
  if (symbol.includes("-")) return symbol;
  if (symbol.endsWith("USDT")) return `${symbol.slice(0, -4)}-USDT`;
  throw new Error(`Не могу преобразовать символ ${sourceSymbol} в формат BingX.`);
}

export function buildOrderParams(signal: Pick<Signal, "direction" | "entry" | "stop" | "target" | "id">, symbol: string, quantity: number): Record<string, string> {
  const direction = executionSides(signal.direction);
  return {
    symbol,
    side: direction.side,
    positionSide: direction.positionSide,
    type: "MARKET",
    quantity: String(quantity),
    stopLoss: JSON.stringify({
      type: "STOP_MARKET",
      stopPrice: signal.stop,
      workingType: "MARK_PRICE"
    }),
    takeProfit: JSON.stringify({
      type: "TAKE_PROFIT_MARKET",
      stopPrice: signal.target.takeProfit,
      workingType: "MARK_PRICE"
    }),
    clientOrderID: safeClientOrderId(signal.id),
    recvWindow: String(config.BINGX_RECV_WINDOW)
  };
}

export function buildSignedQuery(params: Record<string, string>, timestamp: number, secret: string): string {
  const entries = Object.entries({ ...params, timestamp: String(timestamp) })
    .sort(([left], [right]) => left.localeCompare(right));
  const query = new URLSearchParams(entries).toString();
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  return `${query}&signature=${signature}`;
}

function executionSides(direction: Direction): { side: "BUY" | "SELL"; positionSide: "LONG" | "SHORT" } {
  return direction === "long"
    ? { side: "BUY", positionSide: "LONG" }
    : { side: "SELL", positionSide: "SHORT" };
}

function safeClientOrderId(id: string): string {
  return `fvg-${id}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36);
}

async function signedPost(path: string, params: Record<string, string>): Promise<BingXEnvelope> {
  const query = buildSignedQuery(params, Date.now(), config.BINGX_API_SECRET);
  const response = await fetch(`${BINGX_VST_BASE_URL}${path}?${query}`, {
    method: "POST",
    headers: {
      "X-BX-APIKEY": config.BINGX_API_KEY,
      "content-type": "application/x-www-form-urlencoded"
    }
  });
  const body = await response.text();
  let json: BingXEnvelope;
  try {
    json = JSON.parse(body) as BingXEnvelope;
  } catch {
    throw new Error(`BingX Demo HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  if (!response.ok || json.code !== 0) {
    throw new Error(`BingX Demo отклонил ордер: ${json.code ?? response.status} ${json.msg ?? body}`);
  }
  return json;
}
