// Extended adapter: REST API with a read-only API key (X-Api-Key header, no signing for reads).
// One API key = one Extended sub-account; several keys are merged into one exchange in the UI.
import type { Account, Adapter, FundingPayment, Position, Side, Trade } from '../types.js';

const API = 'https://api.starknet.extended.exchange/api/v1';
const PAGE = 1000;
const MAX_PAGES = 50;

type Fetch = typeof fetch;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const symbolOf = (market: string) => market.replace(/-USD$/, '');
const sideOf = (s: string): Side => (s.toUpperCase() === 'SHORT' ? 'Short' : 'Long');

export class ExtendedAdapter implements Adapter {
  readonly id = 'extended' as const;
  readonly name = 'Extended';
  readonly mock = false;
  private readonly keys: string[];
  private unique: string[] | null = null;
  private lookup: Promise<string[]> | null = null;

  constructor(apiKeys: string[], private readonly fetchImpl: Fetch = fetch) {
    this.keys = apiKeys.map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) throw new Error('EXTENDED_API_KEY is empty');
  }

  get label() {
    const n = (this.unique ?? this.keys).length;
    return n > 1 ? `${n} accounts` : 'read-only key';
  }

  /** Keys that reach distinct accounts: two keys of the same account would count it twice. */
  private accounts(): Promise<string[]> {
    this.lookup ??= this.lookupAccounts().catch(e => { this.lookup = null; throw e; });   // retried on failure
    return this.lookup;
  }

  private async lookupAccounts(): Promise<string[]> {
    const ids = await Promise.all(this.keys.map(async k => (await this.get(k, '/user/account/info'))?.data?.accountId));
    const seen = new Set<string>();
    this.unique = this.keys.filter((_, i) => {
      const id = String(ids[i]);
      if (seen.has(id)) { console.warn(`[extended] key #${i + 1} reaches account ${id} again: ignored`); return false; }
      seen.add(id);
      return true;
    });
    return this.unique;
  }

  /** Runs `fn` for every account and concatenates the results. */
  private async each<T>(fn: (key: string, i: number) => Promise<T[]>): Promise<T[]> {
    return (await Promise.all((await this.accounts()).map(fn))).flat();
  }

  /** GET an endpoint and unwrap the {status, data, pagination} envelope. 404 → null. */
  private async get(key: string, path: string, query: Record<string, string | number> = {}): Promise<{ data: Json; cursor: string | null } | null> {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const r = await this.fetchImpl(`${API}${path}${qs ? '?' + qs : ''}`, {
      headers: { 'X-Api-Key': key, 'User-Agent': 'perp-desk/0.1' },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Extended API ${r.status} on ${path}`);
    // ids and cursors are 19-digit integers: quote them before parsing so they keep every digit
    const body = JSON.parse((await r.text()).replace(/(:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
    if (body?.status !== 'OK') throw new Error(`Extended API error on ${path}: ${body?.error?.message ?? 'unknown'}`);
    const cursor = body.pagination?.cursor;
    return { data: body.data, cursor: cursor != null ? String(cursor) : null };
  }

  /** Cursor-paginated list, newest first. Stops early once `done(page)` says the rest is older than needed. */
  private async paged(key: string, path: string, query: Record<string, string | number>, done: (page: Json[]) => boolean = () => false): Promise<Json[]> {
    let out: Json[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await this.get(key, path, { ...query, limit: PAGE, ...(cursor && { cursor }) });
      const page: Json[] = res?.data ?? [];
      out = out.concat(page);
      if (page.length < PAGE || !res?.cursor || res.cursor === cursor || done(page)) break;
      cursor = res.cursor;
    }
    return out;
  }

  async getAccount(): Promise<Account> {
    const balances = await this.each(async k => [(await this.get(k, '/user/balance'))?.data]);   // 404 when the balance is 0
    return {
      exchange: this.id,
      equity: balances.reduce((s, b) => s + +(b?.equity ?? 0), 0),
      freeCollateral: balances.reduce((s, b) => s + +(b?.availableForTrade ?? 0), 0),
      ts: Date.now(),
    };
  }

  async getPositions(): Promise<Position[]> {
    const list: Json[] = await this.each(async k => (await this.get(k, '/user/positions'))?.data ?? []);
    return merge(list.map((p): Position => {
      const margin = +p.margin, upnl = +p.unrealisedPnl;
      return {
        exchange: this.id,
        sub: null,
        symbol: symbolOf(p.market),
        side: sideOf(p.side),
        size: Math.abs(+p.size),
        entry: +p.openPrice,
        mark: +p.markPrice,
        liq: +p.liquidationPrice || null,
        leverage: +p.leverage || 1,
        margin, upnl,
        roe: margin ? upnl / margin : 0,
        funding: +(p.paidFundingFee ?? 0),      // despite the name: + = received (= sum of fundingFee)
        openedAt: p.createdAt ?? p.createdTime ?? null,
      };
    }));
  }

  /** Closed positions as trades: Extended reports realized PnL per position, not per fill. */
  async getTrades(since: number): Promise<Trade[]> {
    // sorted by id (= open order), so a position opened before `since` can still have closed after it
    return this.each(async (k, i) => (await this.paged(k, '/user/positions/history', {}))
      .filter(p => p.closedTime != null && p.closedTime >= since)
      .map(p => ({
        exchange: this.id,
        sub: null,
        id: `${i}:${p.id}`,
        symbol: symbolOf(p.market),
        side: sideOf(p.side),
        // realisedPnl is net (trade + funding + fees); the dashboard wants gross, fees apart
        realizedPnl: +(p.realisedPnlBreakdown?.tradePnl ?? p.realisedPnl ?? 0),
        fee: -(+(p.realisedPnlBreakdown?.openFees ?? 0) + +(p.realisedPnlBreakdown?.closeFees ?? 0)),
        ts: p.closedTime,
      })));
  }

  async getFunding(since: number): Promise<FundingPayment[]> {
    return this.each(async (k, i) => (await this.paged(k, '/user/funding/history', { startTime: since }, page => page.some(f => f.paidTime < since)))
      .filter(f => f.paidTime >= since)
      .map(f => ({
        exchange: this.id,
        id: `${i}:${f.id}`,
        symbol: symbolOf(f.market),
        usdc: +(f.fundingFee ?? 0),           // + = received
        ts: f.paidTime,
      })));
  }
}

/** One row per market and side across accounts: sizes add up, prices are size-weighted. */
function merge(list: Position[]): Position[] {
  const rows = new Map<string, Position>();
  for (const p of list) {
    const k = `${p.symbol}:${p.side}`;
    const q = rows.get(k);
    if (!q) { rows.set(k, { ...p }); continue; }
    const size = q.size + p.size;
    const avg = (a: number, b: number) => (a * q.size + b * p.size) / size;
    // no single liq price exists for two accounts: keep the one closest to the mark (most at risk)
    const liq = [q.liq, p.liq].filter((x): x is number => x != null)
      .sort((a, b) => Math.abs(a - p.mark) - Math.abs(b - p.mark))[0] ?? null;
    const margin = q.margin + p.margin, upnl = q.upnl + p.upnl;
    rows.set(k, {
      ...q, size, liq, margin, upnl,
      entry: avg(q.entry, p.entry),
      mark: avg(q.mark, p.mark),
      leverage: margin ? (avg(q.mark, p.mark) * size) / margin : q.leverage,
      roe: margin ? upnl / margin : 0,
      funding: q.funding + p.funding,
      openedAt: q.openedAt == null || p.openedAt == null ? q.openedAt ?? p.openedAt : Math.min(q.openedAt, p.openedAt),
    });
  }
  return [...rows.values()];
}
