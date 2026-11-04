# Perp desk

Multi-exchange perp dashboard (Hyperliquid, Perpl, Arcus, Extended), ported from the Claude Design file *Perp Dashboard*. Read-only: it shows balances, positions, PnL and trade history, and never places orders.

```
[React + Vite dashboard] ← /api/* ← [Node/TS backend (Hono)] → exchange APIs
                                            ↕
                                   SQLite (data/perp-desk.db)
```

The backend holds keys and talks to the exchanges; the browser only renders what `/api` returns.

## Status

All four exchanges are live. An exchange whose keys or address are missing from `.env` runs on mock data (tagged "Mock" in the UI).

| Exchange | Needs | Notes |
|---|---|---|
| Hyperliquid | `HL_ADDRESS` | Public, by wallet address; sub-accounts and HIP-3 dexes included. The API only serves the last ~10k fills: import older ones from the CSV export (below). |
| Perpl | `PERPL_API_KEY`, `PERPL_API_KEY_SECRET` | Read-scope key, Ed25519-signed requests. The first download takes a few minutes. |
| Arcus | `ARCUS_ADDRESS` (defaults to `HL_ADDRESS`) | Public, by wallet address, subaccount 0. |
| Extended | `EXTENDED_API_KEY` | Read-only key; several comma-separated keys are merged into one "Extended". |

## Run it

Requires Node 24+ (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env      # set HL_ADDRESS, and the keys of the exchanges you use
npm run dev               # API on :8787, dashboard on http://localhost:5173
```

### Older Hyperliquid history

Hyperliquid's API stops at your ~10k most recent fills. For older ones, export your trade history from the Hyperliquid UI (Trade History → Export) into `data/` (git-ignored), then, with the server having run once:

```bash
npm run import:hl data/hl_history.csv    # then restart the server
```

Only fills older than what the API serves are added, and importing the same file twice changes nothing.

Production (one process, serves the built dashboard too):

```bash
npm run build
npm start                 # http://127.0.0.1:8787
```

`npm test` runs the backend tests: each adapter against fixture responses, sync/stale handling, the database and the CSV import, PnL aggregation.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/summary?exchange=all\|<id>` | balance, uPnL for the selection + per-exchange breakdown and sync status |
| `GET /api/positions?exchange=…` | `Position[]` |
| `GET /api/pnl?exchange=…&range=24h\|7D\|30D\|All` | cumulative realized series per exchange + gross / fees / funding / net |
| `GET /api/trades/top?exchange=…&range=…&n=5` | `{ best, worst }` |
| `GET /api/activity?exchange=…&weeks=26&tz=<IANA>` | trades per day |
| `POST /api/refresh` | re-sync every exchange now |

Sync: positions + account every 15 s, trades + funding every 60 s. History is stored in SQLite (`data/perp-desk.db`): on start it is loaded from there, and each account only fetches what came after its newest stored row. An account with nothing stored (first run, or a key or sub-account added later) gets everything the exchange still serves. An equity snapshot per exchange is stored every hour. If an exchange fails, the others keep working and it shows as stale/error.

## Adding an exchange

1. Create `server/adapters/<exchange>.ts` implementing `Adapter` from `server/types.ts` (`getAccount`, `getPositions`, `getTrades(since)`, `getFunding(since)`). `since(account)` gives where each account's history resumes; tag every trade and funding row with that stable `account` id. Return `liq: null` when the exchange doesn't give a liquidation price — the UI shows "—".
2. Wire it in `server/index.ts`, with the `MockAdapter` as fallback when its keys are missing.
3. Add a test in `server/` with fixture responses, like `hyperliquid.test.ts`.

Endpoint notes per exchange are in `docs/implementation-plan.md` (§3).

## Not done yet

- **Equity curve.** Hourly equity snapshots are stored but not shown yet.
- **WebSockets.** Positions refresh by polling every 15 s; Plan §6.4 (SSE push) is optional.
- PnL is **gross** in the curve and top trades; fees and funding are shown separately with the net in the KPI card.

## Security

- Binds to `127.0.0.1` by default. If you set `HOST=0.0.0.0` or deploy it, set `DASH_USER` / `DASH_PASS` (basic auth on everything) or put it behind Cloudflare Access.
- Use read-only API keys only. `.env` is git-ignored.
