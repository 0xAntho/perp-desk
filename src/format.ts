import type { ExchangeId } from './api';

export const EXCHANGE_COLOR: Record<ExchangeId | 'total', string> = {
  total: 'var(--color-text)',
  hyperliquid: 'var(--ex-hyperliquid)',
  perpl: 'var(--ex-perpl)',
  arcus: 'var(--ex-arcus)',
  extended: 'var(--ex-extended)',
};

export const tone = (v: number) => (v >= 0 ? 'pos' : 'neg');

export function usd(v: number, sign = false, dec = 2) {
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + '$' + s;
}

export function compact(v: number) {
  const a = Math.abs(v), sg = v < 0 ? '−' : '';
  if (a >= 1e6) return sg + '$' + (a / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return sg + '$' + (a / 1e3).toFixed(1) + 'k';
  return sg + '$' + a.toFixed(0);
}

export function price(v: number) {
  const d = v >= 1000 ? 1 : v >= 10 ? 2 : v >= 1 ? 3 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function qty(v: number) {
  const d = v >= 1000 ? 0 : v >= 10 ? 2 : v >= 1 ? 3 : 4;
  return v.toLocaleString('en-US', { maximumFractionDigits: d });
}

/** Hyperliquid HIP-3 markets come as 'dex:COIN' (e.g. 'xyz:NVDA'). */
export function market(symbol: string) {
  const i = symbol.indexOf(':');
  return i < 0 ? { coin: symbol, dex: null } : { coin: symbol.slice(i + 1), dex: symbol.slice(0, i) };
}

export function date(t: number, withTime = false) {
  return new Date(t).toLocaleString('en-US', withTime
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'short', day: 'numeric' });
}

export function ago(t: number | null, now = Date.now()) {
  if (!t) return '—';
  const s = Math.round((now - t) / 1000);
  return s < 5 ? 'just now' : s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago';
}

export const RANGE_TEXT = {
  '24h': ['24h', 'the last 24 hours'],
  '7D': ['7D', 'the last 7 days'],
  '30D': ['30D', 'the last 30 days'],
  All: ['All time', 'all time'],
} as const;
