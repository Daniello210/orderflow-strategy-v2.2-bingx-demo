import WebSocket from "ws";
import type { BookSnapshot, Candle, TradeTick } from "./types.js";

export interface MarketHandlers {
  onClosedCandle: (symbol: string, interval: "1h" | "15m", candle: Candle) => void | Promise<void>;
  onTrade: (symbol: string, tick: TradeTick) => void | Promise<void>;
  onBook: (symbol: string, book: BookSnapshot) => void | Promise<void>;
  onStatus?: (message: string) => void;
}

export async function fetchKlines(symbol: string, interval: "1h" | "15m", limit = 300): Promise<Candle[]> {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Binance klines ${response.status}: ${await response.text()}`);
  const rows = await response.json() as unknown[][];
  return rows.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    closed: true
  }));
}

export class BinanceSpotStream {
  private ws?: WebSocket;
  private retry?: NodeJS.Timeout;
  private stopped = false;
  constructor(private readonly symbols: string[], private readonly handlers: MarketHandlers, private readonly depthLevels = 20) {}

  start(): void {
    const streams = this.symbols.flatMap((symbol) => {
      const s = symbol.toLowerCase();
      return [`${s}@kline_1h`, `${s}@kline_15m`, `${s}@aggTrade`, `${s}@depth${this.depthLevels}@100ms`];
    }).join("/");
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    this.ws = new WebSocket(url);
    this.ws.on("open", () => this.handlers.onStatus?.("Binance Spot stream connected"));
    this.ws.on("ping", (payload) => this.ws?.pong(payload));
    this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
    this.ws.on("error", (error) => this.handlers.onStatus?.(`Binance stream error: ${error.message}`));
    this.ws.on("close", () => {
      if (this.stopped) return;
      this.handlers.onStatus?.("Binance stream disconnected; reconnecting");
      this.retry = setTimeout(() => this.start(), 3000);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }

  private async handleMessage(raw: string): Promise<void> {
    const wrapper = JSON.parse(raw) as { stream: string; data: Record<string, unknown> };
    const [name] = wrapper.stream.split("@");
    const symbol = name.toUpperCase();
    const data = wrapper.data;
    if (wrapper.stream.includes("@aggTrade")) {
      const price = Number(data.p);
      const qty = Number(data.q);
      const tick: TradeTick = { time: Number(data.T), price, quoteQty: price * qty, side: data.m ? "sell" : "buy" };
      await this.handlers.onTrade(symbol, tick);
    } else if (wrapper.stream.includes("@kline_")) {
      const k = data.k as Record<string, unknown>;
      if (!k.x) return;
      const interval = String(k.i) as "1h" | "15m";
      const candle: Candle = {
        openTime: Number(k.t), closeTime: Number(k.T), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v), closed: true
      };
      await this.handlers.onClosedCandle(symbol, interval, candle);
    } else if (wrapper.stream.includes("@depth")) {
      const toLevels = (rows: unknown) => (rows as [string, string][]).map(([price, quantity]) => ({ price: Number(price), quantity: Number(quantity) }));
      await this.handlers.onBook(symbol, { bids: toLevels(data.bids), asks: toLevels(data.asks), eventTime: Date.now() });
    }
  }
}
