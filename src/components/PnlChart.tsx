import { useMemo, useState } from 'react';
import type { Pnl, Range } from '../api';
import { EXCHANGE_COLOR, RANGE_TEXT, compact, date, tone, usd } from '../format';
import { Skel } from './Kpis';

const W = 1000, H = 260;

export function PnlChart({ pnl, isAll, range }: { pnl?: Pnl; isAll: boolean; range: Range }) {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<number | null>(null);

  const all = useMemo(() => {
    if (!pnl) return [];
    const ex = pnl.series.map(s => ({ ...s, id: s.id as string, color: EXCHANGE_COLOR[s.id] }));
    if (!isAll) return ex;
    const total = { id: 'total', name: 'Total', color: EXCHANGE_COLOR.total, vals: pnl.points.map((_, k) => ex.reduce((a, s) => a + s.vals[k], 0)) };
    return [total, ...ex];
  }, [pnl, isAll]);
  const visible = isAll ? all.filter(s => !hidden[s.id]) : all;
  const N = pnl?.points.length ?? 0;

  let mn = 0, mx = 0;
  for (const s of visible) for (const v of s.vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mx === mn) mx = mn + 1;
  const pad = (mx - mn) * 0.08; mn -= pad; mx += pad;
  const y = (v: number) => H - ((v - mn) / (mx - mn)) * H;
  const x = (i: number) => (N > 1 ? (i / (N - 1)) * W : 0);
  const line = (vals: number[]) => vals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join('');
  const y0 = y(0);

  const yTicks = [0, 1, 2, 3].map(k => compact(mx - ((mx - mn) * k) / 3));
  const xTicks = pnl ? [0, 0.25, 0.5, 0.75, 1].map(f => {
    const t = pnl.points[Math.round(f * (N - 1))];
    return range === '24h' ? new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : date(t);
  }) : [];

  const k = hover == null ? null : Math.min(N - 1, hover);
  const pct = k == null || N < 2 ? 0 : (k / (N - 1)) * 100;
  const headline = pnl?.flows.gross ?? 0;

  return (
    <section className="card elev-sm panel" style={{ gridArea: 'curve' }}>
      <div className="panel-head" style={{ alignItems: 'center' }}>
        <h4 className="grow">PnL curve</h4>
        {isAll && (
          <div className="series-toggles">
            {all.map(s => {
              const on = !hidden[s.id];
              return (
                <button key={s.id} className="series-toggle" aria-pressed={on} onClick={() => setHidden(h => ({ ...h, [s.id]: !h[s.id] }))}>
                  <span className="series-swatch" style={{ borderColor: s.color, background: on ? s.color : 'transparent' }} />{s.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="chart-headline">
        <span className={`num ${tone(headline)}`}>{pnl ? usd(headline, true) : <Skel w={140} />}</span>
        <span>realized over {RANGE_TEXT[range][1]}</span>
      </div>
      <div className="chart">
        <div className="chart-y num">{yTicks.map((t, i) => <span key={i}>{pnl ? t : ''}</span>)}</div>
        <div className="chart-main">
          <div
            className="chart-plot"
            onMouseMove={ev => {
              if (N < 2) return;
              const r = ev.currentTarget.getBoundingClientRect();
              const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
              const i = Math.round(f * (N - 1));
              if (i !== hover) setHover(i);
            }}
            onMouseLeave={() => setHover(null)}
          >
            {pnl ? (
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Cumulative realized PnL over ${RANGE_TEXT[range][1]}`}>
                <line x1={0} x2={W} y1={y0} y2={y0} style={{ stroke: 'var(--color-divider)', strokeWidth: 1.5, strokeDasharray: '5 5', vectorEffect: 'non-scaling-stroke' }} />
                {visible[0] && <path d={line(visible[0].vals) + `L${W} ${y0}L0 ${y0}Z`} style={{ fill: visible[0].color, opacity: 0.08 }} />}
                {visible.slice().reverse().map(s => (
                  <path key={s.id} d={line(s.vals)} style={{ fill: 'none', stroke: s.color, strokeWidth: s === visible[0] ? 2.75 : 1.75, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }} />
                ))}
              </svg>
            ) : <Skel w="100%" h={200} />}
            {pnl && k != null && visible.length > 0 && (
              <>
                <div className="hover-line" style={{ left: `${pct}%` }} />
                {visible.map(s => <div key={s.id} className="hover-dot" style={{ left: `${pct}%`, top: `${(y(s.vals[k]) / H) * 100}%`, background: s.color }} />)}
                <div className="tooltip elev-md" style={{ left: `${pct}%`, transform: pct > 55 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}>
                  <span style={{ fontWeight: 600 }}>{date(pnl.points[k], range !== 'All')}</span>
                  {visible.map(s => (
                    <span key={s.id} className="tooltip-row">
                      <span className="dot" style={{ background: s.color }} /><span>{s.name}</span>
                      <span className={`num ${tone(s.vals[k])}`}>{usd(s.vals[k], true)}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="chart-x">{xTicks.map((t, i) => <span key={i}>{t}</span>)}</div>
        </div>
      </div>
    </section>
  );
}
