import { Injectable } from '@nestjs/common';
import { DomainError } from '@los/nest-common';
import type { Tx } from '../../prisma.service';
import { branchCodeOf, counterScopeKey, formatContractNo, ubDate } from './approval.rules';

/** BR-11 / FR-11.1: батлагдмагц `contract_number_template` (admin) загвараар гэрээний дугаар үүсгэнэ. Дараалал нь атомик тоолуур (давхцахгүй). */
@Injectable()
export class ContractNumberService {
  async next(tx: Tx, orgId: string, branchId: string, now: Date): Promise<string> {
    const template = await tx.contractNumberTemplate.findFirst({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!template) throw new DomainError('CONTRACT_TEMPLATE_MISSING', 'Гэрээний дугаарын загвар тохируулаагүй байна (Тохиргоо)', 422);
    const { yymmdd, yyyymmdd } = ubDate(now);
    const scopeKey = counterScopeKey(template.seqScope, branchId, yyyymmdd);
    const rows = await tx.$queryRaw<Array<{ seq: number }>>`
      INSERT INTO origination.contract_number_counter (template_id, scope_key, next_seq) VALUES (${template.id}, ${scopeKey}, ${template.nextSeq + 1})
      ON CONFLICT (template_id, scope_key) DO UPDATE SET next_seq = origination.contract_number_counter.next_seq + 1
      RETURNING next_seq - 1 AS seq`;
    return formatContractNo(template.pattern, { prefix: template.prefix, branch: branchCodeOf(branchId), yymmdd, seq: Number(rows[0].seq) });
  }
}
