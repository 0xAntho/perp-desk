import type { Position } from '../api';
import { EXCHANGE_COLOR, date, price, qty, tone, usd } from '../format';
import { Skel } from './Kpis';

export function PositionsTable({ positions, isAll, names }: { positions?: Position[]; isAll: boolean; names: Record<string, string> }) {
  const notional = (positions ?? []).reduce((a, p) => a + p.mark * p.size, 0);
  return (
    <section className="card elev-sm panel" style={{ gridArea: 'pos' }}>
      <div className="panel-head">
        <h4>Open positions</h4>
        <span className="tag tag-neutral">{positions?.length ?? '…'}</span>
        <span className="panel-note num" style={{ marginLeft: 'auto' }}>{usd(notional, false, 0)} notional</span>
      </div>
      <div className="table-wrap">
        <table className="table positions num">
          <thead>
            <tr>
              {isAll && <th>Exchange</th>}
              <th>Symbol</th><th>Side</th><th className="r">Size</th><th className="r">Entry</th><th className="r">Mark</th>
              <th className="r">Liq.</th><th className="r">Lev.</th><th className="r">Margin</th><th className="r">Unrealized PnL</th>
              <th className="r">ROE</th><th className="r">Funding</th><th className="r">Opened</th>
            </tr>
          </thead>
          <tbody>
            {!positions && <tr><td colSpan={13}><Skel w="100%" h={24} /></td></tr>}
            {positions && !positions.length && <tr><td colSpan={13} className="text-muted">No open positions.</td></tr>}
            {positions?.map(p => (
              <tr key={`${p.exchange}:${p.sub}:${p.symbol}`}>
                {isAll && <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} className="nowrap"><span className="dot" style={{ background: EXCHANGE_COLOR[p.exchange] }} />{names[p.exchange]}{p.sub ? ' · ' + p.sub : ''}</span></td>}
                <td style={{ fontWeight: 600 }}>{p.symbol}-PERP</td>
                <td><span className={`tag ${p.side === 'Long' ? 'tag-accent-2' : 'tag-accent'}`}>{p.side}</span></td>
                <td className="r nowrap">{qty(p.size)} {p.symbol}</td>
                <td className="r">{price(p.entry)}</td>
                <td className="r">{price(p.mark)}</td>
                <td className="r neg">{p.liq == null ? '—' : price(p.liq)}</td>
                <td className="r">{p.leverage}×</td>
                <td className="r">{usd(p.margin)}</td>
                <td className={`r ${tone(p.upnl)}`} style={{ fontWeight: 600 }}>{usd(p.upnl, true)}</td>
                <td className={`r ${tone(p.upnl)}`}>{(p.roe >= 0 ? '+' : '−') + Math.abs(p.roe * 100).toFixed(2)}%</td>
                <td className={`r ${tone(p.funding)}`}>{usd(p.funding, true)}</td>
                <td className="r nowrap muted">{p.openedAt ? date(p.openedAt, true) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
