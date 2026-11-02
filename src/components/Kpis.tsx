import type { Pnl, Summary, Tab } from '../api';
import { EXCHANGE_COLOR, RANGE_TEXT, tone, usd } from '../format';

interface Props {
  summary?: Summary; pnl?: Pnl; isAll: boolean; range: keyof typeof RANGE_TEXT;
  onSelect: (t: Tab) => void;
}

const STATUS_TEXT = { loading: 'Loading…', live: 'Live', stale: 'Stale — showing last known data', error: 'Error' } as const;

export function Kpis({ summary, pnl, isAll, range, onSelect }: Props) {
  const f = pnl?.flows;
  const flows = f && [
    ['Gross realized', f.gross], ['Fees', f.fees], ['Funding', f.funding], ['Net', f.net],
  ] as const;
  const total = summary ? summary.exchanges.reduce((a, e) => a + e.balance, 0) : 0;

  return (
    <section className="card elev-sm panel" style={{ gridArea: 'kpi', gap: 'var(--space-4)' }}>
      <div className="kpis">
        <div className="kpi" style={{ minWidth: 150 }}>
          <span className="kpi-label">Balance</span>
          <span className="kpi-value big num">{summary ? usd(summary.balance) : <Skel w={140} />}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Unrealized PnL</span>
          <span className={`kpi-value num ${summary ? tone(summary.upnl) : ''}`}>{summary ? usd(summary.upnl, true) : <Skel w={100} />}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Realized PnL · {RANGE_TEXT[range][0]}</span>
          <span className={`kpi-value num ${f ? tone(f.gross) : ''}`}>{f ? usd(f.gross, true) : <Skel w={100} />}</span>
        </div>
        <div className="flows num">
          {flows ? flows.map(([label, v]) => (
            <div key={label} className={label === 'Net' ? 'strong' : ''}><span>{label}</span><span className={tone(v)}>{usd(v, true)}</span></div>
          )) : <Skel w={200} h={72} />}
        </div>
      </div>

      {isAll && summary && (
        <div className="breakdown">
          {summary.exchanges.map(e => {
            const share = total > 0 ? Math.max(0, (e.balance / total) * 100) : 0;
            return (
              <button key={e.id} className="ex-card" onClick={() => onSelect(e.id)} title={e.error ? `${STATUS_TEXT[e.status]}: ${e.error}` : STATUS_TEXT[e.status]}>
                <span className="ex-card-name">
                  <span className="dot" style={{ background: EXCHANGE_COLOR[e.id] }} />
                  {e.name}
                  {e.status !== 'live' && <span className="status-dot" style={{ background: e.status === 'error' ? 'var(--neg)' : 'var(--color-neutral-400)' }} aria-label={STATUS_TEXT[e.status]} />}
                  {e.mock && <span className="tag tag-neutral">Mock</span>}
                </span>
                <span className="ex-card-vals num">
                  <span>{usd(e.balance, false, 0)}</span>
                  <span className={tone(e.upnl)}>{usd(e.upnl, true, 0)}</span>
                </span>
                <span className="bar"><span style={{ width: `${share.toFixed(1)}%`, background: EXCHANGE_COLOR[e.id] }} /></span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function Skel({ w, h }: { w: number | string; h?: number }) {
  return <span className="skeleton" style={{ display: 'inline-block', width: w, height: h ?? '0.9em' }} />;
}
