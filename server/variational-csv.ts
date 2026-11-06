// Variational's trade-history CSV export, until its API is live. Columns:
// id,created_at,side,instrument_type,underlying,price,qty,trade_type,status,liquidation_trigger_price
// The export has fills only: no PnL, fee or funding. Realized PnL is rebuilt from the fills (average
// cost per underlying); fees are 0 (Variational charges no trading fee, its cut is in the spread).
import type { Side, Trade } from './types.js';

export const VARIATIONAL_ACCOUNT = 'csv';   // no account id in the export
const EPS = 1e-9;

/** Fills of the CSV as trades, oldest first. Ids are the export's fill ids, so re-importing changes nothing. */
export function parseVariationalCsv(text: string): Trade[] {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  const need = ['id', 'created_at', 'side', 'underlying', 'price', 'qty', 'status'];
  const missing = need.filter(c => !cols.includes(c));
  if (missing.length) throw new Error(`not a Variational trade CSV: missing ${missing.join(', ')}`);
  const fills = lines.map(line => {
    const v = line.split(',');
    const r: Record<string, string> = Object.fromEntries(need.map(c => [c, v[cols.indexOf(c)] ?? '']));
    const ts = Date.parse(r.created_at.replace(/Z$/, '').slice(0, 23) + 'Z');   // some rows carry microseconds
    if (!Number.isFinite(ts)) throw new Error(`bad time: ${r.created_at}`);
    if (r.side !== 'buy' && r.side !== 'sell') throw new Error(`bad side: ${r.side}`);
    return { id: r.id, status: r.status, underlying: r.underlying, ts, q: (r.side === 'buy' ? 1 : -1) * +r.qty, px: +r.price };
  }).filter(f => f.status === 'confirmed')
    .sort((a, b) => a.ts - b.ts);   // stable: same-millisecond fills keep file order

  const book = new Map<string, { pos: number; avg: number }>();   // signed size, average entry
  return fills.map(f => {
    const b = book.get(f.underlying) ?? { pos: 0, avg: 0 };
    let pnl = 0;
    let side: Side = f.q > 0 ? 'Long' : 'Short';
    if (Math.abs(b.pos) < EPS || Math.sign(b.pos) === Math.sign(f.q)) {
      b.avg = (b.avg * Math.abs(b.pos) + f.px * Math.abs(f.q)) / (Math.abs(b.pos) + Math.abs(f.q));
      b.pos += f.q;
    } else {
      // closes (part of) the position; any excess opens the other way at the fill price
      side = b.pos > 0 ? 'Long' : 'Short';
      const closed = Math.min(Math.abs(f.q), Math.abs(b.pos));
      pnl = closed * (f.px - b.avg) * Math.sign(b.pos);
      b.pos += f.q;
      if (Math.abs(b.pos) < EPS) b.pos = 0;
      else if (Math.sign(b.pos) === Math.sign(f.q)) b.avg = f.px;
    }
    book.set(f.underlying, b);
    return {
      exchange: 'variational', account: VARIATIONAL_ACCOUNT, sub: null, id: `csv:${f.id}`,
      symbol: f.underlying, side, realizedPnl: pnl, fee: 0, ts: f.ts,
    };
  });
}
