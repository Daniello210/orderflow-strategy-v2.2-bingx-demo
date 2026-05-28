# Запуск и деплой серверной стратегии

Начинай с [START_HERE_RU.md](START_HERE_RU.md), если запускаешь проект впервые.

Сервер работает так:

```text
Binance public streams -> H1 FVG -> M15 reaction -> orderflow confirmation
-> target before liquidity cluster -> Telegram
-> optional BingX Demo Trading VST execution
```

Реальные live-ордера отключены. `SIGNALS_ONLY=true` должен оставаться включенным.

## Локальный запуск на Windows PowerShell

```powershell
cd server
Copy-Item .env.example .env
notepad .env
npm.cmd ci --registry=https://registry.npmjs.org/
npm.cmd test
npm.cmd run check
npm.cmd run dev
```

Проверка:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

## Локальный запуск на macOS/Linux/Git Bash

```bash
cd server
cp .env.example .env
nano .env
npm ci --registry=https://registry.npmjs.org/
npm test
npm run check
npm run dev
```

Проверка:

```bash
curl http://localhost:8787/health
```

## Переменные окружения

Минимальный запуск:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
BINGX_DEMO_EXECUTION=false
```

Telegram:

```env
TELEGRAM_BOT_TOKEN=твой_telegram_bot_token
TELEGRAM_CHAT_ID=твой_chat_id
```

BingX Demo Trading VST:

```env
BINGX_DEMO_EXECUTION=true
BINGX_API_KEY=ключ_demo_api_bingx
BINGX_API_SECRET=секрет_demo_api_bingx
BINGX_DEMO_QUANTITIES_JSON={"ETHUSDT":0.01,"BTCUSDT":0.001}
```

GPT-комментарий необязателен. Если `OPENAI_API_KEY` пустой, сервер использует обычный fallback-текст.

## Проверки перед деплоем

Из папки `server`:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
```

На macOS/Linux можно заменить `npm.cmd` на `npm`.

## Docker/VPS

Из корня проекта:

```bash
docker compose up -d --build strategy
docker compose logs -f strategy
```

Health endpoint:

```bash
curl http://localhost:8787/health
```

## Render

1. Залей проект в GitHub.
2. В Render создай сервис через `New -> Blueprint` и выбери репозиторий.
3. В Environment добавь нужные переменные:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
BINGX_DEMO_EXECUTION
BINGX_API_KEY
BINGX_API_SECRET
BINGX_DEMO_QUANTITIES_JSON
OPENAI_API_KEY
```

4. После деплоя проверь `/health`.

Для постоянной работы стратегии нужен процесс, который не засыпает. Бесплатные сервисы, которые останавливают приложение при простое, будут пропускать market data и сигналы.
