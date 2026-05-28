import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import type { Signal } from "./types.js";

export async function recordSignal(signal: Signal): Promise<void> {
  await mkdir(config.DATA_DIR, { recursive: true });
  await appendFile(join(config.DATA_DIR, "signals.jsonl"), `${JSON.stringify(signal)}\n`, "utf8");
}
