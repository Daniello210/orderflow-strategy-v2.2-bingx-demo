import { config } from "./config.js";
import type { FvgZone, Signal } from "./types.js";

export class TelegramNotifier {
  get enabled(): boolean { return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID); }

  async send(text: string): Promise<void> {
    if (!this.enabled) {
      console.log("[Telegram disabled]", text);
      return;
    }
    const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
    if (!response.ok) throw new Error(`Telegram ${response.status}: ${await response.text()}`);
  }

  async zoneTouched(zone: FvgZone, price: number): Promise<void> {
    await this.send([
      `🟠 <b>${zone.symbol}: цена вошла в H1 FVG</b>`,
      `Сценарий по FVG: <b>${zone.direction === "long" ? "LONG" : "SHORT"}</b> <i>(без фильтра тренда)</i>`,
      `Зона: <code>${fmt(zone.low)}–${fmt(zone.high)}</code>`,
      `Цена: <code>${fmt(price)}</code>`,
      "Жду закрытие M15 и две фазы orderflow: поглощение → перехват инициативы."
    ].join("\n"));
  }

  async signal(signal: Signal): Promise<void> {
    const boundaryName = signal.direction === "long" ? "нижняя граница FVG" : "верхняя граница FVG";
    const dominanceName = signal.direction === "long" ? "перевес bids/покупателей" : "перевес asks/продавцов";
    await this.send([
      `🟢 <b>СИГНАЛ ${signal.symbol} ${signal.direction.toUpperCase()}</b> <i>(граница FVG + orderbook)</i>`,
      "",
      `Вход: <code>${fmt(signal.entry)}</code>`,
      `Стоп: <code>${fmt(signal.stop)}</code>`,
      `Цель перед кластером: <code>${fmt(signal.target.takeProfit)}</code>`,
      `Кластер: <code>${fmt(signal.target.price)}</code> | потенциал <b>${signal.target.rr.toFixed(2)}R</b>`,
      "",
      `<b>Подтверждение у границы</b>`,
      `Граница: ${boundaryName}`,
      `Buy: $${money(signal.flow.confirmation.buyNotional)} | Sell: $${money(signal.flow.confirmation.sellNotional)} | Δ $${signedMoney(signal.flow.confirmation.delta)}`,
      `Отклонение от границы: ${signedBps(signal.flow.confirmation.priceChangeBps)} bps`,
      `Результат: ${dominanceName} подтвердил сценарий.`,
      "",
      signal.commentaryRu,
      "",
      executionText(signal)
    ].join("\n"));
  }
}

function fmt(n: number): string { return n.toLocaleString("en-US", { maximumFractionDigits: 8 }); }
function money(n: number): string { return Math.round(n).toLocaleString("en-US"); }
function signedMoney(n: number): string { return `${n >= 0 ? "+" : "-"}${money(Math.abs(n))}`; }
function signedBps(n: number | undefined): string { return n === undefined ? "н/д" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}`; }

function executionText(signal: Signal): string {
  const execution = signal.execution;
  if (!execution || execution.status === "not_sent") return "ℹ️ Сделка не отправлена: BingX Demo execution выключен.";
  if (execution.status === "submitted") {
    const orderId = execution.orderId ? ` | orderId: <code>${execution.orderId}</code>` : "";
    return `🧪 <b>BingX Demo (VST): ордер отправлен</b>\nПара: <code>${execution.bingxSymbol}</code> | Количество: <code>${execution.quantity}</code>${orderId}\nTP/SL приложены к демо-ордеру.`;
  }
  return `🔴 <b>BingX Demo: ордер не открыт</b>\nПричина: ${escapeHtml(execution.message)}`;
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
