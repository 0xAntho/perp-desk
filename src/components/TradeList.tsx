import type { Trade } from '../api';
import { date, market, usd } from '../format';
import { Skel } from './Kpis';

interface Props { kind: 'best' | 'worst'; trades?: Trade[]; rangeLabel: string; isAll: boolean; names: Record<string, string> }

export function TradeList({ kind, trades, rangeLabel, isAll, names }: Props) {
  const best = kind === 'best';
  const t = best ? 'pos' : 'neg';
  return (
    <section className="card elev-sm panel" style={{ gridArea: kind, gap: 'var(--space-2)' }}>
      <div className="panel-head">
        <h4 className="grow">{best ? 'Best trades' : 'Worst trades'}</h4>
        <span className={`tag ${best ? 'tag-accent-2' : 'tag-accent'}`}>{best ? 'Top' : 'Bottom'} 5 · {rangeLabel}</span>
      </div>
      {!trades && [0, 1, 2].map(i => <div key={i} className="trade-row"><Skel w={24} h={24} /><Skel w="60%" h={30} /><Skel w={70} /></div>)}
      {trades?.map((tr, i) => {
        const m = market(tr.symbol);
        return (
          <div key={tr.exchange + tr.id} className="trade-row">
            <span className={`rank ${t}`}>{i + 1}</span>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span className="trade-sym">{m.coin}-PERP<span className={`tag ${tr.side === 'Long' ? 'tag-accent-2' : 'tag-accent'}`}>{tr.side}</span></span>
              <span className="trade-meta">{[isAll && names[tr.exchange], m.dex, tr.sub, date(tr.ts, true)].filter(Boolean).join(' · ')}</span>
            </div>
            <span className={`trade-pnl num ${t}`}>{usd(tr.realizedPnl, true)}</span>
          </div>
        );
      })}
      {trades && !trades.length && <p className="text-muted empty">No {best ? 'winning' : 'losing'} trades in this range.</p>}
    </section>
  );
}
