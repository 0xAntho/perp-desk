// Pure aggregation over the synced state. The frontend only renders what comes out of here.
import type { ExchangeState } from './sync.js';
import { HISTORY_DAYS } from './sync.js';
import type { Trade } from './types.js';

export const RANGES = {
  '24h': { hours: 24, step: 1 },
  '7D': { hours: 168, step: 2 },
  '30D': { hours: 720, step: 6 },
  All: { hours: HISTORY_DAYS * 24, step: 24 },
} as const;
export type Range = keyof typeof RANGES;
export const isRange = (r: unknown): r is Range => typeof r === 'string' && r in RANGES;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const upnlOf = (s: ExchangeState) => sum(s.positions.map(p => p.upnl));

export function summary(states: ExchangeState[]) {
  const all = states.map(s => ({
    id: s.adapter.id,
    name: s.adapter.name,
    label: s.adapter.label,
    mock: s.adapter.mock,
    status: s.status,
    error: s.error,
    updatedAt: s.liveAt,
    balance: s.account?.equity ?? 0,
    freeCollateral: s.account?.freeCollateral ?? 0,
    upnl: upnlOf(s),
  }));
  return {
    balance: sum(all.map(e => e.balance)),
    upnl: sum(all.map(e => e.upnl)),
    updatedAt: Math.max(0, ...all.map(e => e.updatedAt ?? 0)) || null,
    exchanges: all,
  };
}

export function positions(states: ExchangeState[]) {
  return states
    .flatMap(s => s.positions)
    .sort((a, b) => b.mark * b.size - a.mark * a.size);
}

export function pnl(states: ExchangeState[], range: Range, now = Date.now()) {
  const { hours, step } = RANGES[range];
  const from = now - hours * 3600e3;
  const points: number[] = [];
  for (let t = from; t < now; t += step * 3600e3) points.push(t);
  points.push(now);

  const series = states.map(s => {
    const trades = [...s.trades.values()].filter(t => t.ts > from && t.ts <= now).sort((a, b) => a.ts - b.ts);
    const vals: number[] = [];
    let acc = 0, i = 0;
    for (const p of points) {
      while (i < trades.length && trades[i].ts <= p) acc += trades[i++].realizedPnl;
      vals.push(acc);
    }
    const fees = sum(trades.map(t => t.fee));
    const funding = sum([...s.funding.values()].filter(f => f.ts > from && f.ts <= now).map(f => f.usdc));
    return { id: s.adapter.id, name: s.adapter.name, vals, realized: acc, fees, funding };
  });

  const gross = sum(series.map(x => x.realized));
  const fees = sum(series.map(x => x.fees));
  const funding = sum(series.map(x => x.funding));
  return {
    range, from, to: now, points,
    series: series.map(({ id, name, vals }) => ({ id, name, vals })),
    flows: { gross, fees: -fees, funding, net: gross - fees + funding },
  };
}

export function topTrades(states: ExchangeState[], range: Range, n = 5, now = Date.now()) {
  const from = now - RANGES[range].hours * 3600e3;
  const trades: Trade[] = states.flatMap(s => [...s.trades.values()]).filter(t => t.ts > from && t.ts <= now);
  return {
    best: trades.filter(t => t.realizedPnl > 0).sort((a, b) => b.realizedPnl - a.realizedPnl).slice(0, n),
    worst: trades.filter(t => t.realizedPnl < 0).sort((a, b) => a.realizedPnl - b.realizedPnl).slice(0, n),
  };
}

/** Trades per calendar day in the viewer's time zone, for the last `weeks` weeks (+1 for alignment). */
export function activity(states: ExchangeState[], weeks: number, timeZone: string, now = Date.now()) {
  let fmt: Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  const from = now - (weeks + 1) * 7 * 86400e3;
  const counts: Record<string, number> = {};
  for (const s of states) for (const t of s.trades.values()) {
    if (t.ts < from || t.ts > now) continue;
    const k = fmt.format(t.ts); // YYYY-MM-DD
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}
