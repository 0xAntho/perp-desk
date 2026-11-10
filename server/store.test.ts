// Persistence: Store round trip, Sync resuming from the database, open times across restarts,
// the Hyperliquid CSV import and order grouping in the aggregates. In-memory SQLite, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as agg from './aggregate.js';
import { importable, parseHlCsv } from './hl-csv.js';
import { Store } from './store.js';
import { Sync } from './sync.js';
import { posKey, type Adapter, type FundingPayment, type Position, type Trade } from './types.js';

const H = 3600e3;
const quiet = { warn() {} } as unknown as Console;

/** Adapter serving a fixed history for its accounts; records the `since` asked for each. */
function fake(trades: Trade[], opts: { mock?: boolean; positions?: Position[]; accounts?: string[] } = {}) {
  const calls: Record<string, number>[] = [];
  const accounts = opts.accounts ?? ['A'];
  const ad: Adapter = {
    id: 'hyperliquid', name: 'Hyperliquid', mock: opts.mock ?? false, label: 'x',
    getAccount: async () => ({ exchange: 'hyperliquid', equity: 100, freeCollateral: 50, ts: Date.now() }),
    getPositions: async () => opts.positions ?? [],
    getTrades: async since => {
      const from = Object.fromEntries(accounts.map(a => [a, since(a)]));
      calls.push(from);
      return trades.filter(t => accounts.includes(t.account) && t.ts >= from[t.account]);
    },
    getFunding: async (): Promise<FundingPayment[]> => [],
  };
  return { ad, calls };
}
const trade = (id: string, ts: number, pnl: number, group?: string, account = 'A'): Trade =>
  ({ exchange: 'hyperliquid', account, sub: null, id, symbol: 'BTC', side: 'Long', realizedPnl: pnl, fee: 1, ts, ...(group && { group }) });
const position = (openedAt: number | null): Position => ({
  exchange: 'hyperliquid', sub: null, symbol: 'BTC', side: 'Long', size: 1, entry: 1, mark: 1, liq: null,
  leverage: 1, margin: 1, upnl: 0, roe: 0, funding: 0, openedAt,
});

test('store: upsert by (exchange, id), group kept, hourly equity keeps the first reading', () => {
  const st = new Store(':memory:');
  st.saveTrades([trade('a', 1000, 5, '0xh'), trade('b', 2000, -3)]);
  st.saveTrades([trade('a', 1000, 7, '0xh')]);
  assert.deepEqual(st.trades('hyperliquid').map(t => [t.id, t.realizedPnl, t.group]), [['a', 7, '0xh'], ['b', -3, undefined]]);
  st.saveEquity('hyperliquid', 10 * H + 5, 100);
  st.saveEquity('hyperliquid', 10 * H + 900_000, 120);
  st.saveEquity('hyperliquid', 11 * H, 130);
  assert.deepEqual(st.equity('hyperliquid'), [{ ts: 10 * H, equity: 100 }, { ts: 11 * H, equity: 130 }]);
});

test('sync: first run fetches everything and stores it; a restart loads it and only asks for what is new', async () => {
  const now = Date.now();
  const history = [trade('a', now - 50 * H, 5), trade('b', now - 2 * H, 3)];
  const st = new Store(':memory:');

  const first = fake(history);
  const s1 = new Sync([first.ad], quiet, st);
  await s1.refreshAll();
  assert.deepEqual(first.calls[0], { A: 0 });
  assert.equal(st.trades('hyperliquid').length, 2);

  const second = fake([...history, trade('c', now - H, 4)]);
  const s2 = new Sync([second.ad], quiet, st);
  assert.equal(s2.states[0].trades.size, 2, 'history loaded before any fetch');
  await s2.refreshAll();
  assert.deepEqual(second.calls[0], { A: now - 2 * H - 5 * 60e3 }, 'resumes from the last stored row, minus the overlap');
  assert.deepEqual([...s2.states[0].trades.keys()].sort(), ['a', 'b', 'c']);
  assert.equal(st.trades('hyperliquid').length, 3);
  assert.equal(st.equity('hyperliquid').length, 1);
});

