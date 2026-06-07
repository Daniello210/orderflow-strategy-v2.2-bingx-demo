import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { config } from "./config.js";
import type { Signal } from "./types.js";

const Commentary = z.object({
  quality: z.enum(["strong", "valid"]),
  reason_ru: z.string(),
  risk_note_ru: z.string()
});

let openAiDisabledReason: string | undefined;

export async function composeCommentary(signal: Omit<Signal, "commentaryRu" | "quality">): Promise<{ quality: "strong" | "valid"; commentaryRu: string }> {
  const fallback = fallbackCommentary(signal);
  if (!config.OPENAI_API_KEY || openAiDisabledReason) return fallback;
  try {
    const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    const completion = await client.chat.completions.parse({
      model: config.OPENAI_MODEL,
      store: false,
      messages: [
        {
          role: "system",
          content: "Ты пишешь короткий комментарий торгового сигнала на русском. Правила уже проверены кодом. Не обещай прибыль и не меняй направление. Отрази, что цена дошла до границы FVG, а orderbook подтвердил перевес стороны сигнала."
        },
        { role: "user", content: JSON.stringify(signal) }
      ],
      response_format: zodResponseFormat(Commentary, "trade_commentary")
    });
    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) return fallback;
    return { quality: parsed.quality, commentaryRu: `${parsed.reason_ru}\nРиск: ${parsed.risk_note_ru}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isQuotaError(message)) openAiDisabledReason = message;
    console.warn("GPT commentary fallback:", message);
    return fallback;
  }
}

function fallbackCommentary(signal: Omit<Signal, "commentaryRu" | "quality">): { quality: "strong" | "valid"; commentaryRu: string } {
  const side = signal.direction === "long" ? "покупатель" : "продавец";
  const boundary = signal.direction === "long" ? "нижней" : "верхней";
  const quality = signal.target.rr >= 3.5 || signal.riskProfile.confirmationScore >= 75 ? "strong" : "valid";
  const fakeout = signal.riskProfile.falseBreakoutBps > 0
    ? ` Был учтён возможный ложный выход из FVG на ${signal.riskProfile.falseBreakoutBps.toFixed(2)} bps.`
    : "";
  return {
    quality,
    commentaryRu: `Цена дошла до ${boundary} границы FVG, а стакан показал перевес стороны сигнала: ${side} получил подтверждение по orderbook. Тейк выбран перед встречным кластером ликвидности с адаптивным буфером.${fakeout}\nРиск: сигнал отменяется стопом за границей FVG; результат не гарантирован.`
  };
}

function isQuotaError(message: string): boolean {
  return message.includes("429") && /quota|billing/i.test(message);
}
