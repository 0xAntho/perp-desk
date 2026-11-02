# Perp desk

Multi-exchange perp dashboard (Hyperliquid, Perpl, Arcus, Extended), ported from the Claude Design file *Perp Dashboard*.

```
[React + Vite dashboard] ← /api/* ← [Node/TS backend (Hono)] → exchange APIs
```

The backend holds keys and talks to the exchanges; the browser only renders what `/api` returns.

## Status

| Exchange | State |
|---|---|
| Hyperliquid | **Live** — positions, account, fills, funding, sub-accounts. Needs only `HL_ADDRESS`. |
| Perpl | Mock data (tagged "Mock" in the UI) |
| Arcus | Mock data |
| Extended | Mock data |

## Run it

Requires Node 22+.

```bash
npm install
cp .env.example .env      # set HL_ADDRESS to your wallet
npm run dev               # API on :8787, dashboard on http://localhost:5173
```

Production (one process, serves the built dashboard too):

```bash
npm run build
npm start                 # http://127.0.0.1:8787
```

`npm test` runs the backend tests (Hyperliquid adapter against fixture responses, sync/stale handling, PnL aggregation).

## API

| Endpoint | Returns |
|---|---|
| `GET /api/summary?exchange=all\|<id>` | balance, uPnL for the selection + per-exchange breakdown and sync status |
| `GET /api/positions?exchange=…` | `Position[]` |
| `GET /api/pnl?exchange=…&range=24h\|7D\|30D\|All` | cumulative realized series per exchange + gross / fees / funding / net |
| `GET /api/trades/top?exchange=…&range=…&n=5` | `{ best, worst }` |
| `GET /api/activity?exchange=…&weeks=26&tz=<IANA>` | trades per day |
| `POST /api/refresh` | re-sync every exchange now |

Sync: positions + account every 15 s, trades + funding every 60 s (incremental), full year backfilled at startup. If an exchange fails, the others keep working and it shows as stale/error.

## Adding an exchange

1. Create `server/adapters/<exchange>.ts` implementing `Adapter` from `server/types.ts` (`getAccount`, `getPositions`, `getTrades(since)`, `getFunding(since)`). Return `liq: null` when the exchange doesn't give a liquidation price — the UI shows "—".
2. Swap the `MockAdapter` line for it in `server/index.ts`.
3. Add a test in `server/` with fixture responses, like `hyperliquid.test.ts`.

Suggested order and endpoint notes are in the design's `Implementation Plan.md` (§3, §8): Extended (read-only key) → Arcus → Perpl (Ed25519 signing).

## Not done yet

- **Database.** History is kept in memory and re-fetched on restart (Hyperliquid's API returns the last ~10k fills). Add SQLite (Plan §4) when you want history beyond that, or hourly equity snapshots.
- **WebSockets.** Positions refresh by polling every 15 s; Plan §6.4 (SSE push) is optional.
- PnL is **gross** in the curve and top trades; fees and funding are shown separately with the net in the KPI card.

## Security

- Binds to `127.0.0.1` by default. If you set `HOST=0.0.0.0` or deploy it, set `DASH_USER` / `DASH_PASS` (basic auth on everything) or put it behind Cloudflare Access.
- Use read-only API keys only. `.env` is git-ignored.
