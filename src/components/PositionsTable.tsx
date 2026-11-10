import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePairing, type Leg, type Position, type PositionRow } from '../api';
import { EXCHANGE_COLOR, date, market, price, qty, tone, usd } from '../format';
import { Skel } from './Kpis';

type Col = 'symbol' | 'side' | 'size' | 'entry' | 'mark' | 'liq' | 'lev' | 'margin' | 'upnl' | 'roe' | 'funding' | 'opened';
type PairRow = Extract<PositionRow, { kind: 'pair' }>;

const HEAD: Record<Col, [string, boolean]> = {   // label, right-aligned
  symbol: ['Symbol', false], side: ['Side', false], size: ['Size', true], entry: ['Entry', true], mark: ['Mark', true],
  liq: ['Liq.', true], lev: ['Lev.', true], margin: ['Margin', true], upnl: ['Unrealized PnL', true],
  roe: ['ROE', true], funding: ['Funding', true], opened: ['Opened', true],
};
const MAX_ROWS = 10;   // largest by notional (server sorts); the rest behind "Show all"
const WIDE: Col[] = ['symbol', 'side', 'size', 'entry', 'mark', 'liq', 'lev', 'margin', 'upnl', 'roe', 'funding', 'opened'];
// when the card can't show every column (e.g. Rail), bring PnL next to the symbol instead of scrolled away
const NARROW: Col[] = ['symbol', 'side', 'upnl', 'roe', 'size', 'entry', 'mark', 'liq', 'lev', 'margin', 'funding', 'opened'];

const roeCell = (roe: number, upnl: number) => <td key="roe" className={`r ${tone(upnl)}`}>{(roe >= 0 ? '+' : '−') + Math.abs(roe * 100).toFixed(2)}%</td>;
const openedCell = (t: number | null) => <td key="opened" className="r nowrap muted">{t ? date(t, true) : '—'}</td>;

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
    roe: roeCell(p.roe, p.upnl),
    funding: <td key="funding" className={`r ${tone(p.funding)}`}>{usd(p.funding, true)}</td>,
    opened: openedCell(p.openedAt),
  };
}

/** The delta-neutral row: sums of both legs; per-leg details (size, prices, leverage) are in the expanded legs. */
function pairCells(r: PairRow, open: boolean): Record<Col, ReactNode> {
  const a = market(r.long.symbol), b = market(r.short.symbol);
  const none = (c: Col) => <td key={c} className="r muted">—</td>;
  return {
    symbol: <td key="symbol" className="nowrap" style={{ fontWeight: 600 }}>
      <Icon d="m9 18 6-6-6-6" className={`chevron${open ? ' open' : ''}`} />{a.coin === b.coin ? a.coin : `${a.coin} / ${b.coin}`}-PERP
    </td>,
    side: <td key="side"><span className="tag tag-neutral nowrap">Delta neutral</span></td>,
    size: none('size'), entry: none('entry'), mark: none('mark'), liq: none('liq'), lev: none('lev'),
    margin: <td key="margin" className="r" title="Total collateral of both legs">{usd(r.collateral)}</td>,
    upnl: <td key="upnl" className={`r ${tone(r.upnl)}`} style={{ fontWeight: 600 }}>{usd(r.upnl, true)}</td>,
    roe: roeCell(r.roe, r.upnl),
    funding: <td key="funding" className={`r ${tone(r.funding)}`} title="Net funding since open: long leg + short leg">{usd(r.funding, true)}</td>,
    opened: openedCell(r.openedAt),
  };
}

