// Perpl adapter: REST API, every account request signed with an Ed25519 API key (read scope is enough).
// Prices, sizes and amounts come as scaled integers: decimals are in /v1/pub/context.
import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { Account, Adapter, FundingPayment, Position, Trade } from '../types.js';

const API = 'https://app.perpl.xyz/api';
const CHAIN_ID = 143;          // Monad mainnet
const CONTEXT_TTL = 10 * 60e3;
const PAGE = 100;              // server max
const MAX_PAGES = 500;
const PAGE_GAP = 250;          // ms between history pages: REST limits are unpublished, 429 is the signal
const RETRIES = 5;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// PositionStatusReason values that take size off a position and realize PnL
const EXITS = new Set([13, 14, 15, 19, 22]);   // closed, decreased, deleveraged, liquidated, unwound
const OPENS = new Set([18, 21]);                // inverted, opened

type Fetch = typeof fetch;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Market { symbol: string; px: number; sz: number }
interface Context { markets: Map<number, Market>; amount: number }

export class PerplAdapter implements Adapter {
  readonly id = 'perpl' as const;
  readonly name = 'Perpl';
  readonly mock = false;
  readonly label: string;
  private readonly key: KeyObject;
  private ctx: Context | null = null;
  private ctxAt = 0;
  private accounts = 1;
  /** Open time per position id, from history: the live snapshot leaves `ots` empty. */
  private openedAt = new Map<number, number>();
  private pending: { since: number; rows: Promise<Json[]> } | null = null;

  constructor(private readonly apiKey: string, secretHex: string, label: string, private readonly fetchImpl: Fetch = fetch) {
    const seed = Buffer.from(secretHex.trim().replace(/^0x/, ''), 'hex');
    if (!apiKey.trim() || seed.length !== 32) throw new Error('PERPL_API_KEY / PERPL_API_KEY_SECRET missing or not a 32-byte hex key');
    // wrap the raw 32-byte Ed25519 seed in a PKCS#8 envelope so node:crypto can load it
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    this.key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    this.label = label;
  }

  /** GET with exponential backoff on 429 (1 s, 2 s, 4 s…, or the server's Retry-After). */
  private async get(target: string, signed = true): Promise<Json> {
    for (let i = 0; ; i++) {
      const r = await this.fetchImpl(API + target, { headers: signed ? this.sign(target) : {}, signal: AbortSignal.timeout(15_000) });
      if (r.status === 429 && i < RETRIES) {
        await sleep((Number(r.headers.get('retry-after')) || 2 ** i) * 1000);
        continue;
      }
      if (!r.ok) throw new Error(`Perpl API ${r.status} on ${target.split('?')[0]}`);
      return r.json();
    }
  }

  /** Signature headers: fresh timestamp and nonce on every attempt (nonces are single-use). */
  private sign(target: string): Record<string, string> {
    const ts = Date.now().toString();
    const nonce = randomBytes(16).toString('base64url');
    const bodyHash = createHash('sha256').update('').digest('hex');
    const canonical = [CHAIN_ID, 'GET', target, ts, nonce, bodyHash].join('\n');
    return {
      'X-API-Key': this.apiKey,
      'X-API-Timestamp': ts,
      'X-API-Nonce': nonce,
      'X-API-Signature': sign(null, Buffer.from(canonical), this.key).toString('base64url'),
    };
  }

  private async context(): Promise<Context> {
    if (this.ctx && Date.now() - this.ctxAt < CONTEXT_TTL) return this.ctx;
    try {
      const c = await this.get('/v1/pub/context', false);
      const inst = c.instances?.[0];
      const token = c.tokens?.find((t: Json) => t.id === inst?.collateral_token_id) ?? c.tokens?.[0];
      this.ctx = {
        amount: 10 ** (token?.decimals ?? 6),
        markets: new Map((c.markets ?? []).map((m: Json) => [m.id, {
          symbol: m.symbol || m.name || m.size_units || `#${m.id}`,   // BTC and MON have an empty symbol
          px: 10 ** m.config.price_decimals,
          sz: 10 ** m.config.size_decimals,
        }])),
      };
      this.ctxAt = Date.now();
    } catch (e) {
      if (!this.ctx) throw e;   // keep the cached context on a transient failure
    }
    return this.ctx!;
  }

