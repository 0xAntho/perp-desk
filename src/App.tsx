import { useEffect, useState } from 'react';
import { useActivity, usePnl, usePositions, useRefresh, useSummary, useTopTrades, type Range, type Tab } from './api';
import { ActivityHeatmap } from './components/ActivityHeatmap';
import { Kpis } from './components/Kpis';
import { PnlChart } from './components/PnlChart';
import { PositionsTable } from './components/PositionsTable';
import { TradeList } from './components/TradeList';
import { EXCHANGE_COLOR, RANGE_TEXT, ago } from './format';

type Theme = 'light' | 'dark';

const HEAT_WEEKS = 26;
const EXCHANGES = [
  { id: 'hyperliquid', name: 'Hyperliquid' },
  { id: 'perpl', name: 'Perpl' },
  { id: 'arcus', name: 'Arcus' },
  { id: 'extended', name: 'Extended' },
] as const;
const NAMES: Record<string, string> = Object.fromEntries(EXCHANGES.map(e => [e.id, e.name]));

function usePersisted<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => { try { return (localStorage.getItem(key) as T) || initial; } catch { return initial; } });
  return [v, (next: T) => { setV(next); try { localStorage.setItem(key, next); } catch { /* storage unavailable */ } }];
}

function useNow(every = 10_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}

export function App() {
  const [tab, setTab] = useState<Tab>('all');
  const [range, setRange] = useState<Range>('7D');
  const prefersDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  const [theme, setTheme] = usePersisted<Theme>('perpdesk.theme', prefersDark ? 'dark' : 'light');
  const now = useNow();

  const summary = useSummary(tab);
  const positions = usePositions(tab);
  const pnl = usePnl(tab, range);
  const top = useTopTrades(tab, range);
  const activity = useActivity(tab, HEAT_WEEKS);
  const refresh = useRefresh();

  const isAll = tab === 'all';
  const apiDown = summary.isError && !summary.data;

  return (
    <div className="dash" data-theme={theme}>
      <div className="page">
        <header className="topbar">
          <div className="brand"><div className="brand-mark" aria-hidden /><span className="brand-name">Perp desk</span></div>
          {apiDown
            ? <span className="updated" style={{ color: 'var(--neg)' }}>Backend unreachable</span>
            : <span className="updated">Updated {ago(summary.data?.updatedAt ?? null, now)}</span>}
          <button className="btn btn-secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>{refresh.isPending ? 'Refreshing…' : 'Refresh'}</button>
          <button className="btn btn-secondary btn-icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme" aria-label="Toggle theme">
            {theme === 'dark'
              ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>}
          </button>
        </header>

        <div className="titlebar">
          <div className="titlebar-main">
            <h1>{isAll ? 'All exchanges' : NAMES[tab]}</h1>
            <div className="seg-scroll">
              <div className="seg seg-lg" role="radiogroup" aria-label="Exchange">
                {[{ id: 'all' as Tab, name: 'All' }, ...EXCHANGES].map(t => (
                  <label key={t.id} className="seg-opt">
                    <input type="radio" name="tab" checked={tab === t.id} onChange={() => setTab(t.id)} />
                    <span className="dot" style={{ background: t.id === 'all' ? EXCHANGE_COLOR.total : EXCHANGE_COLOR[t.id] }} />{t.name}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="seg seg-md" role="radiogroup" aria-label="Range">
            {(['24h', '7D', '30D', 'All'] as const).map(r => (
              <label key={r} className="seg-opt"><input type="radio" name="range" checked={range === r} onChange={() => setRange(r)} />{r}</label>
            ))}
          </div>
        </div>

        <div className="grid">
          <Kpis summary={summary.data} pnl={pnl.data} isAll={isAll} range={range} onSelect={setTab} />
          <PnlChart pnl={pnl.data} isAll={isAll} range={range} />
          <ActivityHeatmap days={activity.data} weeks={HEAT_WEEKS} />
          <PositionsTable positions={positions.data} isAll={isAll} names={NAMES} />
          <div className="trades-pair" style={{ gridArea: 'trades' }}>
            <TradeList kind="best" trades={top.data?.best} rangeLabel={RANGE_TEXT[range][0]} isAll={isAll} names={NAMES} />
            <TradeList kind="worst" trades={top.data?.worst} rangeLabel={RANGE_TEXT[range][0]} isAll={isAll} names={NAMES} />
          </div>
        </div>
      </div>
    </div>
  );
}
