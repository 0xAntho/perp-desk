// Sync jobs (Implementation Plan §4): poll every adapter in parallel, cache in memory.
// One failing exchange never blocks the others — it is just marked stale/error.
import type { Account, Adapter, ExchangeId, FundingPayment, Position, Trade } from './types.js';

export const HISTORY_DAYS = 371;
const LIVE_EVERY = 15_000;
const HISTORY_EVERY = 60_000;
const OVERLAP = 5 * 60e3; // re-read the last few minutes of history to catch late fills

export type Status = 'loading' | 'live' | 'stale' | 'error';

export interface ExchangeState {
  adapter: Adapter;
  account: Account | null;
  positions: Position[];
  trades: Map<string, Trade>;
  funding: Map<string, FundingPayment>;
  status: Status;
  error: string | null;
  liveAt: number | null;
  historyAt: number | null;
  historyCursor: number | null;
}

export class Sync {
  readonly states: ExchangeState[];
  private timers: NodeJS.Timeout[] = [];
  private inflight = new Map<string, Promise<void>>();

  constructor(adapters: Adapter[], private readonly log = console) {
    this.states = adapters.map(adapter => ({
      adapter, account: null, positions: [], trades: new Map(), funding: new Map(),
      status: 'loading', error: null, liveAt: null, historyAt: null, historyCursor: null,
    }));
  }

  get(id: ExchangeId) { return this.states.find(s => s.adapter.id === id); }

  start() {
    void this.refreshAll();
    this.timers.push(setInterval(() => void this.each(s => this.syncLive(s)), LIVE_EVERY));
    this.timers.push(setInterval(() => void this.each(s => this.syncHistory(s)), HISTORY_EVERY));
  }

  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  /** Full refresh: positions + history, for every exchange. Resolves when all are done. */
  refreshAll() {
    return this.each(async s => {
      const firstBackfill = s.historyAt == null;
      await Promise.allSettled([this.syncLive(s), this.syncHistory(s)]);
      // positions derive their open time from fill history, so re-read them once it has arrived
      if (firstBackfill && s.historyAt != null) await this.syncLive(s);
    });
  }

  private async each(fn: (s: ExchangeState) => Promise<void>) {
    await Promise.allSettled(this.states.map(fn));
  }

  /** Coalesces concurrent runs of the same job on the same exchange. */
  private once(key: string, fn: () => Promise<void>) {
    const cur = this.inflight.get(key);
    if (cur) return cur;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  syncLive(s: ExchangeState) {
    return this.once('live:' + s.adapter.id, async () => {
      try {
        const [account, positions] = await Promise.all([s.adapter.getAccount(), s.adapter.getPositions()]);
        s.account = account;
        s.positions = positions;
        s.liveAt = Date.now();
        s.error = null;
        if (s.historyAt != null || s.status !== 'loading') s.status = 'live';
      } catch (e) {
        this.fail(s, e, 'positions');
      }
    });
  }

  syncHistory(s: ExchangeState) {
    return this.once('hist:' + s.adapter.id, async () => {
      const since = s.historyCursor != null
        ? s.historyCursor - OVERLAP
        : Date.now() - HISTORY_DAYS * 86400e3;
      try {
        const [trades, funding] = await Promise.all([s.adapter.getTrades(since), s.adapter.getFunding(since)]);
        for (const t of trades) s.trades.set(t.id, t);
        for (const f of funding) s.funding.set(f.id, f);
        const last = Math.max(since + OVERLAP, ...trades.map(t => t.ts), ...funding.map(f => f.ts));
        s.historyCursor = Math.min(last, Date.now());
        s.historyAt = Date.now();
        if (s.liveAt != null) { s.status = 'live'; s.error = null; }
      } catch (e) {
        this.fail(s, e, 'history');
      }
    });
  }

  private fail(s: ExchangeState, e: unknown, what: string) {
    const msg = e instanceof Error ? e.message : String(e);
    s.error = msg;
    s.status = s.liveAt != null || s.historyAt != null ? 'stale' : 'error';
    this.log.warn(`[${s.adapter.id}] ${what} sync failed: ${msg}`);
  }
}
