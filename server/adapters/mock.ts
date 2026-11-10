// Mock adapter: deterministic fake history, used for an exchange whose keys/address are missing from .env.
import type { Account, Adapter, ExchangeId, FundingPayment, Position, Since, Trade } from '../types.js';

const PRICES: Record<string, number> = {
  BTC: 112400, ETH: 4120, SOL: 196, HYPE: 41.8, DOGE: 0.2134, ARB: 0.784, SUI: 3.42, LINK: 22.6,
};
const SYMS = Object.keys(PRICES);
const DAYS = 371;

function rngFrom(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MockPos { sym: string; dir: 1 | -1; entry: number; mark: number; lev: number; size: number; funding: number; opened: number; liq: number | null }

export class MockAdapter implements Adapter {
  readonly mock = true;
  readonly label = 'mock data';
  private readonly trades: Trade[] = [];
  private readonly funding: FundingPayment[] = [];
  private readonly positions: MockPos[] = [];
  private readonly rng: () => number;

  constructor(
    readonly id: ExchangeId,
    readonly name: string,
    private readonly balance: number,
    rate: number,
    seed: number,
    opts: { symbols?: number; noLiq?: boolean } = {},
  ) {
    const rng = (this.rng = rngFrom(seed));
    const gauss = () => (rng() + rng() + rng() - 1.5) / 1.5;
    const now = Math.floor(Date.now() / 3600e3) * 3600e3;
    const start = now - DAYS * 86400e3;
    const nSym = opts.symbols ?? 5;
    let regime = 1, n = 0;
    for (let d = 0; d < DAYS; d++) {
      const day = start + d * 86400e3;
      this.funding.push({ exchange: id, account: 'mock', id: `f${d}`, symbol: 'ALL', usdc: gauss() * balance * 0.0002, ts: day });
      if (rng() < 0.08) regime = 0.3 + rng() * 1.6;
      const dow = new Date(day).getDay();
      const r = rate * regime * (dow === 0 || dow === 6 ? 0.45 : 1);
      const count = rng() < 0.15 ? 0 : Math.floor(rng() * r * 2);
      for (let k = 0; k < count; k++) {
        const ts = day + Math.floor(rng() * 86400e3);
        if (ts > Date.now()) continue;
        this.trades.push({
          exchange: id, account: 'mock', sub: null, id: `t${n++}`,
          symbol: SYMS[Math.floor(rng() * nSym)],
          side: rng() < 0.55 ? 'Long' : 'Short',
          realizedPnl: (gauss() + 0.06) * balance * 0.0035 * (rng() < 0.08 ? 4 : 1),
          fee: balance * 0.0035 * 0.12 * rng(),
          ts,
        });
      }
    }
    const np = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < np; i++) {
      // one position per symbol, like a real one-way perp account
      let sym: string;
      do sym = SYMS[Math.floor(rng() * SYMS.length)]; while (this.positions.some(p => p.sym === sym));
      const dir = rng() < 0.6 ? 1 : -1;
      const entry = PRICES[sym] * (1 + gauss() * 0.04);
      const lev = [3, 5, 5, 10, 10, 15, 20][Math.floor(rng() * 7)];
      const notional = balance * (0.15 + rng() * 0.5);
      this.positions.push({
        sym, dir, entry, mark: PRICES[sym], lev, size: notional / entry,
        funding: -dir * notional * rng() * 0.002,
        opened: now - Math.floor(rng() * 20 * 86400e3),
        liq: opts.noLiq ? null : entry * (1 - (dir * 0.9) / lev),
      });
    }
  }

  async getPositions(): Promise<Position[]> {
    // small random walk so the mock feels alive between refreshes
    for (const p of this.positions) p.mark *= 1 + (Math.random() - 0.5) * 0.002;
    return this.positions.map(p => {
      const upnl = (p.mark - p.entry) * p.size * p.dir;
      const margin = (p.entry * p.size) / p.lev;
      return {
        exchange: this.id, sub: null, symbol: p.sym, side: p.dir > 0 ? 'Long' : 'Short',
        size: p.size, entry: p.entry, mark: p.mark, liq: p.liq, leverage: p.lev,
        margin, upnl, roe: upnl / margin, funding: p.funding, openedAt: p.opened,
      };
    });
  }

  async getAccount(): Promise<Account> {
    const upnl = this.positions.reduce((a, p) => a + (p.mark - p.entry) * p.size * p.dir, 0);
    return { exchange: this.id, equity: this.balance + upnl, freeCollateral: this.balance * 0.6, ts: Date.now() };
  }

  async getTrades(since: Since): Promise<Trade[]> { return this.trades.filter(t => t.ts >= since('mock')); }
  async getFunding(since: Since): Promise<FundingPayment[]> { return this.funding.filter(f => f.ts >= since('mock')); }
}
