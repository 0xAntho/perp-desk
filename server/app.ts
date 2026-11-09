// HTTP API (Implementation Plan §5).
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import * as agg from './aggregate.js';
import type { Sync } from './sync.js';

export interface AppOptions { auth?: { username: string; password: string } }

export function createApp(sync: Sync, opts: AppOptions = {}) {
  const app = new Hono();
  if (opts.auth) app.use('*', basicAuth(opts.auth));

  const pick = (exchange: string | undefined) => {
    if (!exchange || exchange === 'all') return sync.states;
    const s = sync.states.filter(x => x.adapter.id === exchange);
    return s.length ? s : null;
  };
  const range = (r: string | undefined): agg.Range => (agg.isRange(r) ? r : '7D');

  const api = new Hono();

  api.get('/summary', c => {
    const states = pick(c.req.query('exchange'));
    if (!states) return c.json({ error: 'unknown exchange' }, 400);
    const sel = agg.summary(states);
    const all = agg.summary(sync.states);
    return c.json({ balance: sel.balance, upnl: sel.upnl, updatedAt: all.updatedAt, exchanges: all.exchanges });
  });

  api.get('/positions', c => {
    const states = pick(c.req.query('exchange'));
    if (!states) return c.json({ error: 'unknown exchange' }, 400);
    return c.json(agg.positions(states, sync.pairs));
  });

  // delta-neutral pairs: a dashboard-side grouping of two open positions, nothing is sent to an exchange
  api.post('/pairs', async c => {
    const body = await c.req.json().catch(() => null) as { a?: unknown; b?: unknown } | null;
    if (typeof body?.a !== 'string' || typeof body.b !== 'string') return c.json({ error: 'expected { a, b } position keys' }, 400);
    const err = sync.pair(body.a, body.b);
    return err ? c.json({ error: err }, 400) : c.json({ ok: true });
  });

  api.delete('/pairs', c => {
    const key = c.req.query('key');
    if (!key) return c.json({ error: 'expected ?key=' }, 400);
    sync.unpair(key);
    return c.json({ ok: true });
  });

  api.get('/pnl', c => {
    const states = pick(c.req.query('exchange'));
    if (!states) return c.json({ error: 'unknown exchange' }, 400);
    return c.json(agg.pnl(states, range(c.req.query('range'))));
  });

  api.get('/trades/top', c => {
    const states = pick(c.req.query('exchange'));
    if (!states) return c.json({ error: 'unknown exchange' }, 400);
    const n = Math.max(1, Math.min(50, Number(c.req.query('n')) || 5));
    return c.json(agg.topTrades(states, range(c.req.query('range')), n));
  });

  api.get('/activity', c => {
    const states = pick(c.req.query('exchange'));
    if (!states) return c.json({ error: 'unknown exchange' }, 400);
    const weeks = Math.max(1, Math.min(52, Number(c.req.query('weeks')) || 26));
    return c.json(agg.activity(states, weeks, c.req.query('tz') || 'UTC'));
  });

  api.post('/refresh', async c => {
    await sync.refreshAll();
    return c.json({ ok: true });
  });

  app.route('/api', api);
  return app;
}
