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
  account: string;         // stable account id (wallet, exchange account id…): history resumes per account
  sub: string | null;
  id: string;
  symbol: string;
  side: Side;
  realizedPnl: number;     // gross, before fees
  fee: number;
  ts: number;
  group?: string;          // fills sharing a group are one order: merged in trade lists and activity counts
}

export interface FundingPayment {
  exchange: ExchangeId;
  account: string;
  id: string;
  symbol: string;
  usdc: number;            // + = received, − = paid
  ts: number;
}

/** Where to resume an account's history: 0 for an account with nothing stored yet. */
export type Since = (account: string) => number;

export interface Adapter {
  readonly id: ExchangeId;
  readonly name: string;
  readonly mock: boolean;
  /** Short identifier shown in the UI (wallet, account id…). */
  readonly label: string;
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  /** Incremental: everything with ts >= since(account), per account. Must be safe to call repeatedly (dedupe by id). */
  getTrades(since: Since): Promise<Trade[]>;
  getFunding(since: Since): Promise<FundingPayment[]>;
}