test('sync: an account added later gets its whole history; stored accounts only what is new', async () => {
  const now = Date.now();
  const st = new Store(':memory:');
  await new Sync([fake([trade('a1', now - 10 * H, 1)]).ad], quiet, st).refreshAll();

  const history = [trade('a1', now - 10 * H, 1), trade('b1', now - 300 * 24 * H, 2, undefined, 'B'), trade('b2', now - H, 3, undefined, 'B')];
  const added = fake(history, { accounts: ['A', 'B'] });
  const s2 = new Sync([added.ad], quiet, st);
  await s2.refreshAll();
  assert.deepEqual(added.calls[0], { A: now - 10 * H - 5 * 60e3, B: 0 });
  assert.deepEqual(st.trades('hyperliquid').map(t => t.id).sort(), ['a1', 'b1', 'b2']);
  await s2.syncHistory(s2.states[0]);
  assert.equal(added.calls[1].A, now - 10 * H - 5 * 60e3);
  assert.ok(added.calls[1].B > now - 11 * 60e3, 'B now resumes from its first fetch');

  // an account with no history at all is not re-read from 0 every minute
  const empty = fake([], { accounts: ['C'] });
  const s3 = new Sync([empty.ad], quiet, new Store(':memory:'));
  await s3.refreshAll();
  await s3.syncHistory(s3.states[0]);
  assert.equal(empty.calls[0].C, 0);
  assert.ok(empty.calls[1].C > now - 11 * 60e3);
});

test('sync: mock adapters are never stored', async () => {
  const st = new Store(':memory:');
  await new Sync([fake([trade('m', Date.now() - H, 1)], { mock: true }).ad], quiet, st).refreshAll();
  assert.equal(st.trades('hyperliquid').length, 0);
  assert.equal(st.equity('hyperliquid').length, 0);
});

test('sync: an open time survives a restart where the adapter only sees recent fills', async () => {
  const st = new Store(':memory:');
  await new Sync([fake([], { positions: [position(1000)] }).ad], quiet, st).refreshAll();
  const s2 = new Sync([fake([], { positions: [position(5000)] }).ad], quiet, st);   // "oldest fill seen" after restart
  await s2.refreshAll();
  assert.equal(s2.states[0].positions[0].openedAt, 1000);
  const s3 = new Sync([fake([], { positions: [] }).ad], quiet, st);   // closed: forgotten
  await s3.refreshAll();
  assert.equal(st.opened('hyperliquid').size, 0);
});

test('hl csv: perp fills only, UTC times to the ms, stable ids, identical fills numbered, zero hash ungrouped', () => {
  const csv = [
    'time,coin,dir,px,sz,ntl,fee,feeToken,closedPnl,hash',
    '2025-01-02 03:04:05.678000,@107,Buy,17.5,2.22,38.85,,,,0xaa',
    '2025-04-08 12:19:06,xyz:NVDA,Open Long,100.0,1.0,100.0,0.05,USDC,,0xbb',
    '2025-04-08 12:19:06,xyz:NVDA,Open Long,100.0,1.0,100.0,0.05,USDC,,0xbb',
    '2025-04-09 10:00:00.250000,xyz:NVDA,Long > Short,100.69999999999999,2.0,201.4,0.1,USDC,1.4,0xbb',
    '2025-04-10 00:00:00,BTC,Close Short,90000,0.01,900,0.2,USDC,-5,0x0000000000000000000000000000000000000000000000000000000000000000',
  ].join('\r\n');
  const rows = parseHlCsv(csv, '0xABC');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].ts, Date.UTC(2025, 3, 8, 12, 19, 6));
  assert.equal(rows[2].ts, Date.UTC(2025, 3, 9, 10, 0, 0, 250));
  assert.notEqual(rows[0].id, rows[1].id);
  assert.ok(rows[0].id.startsWith('0xabc:csv:'));
  assert.deepEqual(rows.map(r => r.side), ['Long', 'Long', 'Short', 'Short']);
  assert.deepEqual(rows.map(r => r.group), ['0xbb', '0xbb', '0xbb', undefined]);
  assert.deepEqual([rows[2].realizedPnl, rows[2].fee, rows[0].realizedPnl], [1.4, 0.1, 0]);
  assert.deepEqual(parseHlCsv(csv, '0xabc').map(r => r.id), rows.map(r => r.id), 'same file, same ids');
  // only rows before the API's first second are imported
  assert.equal(importable(rows, Date.UTC(2025, 3, 9, 10, 0, 0, 900)).length, 2);
  assert.throws(() => parseHlCsv('a,b\n1,2', '0xabc'), /missing/);
});

