import { useMemo } from 'react';
import type { ActivityDay } from '../api';

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function ActivityHeatmap({ days, weeks }: { days?: ActivityDay[]; weeks: number }) {
  const { cols, total } = useMemo(() => {
    const counts = new Map((days ?? []).map(d => [d.date, d.count]));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    // weeks run Monday → Sunday; the last column holds the current week
    const end = new Date(today); end.setDate(today.getDate() + (6 - ((today.getDay() + 6) % 7)));
    const start = new Date(end); start.setDate(end.getDate() - weeks * 7 + 1);
    let total = 0, lastMonth = -1;
    const active: number[] = [];
    const cols = [];
    for (let w = 0; w < weeks; w++) {
      const cells = [];
      let month = '';
      for (let d = 0; d < 7; d++) {
        const dt = new Date(start); dt.setDate(start.getDate() + w * 7 + d);
        const future = dt > today;
        const c = future ? 0 : counts.get(keyOf(dt)) ?? 0;
        if (!future) { total += c; if (c > 0) active.push(c); }
        if (d === 0 && dt.getMonth() !== lastMonth) {
          month = w === 0 && dt.getDate() > 14 ? '' : dt.toLocaleString('en-US', { month: 'short' });
          lastMonth = dt.getMonth();
        }
        cells.push({ c, future, title: future ? '' : `${c} trade${c === 1 ? '' : 's'} · ${dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` });
      }
      cols.push({ month, cells });
    }
    // levels by quartile of active days, so a few huge days don't wash out the rest
    active.sort((a, b) => a - b);
    const q = [0.25, 0.5, 0.75].map(p => active[Math.floor(p * (active.length - 1))] ?? 0);
    const level = (c: number) => c === 0 ? 0 : 1 + q.filter(t => c > t).length;
    const bg = (c: number, future: boolean) => future ? 'transparent' : `var(--heat${level(c)})`;
    return { cols: cols.map(col => ({ ...col, cells: col.cells.map(x => ({ ...x, bg: bg(x.c, x.future) })) })), total };
  }, [days, weeks]);

  return (
    <section className="card elev-sm panel" style={{ gridArea: 'heat' }}>
      <div className="panel-head">
        <h4 className="grow">Activity</h4>
        <span className="panel-note">{days ? `${total.toLocaleString('en-US')} trades` : '…'} · last {weeks} weeks</span>
      </div>
      <div className="heat" style={{ opacity: days ? 1 : 0.5 }}>
        <div className="heat-row">{cols.map((w, i) => <div key={i} className="heat-month">{w.month}</div>)}</div>
        <div className="heat-row">
          {cols.map((w, i) => (
            <div key={i} className="heat-col">
              {w.cells.map((d, j) => <div key={j} className="heat-cell" title={d.title} style={{ background: d.bg }} />)}
            </div>
          ))}
        </div>
      </div>
      <div className="heat-legend">
        <span style={{ marginRight: 4 }}>Less</span>
        {[0, 1, 2, 3, 4].map(i => <span key={i} className="dot" style={{ background: `var(--heat${i})` }} />)}
        <span style={{ marginLeft: 4 }}>More</span>
      </div>
    </section>
  );
}
