# Perp desk — implementation plan

## 1. Architecture

```
[Browser: React dashboard]  ←  /api/*  ←  [Backend: Node/TS]  →  Hyperliquid / Perpl / Arcus / Extended
                                               │
                                           [SQLite / Postgres]
```

- **Backend** (Node + TypeScript, Fastify or Hono). Stores your API keys and handles request signing. Keys must never reach the browser.
- **Database**: keeps trade history and PnL snapshots, so the curve and heatmap don't depend on how far back each exchange's API goes.
- **Frontend**: React + Vite. Port the current design as-is: the `data()` method becomes calls to your backend.

## 2. Normalized data model (one shape for all 4 exchanges)

```ts
type Exchange = 'hyperliquid' | 'perpl' | 'arcus' | 'extended';

interface Account  { exchange: Exchange; equity: number; freeCollateral: number; ts: number }
interface Position { exchange: Exchange; symbol: string; side: 'Long'|'Short'; size: number;
                     entry: number; mark: number; liq: number|null; leverage: number;
                     margin: number; upnl: number; roe: number; funding: number; openedAt: number|null }
interface Trade    { exchange: Exchange; id: string; symbol: string; side: 'Long'|'Short';
                     realizedPnl: number; fee: number; ts: number }   // one row per closing fill / closed position
interface PnlPoint { exchange: Exchange; ts: number; cumRealized: number; equity: number }
```

Each exchange gets one adapter that implements the same interface:

```ts
interface Adapter {
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getTrades(since: number): Promise<Trade[]>;   // paginated, incremental
}
```

Derived on the backend: ROE = upnl / margin; when an exchange doesn't return a liq. price, store `null` and show "—".

## 3. Exchange adapters

Check each exchange's current docs before you build. The notes below are a starting point.

**Hyperliquid** (easiest: public, read by wallet address, no key)
- `POST https://api.hyperliquid.xyz/info`
  - `{type:"clearinghouseState", user}` → equity, positions (entry, liq px, leverage, margin, uPnL, cumulative funding)
  - `{type:"userFillsByTime", user, startTime}` → fills with `closedPnl` (paginate by time)
  - `{type:"userFunding", user, startTime}` → funding payments
- Mark prices: `{type:"metaAndAssetCtxs"}`.

**Arcus** (dYdX Labs, Robinhood Chain)
- REST base `https://api.arcus.xyz`, WebSocket `wss://api.arcus.xyz/v1/ws`.
- `GET /v1/account` returns equity, free collateral and open positions by wallet address, without auth. Liq. price is not returned (compute it or show "—").
- Docs also list a portfolio-history endpoint (equity/PnL time series). Use it to backfill the curve.
- Private calls use an Ed25519 API key registered to your ETH address.

**Extended**
- Create a **read-only API key** in the Extended UI.
- `GET /api/v1/user/positions` → open positions
- `GET /api/v1/user/positions/history` → closed positions with `realisedPnl`, `openPrice`, `exitPrice`, `createdTime`, `closedTime`. Use these as your "trades" for the top 5 lists.
- Balance endpoint for equity.

**Perpl** (Monad)
- REST `https://app.perpl.xyz/api` (history, profile) + WebSocket (real-time).
- Public context: `GET /v1/pub/context` (markets, tokens).
- Account and history calls need an Ed25519 API key, enrolled once with a wallet signature. Every request is then signed. Use their JS/TS examples in `PerplFoundation/api-docs`.

## 4. Sync jobs (backend)

| Job | Every | Does |
|---|---|---|
| Positions + account | 10–15 s | Fetch from all 4 in parallel (`Promise.allSettled`), cache in memory |
| Trades | 1–5 min | Fetch since last stored ts per exchange, upsert by `(exchange, id)` |
| Equity snapshot | 1 h | Write a `PnlPoint` per exchange (powers the curve) |
| Backfill | once | Pull full history on first run (paginate, respect rate limits) |

If one exchange fails, still return the other three, and mark the failed one stale in the UI.

## 5. Backend API (what the dashboard calls)

```
GET /api/summary?exchange=all|<id>            → balance, upnl, per-exchange breakdown
GET /api/positions?exchange=…                 → Position[]
GET /api/pnl?exchange=…&range=24h|7d|30d|all  → series per exchange (already downsampled)
GET /api/trades/top?exchange=…&range=…&n=5    → { best: Trade[], worst: Trade[] }
GET /api/activity?exchange=…&weeks=24         → [{ date, count }]
```

Aggregation (sum curves, top-N, daily counts) is done in SQL. The frontend only renders.

## 6. Frontend port

1. `npm create vite@latest perp-desk -- --template react-ts`
2. Copy the Organic `styles.css` and convert each dashboard card into a component: `Kpis`, `PnlChart`, `ActivityHeatmap`, `TopTrades`, `PositionsTable`.
3. Replace the mock `data()` with **TanStack Query** hooks (`refetchInterval: 15_000` for positions, 60 s for the rest).
4. Optional: open the exchange WebSockets on the backend and push live mark prices / uPnL to the browser via SSE.

## 7. Security

- Read-only keys only, wherever the exchange supports them. Never give the backend trade/withdraw permissions.
- Keep keys in `.env` / a secrets manager. Add `.env` to `.gitignore`.
- Run the backend locally or behind auth (e.g. basic auth or Cloudflare Access). Your positions are private.

## 8. Suggested order

1. Backend skeleton + Hyperliquid adapter (no auth, fastest win) → `/api/positions` working
2. Frontend port wired to that endpoint
3. Extended adapter (read-only key)
4. Arcus adapter
5. Perpl adapter (Ed25519 signing)
6. DB + trade sync + backfill → curve, heatmap, top trades on real data
7. Polish: stale-exchange indicators, error states, deploy

## Open questions

- Do you have one wallet/account per exchange, or several sub-accounts?
- Local-only (runs on your machine), or hosted so you can check it from your phone?
- Should fees and funding be counted in realized PnL (net) or not (gross)?
