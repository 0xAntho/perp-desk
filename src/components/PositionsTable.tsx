import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Position } from '../api';
import { EXCHANGE_COLOR, date, market, price, qty, tone, usd } from '../format';
import { Skel } from './Kpis';

type Col = 'symbol' | 'side' | 'size' | 'entry' | 'mark' | 'liq' | 'lev' | 'margin' | 'upnl' | 'roe' | 'funding' | 'opened';

const HEAD: Record<Col, [string, boolean]> = {   // label, right-aligned
  symbol: ['Symbol', false], side: ['Side', false], size: ['Size', true], entry: ['Entry', true], mark: ['Mark', true],
  liq: ['Liq.', true], lev: ['Lev.', true], margin: ['Margin', true], upnl: ['Unrealized PnL', true],
  roe: ['ROE', true], funding: ['Funding', true], opened: ['Opened', true],
};
const WIDE: Col[] = ['symbol', 'side', 'size', 'entry', 'mark', 'liq', 'lev', 'margin', 'upnl', 'roe', 'funding', 'opened'];
// when the card can't show every column (e.g. Rail), bring PnL next to the symbol instead of scrolled away
const NARROW: Col[] = ['symbol', 'side', 'upnl', 'roe', 'size', 'entry', 'mark', 'liq', 'lev', 'margin', 'funding', 'opened'];

function cells(p: Position): Record<Col, ReactNode> {
  const m = market(p.symbol);
  return {
    symbol: <td key="symbol" className="nowrap" style={{ fontWeight: 600 }}>{m.coin}-PERP{m.dex && <span className="text-muted" style={{ fontWeight: 400 }}> · {m.dex}</span>}</td>,
    side: <td key="side"><span className={`tag ${p.side === 'Long' ? 'tag-accent-2' : 'tag-accent'}`}>{p.side}</span></td>,
    size: <td key="size" className="r nowrap">{qty(p.size)} {m.coin}</td>,
    entry: <td key="entry" className="r">{price(p.entry)}</td>,
    mark: <td key="mark" className="r">{price(p.mark)}</td>,
    liq: <td key="liq" className="r neg">{p.liq == null ? '—' : price(p.liq)}</td>,
    lev: <td key="lev" className="r">{p.leverage}×</td>,
    margin: <td key="margin" className="r">{usd(p.margin)}</td>,
    upnl: <td key="upnl" className={`r ${tone(p.upnl)}`} style={{ fontWeight: 600 }}>{usd(p.upnl, true)}</td>,
    roe: <td key="roe" className={`r ${tone(p.upnl)}`}>{(p.roe >= 0 ? '+' : '−') + Math.abs(p.roe * 100).toFixed(2)}%</td>,
    funding: <td key="funding" className={`r ${tone(p.funding)}`}>{usd(p.funding, true)}</td>,
    opened: <td key="opened" className="r nowrap muted">{p.openedAt ? date(p.openedAt, true) : '—'}</td>,
  };
}

export function PositionsTable({ positions, isAll, names }: { positions?: Position[]; isAll: boolean; names: Record<string, string> }) {
  const notional = (positions ?? []).reduce((a, p) => a + p.mark * p.size, 0);
  const wrap = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // column order doesn't change the table's width, so this can't flip back and forth
    const ro = new ResizeObserver(() => setNarrow(el.scrollWidth > el.clientWidth + 1));
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  const order = narrow ? NARROW : WIDE;

  return (
    <section className="card elev-sm panel" style={{ gridArea: 'pos' }}>
      <div className="panel-head">
        <h4>Open positions</h4>
        <span className="tag tag-neutral">{positions?.length ?? '…'}</span>
        <span className="panel-note num" style={{ marginLeft: 'auto' }}>{usd(notional, false, 0)} notional</span>
      </div>
      <div className="table-wrap" ref={wrap}>
        <table className="table positions num">
          <thead>
            <tr>
              {isAll && <th>Exchange</th>}
              {order.map(c => <th key={c} className={HEAD[c][1] ? 'r' : undefined}>{HEAD[c][0]}</th>)}
            </tr>
          </thead>
          <tbody>
            {!positions && <tr><td colSpan={13}><Skel w="100%" h={24} /></td></tr>}
            {positions && !positions.length && <tr><td colSpan={13} className="text-muted">No open positions.</td></tr>}
            {positions?.map(p => {
              const row = cells(p);
              return (
                <tr key={`${p.exchange}:${p.sub}:${p.symbol}`}>
                  {isAll && <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} className="nowrap"><span className="dot" style={{ background: EXCHANGE_COLOR[p.exchange] }} />{names[p.exchange]}{p.sub ? ' · ' + p.sub : ''}</span></td>}
                  {order.map(c => row[c])}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
