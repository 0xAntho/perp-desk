// Sync jobs (Implementation Plan §4): poll every adapter in parallel, cache in memory.
// One failing exchange never blocks the others — it is just marked stale/error.
// With a Store, history is persisted: a restart loads it and only fetches what came after.
import type { Store } from './store.js';
import { posKey, type Account, type Adapter, type ExchangeId, type FundingPayment, type Pair, type Position, type Status, type Trade } from './types.js';

const LIVE_EVERY = 15_000;
const HISTORY_EVERY = 60_000;
const OVERLAP = 5 * 60e3; // re-read the last few minutes of history to catch late fills

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
  cursors: Map<string, number>;  // per account: newest history row (or last empty fetch)
  opened: Map<string, number>;   // open time of each current position, kept across restarts
}

export class Sync {
  readonly states: ExchangeState[];
  pairs: Pair[];
  private timers: NodeJS.Timeout[] = [];
  private inflight = new Map<string, Promise<void>>();

  constructor(adapters: Adapter[], private readonly log = console, private readonly store?: Store) {
    this.states = adapters.map(adapter => {
      // mock data is never stored: it would mix with the real history once keys are added
      const stored = store && !adapter.mock;
      const trades = stored ? store.trades(adapter.id) : [];
      const funding = stored ? store.funding(adapter.id) : [];
      const cursors = new Map<string, number>();
      for (const x of [...trades, ...funding]) cursors.set(x.account, Math.max(cursors.get(x.account) ?? -Infinity, x.ts));
      return {
        adapter, account: null, positions: [],
        trades: new Map(trades.map(t => [t.id, t])), funding: new Map(funding.map(f => [f.id, f])),
        status: 'loading', error: null, liveAt: null, historyAt: null, cursors,
        opened: stored ? store.opened(adapter.id) : new Map(),
      };
    });
    this.pairs = store?.pairs() ?? [];
  }

  private persist(s: ExchangeState) { return this.store && !s.adapter.mock ? this.store : null; }

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
        this.keepOpenTimes(s);
        this.dropClosedPairs(s);
        this.persist(s)?.saveEquity(s.adapter.id, account.ts, account.equity);
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
      // per account: everything the exchange still serves for one we have nothing of (a key or
      // sub-account added later included), otherwise only what came after its newest row
      const asked = new Set<string>();
      const since = (account: string) => {
        asked.add(account);
        const c = s.cursors.get(account);
        return c != null ? c - OVERLAP : 0;
      };
      const started = Date.now();
      try {
        const [trades, funding] = await Promise.all([s.adapter.getTrades(since), s.adapter.getFunding(since)]);
        this.persist(s)?.saveTrades(trades);
        this.persist(s)?.saveFunding(funding);
        for (const t of trades) s.trades.set(t.id, t);
        for (const f of funding) s.funding.set(f.id, f);
        const newest = new Map<string, number>();
        for (const x of [...trades, ...funding]) newest.set(x.account, Math.max(newest.get(x.account) ?? -Infinity, x.ts));
        // an account with no history at all resumes from this fetch instead of from 0 again
        for (const a of asked) s.cursors.set(a, Math.max(s.cursors.get(a) ?? started - OVERLAP, newest.get(a) ?? -Infinity));
        s.historyAt = Date.now();
        if (s.liveAt != null) { s.status = 'live'; s.error = null; }
      } catch (e) {
        this.fail(s, e, 'history');
      }
    });
  }

  /**
   * Adapters derive open times from the history they fetched since start, which no longer reaches
   * back to the open after a restart: keep the earliest time seen while the position stays open.
   * Limit: a position closed and reopened while the server was down keeps its first open time.
   */
  private keepOpenTimes(s: ExchangeState) {
    const next = new Map<string, number>();
    for (const p of s.positions) {
      const key = `${p.sub ?? ''}|${p.symbol}|${p.side}`;
      const known = s.opened.get(key);
      if (known != null && (p.openedAt == null || known < p.openedAt)) p.openedAt = known;
      if (p.openedAt != null) next.set(key, p.openedAt);
    }
    s.opened = next;
    this.persist(s)?.saveOpened(s.adapter.id, next);
  }

  /** Pairs two open positions (one long, one short) into a delta-neutral trade. Returns an error message, or null. */
  pair(a: string, b: string): string | null {
    const open = new Map(this.states.flatMap(s => s.positions).map(p => [posKey(p), p]));
    const pa = open.get(a), pb = open.get(b);
    if (!pa || !pb) return 'position not open';
    if (pa.side === pb.side) return 'a pair needs one long and one short';
    const p: Pair = pa.side === 'Long' ? { long: a, short: b } : { long: b, short: a };
    if (this.pairs.some(x => [x.long, x.short].some(k => k === a || k === b))) return 'position already paired';
    this.store?.savePair(p);
    this.pairs.push(p);
    return null;
  }

  unpair(long: string) {
    this.store?.deletePair(long);
    this.pairs = this.pairs.filter(p => p.long !== long);
  }

  /** A pair ends when one of its legs is no longer open (read fresh from that leg's exchange). */
  private dropClosedPairs(s: ExchangeState) {
    const open = new Set(s.positions.map(posKey));
    const prefix = s.adapter.id + '|';
    for (const p of [...this.pairs])
      if ([p.long, p.short].some(k => k.startsWith(prefix) && !open.has(k))) this.unpair(p.long);
  }

  private fail(s: ExchangeState, e: unknown, what: string) {
    const msg = e instanceof Error ? e.message : String(e);
    s.error = msg;
    s.status = s.liveAt != null || s.historyAt != null ? 'stale' : 'error';
    this.log.warn(`[${s.adapter.id}] ${what} sync failed: ${msg}`);
  }
}