test('aggregate: fills of one order count once in top trades and activity; All starts at the oldest row', () => {
  const now = Date.UTC(2026, 10, 4);
  const st = new Store(':memory:');
  st.saveTrades([
    trade('f1', now - 400 * 24 * H, 10, '0xo'), trade('f2', now - 400 * 24 * H + 1, 15, '0xo'),
    trade('f3', now - 2 * H, 20), trade('f4', now - 3 * H, -4, '0xp'),
    trade('f5', now - 5 * H, 0.5),   // gross win smaller than its fee: a net loss
    trade('f6', now - 6 * H, 0),     // opening order: fee only, not a trade result
  ]);
  const sync = new Sync([fake([]).ad], quiet, st);
  const top = agg.topTrades(sync.states, 'All', 5, now);
  // ranked and shown net of the order's fees (fee is 1 per fill)
  assert.deepEqual(top.best.map(t => [t.id, t.realizedPnl, t.fee, t.net]), [['f1', 25, 2, 23], ['f3', 20, 1, 19]]);
  assert.deepEqual(top.worst.map(t => [t.id, t.net]), [['f4', -5], ['f5', -0.5]]);
  const curve = agg.pnl(sync.states, 'All', now);
  assert.equal(curve.from, now - 400 * 24 * H - 1);
  assert.equal(curve.flows.gross, 41.5);
  assert.equal(curve.series[0].vals.at(-1), 41.5 - 6, 'net of the 6 fills\' fees');
  const days = agg.activity(sync.states, 60, 'UTC', now);
  assert.equal(days.reduce((s, d) => s + d.count, 0), 6 - 1);
});

test('pairs: one long + one short become one delta-neutral row, kept across restarts, dropped when a leg closes', async () => {
  const leg = (side: 'Long' | 'Short', o: Partial<Position>): Position => ({ ...position(1000), side, ...o });
  const long = leg('Long', { mark: 100, size: 2, margin: 40, upnl: 12, funding: -3, openedAt: 2000 });
  const short = leg('Short', { symbol: 'xyz:BTC', mark: 100, size: 2, margin: 60, upnl: -10, funding: 5, openedAt: 1000 });
  const other = leg('Long', { symbol: 'ETH', mark: 10, size: 1 });
  const opts = { positions: [long, short, other] };
  const st = new Store(':memory:');
  const s1 = new Sync([fake([], opts).ad], quiet, st);
  await s1.refreshAll();
  const [kl, ks, ko] = [long, short, other].map(posKey);

  assert.equal(s1.pair(kl, ko), 'a pair needs one long and one short');
  assert.equal(s1.pair(kl, 'hyperliquid||NOPE|Short'), 'position not open');
  assert.equal(s1.pair(ks, kl), null);   // order doesn't matter
  assert.equal(s1.pair(ko, ks), 'position already paired');

  const rows = agg.positions(s1.states, s1.pairs);
  assert.deepEqual(rows.map(r => r.kind), ['pair', 'position']);
  const p = rows[0];
  assert.ok(p.kind === 'pair');
  assert.deepEqual([p.long.key, p.short.key, p.collateral, p.upnl, p.roe, p.funding, p.openedAt], [kl, ks, 100, 2, 0.02, 2, 1000]);

  const s2 = new Sync([fake([], opts).ad], quiet, st);   // restart
  assert.deepEqual(s2.pairs, [{ long: kl, short: ks }]);
  await s2.refreshAll();
  assert.equal(s2.pairs.length, 1);
  opts.positions = [long, other];   // short leg closed
  await s2.syncLive(s2.states[0]);
  assert.deepEqual([s2.pairs, st.pairs()], [[], []]);
});