const Icon = ({ d, className }: { d: string; className?: string }) => (
  <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const LINK = 'M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8';
const UNLINK = 'M15 7h2a5 5 0 0 1 0 10h-2m-6 0H7A5 5 0 0 1 7 7h2';

export function PositionsTable({ rows, isAll, names }: { rows?: PositionRow[]; isAll: boolean; names: Record<string, string> }) {
  const positions = rows?.flatMap(r => (r.kind === 'pair' ? [r.long, r.short] : [r]));
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
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows?.slice(0, MAX_ROWS);

  const { pair, unpair } = usePairing();
  const [picked, setPicked] = useState<Leg | null>(null);   // first leg, from a drag or the link button
  const [over, setOver] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const dragged = useRef<Leg | null>(null);   // set synchronously: dragover can fire before `picked` re-renders
  const first = () => dragged.current ?? picked;
  const canPair = (b: Leg, a = first()) => a != null && a.key !== b.key && a.side !== b.side;
  const join = (b: Leg) => {
    const a = first();
    if (canPair(b, a)) pair.mutate({ a: a!.key, b: b.key });
    dragged.current = null;
    setPicked(null);
    setOver(null);
  };
  const toggle = (key: string) => setExpanded(s => { const n = new Set(s); if (!n.delete(key)) n.add(key); return n; });
  const error = pair.error ?? unpair.error;

  const exchange = (...ps: Position[]) => isAll && (
    <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} className="nowrap">
      {ps.map(p => <span key={p.exchange + p.side} className="dot" style={{ background: EXCHANGE_COLOR[p.exchange] }} />)}
      {[...new Set(ps.map(p => names[p.exchange] + (p.sub ? ' · ' + p.sub : '')))].join(' / ')}
    </span></td>
  );

  const pairRows = (r: PairRow) => {
    const open = expanded.has(r.key), row = pairCells(r, open);
    return [
      <tr key={'pair:' + r.key} className="pair-row" onClick={() => toggle(r.key)} aria-expanded={open}>
        <td className="pair-col">
          <button className="btn btn-ghost pair-btn" title="Unpair" aria-label="Unpair" disabled={unpair.isPending}
            onClick={e => { e.stopPropagation(); unpair.mutate(r.key); }}><Icon d={UNLINK} /></button>
        </td>
        {exchange(r.long, r.short)}
        {order.map(c => row[c])}
      </tr>,
      ...(open ? [r.long, r.short].map(l => {
        const leg = cells(l);
        return <tr key={'leg:' + l.key} className="leg-row"><td className="pair-col" />{exchange(l)}{order.map(c => leg[c])}</tr>;
      }) : []),
    ];
  };

  const positionRow = (r: Leg) => {
    const row = cells(r), target = canPair(r), self = picked?.key === r.key;
    return (
      <tr key={r.key} draggable className={[self && 'picked', target && 'pair-target', target && over === r.key && 'drop'].filter(Boolean).join(' ')}
        onDragStart={e => { e.dataTransfer.setData('text/plain', r.key); e.dataTransfer.effectAllowed = 'link'; dragged.current = r; setTimeout(() => setPicked(r)); }}   // re-rendering the dragged row inside dragstart cancels the drag in Chrome
        onDragEnd={() => { dragged.current = null; setPicked(null); setOver(null); }}
        onDragOver={e => { if (canPair(r)) { e.preventDefault(); setOver(r.key); } }}
        onDragLeave={() => setOver(o => (o === r.key ? null : o))}
        onDrop={e => { e.preventDefault(); join(r); }}>
        <td className="pair-col">
          <button className="btn btn-ghost pair-btn" disabled={pair.isPending || (picked != null && !self && !target)}
            title={self ? 'Cancel' : picked ? 'Pair with this leg' : 'Pair into a delta-neutral trade (or drag onto the other leg)'}
            aria-label="Pair" aria-pressed={self}
            onClick={() => (self ? setPicked(null) : picked ? join(r) : setPicked(r))}><Icon d={LINK} /></button>
        </td>
        {exchange(r)}
        {order.map(c => row[c])}
      </tr>
    );
  };

  return (
    <section className="card elev-sm panel" style={{ gridArea: 'pos' }}>
      <div className="panel-head">
        <h4>Open positions</h4>
        <span className="tag tag-neutral">{positions?.length ?? '…'}</span>
        {/* in the header, not above the table: rows must not move under a drag */}
        {picked
          ? <span className="panel-note pair-hint">Pick the {picked.side === 'Long' ? 'short' : 'long'} leg for {market(picked.symbol).coin} {picked.side.toLowerCase()}
              <button className="btn btn-ghost" onClick={() => setPicked(null)}>Cancel</button></span>
          : error
            ? <span className="panel-note pair-hint neg">Couldn’t {pair.error ? 'pair' : 'unpair'}: {error.message}</span>
            : <span className="panel-note num" style={{ marginLeft: 'auto' }}>{usd(notional, false, 0)} notional</span>}
      </div>
      <div className="table-wrap" ref={wrap}>
        <table className="table positions num">
          <thead>
            <tr>
              <th className="pair-col" aria-label="Pair" />
              {isAll && <th>Exchange</th>}
              {order.map(c => <th key={c} className={HEAD[c][1] ? 'r' : undefined}>{HEAD[c][0]}</th>)}
            </tr>
          </thead>
          <tbody>
            {!rows && <tr><td colSpan={14}><Skel w="100%" h={24} /></td></tr>}
            {rows && !rows.length && <tr><td colSpan={14} className="text-muted">No open positions.</td></tr>}
            {shown?.flatMap(r => (r.kind === 'pair' ? pairRows(r) : [positionRow(r)]))}
          </tbody>
        </table>
      </div>
      {rows && rows.length > MAX_ROWS && (
        <button className="btn btn-ghost show-all" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show less' : `Show all (${rows.length})`}
        </button>
      )}
    </section>
  );
}
