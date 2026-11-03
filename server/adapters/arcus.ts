// Arcus adapter: public REST reads by wallet address — no key needed. Reads subaccount 0 (accountIndex default).
// History timestamps are epoch microseconds; the dashboard works in milliseconds.
import type { Account, Adapter, FundingPayment, Position, Side, Trade } from '../types.js';

const API = 'https://api.arcus.xyz/v1';
const PAGE = 1000;             // server max for fills and funding
const MAX_PAGES = 200;
const RETRIES = 5;

type Fetch = typeof fetch;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Fill { tradeId: string; marketDisplayName: string; side: 'BUY' | 'SELL'; size: string; fee: string; closedPnl: string; positionEffect: string; createdAt: number; liquidation?: { method: string } }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const symbolOf = (market: string) => market.replace(/-USD$/, '');
// OPEN_SHORT, ADD_LONG, CLOSE_SHORT…; a flip reports the side it closed (FLIP_SHORT_TO_LONG → Short)
const sideOf = (effect: string): Side => (/LONG|SHORT/.exec(effect)?.[0] === 'SHORT' ? 'Short' : 'Long');

export class ArcusAdapter implements Adapter {
  readonly id = 'arcus' as const;
  readonly name = 'Arcus';
  readonly mock = false;
  readonly label: string;
  private readonly address: string;
  /** Local copy of the fills, so open positions can show their open time. */
  private fills = new Map<string, Fill>();

  constructor(address: string, private readonly fetchImpl: Fetch = fetch) {
    const a = address.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('ARCUS_ADDRESS is not a valid 0x wallet address');
    this.address = a;
    this.label = a.slice(0, 6) + '…' + a.slice(-4);
  }

  /** GET with backoff on 429: Arcus sends Retry-After (whole seconds) when the per-IP weight bucket is empty. */
  private async get(path: string, query: Record<string, string | number> = {}): Promise<Json> {
    const qs = new URLSearchParams({ address: this.address, ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) });
    for (let i = 0; ; i++) {
      const r = await this.fetchImpl(`${API}${path}?${qs}`, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 429 && i < RETRIES) {
        await sleep((Number(r.headers.get('retry-after')) || 2 ** i) * 1000);
        continue;
      }
      if (r.status === 404) return null;   // "this account has no activity yet"
      if (!r.ok) throw new Error(`Arcus API ${r.status} on ${path}`);
      return r.json();
    }
  }

  /** Newest-first list bounded by from/to (µs, both inclusive): page by moving `to` to the oldest row seen. */
  private async history(path: string, key: string, since: number, time: (row: Json) => number): Promise<Json[]> {
    const from = Math.max(since * 1000, 1e14);
    let to = Date.now() * 1000;
    const out: Json[] = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const rows: Json[] = (await this.get(path, { from, to, limit: PAGE }))?.[key] ?? [];
      out.push(...rows);
      if (rows.length < PAGE) break;
      const oldest = time(rows[rows.length - 1]);
      if (oldest >= to) break;   // a whole page inside one microsecond: cannot page further
      to = oldest;               // inclusive bound: the overlap is removed by id downstream
    }
    return out;
  }

  async getAccount(): Promise<Account> {
    const a = await this.get('/account');
    return { exchange: this.id, equity: +(a?.equity ?? 0), freeCollateral: +(a?.freeCollateral ?? 0), ts: Date.now() };
  }

  async getPositions(): Promise<Position[]> {
    const res = await this.get('/positions');
    return Object.values<Json>(res?.positions ?? {}).filter(p => +p.size).map(p => {
      const size = Math.abs(+p.size), dir = +p.size > 0 ? 1 : -1, entry = +p.averageEntryPrice;
      const mark = +p.markPx || entry;
      const margin = +p.marginUsed;
      // unrealizedPnl from the API is a margin delta, not price PnL: compute it like the other exchanges
      const upnl = (mark - entry) * size * dir;
      return {
        exchange: this.id,
        sub: null,
        symbol: symbolOf(p.marketDisplayName),
        side: dir > 0 ? 'Long' : 'Short',
        size, entry, mark,
        liq: null,                     // not returned by the API
        leverage: +p.leverage || 1,
        margin, upnl,
        roe: margin ? upnl / margin : 0,
        funding: +(p.cumulativeFunding?.sinceOpen ?? 0),   // + = received
        openedAt: openedAt([...this.fills.values()], p.marketDisplayName, +p.size),
      };
    });
  }

  async getTrades(since: number): Promise<Trade[]> {
    const fills: Fill[] = await this.history('/fills', 'fills', since, f => f.createdAt);
    for (const f of fills) this.fills.set(f.tradeId, f);
    return fills.map(f => ({
      exchange: this.id,
      sub: null,
      id: f.tradeId,
      symbol: symbolOf(f.marketDisplayName),
      side: sideOf(f.positionEffect),
      // closedPnl is net of the fill's fee; on a liquidated leg `fee` is the penalty, not deducted
      realizedPnl: +f.closedPnl + (f.liquidation?.method === 'LIQUIDATION' ? 0 : +f.fee),
      fee: +f.fee,
      ts: Math.floor(f.createdAt / 1000),
    }));
  }

  async getFunding(since: number): Promise<FundingPayment[]> {
    const rows = await this.history('/funding', 'fundingPayments', since, x => x.time);
    return rows.map(x => ({
      exchange: this.id,
      id: `${x.marketId}:${x.time}`,   // one payment per market per funding tick
      symbol: symbolOf(x.marketDisplayName),
      usdc: +x.payment,                // + = received
      ts: Math.floor(x.time / 1000),
    }));
  }
}

/** Open time of the current position: walk fills back from the current size until it was flat. */
function openedAt(fills: Fill[], market: string, size: number): number | null {
  const mine = fills.filter(f => f.marketDisplayName === market).sort((a, b) => b.createdAt - a.createdAt);
  let pos = size, first: number | null = null;
  for (const f of mine) {
    first = f.createdAt;
    pos -= f.side === 'BUY' ? +f.size : -f.size;
    if (Math.abs(pos) < 1e-9) return Math.floor(f.createdAt / 1000);
  }
  return first == null ? null : Math.floor(first / 1000);   // history doesn't reach the open: oldest fill seen
}
