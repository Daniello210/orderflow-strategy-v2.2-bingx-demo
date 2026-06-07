# Server Epics

## Product Direction: Telegram Bot First

Final product: Telegram bot as the primary control plane for monitoring, pair management, paper statistics, signals, and safe demo execution.

Roadmap:

- MVP commands: `/status`, `/pairs`, `/addpair`, `/removepair`, `/setpairs`, `/search`, `/paper`, `/settings`.
- Strategy controls from Telegram: risk filters, min RR, orderbook imbalance, pair-specific quantities.
- Signal lifecycle in chat: pre-signal, final signal, paper TP/SL close, execution status.
- Daily/weekly reports: total R, winrate, active pairs, rejected setups, best/worst symbols.
- Confirmation workflows for risky actions: enabling demo execution, changing quantities, resetting paper stats.
- Web admin remains secondary/internal; Telegram is the product surface.

## Epic 1: BingX Execution Safety

Status: implemented in code, requires valid BingX VST credentials.

- Stop repeated order attempts after BingX auth error `100413`.
- Keep Telegram signals active while execution is blocked.
- Restart server after updating `BINGX_API_KEY` / `BINGX_API_SECRET`.

## Epic 2: Swing Signal Quality

Status: implemented, adaptive risk added.

- Reject FVG zones that are too narrow for swing.
- Reject signals with stops that are too close for swing.
- Reject targets that are too close for swing.
- Keep FVG pre-signal behavior unchanged.
- Use `4h` candles to define FVG zones.
- Use closed `1h` candles to confirm reaction after zone touch.
- Adapt stop buffer, target buffer, and minimum RR from orderbook imbalance strength, confirmation score, and possible false FVG boundary break.

## Epic 3: Log Hygiene

Status: implemented, paper outcome tracking added.

- Deduplicate repeated rejection logs per zone.
- Prevent duplicate signal creation from concurrent ticks.
- Stop repeated OpenAI calls after quota/billing `429` fallback.
- Track paper TP/SL outcomes for every confirmed signal in `DATA_DIR/paper-outcomes.jsonl`.
- Keep open paper positions in `DATA_DIR/paper-open.json` across PM2 restarts.
- Expose paper performance through `/admin/paper-outcomes` and the admin panel.

## Epic 4: Admin Pair Controls

Status: in progress.

- Track requested symbols separately from active Binance Spot symbols.
- Expose read-only pair diagnostics through `/admin/symbols`.
- Show skipped symbols when Binance Spot does not support them, for example `HYPEUSDT`.
- Add an admin UI/API to enable or disable watched symbols without editing `.env`.
- Store the admin watchlist in `DATA_DIR/admin-symbols.json` and keep `.env` as bootstrap defaults.
- Expose `/admin/available-symbols` for searchable Binance Spot USDT pairs.
- Store per-symbol settings: Telegram alerts, BingX execution, quantity, swing filters.
- Show per-symbol diagnostics: last price, active FVG zones, last rejection reason, last signal.
- Use `.env` as bootstrap defaults when no admin watchlist has been saved yet.

## Epic 5: Telegram Bot Control Plane

Status: MVP in progress.

- Authorize commands by `TELEGRAM_CHAT_ID`.
- Poll Telegram with `getUpdates`; no public webhook required.
- Manage watchlist from chat.
- Search available Binance Spot USDT pairs from chat.
- Show server status and paper performance from chat.
- Show current strategy settings from chat.
- Run historical swing sandbox from chat.
- Next: strategy parameter controls and confirmation buttons.

## Epic 6: Swing Sandbox

Status: MVP implemented.

- Run historical sandbox by symbols and lookback days through CLI: `npm run sandbox -- --symbols ETHUSDT,SOLUSDT --days 30`.
- Expose HTTP sandbox through `/admin/sandbox?symbols=ETHUSDT,SOLUSDT&days=30`.
- Expose Telegram sandbox through `/sandbox ETHUSDT,SOLUSDT 30`.
- Use historical H4 FVG + H1 reaction candles to evaluate swing TP/SL on past movement.
- Note: Binance Spot does not provide historical orderbook here, so sandbox tests the candle-structure part of the strategy, while live signals still require orderbook confirmation.
