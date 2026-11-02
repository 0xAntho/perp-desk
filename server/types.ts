// Normalized data model: one shape for all exchanges (see Implementation Plan §2).

export type ExchangeId = 'hyperliquid' | 'perpl' | 'arcus' | 'extended';
export type Side = 'Long' | 'Short';

export interface Account {
  exchange: ExchangeId;
  equity: number;          // account value incl. unrealized PnL
  freeCollateral: number;
  ts: number;
}

export interface Position {
  exchange: ExchangeId;
  sub: string | null;      // sub-account label, when the exchange has several
  symbol: string;
  side: Side;
  size: number;            // absolute, in base units
  entry: number;
  mark: number;
  liq: number | null;      // null when the exchange doesn't return it
  leverage: number;
  margin: number;
  upnl: number;
  roe: number;             // upnl / margin
  funding: number;         // funding since open, + = received
  openedAt: number | null;
}

/** One row per fill (or per closed position, when the exchange reports it that way). */
export interface Trade {
  exchange: ExchangeId;
  sub: string | null;
  id: string;
  symbol: string;
  side: Side;
  realizedPnl: number;     // gross, before fees
  fee: number;
  ts: number;
}

export interface FundingPayment {
  exchange: ExchangeId;
  id: string;
  symbol: string;
  usdc: number;            // + = received, − = paid
  ts: number;
}

export interface Adapter {
  readonly id: ExchangeId;
  readonly name: string;
  readonly mock: boolean;
  /** Short identifier shown in the UI (wallet, account id…). */
  readonly label: string;
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  /** Incremental: everything with ts >= since. Must be safe to call repeatedly (dedupe by id). */
  getTrades(since: number): Promise<Trade[]>;
  getFunding(since: number): Promise<FundingPayment[]>;
}
