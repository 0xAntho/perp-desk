import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtendedAdapter } from './adapters/extended.js';
import { Sync } from './sync.js';

const now = Date.now();
const H = 3600e3;

// Fixture responses shaped like the live Extended API (2026-11), values made up.
// Ids are 19-digit integers, written unquoted as the API does.
const ACCOUNTS: Record<string, { id: number; balance: string | null; positions: string; history: string; funding: string }> = {
  k1: {
    id: 1001,
    balance: '{"equity":"683.5","availableForTrade":"679.5"}',
    positions: `[{"id":2077738870304145401,"market":"BTC-USD","status":"OPENED","side":"LONG","leverage":"5","size":"0.1","value":"11000","openPrice":"100000","markPrice":"110000","liquidationPrice":"80000","margin":"220","unrealisedPnl":"1000","paidFundingFee":"0.74","createdAt":${now - 5 * H}},
                 {"id":2077738870304145402,"market":"XAG-USD","status":"OPENED","side":"SHORT","leverage":"5","size":"0.4","value":"20.2","openPrice":"55.776","markPrice":"50.5","liquidationPrice":"1675.784","margin":"0.404","unrealisedPnl":"2.1","paidFundingFee":"0","createdAt":${now - 4 * H}}]`,
    history: `[{"id":2078423715724394501,"market":"SPX-USD","side":"SHORT","realisedPnl":"0.056914","realisedPnlBreakdown":{"tradePnl":"0.06","fundingFees":"0.004017","openFees":"-0.00382","closeFees":"-0.003283"},"createdTime":${now - 9 * H},"closedTime":${now - 3 * H}},
               {"id":2078423715724394502,"market":"ETH-USD","side":"LONG","realisedPnl":"1","createdTime":${now - 9 * H}}]`,
    funding: `[{"id":221610368,"market":"XAG-USD","positionId":2077738870304145402,"side":"SHORT","fundingFee":"0.000634","paidTime":${now - H}}]`,
  },
  k2: {
    id: 1002,
    balance: null,   // 404: empty account
    positions: `[{"id":2077738870304145403,"market":"BTC-USD","status":"OPENED","side":"LONG","leverage":"10","size":"0.3","value":"33000","openPrice":"104000","markPrice":"110000","liquidationPrice":"95000","margin":"660","unrealisedPnl":"1800","paidFundingFee":"-0.5","createdAt":${now - 8 * H}}]`,
    history: `[{"id":2078423715724394501,"market":"ETH-USD","side":"LONG","realisedPnl":"-2","realisedPnlBreakdown":{"tradePnl":"-1.9","fundingFees":"0","openFees":"-0.05","closeFees":"-0.05"},"createdTime":${now - 7 * H},"closedTime":${now - 2 * H}}]`,
    funding: `[{"id":5,"market":"BTC-USD","positionId":2077738870304145403,"side":"LONG","fundingFee":"-0.5","paidTime":${now - H}}]`,
  },
};
ACCOUNTS.k1dup = ACCOUNTS.k1;   // a second key of the same account

function fakeFetch(calls: string[]) {
  return (async (url: string, init: any) => {
    const u = new URL(url);
    const a = ACCOUNTS[init.headers['X-Api-Key']];
    calls.push(u.pathname);
    const ok = (data: string, cursor = '') =>
      new Response(`{"status":"OK","data":${data}${cursor && `,"pagination":{"cursor":${cursor},"count":1}`}}`, { status: 200 });
    switch (u.pathname.replace('/api/v1', '')) {
      case '/user/account/info': return ok(`{"accountId":${a.id},"description":"Main account"}`);
      case '/user/balance': return a.balance ? ok(a.balance) : new Response('', { status: 404 });
      case '/user/positions': return ok(a.positions);
      case '/user/positions/history': return ok(a.history, '2078423715724394502');
      case '/user/funding/history': return ok(a.funding);
    }
    return new Response('?', { status: 400 });
  }) as typeof fetch;
}

