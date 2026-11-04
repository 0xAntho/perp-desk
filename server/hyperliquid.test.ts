import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HyperliquidAdapter } from './adapters/hyperliquid.js';
import { Sync } from './sync.js';
import * as agg from './aggregate.js';

const MAIN = '0x2222222222222222222222222222222222222222';
const SUB = '0x1111111111111111111111111111111111111111';
const now = Date.now();
const H = 3600e3;

// Fixture responses shaped like the real Hyperliquid info API.
function fakeFetch(calls: any[], { unifiedMain = false } = {}) {
  return (async (_url: string, init: any) => {
    const b = JSON.parse(init.body);
    calls.push(b);
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    switch (b.type) {
      case 'subAccounts': return json([{ name: 'grid-bot', subAccountUser: SUB }]);
      case 'userAbstraction': return json(unifiedMain && b.user === MAIN ? 'unifiedAccount' : 'default');
      case 'spotClearinghouseState':
        return json({ balances: [{ coin: 'USDC', total: '727', hold: '100' }, { coin: 'HYPE', total: '5', hold: '0' }] });
      case 'allMids': return json({ BTC: '110000', ETH: '4000' });
      case 'perpDexs': return json([null, { name: 'xyz' }]);
      case 'clearinghouseState':
        if (b.dex === 'xyz') return json(b.user === MAIN ? {
          marginSummary: { accountValue: '500' }, withdrawable: '300',
          assetPositions: [{ position: { coin: 'xyz:NVDA', szi: '2', entryPx: '180', positionValue: '380', unrealizedPnl: '20', liquidationPx: '100', marginUsed: '190', leverage: { type: 'isolated', value: 2 }, cumFunding: { sinceOpen: '0' } } }],
        } : { marginSummary: { accountValue: '0' }, withdrawable: '0', assetPositions: [] });
        return json(b.user === MAIN ? {
          marginSummary: { accountValue: '10500' }, withdrawable: '6000',
          assetPositions: [{ position: { coin: 'BTC', szi: '0.1', entryPx: '100000', positionValue: '11000', unrealizedPnl: '1000', liquidationPx: '80000', marginUsed: '2000', leverage: { type: 'cross', value: 5 }, cumFunding: { sinceOpen: '12.5' } } }],
        } : {
          marginSummary: { accountValue: '2000' }, withdrawable: '2000',
          assetPositions: [{ position: { coin: 'ETH', szi: '-1', entryPx: '4200', positionValue: '4000', liquidationPx: null, marginUsed: '400', leverage: { type: 'cross', value: 10 }, cumFunding: { sinceOpen: '-3' } } }],
        });
      case 'userFillsByTime':
        if (b.startTime > now - 10 * H) return json([]);
        return json(b.user === MAIN ? [
          { coin: 'BTC', px: '100000', sz: '0.1', side: 'B', time: now - 5 * H, startPosition: '0', dir: 'Open Long', closedPnl: '0', hash: '0xa', tid: 1, fee: '4' },
          { coin: 'ETH', px: '4100', sz: '1', side: 'A', time: now - 3 * H, startPosition: '1', dir: 'Close Long', closedPnl: '250', hash: '0xb', tid: 2, fee: '2' },
          { coin: '@107', px: '1', sz: '1', side: 'B', time: now - 2 * H, startPosition: '0', dir: 'Buy', closedPnl: '0', hash: '0xc', tid: 3, fee: '0' },
          { coin: '#1100', px: '0.56', sz: '89', side: 'B', time: now - 2 * H, startPosition: '271', dir: 'Buy', closedPnl: '40', hash: '0xe', tid: 5, fee: '0' },
        ] : [
          { coin: 'ETH', px: '4200', sz: '1', side: 'A', time: now - 4 * H, startPosition: '0', dir: 'Open Short', closedPnl: '-80', hash: '0xd', tid: 4, fee: '1' },
        ]);
      case 'userFunding':
        if (b.startTime > now - 10 * H) return json([]);
        return json([{ time: now - H, hash: '0xf' + b.user.slice(2, 6), delta: { type: 'funding', coin: 'BTC', usdc: '-1.5' } }]);
    }
    return new Response('?', { status: 400 });
  }) as typeof fetch;
}

