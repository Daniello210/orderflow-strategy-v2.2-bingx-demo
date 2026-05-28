# OrderFlow Strategy

Проект состоит из двух частей:

- фронтенд в корне репозитория: React + Vite визуализация order book/trades;
- сервер в `server`: стратегия Binance orderflow, Telegram-уведомления и опциональное исполнение подтвержденных сигналов в BingX Demo Trading VST.

Orderflow и подтверждения берутся из публичных потоков Binance. BingX используется только для demo-исполнения, если включен `BINGX_DEMO_EXECUTION=true`.

## Требования

- Node.js 22 LTS или новее.
- npm.
- Для Windows PowerShell лучше использовать `npm.cmd`, потому что обычный `npm` может быть заблокирован Execution Policy через `npm.ps1`.

## Первый запуск на Windows PowerShell

### 1. Фронтенд

```powershell
npm.cmd install
npm.cmd run dev
```

Открой адрес, который покажет Vite, обычно:

```text
http://localhost:5173
```

Проверки фронтенда:

```powershell
npm.cmd run lint
npm.cmd run build
```

### 2. Сервер стратегии

```powershell
cd server
Copy-Item .env.example .env
notepad .env
npm.cmd ci --registry=https://registry.npmjs.org/
npm.cmd test
npm.cmd run check
npm.cmd run dev
```

Проверка health endpoint:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

Ожидаемый ответ:

```json
{
  "ok": true,
  "mode": "binance_orderflow",
  "execution": "disabled",
  "symbols": ["ETHUSDT", "BTCUSDT"],
  "telegram": false
}
```

Если `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` заполнены, `telegram` будет `true`.

## Первый запуск на macOS/Linux/Git Bash

Фронтенд:

```bash
npm install
npm run dev
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

## Настройка `server/.env`

Минимально для запуска без demo-ордеров:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
BINGX_DEMO_EXECUTION=false
```

Для Telegram заполни:

```env
TELEGRAM_BOT_TOKEN=твой_telegram_bot_token
TELEGRAM_CHAT_ID=твой_chat_id
```

Для BingX Demo Trading после проверки `/health` и Telegram:

```env
BINGX_DEMO_EXECUTION=true
BINGX_API_KEY=ключ_demo_api_bingx
BINGX_API_SECRET=секрет_demo_api_bingx
BINGX_DEMO_QUANTITIES_JSON={"ETHUSDT":0.01,"BTCUSDT":0.001}
```

`SIGNALS_ONLY` должен оставаться `true`. Реальные live-ордера этим проектом не поддерживаются.

## Команды

Фронтенд, из корня:

```powershell
npm.cmd run dev
npm.cmd run lint
npm.cmd run build
npm.cmd run preview
```

Сервер, из `server`:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run dev
npm.cmd start
```

## Если установка сервера падает

Если `npm ci` пытается скачать пакеты из старого internal registry или зависает на `ETIMEDOUT`, запускай установку явно через публичный registry:

```powershell
cd server
npm.cmd ci --registry=https://registry.npmjs.org/
```

Если PowerShell пишет, что `npm.ps1` заблокирован политикой выполнения сценариев, используй `npm.cmd` вместо `npm`.

## Деплой

Для серверной стратегии смотри [SERVER_SETUP_RU.md](SERVER_SETUP_RU.md).
