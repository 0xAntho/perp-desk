// Hyperliquid's trade-history CSV export (UI → Trade History → Export), for fills older than the
// ~10k the info API still serves. Columns: time,coin,dir,px,sz,ntl,fee,feeToken,closedPnl,hash
// Times are UTC text, to the microsecond on older rows and to the second on recent ones.
import { groupOf, isPerp, sideOf } from './adapters/hyperliquid.js';
import type { Trade } from './types.js';

/** Perp fills of the CSV as trades. Ids are stable, so importing the same file twice changes nothing. */
export function parseHlCsv(text: string, user: string): Trade[] {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  const need = ['time', 'coin', 'dir', 'px', 'sz', 'fee', 'closedPnl', 'hash'];
  const missing = need.filter(c => !cols.includes(c));
  if (missing.length) throw new Error(`not a Hyperliquid trade-history CSV: missing ${missing.join(', ')}`);
  const at = (c: string) => cols.indexOf(c);
  const u = user.toLowerCase();
  const seen = new Map<string, number>();
  const out: Trade[] = [];
  for (const line of lines) {
    const v = line.split(',');
    const r = Object.fromEntries(need.map(c => [c, v[at(c)] ?? '']));
    if (!isPerp(r.coin)) continue;
    const ts = Date.parse(r.time.replace(' ', 'T').slice(0, 23) + 'Z');
    if (!Number.isFinite(ts)) throw new Error(`bad time: ${r.time}`);
    // no fill id in the export: identical fills (same second, order, price, size) are numbered in file order
    const key = `${r.hash}:${Math.floor(ts / 1000)}:${r.coin}:${r.dir}:${(+r.px).toPrecision(10)}:${(+r.sz).toPrecision(10)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    out.push({
      exchange: 'hyperliquid',
      account: u,
      sub: null,
      id: `${u}:csv:${key}:${n}`,
      symbol: r.coin,
      side: sideOf({ dir: r.dir }),
      realizedPnl: +r.closedPnl || 0,
      fee: +r.fee || 0,
      ts,
      group: groupOf(r.hash),
    });
  }
  return out;
}

/** CSV trades older than the API-sourced history; the cutoff second is skipped (the CSV has no milliseconds). */
export function importable(trades: Trade[], apiOldest: number): Trade[] {
  const cutoff = Math.floor(apiOldest / 1000) * 1000;
  return trades.filter(t => t.ts < cutoff);
}
