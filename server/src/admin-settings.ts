import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

const SYMBOLS_FILE = "admin-symbols.json";

interface StoredSymbols {
  symbols: string[];
}

export async function loadAdminSymbols(): Promise<string[]> {
  try {
    const raw = await readFile(symbolsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredSymbols>;
    return normalizeSymbols(parsed.symbols ?? config.symbols);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return config.symbols;
    throw error;
  }
}

export async function saveAdminSymbols(symbols: string[]): Promise<string[]> {
  const normalized = normalizeSymbols(symbols);
  if (normalized.length === 0) throw new Error("Нужна хотя бы одна пара для мониторинга.");
  await mkdir(config.DATA_DIR, { recursive: true });
  await writeFile(symbolsPath(), JSON.stringify({ symbols: normalized }, null, 2), "utf8");
  return normalized;
}

export function normalizeSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase().replace("-", "")).filter(Boolean))];
}

function symbolsPath(): string {
  return join(config.DATA_DIR, SYMBOLS_FILE);
}
