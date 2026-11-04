// SQLite persistence (Implementation Plan §4): trade and funding history, open times of current
// positions, hourly equity snapshots. Lets a restart resume from the last stored row instead of
// re-downloading everything, and keeps history the exchanges' APIs no longer serve.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExchangeId, FundingPayment, Side, Trade } from './types.js';

export const DB_PATH = 'data/perp-desk.db';   // data/ is git-ignored
const SCHEMA = 2;   // bump to rebuild: history is re-downloaded (and the Hyperliquid CSV must be re-imported)

interface TradeRow {
  exchange: ExchangeId; account: string; id: string; sub: string | null; symbol: string; side: Side;
  realized_pnl: number; fee: number; ts: number; grp: string | null;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version !== SCHEMA) {
      const old = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      if (old.length) console.warn(`[store] database schema ${version} → ${SCHEMA}: rebuilt, history will be re-downloaded. Re-run \`npm run import:hl\` for Hyperliquid fills older than the API serves.`);
      for (const t of old) this.db.exec(`DROP TABLE "${t.name}"`);
      this.db.exec(`PRAGMA user_version = ${SCHEMA}`);
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS trades (
        exchange TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL, sub TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL,
        realized_pnl REAL NOT NULL, fee REAL NOT NULL, ts INTEGER NOT NULL, grp TEXT,
        PRIMARY KEY (exchange, id));
      CREATE TABLE IF NOT EXISTS funding (
        exchange TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL, symbol TEXT NOT NULL, usdc REAL NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY (exchange, id));
      CREATE TABLE IF NOT EXISTS opened (
        exchange TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (exchange, key));
      CREATE TABLE IF NOT EXISTS equity (
        exchange TEXT NOT NULL, ts INTEGER NOT NULL, equity REAL NOT NULL, PRIMARY KEY (exchange, ts));
    `);
  }

  private tx(fn: () => void) {
    this.db.exec('BEGIN');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Upsert by (exchange, id): a row read again from the API replaces the stored one. */
  saveTrades(list: Trade[]) {
    if (!list.length) return;
    const q = this.db.prepare('INSERT OR REPLACE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.tx(() => { for (const t of list) q.run(t.exchange, t.account, t.id, t.sub, t.symbol, t.side, t.realizedPnl, t.fee, t.ts, t.group ?? null); });
  }

  saveFunding(list: FundingPayment[]) {
    if (!list.length) return;
    const q = this.db.prepare('INSERT OR REPLACE INTO funding VALUES (?, ?, ?, ?, ?, ?)');
    this.tx(() => { for (const f of list) q.run(f.exchange, f.account, f.id, f.symbol, f.usdc, f.ts); });
  }

  trades(exchange: ExchangeId): Trade[] {
    const rows = this.db.prepare('SELECT * FROM trades WHERE exchange = ? ORDER BY ts').all(exchange) as unknown as TradeRow[];
    return rows.map(r => ({
      exchange: r.exchange, account: r.account, id: r.id, sub: r.sub, symbol: r.symbol, side: r.side,
      realizedPnl: r.realized_pnl, fee: r.fee, ts: r.ts, ...(r.grp != null && { group: r.grp }),
    }));
  }

  funding(exchange: ExchangeId): FundingPayment[] {
    const rows = this.db.prepare('SELECT exchange, account, id, symbol, usdc, ts FROM funding WHERE exchange = ? ORDER BY ts').all(exchange) as unknown as FundingPayment[];
    return rows.map(r => ({ exchange: r.exchange, account: r.account, id: r.id, symbol: r.symbol, usdc: r.usdc, ts: r.ts }));
  }

  /** Oldest trade of an account whose id doesn't match `notLike` (used to find where API-sourced history starts). */
  oldestTrade(exchange: ExchangeId, account: string, notLike: string): number | null {
    const r = this.db.prepare('SELECT MIN(ts) AS ts FROM trades WHERE exchange = ? AND account = ? AND id NOT LIKE ?')
      .get(exchange, account, notLike) as { ts: number | null };
    return r.ts;
  }

  /** Open time of each current position, keyed by sub|symbol|side. Replaces the exchange's previous set. */
  saveOpened(exchange: ExchangeId, opened: Map<string, number>) {
    const del = this.db.prepare('DELETE FROM opened WHERE exchange = ?');
    const ins = this.db.prepare('INSERT INTO opened VALUES (?, ?, ?)');
    this.tx(() => { del.run(exchange); for (const [k, ts] of opened) ins.run(exchange, k, ts); });
  }

  opened(exchange: ExchangeId): Map<string, number> {
    const rows = this.db.prepare('SELECT key, ts FROM opened WHERE exchange = ?').all(exchange) as { key: string; ts: number }[];
    return new Map(rows.map(r => [r.key, r.ts]));
  }

  /** One snapshot per exchange per hour: the first reading of the hour is kept. */
  saveEquity(exchange: ExchangeId, ts: number, equity: number) {
    const hour = Math.floor(ts / 3600e3) * 3600e3;
    this.db.prepare('INSERT OR IGNORE INTO equity VALUES (?, ?, ?)').run(exchange, hour, equity);
  }

  equity(exchange: ExchangeId): { ts: number; equity: number }[] {
    const rows = this.db.prepare('SELECT ts, equity FROM equity WHERE exchange = ? ORDER BY ts').all(exchange) as { ts: number; equity: number }[];
    return rows.map(r => ({ ts: r.ts, equity: r.equity }));
  }

  close() { this.db.close(); }
}
