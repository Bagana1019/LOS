import { Injectable } from '@nestjs/common';
import { BankNameCheckResponse, type BankNameCheckRequest } from '@los/contracts';
import { withProvider } from './payment.errors';
import { ProviderRegistry } from './provider-registry';

/** FR-12.4: банкны дансны нэр-дугаар тулгалт (банкны API, mock). Дансны дугаар, нэрийг лог-д бичихгүй. */
@Injectable()
export class BankAccountService {
  constructor(private readonly registry: ProviderRegistry) {}

  async nameCheck(req: BankNameCheckRequest): Promise<BankNameCheckResponse> {
    const result = await withProvider(() => this.registry.bank.nameCheck(req));
    return BankNameCheckResponse.parse(result);
  }
}
