import { Inject, Injectable } from '@nestjs/common';
import { PortalError } from '../../common/portal-error';
import type { CallContext } from '../../common/request-context';
import { LOAN_SERVICING, type LoanServicingPort } from '../../integrations/loan-servicing/loan-servicing.port';
import { KV_STORE, type KvStore } from '../../store/kv-store';

const CACHE_TTL_SEC = 30;

/**
 * Объект түвшний эрхийн ХОЁРДУГААР хамгаалалт (BOLA/IDOR): downstream харилцагчаар хязгаарлах ёстой ч,
 * portal-bff өөрөө `:loanId` нь нэвтэрсэн харилцагчийн зээлүүдийн жагсаалтад байгааг шалгана.
 * Жагсаалтыг 30с кэшлэнэ; кэшэд байхгүй ID-г шинэчлэн шалгана (дөнгөж олгосон зээлийг буруу татгалзахгүй).
 */
@Injectable()
export class LoanOwnershipService {
  constructor(
    @Inject(LOAN_SERVICING) private readonly loans: LoanServicingPort,
    @Inject(KV_STORE) private readonly store: KvStore,
  ) {}

  async remember(customerId: string, loanIds: string[]): Promise<void> {
    await this.store.set(`owned:${customerId}`, JSON.stringify(loanIds), CACHE_TTL_SEC);
  }

  async assertOwned(ctx: CallContext, loanId: string): Promise<void> {
    const cached = await this.store.get(`owned:${ctx.customerId}`);
    if (cached && (JSON.parse(cached) as string[]).includes(loanId)) return;
    const list = await this.loans.listLoans(ctx);
    await this.remember(ctx.customerId, list.map((l) => l.loanId));
    if (!list.some((l) => l.loanId === loanId)) throw new PortalError('LOAN_NOT_FOUND');
  }
}

/** Downstream-ээс ирсэн объект хүссэн ID-тайгаа таарахгүй бол гэрээний зөрчил — харилцагчид огт өгөхгүй. */
export function ensureSameLoan(expected: string, actual: string): void {
  if (expected !== actual) throw new PortalError('DOWNSTREAM_INVALID_RESPONSE');
}
