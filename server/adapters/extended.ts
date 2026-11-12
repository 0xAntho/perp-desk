// Extended adapter: REST API with a read-only API key (X-Api-Key header, no signing for reads).
// One API key = one Extended sub-account; several keys are merged into one exchange in the UI.
import type { Account, Adapter, FundingPayment, Position, Side, Since, Trade } from '../types.js';
import { symbolOf, type Fetch, type Json } from './http.js';

const API = 'https://api.starknet.extended.exchange/api/v1';
const PAGE = 1000;
const MAX_PAGES = 50;

const sideOf = (s: string): Side => (s.toUpperCase() === 'SHORT' ? 'Short' : 'Long');

export class ExtendedAdapter implements Adapter {
  readonly id = 'extended' as const;
  readonly name = 'Extended';
  readonly mock = false;
  private readonly keys: string[];
  private unique: { key: string; account: string }[] | null = null;
  private lookup: Promise<{ key: string; account: string }[]> | null = null;
  private opening: Promise<Json[]> | null = null;

  constructor(apiKeys: string[], private readonly fetchImpl: Fetch = fetch) {
    this.keys = apiKeys.map(k => k.trim()).filter(Boolean);
    if (!this.keys.length) throw new Error('EXTENDED_API_KEY is empty');
  }

  get label() {
    const n = (this.unique ?? this.keys).length;
    return n > 1 ? `${n} accounts` : 'read-only key';
  }

  /** Keys that reach distinct accounts: two keys of the same account would count it twice. */
  private accounts(): Promise<{ key: string; account: string }[]> {
    this.lookup ??= this.lookupAccounts().catch(e => { this.lookup = null; throw e; });   // retried on failure
    return this.lookup;
  }

  private async lookupAccounts(): Promise<{ key: string; account: string }[]> {
    const ids = await Promise.all(this.keys.map(async k => (await this.get(k, '/user/account/info'))?.data?.accountId));
    const seen = new Set<string>();
    this.unique = [];
    this.keys.forEach((key, i) => {
      const account = String(ids[i]);
      if (seen.has(account)) { console.warn(`[extended] key #${i + 1} reaches account ${account} again: ignored`); return; }
      seen.add(account);
      this.unique!.push({ key, account });
    });
    return this.unique;
  }

  /** Runs `fn` for every account (its key and Extended account id) and concatenates the results. */
  private async each<T>(fn: (key: string, account: string) => Promise<T[]>): Promise<T[]> {
    return (await Promise.all((await this.accounts()).map(a => fn(a.key, a.account)))).flat();
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

  /**
   * Open positions of every account (tagged with it), repriced at the live mark. /user/positions only
   * refreshes markPrice, value and unrealisedPnl when the position itself changes (seen 2026-11-12:
   * at the hourly funding), so they can be an hour old. getAccount and getPositions of one sync share the request.
   */
  private open(): Promise<Json[]> {
    this.opening ??= this.readOpen().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async readOpen(): Promise<Json[]> {
    const list: Json[] = await this.each(async (k, account) =>
      ((await this.get(k, '/user/positions'))?.data ?? []).map((p: Json) => ({ ...p, account })));
    if (!list.length) return list;
    const markets = [...new Set(list.map(p => p.market as string))];
    const stats: Json[] = (await this.get(this.keys[0], `/info/markets?${markets.map(m => `market=${m}`).join('&')}`))?.data ?? [];
    const marks = new Map(stats.map(m => [m.name, +m.marketStats.markPrice]));
    return list.map(p => {
      const mark = marks.get(p.market) ?? +p.markPrice, size = Math.abs(+p.size);
      const upnl = (mark - +p.openPrice) * size * (sideOf(p.side) === 'Short' ? -1 : 1);
      return { ...p, markPrice: mark, value: mark * size, unrealisedPnl: upnl };
    });
  }

  async getAccount(): Promise<Account> {
    const [open, balances] = await Promise.all([
      this.open(),
      this.each(async (k, account) => {
        const b = (await this.get(k, '/user/balance'))?.data;   // 404 when the balance is 0
        return b ? [{ account, b }] : [];
      }),
    ]);
    // equity counts the same stale uPnL as /user/positions: swap it for the live one
    const live = (account: string) => open.filter(p => p.account === account).reduce((s, p) => s + p.unrealisedPnl, 0);
    return {
      exchange: this.id,
      equity: balances.reduce((s, { account, b }) => s + +b.equity - +b.unrealisedPnl + live(account), 0),
      freeCollateral: balances.reduce((s, { b }) => s + +(b.availableForTrade ?? 0), 0),
      ts: Date.now(),
    };
  }

  async getPositions(): Promise<Position[]> {
    return merge((await this.open()).map((p): Position => {
      // initial margin, as Extended's UI shows it. The API's own `margin` is smaller
      // (2% of value on a 15x XAU position: it looks like the maintenance margin).
      const leverage = +p.leverage || 1;
      const margin = +p.value / leverage, upnl = +p.unrealisedPnl;
      return {
        exchange: this.id,
        sub: null,
        symbol: symbolOf(p.market),
        side: sideOf(p.side),
        size: Math.abs(+p.size),
        entry: +p.openPrice,
        mark: +p.markPrice,
        liq: +p.liquidationPrice || null,
        leverage, margin, upnl,
        roe: margin ? upnl / margin : 0,
        funding: +(p.paidFundingFee ?? 0),      // despite the name: + = received (= sum of fundingFee)
        openedAt: p.createdAt ?? p.createdTime ?? null,
      };
    }));
  }

  /** Closed positions as trades: Extended reports realized PnL per position, not per fill. */
  async getTrades(since: Since): Promise<Trade[]> {
    // sorted by id (= open order), so a position opened before `since` can still have closed after it
    return this.each(async (k, account) => {
      const from = since(account);
      return (await this.paged(k, '/user/positions/history', {}))
        .filter(p => p.closedTime != null && p.closedTime >= from)
        .map(p => ({
          exchange: this.id,
          account,
          sub: null,
          id: `${account}:${p.id}`,
          symbol: symbolOf(p.market),
          side: sideOf(p.side),
          // realisedPnl is net (trade + funding + fees); the dashboard wants gross, fees apart
          realizedPnl: +(p.realisedPnlBreakdown?.tradePnl ?? p.realisedPnl ?? 0),
          fee: -(+(p.realisedPnlBreakdown?.openFees ?? 0) + +(p.realisedPnlBreakdown?.closeFees ?? 0)),
          ts: p.closedTime,
        }));
    });
  }

  async getFunding(since: Since): Promise<FundingPayment[]> {
    return this.each(async (k, account) => {
      const from = since(account);
      return (await this.paged(k, '/user/funding/history', { startTime: from }, page => page.some(f => f.paidTime < from)))
        .filter(f => f.paidTime >= from)
        .map(f => ({
          exchange: this.id,
          account,
          id: `${account}:${f.id}`,
          symbol: symbolOf(f.market),
          usdc: +(f.fundingFee ?? 0),           // + = received
          ts: f.paidTime,
        }));
    });
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
