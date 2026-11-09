# Perp desk — context for Claude Code

Personal multi-exchange perp trading dashboard (Hyperliquid, Perpl, Arcus, Extended), all on live data. Read-only: it shows balances, positions, PnL and trade history. It never places orders.

## Origin
- Ported from a Claude Design file. The original design is in `docs/design/perp-dashboard.dc.html` (a design-tool format, not runnable as-is; use it as the visual reference).
- The design's build plan is in `docs/implementation-plan.md`. It contains the data model, API notes per exchange (§3), sync jobs (§4) and suggested order (§8). Follow it unless the user says otherwise.
- Visual language: the "Organic" design system, documented in `docs/design/organic-design-system.md`. Take every color, font, space and radius from its CSS variables (`src/styles/organic.css`); don't hard-code values.

## Architecture
- `server/` — Node + TypeScript, Hono. Holds keys and talks to exchanges. Keys must never reach the browser.
  - `types.ts` — normalized model (`Account`, `Position`, `Trade`, `FundingPayment`) and the `Adapter` interface every exchange implements.
  - `adapters/hyperliquid.ts` — real adapter (public info API, by wallet address, sub-accounts included). One trade per fill (`aggregateByTime: false`, like the CSV export); fills of one transaction share a `group` and are merged in top trades and activity.
  - `adapters/extended.ts` — real adapter (read-only `X-Api-Key`). Several comma-separated keys are merged into one "Extended" (same market+side → one row); a key reaching an already-seen account is ignored. Trades = closed positions, gross `tradePnl` with open+close fees apart. 19-digit ids/cursors are parsed as strings.
  - `adapters/perpl.ts` — real adapter (Ed25519-signed requests, read-scope key). Scaled integers via `/v1/pub/context`. Trades = exit events of position history (`dpnl` gross, `fee`); funding = `fnd` on those exits. REST limits unpublished: backs off on 429, paces pages; the first backfill takes ~2 min.
  - `adapters/arcus.ts` — real adapter (public REST by wallet address, subaccount 0; `ARCUS_ADDRESS`, defaults to `HL_ADDRESS`). Times are epoch µs. `closedPnl` is net of fee (added back for gross); no liq price (`null`). Pages by moving `to` to the oldest row.
  - `adapters/variational.ts` — no API yet (planned for 2026-11): history only, from `variational-csv.ts` + `import-variational.ts` (the trade CSV export). The export has fills only, so realized PnL is rebuilt by average cost per underlying; fee 0, no funding, balance $0, no positions. Replace with a real adapter when the API ships.
  - `adapters/mock.ts` — deterministic fake data, used for any exchange whose keys/address are missing from `.env` (shown with a "Mock" tag in the UI).
  - `store.ts` — SQLite (`node:sqlite`, file `data/perp-desk.db`, git-ignored): trades, funding, open times of current positions, hourly equity snapshots (stored, not shown yet), delta-neutral pairs (`pairs` table, added without a `SCHEMA` bump). Mock adapters are never stored.
  - `sync.ts` — positions/account every 15 s, trades/funding every 60 s. History is loaded from the store at start and resumes **per account** (`Trade.account`/`FundingPayment.account`: HL wallet, Extended account id, Perpl key hash, Arcus address) from its newest stored row; an account with nothing stored (first run, key or sub-account added later) gets everything the exchange still serves. Open times are kept across restarts (adapters only see fills since start). A failing exchange goes "stale"/"error" without blocking the others.
  - `hl-csv.ts` + `import-hl.ts` — one-time import of Hyperliquid's trade-history CSV export for fills older than the ~10k the API serves. Only rows older than the oldest API-fetched fill are added; ids are stable, so re-running changes nothing.
  - `aggregate.ts` — all derived numbers (PnL series, flows, top trades, activity). The frontend only renders.
  - `app.ts` — routes under `/api` (summary, positions, pnl, trades/top, activity, refresh, pairs). Optional basic auth.
  - `index.ts` — wires adapters from `.env`, binds to 127.0.0.1 by default.
- `src/` — React + Vite + TanStack Query. One component per dashboard card in `src/components/`. `src/styles/dashboard.css` holds the dashboard layer and the dark theme.

## Commands
- `npm run dev` — API on :8787 + Vite on :5173 (proxies /api)
- `npm test` — backend tests (`server/*.test.ts`, Node test runner, fixture responses instead of network)
- `npm run build` — typechecks both client and server, then builds
- `npm start` — production: one process serving API + built dashboard
- `npm run import:hl data/hl_history.csv` — import the Hyperliquid CSV once (server must have run once; restart it after). Keep exports in `data/`: the repo is public.
- `npm run import:variational data/export-trades.csv` — load Variational's trade CSV (re-running a newer export replaces the rows; restart the server after).
- Node 24+ (`node:sqlite` needs 22.5+).

## Status and next steps
1. All four exchanges run on live data (checked 2026-11-03). Perpl totals match its own all-time stats; Arcus matches its documented invariant (Σ closedPnl + Σ funding = netQuoteBalance − net deposits). Hyperliquid is ~$155 below its own `portfolio` perpAllTime, accepted by the user (2026-11-09): ~$7 predates any reachable fill (before 2025-04-08), ~$150 comes from intervals with trades on the USDH-collateral HIP-3 dexes (vntl, flx, km), mechanism unknown; every other interval reconciles to the cent. Each adapter has a fixture test (`server/<exchange>.test.ts`).
2. SQLite history done (2026-11-04); older Hyperliquid fills come from the CSV import. Changing the schema: bump `SCHEMA` in `store.ts` (the database is rebuilt and re-downloaded; re-run the CSV imports, Hyperliquid and Variational).
3. Optional: push live marks/uPnL over SSE instead of 15 s polling (plan §6.4).

## Conventions and decisions
- Best/worst trades are ranked and shown net of the order's own fees (user's call, 2026-11-09). The PnL curve is still gross realized; fees and funding are shown separately, net in the KPI card. Ask before changing the curve.
- Delta-neutral pairs (2026-11-09): the user drags a position onto the opposite leg (or taps the link button on both, for phones) to group one long + one short, on any exchanges/symbols. The DN row shows Σ margin as collateral, Σ uPnL, ROE on that, Σ funding since open (accumulated, not live rates: the user's call); it expands to the legs. Pairs live in SQLite and are dropped when a fresh positions read shows a leg closed. Purely a display grouping, nothing is sent to an exchange.
- Use read-only exchange keys only. Keys live in `.env` (git-ignored); `.env.example` lists the variables.
- Keep the UI faithful to the design file. Only the design's "Rail" layout is kept (the user removed Stacked and Bento); it and light/dark must keep working, including at phone width.
- Code and comments in English. The user writes in French or English.
