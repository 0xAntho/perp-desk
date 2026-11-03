import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { PerplAdapter } from './adapters/perpl.js';
import { Sync } from './sync.js';

const now = Date.now();
const H = 3600e3;

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const SECRET = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url').toString('hex');
const TOKEN = 'tok';

// Fixture responses shaped like the live Perpl API (2026-11), values made up.
// BTC: price_decimals 1, size_decimals 5. AUSD: 6 decimals.
const CONTEXT = {
  instances: [{ id: 1, collateral_token_id: 1 }],
  tokens: [{ id: 1, symbol: 'AUSD', decimals: 6 }],
  markets: [
    { id: 1, symbol: '', name: 'BTC', config: { price_decimals: 1, size_decimals: 5 } },
    { id: 20, symbol: 'ETH', name: 'ETH', config: { price_decimals: 2, size_decimals: 3 } },
  ],
};
const at = (t: number, l: number) => ({ b: 1000 + l, t, tx: 1, l });
const HISTORY = [   // newest first, as the API pages it
  // closing 0.00295 BTC: dpnl gross, fee = entry share + close fee, fnd = funding settled
  { at: at(now - 2 * H, 3), mkt: 1, acc: 3001, pid: 7, st: 1, sr: 14, sd: 1, c: '-15211689', ep: 773239, s: 295, fee: '20538', cfee: '0', dpnl: '-361608', fnd: '8850', xp: 772013 },
  // open of the position still open now
  { at: at(now - 3 * H, 2), mkt: 20, acc: 3001, pid: 9, st: 1, sr: 21, sd: 2, c: '400000000', ep: 420000, s: 1000, fee: '1000000', cfee: '0', dpnl: '0', fnd: '0' },
  { at: at(now - 4 * H, 1), mkt: 1, acc: 3001, pid: 7, st: 1, sr: 21, sd: 1, c: '3045792', ep: 773239, s: 295, fee: '4106', cfee: '0', dpnl: '0', fnd: '0' },
];

function fakeFetch(calls: string[], { throttleOnce = false } = {}) {
  let throttled = !throttleOnce;
  return (async (url: string, init: any) => {
    const target = url.replace('https://app.perpl.xyz/api', '');
    const path = target.split('?')[0];
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (path === '/v1/pub/context') return json(CONTEXT);
    if (path === '/v1/market-data/ticker') return json({ mt: 9, d: { 20: { mrk: 400000 } } });

    // every account call must carry a valid signature over the exact target
    const h = init.headers;
    const canonical = [143, 'GET', target, h['X-API-Timestamp'], h['X-API-Nonce'], createHash('sha256').update('').digest('hex')].join('\n');
    if (h['X-API-Key'] !== TOKEN || !verify(null, Buffer.from(canonical), publicKey, Buffer.from(h['X-API-Signature'], 'base64url'))) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (!throttled) { throttled = true; return new Response('', { status: 429, headers: { 'retry-after': '0.01' } }); }
    calls.push(target);
    switch (path) {
      case '/v1/trading/wallet': return json({ addr: '0x6af0', as: [{ id: 3001, b: '542932228', lb: '1000000' }] });
      case '/v1/trading/positions': return json({ mt: 26, d: [{ mkt: 20, acc: 3001, pid: 9, sd: 2, c: '400000000', ep: 420000, s: 1000, lv: 1000, ots: {} }] });
      case '/v1/trading/position-history': {
        // two pages: 2 rows, then 1
        const page = new URL(url).searchParams.get('page');
        return json(page ? { d: HISTORY.slice(2), np: '' } : { d: HISTORY.slice(0, 2), np: 'p2' });
      }
    }
    return new Response('?', { status: 400 });
  }) as typeof fetch;
}

test('rejects a secret that is not a 32-byte hex key', () => {
  assert.throws(() => new PerplAdapter(TOKEN, 'abcd', ''));
});

test('signs requests, scales integers and normalizes account, positions, trades and funding', async () => {
  const calls: string[] = [];
  const ad = new PerplAdapter(TOKEN, '0x' + SECRET, 'read-only key', fakeFetch(calls, { throttleOnce: true }));
  const sync = new Sync([ad], { warn() {} } as any);
  await sync.refreshAll();
  const s = sync.states[0];
  assert.equal(s.status, 'live', s.error ?? '');

  // ETH short 1.000 @ 4200, mark 4000, collateral 400 AUSD → uPnL +200
  const eth = s.positions[0];
  assert.equal(eth.symbol, 'ETH');
  assert.equal(eth.side, 'Short');
  assert.equal(eth.size, 1);
  assert.equal(eth.entry, 4200);
  assert.equal(eth.mark, 4000);
  assert.equal(eth.margin, 400);
  assert.equal(eth.upnl, 200);
  assert.equal(eth.leverage, 10);
  assert.equal(eth.liq, null);
  assert.equal(eth.openedAt, now - 3 * H, 'open time from the history, the snapshot has an empty ots');

  // balance excludes position collateral: 542.932228 + 400 + 200
  assert.ok(Math.abs(s.account!.equity - 1142.932228) < 1e-9);
  assert.ok(Math.abs(s.account!.freeCollateral - 541.932228) < 1e-9);

  const trades = [...s.trades.values()];
  assert.equal(trades.length, 1, 'only exits are trades');
  assert.equal(trades[0].symbol, 'BTC', 'name used when symbol is empty');
  assert.equal(trades[0].realizedPnl, -0.361608);
  assert.equal(trades[0].fee, 0.020538);
  assert.deepEqual([...s.funding.values()].map(f => f.usdc), [0.00885]);

  assert.ok(calls.some(c => c.includes('page=p2')), 'follows the cursor');
  assert.equal(calls.filter(c => c.startsWith('/v1/trading/position-history')).length, 2, 'trades and funding share one history read');
});
