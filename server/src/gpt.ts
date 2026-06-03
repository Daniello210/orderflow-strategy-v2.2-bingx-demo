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

export async function composeCommentary(signal: Omit<Signal, "commentaryRu" | "quality">): Promise<{ quality: "strong" | "valid"; commentaryRu: string }> {
  const fallback = fallbackCommentary(signal);
  if (!config.OPENAI_API_KEY) return fallback;
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
    console.warn("GPT commentary fallback:", error instanceof Error ? error.message : error);
    return fallback;
  }
}

function fallbackCommentary(signal: Omit<Signal, "commentaryRu" | "quality">): { quality: "strong" | "valid"; commentaryRu: string } {
  const side = signal.direction === "long" ? "покупатель" : "продавец";
  const boundary = signal.direction === "long" ? "нижней" : "верхней";
  const quality = signal.target.rr >= 3.5 ? "strong" : "valid";
  return {
    quality,
    commentaryRu: `Цена дошла до ${boundary} границы FVG, а стакан показал перевес стороны сигнала: ${side} получил подтверждение по orderbook. Тейк выбран перед встречным кластером ликвидности.\nРиск: сигнал отменяется стопом за границей FVG; результат не гарантирован.`
  };
}
