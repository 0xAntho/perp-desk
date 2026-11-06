// Variational has no API yet: history comes from the CSV import (`npm run import:variational`), already
// in the store. This adapter only makes it show up; balance and positions are unknown until the API ships.
import type { Account, Adapter, FundingPayment, Position, Trade } from '../types.js';

export class VariationalAdapter implements Adapter {
  readonly id = 'variational' as const;
  readonly name = 'Variational';
  readonly mock = false;
  readonly label = 'CSV history';

  async getAccount(): Promise<Account> { return { exchange: this.id, equity: 0, freeCollateral: 0, ts: Date.now() }; }
  async getPositions(): Promise<Position[]> { return []; }
  async getTrades(): Promise<Trade[]> { return []; }
  async getFunding(): Promise<FundingPayment[]> { return []; }
}
