import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SymbolDiagnostics {
	symbol: string;
	lastPrice?: number;
	zones?: Record<string, number>;
	activeZones?: number;
	bookUpdatedAt?: number;
}

interface AdminSymbolRow {
	symbol: string;
	active: boolean;
	skipped?: string;
	diagnostics?: SymbolDiagnostics;
}

interface AdminSymbolsResponse {
	requested: string[];
	active: string[];
	skipped: Array<{ symbol: string; reason: string }>;
	updating: boolean;
	symbols: AdminSymbolRow[];
}

interface AvailableSymbol {
	symbol: string;
	baseAsset: string;
	quoteAsset: string;
	active: boolean;
	requested: boolean;
}

interface PaperSymbolSummary {
	count: number;
	wins: number;
	losses: number;
	open: number;
	totalR: number;
}

interface PaperOutcomesResponse {
	summary: {
		count: number;
		wins: number;
		losses: number;
		open: number;
		winRate: number;
		totalR: number;
		avgR: number;
		bySymbol: Record<string, PaperSymbolSummary>;
	};
	recent: Array<{
		signalId: string;
		symbol: string;
		direction: "long" | "short";
		outcome: "tp" | "sl";
		openedAt: number;
		closedAt: number;
		pnlR: number;
		minutesToClose: number;
	}>;
	open: Array<{
		signalId: string;
		symbol: string;
		direction: "long" | "short";
		openedAt: number;
		entry: number;
		stop: number;
		takeProfit: number;
		rr: number;
	}>;
}

