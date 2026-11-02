// Hyperliquid adapter: public info API, read by wallet address — no keys needed.
// Sub-accounts of the main wallet are discovered and included automatically.
import type { Account, Adapter, FundingPayment, Position, Side, Trade } from '../types.js';

const API = 'https://api.hyperliquid.xyz/info';
const SUBS_TTL = 10 * 60e3;

type Fetch = typeof fetch;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Fill {
  coin: string; px: string; sz: string; side: 'B' | 'A'; time: number;
  startPosition: string; dir: string; closedPnl: string; hash: string; tid: number; fee: string;
}
interface SubAccount { label: string; user: string; fills: Fill[] }

const isPerp = (coin: string) => !!coin && !coin.startsWith('@') && !coin.includes('/');
const fillId = (f: Fill) => `${f.hash}:${f.tid}:${f.time}`;
const sideOf = (f: Fill): Side =>
  /Short/.test(f.dir) ? 'Short' : /Long/.test(f.dir) ? 'Long' : f.side === 'B' ? 'Long' : 'Short';

export class HyperliquidAdapter implements Adapter {
  readonly id = 'hyperliquid' as const;
  readonly name = 'Hyperliquid';
  readonly mock = false;
  readonly label: string;
  private readonly main: string;
  private accounts: SubAccount[] | null = null;
  private accountsAt = 0;

  constructor(address: string, private readonly fetchImpl: Fetch = fetch) {
    const a = address.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('HL_ADDRESS is not a valid 0x wallet address');
    this.main = a;
    this.label = a.slice(0, 6) + '…' + a.slice(-4);
  }

  private async post(body: Json): Promise<Json> {
    const r = await this.fetchImpl(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Hyperliquid API ${r.status}`);
    return r.json();
  }

  /** Time-paginated history endpoint (userFillsByTime, userFunding). */
  private async paged(type: string, user: string, startTime: number, extra: Json = {}): Promise<Json[]> {
    let out: Json[] = [];
    let t = startTime;
    for (let i = 0; i < 50; i++) {
      const page = await this.post({ type, user, startTime: t, endTime: Date.now(), ...extra });
      if (!Array.isArray(page) || !page.length) break;
      out = out.concat(page);
      const last = page[page.length - 1].time;
      if (out.length >= 20_000 || last <= t) break;
      t = last + 1;
    }
    return out;
  }

  private async getAccounts(): Promise<SubAccount[]> {
    if (this.accounts && Date.now() - this.accountsAt < SUBS_TTL) return this.accounts;
    const subs: Json[] | null = await this.post({ type: 'subAccounts', user: this.main }).catch(() => undefined);
    if (subs === undefined) {
      // lookup failed: keep what we had (or just the main wallet) and retry next call
      return this.accounts ?? [{ label: 'Main', user: this.main, fills: [] }];
    }
    const prev = new Map((this.accounts ?? []).map(a => [a.user, a]));
    const list = [
      { label: 'Main', user: this.main },
      ...(subs ?? []).map(s => ({ label: String(s.name), user: String(s.subAccountUser).toLowerCase() })),
    ];
    this.accounts = list.map(a => ({ ...a, fills: prev.get(a.user)?.fills ?? [] }));
    this.accountsAt = Date.now();
    return this.accounts;
  }

  private get multi() { return (this.accounts?.length ?? 1) > 1; }

  async getAccount(): Promise<Account> {
    const accounts = await this.getAccounts();
    const states = await Promise.all(accounts.map(a => this.post({ type: 'clearinghouseState', user: a.user })));
    let equity = 0, free = 0;
    for (const s of states) {
      equity += +(s?.marginSummary?.accountValue ?? 0);
      free += +(s?.withdrawable ?? 0);
    }
    return { exchange: this.id, equity, freeCollateral: free, ts: Date.now() };
  }

  async getPositions(): Promise<Position[]> {
    const accounts = await this.getAccounts();
    const [mids, ...states] = await Promise.all([
      this.post({ type: 'allMids' }),
      ...accounts.map(a => this.post({ type: 'clearinghouseState', user: a.user })),
    ]);
    const out: Position[] = [];
    accounts.forEach((a, i) => {
      for (const { position: p } of states[i]?.assetPositions ?? []) {
        const szi = +p.szi;
        if (!szi) continue;
        const size = Math.abs(szi), entry = +p.entryPx, dir = szi > 0 ? 1 : -1;
        const mark = mids?.[p.coin] ? +mids[p.coin] : +p.positionValue / size;
        const upnl = (mark - entry) * size * dir;
        const margin = +p.marginUsed || (entry * size) / (p.leverage?.value || 1);
        out.push({
          exchange: this.id,
          sub: this.multi ? a.label : null,
          symbol: p.coin,
          side: dir > 0 ? 'Long' : 'Short',
          size, entry, mark,
          liq: p.liquidationPx ? +p.liquidationPx : null,
          leverage: p.leverage?.value || 1,
          margin, upnl,
          roe: margin ? upnl / margin : 0,
          funding: -(+(p.cumFunding?.sinceOpen ?? 0)),   // HL reports funding paid as positive
          openedAt: openedAt(a.fills, p.coin),
        });
      }
    });
    return out;
  }

  async getTrades(since: number): Promise<Trade[]> {
    const accounts = await this.getAccounts();
    const out: Trade[] = [];
    await Promise.all(accounts.map(async a => {
      const fills: Fill[] = (await this.paged('userFillsByTime', a.user, since, { aggregateByTime: true }))
        .filter((f: Fill) => isPerp(f.coin));
      // keep a local copy per sub-account so positions can show their open time
      const seen = new Set(a.fills.map(fillId));
      for (const f of fills) if (!seen.has(fillId(f))) { a.fills.push(f); seen.add(fillId(f)); }
      a.fills.sort((x, y) => x.time - y.time);
      for (const f of fills) {
        out.push({
          exchange: this.id,
          sub: this.multi ? a.label : null,
          id: `${a.user}:${fillId(f)}`,
          symbol: f.coin,
          side: sideOf(f),
          realizedPnl: +f.closedPnl || 0,
          fee: +f.fee || 0,
          ts: f.time,
        });
      }
    }));
    return out;
  }

  async getFunding(since: number): Promise<FundingPayment[]> {
    const accounts = await this.getAccounts();
    const lists = await Promise.all(accounts.map(async a =>
      (await this.paged('userFunding', a.user, since)).map((x: Json) => ({
        exchange: this.id,
        id: `${a.user}:${x.hash}:${x.time}:${x.delta?.coin}`,
        symbol: String(x.delta?.coin ?? ''),
        usdc: +(x.delta?.usdc ?? 0),
        ts: x.time,
      }))));
    return lists.flat();
  }
}

/** Time the current position in `coin` was opened: last fill that started from a flat position. */
function openedAt(fills: Fill[], coin: string): number | null {
  let first: number | null = null;
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i];
    if (f.coin !== coin) continue;
    first = f.time;
    if (+f.startPosition === 0) return f.time;
  }
  return first;
}
