import { ProviderRejectedError, ProviderUnavailableError } from '../payment-provider/provider-errors';
import type { BankGatewayPort, IncomingTransfer, ListIncomingRequest, NameCheckRequest, NameCheckResult, TransferRequest, TransferResult } from './bank-transfer.client';
import { isNameMatch, nameSimilarity } from './name-similarity';

// Deterministic mock. Нэр-дугаар тулгалт: бүртгэлтэй нэр = дансны ХАМГИЙН СҮҮЛИЙН ЦИФРЭЭР fixture жагсаалтаас (0..9).
// Дансны дугаар цифрээс бүрдээгүй / 4-өөс богино, эсвэл `0000`-оор төгссөн бол "данс олдсонгүй" (registeredName=null).
export const MOCK_ACCOUNT_HOLDERS = [
  'Бат-Эрдэнэ Дорж', 'Сарангэрэл Болд', 'Өлзийбаяр Ганбат', 'Үүрцайх Төмөр', 'Мөнхцэцэг Баяр',
  'Энхтуяа Нямдорж', 'Гэрэлмаа Очир', 'Тэмүүлэн Пүрэв', 'Номин Дашдорж', 'Оюунчимэг Лхагва',
] as const;

/** Mock горимд `payment.collection_account` тохируулаагүй үед ашиглах хүлээн авах данс. */
export const MOCK_COLLECTION_ACCOUNT = { bankCode: 'KHAN', accountNo: '5000000001', accountName: 'ЛОС ББСБ ХК' } as const;

export function mockRegisteredName(accountNo: string): string | null {
  if (!/^\d{4,}$/.test(accountNo) || accountNo.endsWith('0000')) return null;
  return MOCK_ACCOUNT_HOLDERS[Number(accountNo[accountNo.length - 1])];
}

export interface MockBankOptions { now?: () => Date }
type BankMethod = 'nameCheck' | 'listIncomingTransfers' | 'transfer';

export class MockBankGateway implements BankGatewayPort {
  readonly mode = 'mock' as const;
  private readonly now: () => Date;
  private readonly incoming: IncomingTransfer[] = [];
  private readonly transfers = new Map<string, TransferResult>();
  private readonly failures: Array<{ method?: BankMethod; error: Error; remaining: number }> = [];
  private counter = 0;

  constructor(opts: MockBankOptions = {}) { this.now = opts.now ?? (() => new Date()); }

  isAvailable() { return true; }
  unavailableReason() { return null; }

  /** Тестийн helper: бүх төлөвийг (орж ирсэн шилжүүлэг, payout, дараалал, төлөвлөсөн алдаа) цэвэрлэнэ. */
  reset(): void { this.incoming.length = 0; this.transfers.clear(); this.failures.length = 0; this.counter = 0; }

  failNext(opts: { method?: BankMethod; error?: Error; times?: number } = {}): void {
    this.failures.push({ method: opts.method, error: opts.error ?? new ProviderUnavailableError('Банк', 'Банкны gateway mock: тест хийж буй алдаа'), remaining: opts.times ?? 1 });
  }

  private maybeFail(method: BankMethod) {
    const i = this.failures.findIndex((f) => !f.method || f.method === method);
    if (i < 0) return;
    const f = this.failures[i];
    if (--f.remaining <= 0) this.failures.splice(i, 1);
    throw f.error;
  }

  /** Тестийн helper: манай данс руу орж ирсэн шилжүүлэг нэмнэ. bankReference өгөөгүй бол дараалсан (MOCKTXN-0001…). */
  pushIncoming(t: Partial<IncomingTransfer> & Pick<IncomingTransfer, 'amount' | 'description'>): IncomingTransfer {
    const entry: IncomingTransfer = {
      bankCode: MOCK_COLLECTION_ACCOUNT.bankCode, accountNo: MOCK_COLLECTION_ACCOUNT.accountNo, currency: 'MNT', valueDate: this.now(),
      bankReference: `MOCKTXN-${String(++this.counter).padStart(4, '0')}`, payerName: 'Тест Төлөгч', payerAccount: '5099887766', ...t,
    };
    this.incoming.push(entry);
    return entry;
  }

  async nameCheck(req: NameCheckRequest): Promise<NameCheckResult> {
    this.maybeFail('nameCheck');
    const registeredName = mockRegisteredName(req.accountNo);
    if (!registeredName) return { matched: false, registeredName: null, similarity: 0 };
    const similarity = nameSimilarity(registeredName, req.holderName);
    return { matched: isNameMatch(similarity), registeredName, similarity };
  }

  async listIncomingTransfers(req: ListIncomingRequest): Promise<IncomingTransfer[]> {
    this.maybeFail('listIncomingTransfers');
    return this.incoming
      .filter((t) => t.accountNo === req.accountNo && t.valueDate.getTime() >= req.since.getTime())
      .sort((a, b) => a.valueDate.getTime() - b.valueDate.getTime() || a.bankReference.localeCompare(b.bankReference))
      .map((t) => ({ ...t }));
  }

  async transfer(req: TransferRequest): Promise<TransferResult> {
    this.maybeFail('transfer');
    if (!(req.amount > 0)) throw new ProviderRejectedError('Банк', 'INVALID_AMOUNT', 'Банк: шилжүүлгийн дүн эерэг байх ёстой');
    const existing = this.transfers.get(req.reference);
    if (existing) return existing;
    const result: TransferResult = { bankReference: `MOCKOUT-${String(++this.counter).padStart(4, '0')}`, status: 'COMPLETED', executedAt: this.now() };
    this.transfers.set(req.reference, result);
    return result;
  }
}