test('rejects an invalid address', () => {
  assert.throws(() => new HyperliquidAdapter('nope'));
});

test('normalizes account, positions, fills and funding across sub-accounts', async () => {
  const calls: any[] = [];
  const hl = new HyperliquidAdapter(MAIN, fakeFetch(calls));
  const sync = new Sync([hl], { warn() {} } as any);
  await sync.refreshAll();
  const s = sync.states[0];

  assert.equal(s.status, 'live');
  assert.equal(s.account?.equity, 13000, 'includes the xyz HIP-3 dex');
  assert.equal(s.account?.freeCollateral, 8300);

  const btc = s.positions.find(p => p.symbol === 'BTC')!;
  assert.equal(btc.side, 'Long');
  assert.equal(btc.mark, 110000);
  assert.equal(btc.upnl, 1000);           // (110000 − 100000) × 0.1
  assert.equal(btc.roe, 0.5);             // 1000 / 2000
  assert.equal(btc.funding, -12.5);       // HL reports paid as positive
  assert.equal(btc.sub, 'Main');
  assert.equal(btc.openedAt, now - 5 * H);
  const eth = s.positions.find(p => p.symbol === 'ETH')!;
  assert.equal(eth.side, 'Short');
  assert.equal(eth.liq, null);
  assert.equal(eth.upnl, 200);            // (4000 − 4200) × 1 × −1
  assert.equal(eth.sub, 'grid-bot');
  const nvda = s.positions.find(p => p.symbol === 'xyz:NVDA')!;
  assert.ok(nvda, 'HIP-3 dex position is read');
  assert.equal(nvda.mark, 190);           // not in allMids: positionValue / size
  assert.equal(nvda.upnl, 20);            // (190 − 180) × 2
  assert.equal(nvda.sub, 'Main');
  assert.equal(s.positions.length, 3);

  assert.equal(s.trades.size, 3, 'spot (@107) and outcome (#1100) fills are excluded');
  assert.equal(s.funding.size, 2);

  const p = agg.pnl(sync.states, '24h');
  assert.equal(p.flows.gross, 170);
  assert.equal(p.flows.fees, -7);
  assert.equal(p.flows.funding, -3);
  assert.equal(p.flows.net, 160);
  assert.equal(p.series[0].vals.at(-1), 170);

  const top = agg.topTrades(sync.states, '24h');
  assert.equal(top.best[0].realizedPnl, 250);
  assert.equal(top.worst[0].realizedPnl, -80);

  // incremental sync doesn't duplicate
  await sync.syncHistory(s);
  assert.equal(s.trades.size, 3);
});

test('a unified account counts spot USDC as collateral', async () => {
  const hl = new HyperliquidAdapter(MAIN, fakeFetch([], { unifiedMain: true }));
  const sync = new Sync([hl], { warn() {} } as any);
  await sync.refreshAll();
  const a = sync.states[0].account!;
  // main: 727 USDC + uPnL of BTC (1000) and xyz:NVDA (20); its perp accountValues are ignored.
  // grid-bot sub-account is not unified: its 2000 accountValue counts as before. HYPE is not collateral.
  assert.equal(a.equity, 727 + 1000 + 20 + 2000);
  assert.equal(a.freeCollateral, 727 - 100 + 2000);
});

test('a failing exchange is marked error, then stale after it has had data', async () => {
  let fail = true;
  const ok = fakeFetch([]);
  const hl = new HyperliquidAdapter(MAIN, ((u: string, i: any) => fail ? Promise.resolve(new Response('', { status: 502 })) : ok(u, i)) as typeof fetch);
  const sync = new Sync([hl], { warn() {} } as any);
  await sync.refreshAll();
  assert.equal(sync.states[0].status, 'error');
  fail = false; await sync.refreshAll();
  assert.equal(sync.states[0].status, 'live');
  fail = true; await sync.syncLive(sync.states[0]);
  assert.equal(sync.states[0].status, 'stale');
  assert.equal(sync.states[0].positions.length, 3, 'keeps last known positions');
});
