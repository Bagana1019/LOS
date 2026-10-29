import type { IntegrationMode } from '@los/contracts';

/** Core-ийн депозит данс (Core нь хамрах хүрээнээс гадуур — docs/01 §1). Тайлангийн `deposit-balances` ашиглана. */
export interface DepositCustomerRef {
  customerId: string;
  /** Задгай (plain) регистр — Core руу хүсэлт илгээхэд л хэрэгтэй. Лог-д бичихгүй. */
  registerNo: string;
}

export type DepositAccountStatus = 'ACTIVE' | 'DORMANT' | 'CLOSED';

export interface DepositAccountBalance {
  customerId: string;
  /** Дансны дугаар (plain). API-д гаргахдаа заавал нуугдмал болгоно. */
  accountNo: string;
  currency: string;
  balance: number;
  availableBalance: number;
  status: DepositAccountStatus;
}

export interface ListDepositBalancesRequest {
  /** Үлдэгдлийн өдөр (YYYY-MM-DD, Asia/Ulaanbaatar). */
  asOf: string;
  customers: DepositCustomerRef[];
}

/** CLAUDE.md §3.2.7: гадаад интеграци = interface + Mock (deterministic) + Real. */
export interface CoreDepositPort {
  readonly mode: IntegrationMode;
  /** Харилцагч бүрийн депозит дансууд (данстай харилцагч л буцна). */
  listBalances(req: ListDepositBalancesRequest): Promise<DepositAccountBalance[]>;
}