  /** History endpoints: newest first, cursor in `np`, no date filter — stop once past `since`. */
  private async history(path: string, since: number): Promise<Json[]> {
    let out: Json[] = [];
    let page = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = new URLSearchParams({ count: String(PAGE) });
      if (page) q.set('page', page);
      const res = await this.get(`${path}?${q}`);
      const d: Json[] = res?.d ?? [];
      out = out.concat(d);
      if (!res?.np || res.np === page || !d.length || (d[d.length - 1].at?.t ?? 0) < since) break;
      page = res.np;
      await sleep(PAGE_GAP);
    }
    return out.filter(x => (x.at?.t ?? 0) >= since);
  }

  /** Position history, shared by getTrades and getFunding (Sync calls both at once with the same `since`). */
  private positionHistory(since: number): Promise<Json[]> {
    if (this.pending?.since !== since) {
      const rows = this.history('/v1/trading/position-history', since);
      this.pending = { since, rows };
      rows.then(list => {
        for (const p of list) if (OPENS.has(p.sr) && p.at?.t) this.openedAt.set(p.pid, p.at.t);
      }, () => { if (this.pending?.rows === rows) this.pending = null; });
    }
    return this.pending.rows;
  }

  private sub(acc: number) { return this.accounts > 1 ? `#${acc}` : null; }

  async getAccount(): Promise<Account> {
    const [ctx, w, positions] = await Promise.all([this.context(), this.get('/v1/trading/wallet'), this.getPositions()]);
    const accounts: Json[] = w?.as ?? [];
    this.accounts = Math.max(1, accounts.length);
    const balance = accounts.reduce((s, a) => s + +a.b, 0) / ctx.amount;
    const locked = accounts.reduce((s, a) => s + +(a.lb ?? 0), 0) / ctx.amount;
    // `b` excludes the collateral posted on open positions (it drops by `c` on open), so add it back
    const inPositions = positions.reduce((s, p) => s + p.margin + p.upnl, 0);
    return { exchange: this.id, equity: balance + inPositions, freeCollateral: balance - locked, ts: Date.now() };
  }

  async getPositions(): Promise<Position[]> {
    const [ctx, snap, ticker] = await Promise.all([
      this.context(), this.get('/v1/trading/positions'), this.get('/v1/market-data/ticker', false),
    ]);
    const out: Position[] = [];
    for (const p of snap?.d ?? []) {
      const m = ctx.markets.get(p.mkt);
      if (!m || !+p.s) continue;
      const size = +p.s / m.sz, entry = +p.ep / m.px, dir = p.sd === 2 ? -1 : 1;
      const mrk = ticker?.d?.[p.mkt]?.mrk;
      const mark = mrk ? mrk / m.px : entry;
      const margin = +p.c / ctx.amount;
      const upnl = (mark - entry) * size * dir;
      out.push({
        exchange: this.id,
        sub: this.sub(p.acc),
        symbol: m.symbol,
        side: dir > 0 ? 'Long' : 'Short',
        size, entry, mark,
        liq: null,                    // not returned by the API
        leverage: (p.lv ?? 100) / 100,
        margin, upnl,
        roe: margin ? upnl / margin : 0,
        funding: +(p.fnd ?? 0) / ctx.amount,   // TODO(live): seen on exits only; check on an open position
        openedAt: p.ots?.t ?? this.openedAt.get(p.pid) ?? null,
      });
    }
    return out;
  }

  /** Exit events of position history: realized PnL (gross) and the fees the closed size carried. */
  async getTrades(since: number): Promise<Trade[]> {
    const [ctx, rows] = await Promise.all([this.context(), this.positionHistory(since)]);
    return rows
      .filter(p => EXITS.has(p.sr) && p.dpnl != null)
      .map(p => ({
        exchange: this.id,
        sub: this.sub(p.acc),
        id: `${p.acc}:${p.pid}:${p.at?.b}:${p.at?.tx}:${p.at?.l}`,
        symbol: ctx.markets.get(p.mkt)?.symbol ?? `#${p.mkt}`,
        side: p.sd === 2 ? 'Short' : 'Long',
        realizedPnl: +p.dpnl / ctx.amount,     // gross: (exit − entry) × size
        fee: +(p.fee ?? 0) / ctx.amount,       // entry share released + close fee
        ts: p.at.t,
      }));
  }

  /** Perpl settles funding when size comes off a position: `fnd` on exit events, + = received. */
  async getFunding(since: number): Promise<FundingPayment[]> {
    const [ctx, rows] = await Promise.all([this.context(), this.positionHistory(since)]);
    return rows
      .filter(p => EXITS.has(p.sr) && +(p.fnd ?? 0) !== 0)
      .map(p => ({
        exchange: this.id,
        id: `${p.acc}:${p.pid}:${p.at?.b}:${p.at?.tx}:${p.at?.l}`,
        symbol: ctx.markets.get(p.mkt)?.symbol ?? `#${p.mkt}`,
        usdc: +p.fnd / ctx.amount,
        ts: p.at.t,
      }));
  }

}