export function AdminPanel() {
	const [token, setToken] = useState(() => localStorage.getItem("orderflow-admin-token") ?? "");
	const [data, setData] = useState<AdminSymbolsResponse | null>(null);
	const [available, setAvailable] = useState<AvailableSymbol[]>([]);
	const [paper, setPaper] = useState<PaperOutcomesResponse | null>(null);
	const [search, setSearch] = useState("");
	const [loading, setLoading] = useState(false);
	const [paperLoading, setPaperLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [paperError, setPaperError] = useState<string | null>(null);

	const requested = useMemo(() => data?.requested ?? [], [data]);
	const symbolBreakdown = useMemo(() => {
		return Object.entries(paper?.summary.bySymbol ?? {})
			.sort(([, left], [, right]) => right.count - left.count)
			.slice(0, 8);
	}, [paper]);
	const normalizedSearch = search.trim().toUpperCase().replace("-", "");
	const canAddManual = normalizedSearch.endsWith("USDT") && !requested.includes(normalizedSearch);

	const authHeaders = useCallback((): Record<string, string> => {
		return token ? { "x-admin-token": token } : {};
	}, [token]);

	const loadSymbols = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const response = await fetch("/admin/symbols", { headers: authHeaders() });
			if (!response.ok) throw new Error(await response.text());
			setData(await response.json() as AdminSymbolsResponse);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Не удалось загрузить статус.");
		} finally {
			setLoading(false);
		}
	}, [authHeaders]);

	const loadPaperOutcomes = useCallback(async () => {
		setPaperLoading(true);
		setPaperError(null);
		try {
			const response = await fetch("/admin/paper-outcomes", { headers: authHeaders() });
			if (!response.ok) {
				const message = await response.text();
				throw new Error(message || `HTTP ${response.status}`);
			}
			setPaper(await response.json() as PaperOutcomesResponse);
		} catch (err) {
			setPaperError(err instanceof Error ? err.message : "Не удалось загрузить paper-trading статистику.");
		} finally {
			setPaperLoading(false);
		}
	}, [authHeaders]);

	useEffect(() => {
		localStorage.setItem("orderflow-admin-token", token);
	}, [token]);

	useEffect(() => {
		void loadSymbols();
		void loadPaperOutcomes();
		const timer = window.setInterval(() => {
			void loadSymbols();
			void loadPaperOutcomes();
		}, 15_000);
		return () => window.clearInterval(timer);
	}, [loadPaperOutcomes, loadSymbols]);

	useEffect(() => {
		const controller = new AbortController();
		const timer = window.setTimeout(async () => {
			try {
				const params = new URLSearchParams({ quote: "USDT", search });
				const response = await fetch(`/admin/available-symbols?${params}`, { signal: controller.signal });
				if (!response.ok) throw new Error(await response.text());
				const body = await response.json() as { symbols: AvailableSymbol[] };
				setAvailable(body.symbols.slice(0, 80));
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") return;
				setAvailable([]);
			}
		}, 250);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [search]);

	async function saveSymbols(next: string[]) {
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/admin/symbols", {
				method: "POST",
				headers: { "content-type": "application/json", ...authHeaders() },
				body: JSON.stringify({ symbols: next })
			});
			if (!response.ok) throw new Error(await response.text());
			setData(await response.json() as AdminSymbolsResponse);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Не удалось сохранить пары.");
		} finally {
			setSaving(false);
		}
	}

	const addSymbol = (symbol: string) => {
		const normalized = symbol.trim().toUpperCase().replace("-", "");
		if (!normalized || requested.includes(normalized)) return;
		void saveSymbols([...requested, normalized]);
		setSearch("");
	};

	const removeSymbol = (symbol: string) => {
		const next = requested.filter((item) => item !== symbol);
		void saveSymbols(next);
	};

	return (
		<section className="border rounded-md overflow-hidden bg-background">
			<div className="border-b px-4 py-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
				<div className="flex items-center gap-2 min-w-0">
					<Activity className="size-5 text-primary" />
					<h2 className="text-base font-semibold">Admin</h2>
					<span className="text-xs text-muted-foreground">
						{data ? `${data.active.length}/${data.requested.length} active` : "loading"}
					</span>
				</div>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input
						value={token}
						onChange={(event) => setToken(event.target.value)}
						placeholder="Admin token"
						type="password"
						className="h-8 w-full sm:w-44"
					/>
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							void loadSymbols();
							void loadPaperOutcomes();
						}}
						disabled={loading || paperLoading || saving}
					>
						<RefreshCw className={cn((loading || paperLoading || saving) && "animate-spin")} />
						Refresh
					</Button>
				</div>
			</div>

			<div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
				<div className="border-b lg:border-b-0 lg:border-r">
					<div className="px-4 py-3 flex items-center gap-2 border-b">
						<Search className="size-4 text-muted-foreground" />
						<Input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search USDT symbols"
							className="h-8"
						/>
						<Button size="sm" variant="outline" disabled={!canAddManual || saving} onClick={() => addSymbol(normalizedSearch)}>
							<Plus />
						</Button>
					</div>
					<div className="h-[260px] overflow-auto">
						{available.map((item) => (
							<button
								key={item.symbol}
								type="button"
								className="w-full px-4 py-2 border-b flex items-center justify-between text-left hover:bg-accent"
								onClick={() => addSymbol(item.symbol)}
								disabled={item.requested || saving}
							>
								<span className="font-mono text-sm">{item.symbol}</span>
								<span className="text-xs text-muted-foreground">{item.requested ? "requested" : item.baseAsset}</span>
							</button>
						))}
						{available.length === 0 && (
							<div className="px-4 py-8 text-sm text-muted-foreground">No Binance Spot symbols found.</div>
						)}
					</div>
				</div>

				<div>
					<div className="px-4 py-2 border-b text-xs uppercase text-muted-foreground">Watchlist</div>
					<div className="h-[315px] overflow-auto">
						{data?.symbols.map((item) => (
							<div key={item.symbol} className="px-4 py-3 border-b space-y-2">
								<div className="flex items-center justify-between gap-3">
									<div className="flex items-center gap-2 min-w-0">
										{item.active ? (
											<CheckCircle2 className="size-4 text-emerald-500" />
										) : (
											<AlertTriangle className="size-4 text-amber-500" />
										)}
										<span className="font-mono text-sm">{item.symbol}</span>
									</div>
									<Button size="icon" variant="ghost" onClick={() => removeSymbol(item.symbol)} disabled={saving || requested.length <= 1}>
										<Trash2 />
									</Button>
								</div>
								<div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
									<span>${fmt(item.diagnostics?.lastPrice)}</span>
									<span>{item.diagnostics?.activeZones ?? 0} FVG</span>
									<span>{age(item.diagnostics?.bookUpdatedAt)}</span>
								</div>
								{item.skipped && <div className="text-xs text-amber-600 break-words">{item.skipped}</div>}
							</div>
						))}
					</div>
				</div>
			</div>

			<div className="border-t">
				<div className="px-4 py-2 border-b flex items-center justify-between gap-3">
					<div className="text-xs uppercase text-muted-foreground">Paper trading</div>
					<span className="text-xs text-muted-foreground">
						{paperLoading ? "loading" : paper ? `${paper.recent.length} recent` : "waiting for endpoint"}
					</span>
				</div>

				{paper ? (
					<div className="px-4 py-3 space-y-3">
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							<Stat label="total R" value={formatR(paper.summary.totalR)} tone={paper.summary.totalR >= 0 ? "positive" : "negative"} />
							<Stat label="winrate" value={formatPercent(paper.summary.winRate)} />
							<Stat label="count" value={String(paper.summary.count)} />
							<Stat label="open" value={String(paper.summary.open)} />
						</div>

						<div className="grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
							<div className="min-w-0">
								<div className="mb-2 text-xs uppercase text-muted-foreground">By symbol</div>
								<div className="max-h-36 overflow-auto border rounded-md">
									{symbolBreakdown.map(([symbol, item]) => (
										<div key={symbol} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 border-b px-3 py-2 text-xs last:border-b-0">
											<span className="font-mono text-foreground">{symbol}</span>
											<span className="text-muted-foreground">{item.count} trades</span>
											<span className="text-muted-foreground">{item.wins}/{item.losses}/{item.open}</span>
											<span className={cn("font-mono", item.totalR >= 0 ? "text-emerald-600" : "text-red-600")}>
												{formatR(item.totalR)}
											</span>
										</div>
									))}
									{symbolBreakdown.length === 0 && (
										<div className="px-3 py-6 text-sm text-muted-foreground">No symbol outcomes yet.</div>
									)}
								</div>
							</div>

							<div className="min-w-0">
								<div className="mb-2 text-xs uppercase text-muted-foreground">Recent outcomes</div>
								<div className="max-h-36 overflow-auto border rounded-md">
									{paper.recent.slice(0, 8).map((item) => (
										<div key={item.signalId} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 border-b px-3 py-2 text-xs last:border-b-0">
											<div className="min-w-0">
												<div className="font-mono text-foreground truncate">{item.symbol}</div>
												<div className="text-muted-foreground">{formatAge(item.closedAt)}</div>
											</div>
											<span className="uppercase text-muted-foreground">{item.direction}</span>
											<span className={cn("font-medium uppercase", item.outcome === "tp" ? "text-emerald-600" : "text-red-600")}>
												{item.outcome}
											</span>
											<span className={cn("font-mono", item.pnlR >= 0 ? "text-emerald-600" : "text-red-600")}>
												{formatR(item.pnlR)}
											</span>
										</div>
									))}
									{paper.recent.length === 0 && (
										<div className="px-3 py-6 text-sm text-muted-foreground">No closed paper trades yet.</div>
									)}
								</div>
							</div>
						</div>
					</div>
				) : (
					<div className="px-4 py-6 text-sm text-muted-foreground break-words">
						{paperError ? `Paper outcomes unavailable: ${paperError}` : "Paper outcomes will appear here after /admin/paper-outcomes is available."}
					</div>
				)}
			</div>

			{error && <div className="border-t px-4 py-2 text-sm text-destructive break-words">{error}</div>}
		</section>
	);
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
	return (
		<div className="rounded-md border px-3 py-2">
			<div className="text-[11px] uppercase text-muted-foreground">{label}</div>
			<div className={cn("mt-1 font-mono text-sm font-semibold", tone === "positive" && "text-emerald-600", tone === "negative" && "text-red-600")}>
				{value}
			</div>
		</div>
	);
}

function fmt(value: number | undefined): string {
	if (!value) return "n/a";
	return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function formatR(value: number): string {
	const prefix = value > 0 ? "+" : "";
	return `${prefix}${value.toFixed(2)}R`;
}

function formatPercent(value: number): string {
	const normalized = value > 1 ? value : value * 100;
	return `${normalized.toFixed(1)}%`;
}

function age(value: number | undefined): string {
	if (!value) return "no book";
	const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return `${minutes}m`;
}

function formatAge(value: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	return `${days}d ago`;
}
