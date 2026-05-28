# Старт: Binance Orderflow -> BingX Demo Trading -> Telegram

## Что делает эта версия

```text
Binance public streams = источник orderflow и подтверждения
H1 FVG -> M15 реакция -> поглощение -> перехват инициативы
-> цель перед ближайшим сильным кластером
-> BingX Demo Trading VST открывает demo-сделку с TP/SL
-> Telegram присылает аналитику и статус demo-ордера
```

Orderflow не перенесен на BingX. Аналитика продолжает брать market trades и стакан из Binance. BingX используется только для виртуального исполнения подтвержденной сделки.

## Быстрый локальный запуск

### Windows PowerShell

Из корня проекта:

```powershell
npm.cmd install
npm.cmd run build
```

Сервер:

```powershell
cd server
Copy-Item .env.example .env
notepad .env
npm.cmd ci --registry=https://registry.npmjs.org/
npm.cmd test
npm.cmd run check
npm.cmd run dev
```

Проверка сервера:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

Фронтенд можно запустить в отдельном терминале из корня проекта:

```powershell
npm.cmd run dev
```

Обычно Vite откроется на:

```text
http://localhost:5173
```

### macOS/Linux/Git Bash

Из корня проекта:

```bash
npm install
npm run build
```

Сервер:

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

## Где находится `.env`

Секретный файл создается внутри папки `server`:

```text
server/.env
```

Он уже исключен из Git через `.gitignore`.

## Что вписать в `server/.env`

Сначала оставь исполнение выключенным и проверь, что сервер запускается:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
BINGX_DEMO_EXECUTION=false
```

Для Telegram:

```env
TELEGRAM_BOT_TOKEN=твой_telegram_token
TELEGRAM_CHAT_ID=твой_chat_id
BINGX_DEMO_EXECUTION=false
```

Когда `/health` и Telegram проверены, можно включить BingX Demo Trading:

```env
BINGX_DEMO_EXECUTION=true
BINGX_API_KEY=ключ_демо_api_bingx
BINGX_API_SECRET=секрет_демо_api_bingx
BINGX_DEMO_QUANTITIES_JSON={"ETHUSDT":0.01,"BTCUSDT":0.001}
```

`BINGX_DEMO_QUANTITIES_JSON` задает размер виртуальной позиции для каждой пары.

## Ожидаемый `/health`

Без BingX Demo:

```json
{
  "ok": true,
  "mode": "binance_orderflow",
  "execution": "disabled",
  "symbols": ["ETHUSDT", "BTCUSDT"],
  "telegram": false
}
```

С включенным demo execution и Telegram:

```json
{
  "ok": true,
  "mode": "binance_orderflow",
  "execution": "bingx_vst",
  "symbols": ["ETHUSDT", "BTCUSDT"],
  "telegram": true
}
```

## Важные команды

Фронтенд, из корня проекта:

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd run dev
```

Сервер, из `server`:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run dev
```

На macOS/Linux используй `npm` вместо `npm.cmd`.

## Если npm падает на Windows

Если PowerShell пишет, что выполнение `npm.ps1` запрещено, запускай команды через `npm.cmd`:

```powershell
npm.cmd run build
```

Если серверные зависимости не ставятся или npm пытается скачать пакеты из internal registry, используй:

```powershell
cd server
npm.cmd ci --registry=https://registry.npmjs.org/
```

## BingX Demo Trading

Исполнение отправляется только в demo-домен BingX VST. Код не содержит live-домена для отправки реальных ордеров.

При полностью подтвержденном сигнале сервер отправляет market demo-order с защитными условиями:

```text
LONG: BUY / LONG / MARKET + STOP_MARKET + TAKE_PROFIT_MARKET
SHORT: SELL / SHORT / MARKET + STOP_MARKET + TAKE_PROFIT_MARKET
```

Telegram покажет успешную отправку в BingX Demo или причину отказа API.

## Ограничение текущей версии

Цена входа и подтверждение считаются по Binance orderflow, а demo-ордер исполняется на BingX. Между котировками двух площадок может быть небольшое расхождение. Для paper/demo trading это приемлемо как первый forward-test.
