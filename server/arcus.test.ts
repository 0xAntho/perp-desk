import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArcusAdapter } from './adapters/arcus.js';
import { Sync } from './sync.js';

const ADDR = '0x6af0b3433e185614f2ee8a6cdb789fe1de4ccd05';
const now = Date.now();
const H = 3600e3;
const us = (ms: number) => ms * 1000;

// Fixture responses shaped like the live Arcus API (2026-11), values made up. Times are epoch µs.
const fill = (id: string, market: string, side: 'BUY' | 'SELL', size: string, effect: string, closedPnl: string, fee: string, ms: number, extra = {}) =>
  ({ tradeId: id, address: ADDR, accountIndex: 0, marketDisplayName: market, side, size, price: '1', fee, closedPnl, positionEffect: effect, createdAt: us(ms), ...extra });
const FILLS = [   // newest first
  fill('6', 'ETH-USD', 'SELL', '0.5', 'OPEN_SHORT', '-0.2', '0.2', now - 1 * H),
  fill('5', 'BTC-USD', 'BUY', '0.1', 'ADD_LONG', '-0.4', '0.4', now - 2 * H),
  fill('4', 'BTC-USD', 'BUY', '0.1', 'OPEN_LONG', '-0.4', '0.4', now - 3 * H),
  fill('3', 'BTC-USD', 'SELL', '0.2', 'CLOSE_LONG', '99', '1', now - 4 * H),
  fill('2', 'DRAM-USD', 'SELL', '2', 'FLIP_SHORT_TO_LONG', '-7.189153173', '0.214773486', now - 5 * H),
  fill('1', 'SOL-USD', 'SELL', '3', 'CLOSE_LONG', '-50', '2.5', now - 6 * H, { liquidation: { method: 'LIQUIDATION', liquidatedUser: ADDR } }),
];

function fakeFetch(calls: URL[], { fills = FILLS, throttleOnce = false } = {}) {
  let throttled = !throttleOnce;
  return (async (url: string) => {
    const u = new URL(url);
    calls.push(u);
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (u.searchParams.get('address') !== ADDR) return new Response('{"error":"bad address"}', { status: 400 });
    if (!throttled) { throttled = true; return new Response('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '0' } }); }
    const from = Number(u.searchParams.get('from')), to = Number(u.searchParams.get('to'));
    switch (u.pathname) {
      case '/v1/account': return json({ accountIndex: 0, equity: '391.69', freeCollateral: '300.5', netQuoteBalance: '391.69', netDeposits: '600', positions: {} });
      case '/v1/positions': return json({ total: 2, positions: {
        1: { marketId: 1, marketDisplayName: 'BTC-USD', side: 'LONG', size: '0.2', averageEntryPrice: '100000', markPx: '110000', leverage: '5', marginUsed: '4400', unrealizedPnl: '-123', cumulativeFunding: { allTime: '-3', sinceOpen: '-1.5', sinceChange: '0' } },
        2: { marketId: 2, marketDisplayName: 'ETH-USD', side: 'SHORT', size: '-0.5', averageEntryPrice: '4000', markPx: '0', leverage: '10', marginUsed: '200', unrealizedPnl: '0' },
      } });
      case '/v1/fills': {
        const limit = Math.min(Number(u.searchParams.get('limit')) || 1000, 1000);
        const rows = fills.filter(f => f.createdAt >= from && f.createdAt <= to).slice(0, limit);
        return json({ fills: rows, total: rows.length });
      }
      case '/v1/funding': return json({ fundingPayments: [
        { marketId: 38, marketDisplayName: 'SPCX-USD', fundingRate: '0.00002', size: '-6.7', payment: '0.019238395', time: us(now - H) },
        { marketId: 34, marketDisplayName: 'DRAM-USD', fundingRate: '0.00003', size: '21.1', payment: '-0.033935218', time: us(now - H) },
      ].filter(x => x.time >= from && x.time <= to), total: 2 });
    }
    return new Response('?', { status: 400 });
  }) as typeof fetch;
}

async function run(opts = {}) {
  const calls: URL[] = [];
  const sync = new Sync([new ArcusAdapter(ADDR.toUpperCase().replace('0X', '0x'), fakeFetch(calls, opts))], { warn() {} } as any);
  await sync.refreshAll();
  return { s: sync.states[0], calls };
}

test('rejects an invalid address', () => {
  assert.throws(() => new ArcusAdapter('nope'));
});

test('normalizes account, positions, fills and funding (µs → ms, gross PnL)', async () => {
  const { s, calls } = await run({ throttleOnce: true });
  assert.equal(s.status, 'live', s.error ?? '');
  assert.equal(s.account?.equity, 391.69);
  assert.equal(s.account?.freeCollateral, 300.5);

  const btc = s.positions.find(p => p.symbol === 'BTC')!;
  assert.equal(btc.side, 'Long');
  assert.equal(btc.upnl, 2000, 'price PnL, not the API margin delta');
  assert.equal(btc.roe, 2000 / 4400);
  assert.equal(btc.liq, null);
  assert.equal(btc.funding, -1.5);
  assert.equal(btc.openedAt, now - 3 * H, 'walks fills back to the last flat point (after the CLOSE at −4h)');
  const eth = s.positions.find(p => p.symbol === 'ETH')!;
  assert.equal(eth.side, 'Short');
  assert.equal(eth.mark, 4000, 'markPx "0" falls back to entry');
  assert.equal(eth.openedAt, now - 1 * H);

  const t = (id: string) => s.trades.get(id)!;
  assert.equal(s.trades.size, 6);
  assert.equal(t('3').realizedPnl, 100, 'closedPnl is net of fee: add it back');
  assert.equal(t('3').fee, 1);
  assert.equal(t('3').ts, now - 4 * H);
  assert.equal(t('4').realizedPnl, 0, 'an opening fill has no price PnL');
  assert.equal(t('2').side, 'Short', 'a flip reports the side it closed');
  assert.equal(t('1').realizedPnl, -50, 'liquidation penalty is not in closedPnl');

  assert.deepEqual([...s.funding.values()].map(f => [f.symbol, f.usdc]), [['SPCX', 0.019238395], ['DRAM', -0.033935218]]);
  assert.ok(calls.every(c => c.searchParams.get('address') === ADDR), 'address sent lowercase');
  assert.ok(calls.filter(c => c.pathname === '/v1/fills').every(c => Number(c.searchParams.get('from')) >= 1e14), 'bounds in µs');
});

test('pages fills by moving `to` to the oldest row, deduping the inclusive overlap', async () => {
  // 2,500 fills one second apart: three pages of at most 1,000
  const fills = Array.from({ length: 2500 }, (_, i) => fill(String(i), 'BTC-USD', 'BUY', '0.1', 'OPEN_LONG', '-0.1', '0.1', now - (i + 1) * 1000));
  const { s, calls } = await run({ fills });
  assert.equal(s.trades.size, 2500);
  const tos = calls.filter(c => c.pathname === '/v1/fills').map(c => Number(c.searchParams.get('to')));
  assert.equal(tos.length, 3);
  assert.equal(tos[1], fills[999].createdAt, 'second page ends at the oldest createdAt of the first');
});
