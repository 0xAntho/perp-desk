import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVariationalCsv } from './variational-csv.js';

// Shaped like Variational's export (2026-11), values made up. Rows are out of order, as in the real file.
const CSV = `id,created_at,side,instrument_type,underlying,price,qty,trade_type,status,liquidation_trigger_price
c,2026-01-03T00:00:00.000Z,sell,perpetual_future,BTC,120,1.5,trade,confirmed,
a,2026-01-01T00:00:00.000000Z,buy,perpetual_future,BTC,100,1,trade,confirmed,
b,2026-01-02T00:00:00.000Z,buy,perpetual_future,BTC,130,1,trade,confirmed,
d,2026-01-04T00:00:00.000Z,buy,perpetual_future,BTC,110,1,trade,confirmed,
e,2026-01-05T00:00:00.000Z,sell,swap,XAU,4000,0.5,trade,confirmed,
f,2026-01-06T00:00:00.000Z,buy,perpetual_rwa_future,XAU,3900,0.5,trade,confirmed,
x,2026-01-07T00:00:00.000Z,buy,perpetual_future,ETH,1,1,trade,rejected,`;

test('Variational CSV: realized PnL from fills, average cost, partial close and flip', () => {
  const t = parseVariationalCsv(CSV);
  assert.deepEqual(t.map(x => x.id), ['csv:a', 'csv:b', 'csv:c', 'csv:d', 'csv:e', 'csv:f']);   // sorted, rejected dropped
  assert.deepEqual(t.map(x => x.side), ['Long', 'Long', 'Long', 'Long', 'Short', 'Short']);
  // long 2 @ 115; sell 1.5 @ 120 → +7.5 (0.5 left); buy 1 @ 110 adds to the long; XAU short 4000 → 3900 → +50
  assert.deepEqual(t.map(x => x.realizedPnl), [0, 0, 7.5, 0, 0, 50]);
  assert.equal(t[3].side, 'Long');
  assert.ok(t.every(x => x.exchange === 'variational' && x.fee === 0));
  assert.equal(t[0].ts, Date.parse('2026-01-01T00:00:00Z'));
});

test('Variational CSV: a fill through zero realizes the close and opens the other side at its price', () => {
  const t = parseVariationalCsv(`id,created_at,side,underlying,price,qty,status
1,2026-01-01T00:00:00Z,buy,SOL,10,2,confirmed
2,2026-01-02T00:00:00Z,sell,SOL,12,5,confirmed
3,2026-01-03T00:00:00Z,buy,SOL,11,3,confirmed`);
  assert.deepEqual(t.map(x => [x.side, x.realizedPnl]), [['Long', 0], ['Long', 4], ['Short', 3]]);
});

test('Variational CSV: rejects another file', () => {
  assert.throws(() => parseVariationalCsv('time,coin,dir\n1,BTC,Open Long'), /missing/);
});
