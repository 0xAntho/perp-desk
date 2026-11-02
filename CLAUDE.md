# Perp desk — context for Claude Code

Personal multi-exchange perp trading dashboard (Hyperliquid, Perpl, Arcus, Extended). Read-only: it shows balances, positions, PnL and trade history. It never places orders.

## Origin
- Ported from a Claude Design file. The original design is in `docs/design/perp-dashboard.dc.html` (a design-tool format, not runnable as-is; use it as the visual reference).
- The design's build plan is in `docs/implementation-plan.md`. It contains the data model, API notes per exchange (§3), sync jobs (§4) and suggested order (§8). Follow it unless the user says otherwise.
- Visual language: the "Organic" design system, documented in `docs/design/organic-design-system.md`. Take every color, font, space and radius from its CSS variables (`src/styles/organic.css`); don't hard-code values.

## Architecture
- `server/` — Node + TypeScript, Hono. Holds keys and talks to exchanges. Keys must never reach the browser.
  - `types.ts` — normalized model (`Account`, `Position`, `Trade`, `FundingPayment`) and the `Adapter` interface every exchange implements.
  - `adapters/hyperliquid.ts` — real adapter (public info API, by wallet address, sub-accounts included).
  - `adapters/mock.ts` — deterministic fake data; Perpl, Arcus and Extended still use it (shown with a "Mock" tag in the UI).
  - `sync.ts` — polls adapters in memory: positions/account every 15 s, trades/funding every 60 s incrementally, full year backfill at start. A failing exchange goes "stale"/"error" without blocking the others.
  - `aggregate.ts` — all derived numbers (PnL series, flows, top trades, activity). The frontend only renders.
  - `app.ts` — routes under `/api` (summary, positions, pnl, trades/top, activity, refresh). Optional basic auth.
  - `index.ts` — wires adapters from `.env`, binds to 127.0.0.1 by default.
- `src/` — React + Vite + TanStack Query. One component per dashboard card in `src/components/`. `src/styles/dashboard.css` holds the dashboard layer and the dark theme.

## Commands
- `npm run dev` — API on :8787 + Vite on :5173 (proxies /api)
- `npm test` — backend tests (`server/*.test.ts`, Node test runner, fixture responses instead of network)
- `npm run build` — typechecks both client and server, then builds
- `npm start` — production: one process serving API + built dashboard

## Status and next steps
1. Hyperliquid adapter is tested against fixture responses only; the real API was not reachable when it was written. Verify against the live API first.
2. Replace mocks in this order: Extended (read-only API key) → Arcus (public account endpoint by address; no liq price, return `null`) → Perpl (Ed25519-signed requests). One file per adapter + a fixture test like `server/hyperliquid.test.ts`.
3. No database yet: history lives in memory and is re-fetched on restart. Add SQLite for history beyond ~10k Hyperliquid fills and hourly equity snapshots (plan §4).
4. Optional: push live marks/uPnL over SSE instead of 15 s polling (plan §6.4).

## Conventions and decisions
- Realized PnL is gross in the curve and top-trade lists; fees and funding shown separately, net in the KPI card. The user hasn't confirmed this; ask before changing.
- Use read-only exchange keys only. Keys live in `.env` (git-ignored); `.env.example` lists the variables.
- Keep the UI faithful to the design file. Only the design's "Rail" layout is kept (the user removed Stacked and Bento); it and light/dark must keep working, including at phone width.
- Code and comments in English. The user writes in French or English.