async function run(keys: string[]) {
  const calls: string[] = [];
  const warns: string[] = [];
  const ad = new ExtendedAdapter(keys, fakeFetch(calls));
  const sync = new Sync([ad], { warn: (m: string) => warns.push(m) } as any);
  const origWarn = console.warn;
  console.warn = (m: string) => warns.push(m);
  try { await sync.refreshAll(); } finally { console.warn = origWarn; }
  return { ad, s: sync.states[0], calls, warns };
}

test('rejects an empty key list', () => {
  assert.throws(() => new ExtendedAdapter([' ', '']));
});

test('one account: balance, positions, gross trades with fees apart, funding', async () => {
  const { ad, s } = await run(['k1']);
  assert.equal(s.status, 'live');
  assert.equal(ad.label, 'read-only key');
  assert.equal(s.account?.equity, 683.5);
  assert.equal(s.account?.freeCollateral, 679.5);

  const xag = s.positions.find(p => p.symbol === 'XAG')!;
  assert.equal(xag.side, 'Short');
  assert.equal(xag.liq, 1675.784);
  assert.equal(xag.openedAt, now - 4 * H, 'createdAt, not the documented createdTime');
  const btc = s.positions.find(p => p.symbol === 'BTC')!;
  assert.equal(btc.funding, 0.74, 'paidFundingFee: + = received');
  assert.equal(btc.margin, 2200, 'value / leverage as in Extended\x27s UI, not the API margin');
  assert.equal(btc.roe, 1000 / 2200);

  const trades = [...s.trades.values()];
  assert.equal(trades.length, 1, 'positions without closedTime are still open');
  assert.equal(trades[0].id, '1001:2078423715724394501', 'keeps every digit of the 19-digit id');
  assert.equal(trades[0].realizedPnl, 0.06, 'gross trade PnL, not the net realisedPnl');
  assert.ok(Math.abs(trades[0].fee - 0.007103) < 1e-12);
  assert.equal(trades[0].ts, now - 3 * H);

  assert.deepEqual([...s.funding.values()].map(f => [f.symbol, f.usdc]), [['XAG', 0.000634]]);
});

test('two accounts merge into one exchange; same market and side become one row', async () => {
  const { ad, s } = await run(['k1', 'k2']);
  assert.equal(ad.label, '2 accounts');
  assert.equal(s.account?.equity, 683.5, 'the empty account (404) adds 0');

  const btc = s.positions.filter(p => p.symbol === 'BTC');
  assert.equal(btc.length, 1);
  const p = btc[0];
  assert.ok(Math.abs(p.size - 0.4) < 1e-12);
  assert.equal(p.entry, 103000);           // (100000 × 0.1 + 104000 × 0.3) / 0.4
  assert.equal(p.margin, 5500);              // 11000 / 5 + 33000 / 10
  assert.equal(p.upnl, 2800);
  assert.equal(p.liq, 95000, 'liq closest to the mark');
  assert.equal(p.leverage, 110000 * 0.4 / 5500);
  assert.ok(Math.abs(p.funding - 0.24) < 1e-12);
  assert.equal(p.openedAt, now - 8 * H, 'earliest open');
  assert.equal(p.sub, null);

  // the same id in two accounts must not collide
  assert.equal(s.trades.size, 2);
  assert.equal(s.funding.size, 2);
});

test('a second key of the same account is ignored, not counted twice', async () => {
  const { ad, s, calls, warns } = await run(['k1', 'k1dup']);
  assert.equal(ad.label, 'read-only key');
  assert.equal(s.account?.equity, 683.5);
  assert.equal(s.trades.size, 1);
  assert.equal(calls.filter(c => c.endsWith('/account/info')).length, 2, 'accounts looked up once, not per call');
  assert.equal(warns.filter(w => w.includes('again')).length, 1);
});
