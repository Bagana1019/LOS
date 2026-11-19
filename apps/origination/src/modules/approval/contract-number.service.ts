import { Injectable } from '@nestjs/common';
import { DomainError } from '@los/nest-common';
import { OrgSettings } from '../../shared/org-settings';
import type { Tx } from '../../prisma.service';
import { counterScopeKey, formatContractNo, hasBranchToken, ubDate } from './approval.rules';

/** BR-11 / FR-11.1: батлагдмагц `contract_number_template` (admin) загвараар гэрээний дугаар үүсгэнэ. Дараалал нь атомик тоолуур (давхцахгүй). */
@Injectable()
export class ContractNumberService {
  constructor(private readonly settings: OrgSettings) {}

  async next(tx: Tx, orgId: string, branchId: string, now: Date): Promise<string> {
    const template = await tx.contractNumberTemplate.findFirst({ where: { orgId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!template) throw new DomainError('CONTRACT_TEMPLATE_MISSING', 'Гэрээний дугаарын загвар тохируулаагүй байна (Тохиргоо)', 422);
    const branch = await this.branchCode(tx, orgId, branchId, template.pattern); // тоолуураас ӨМНӨ: алдаа гарвал дугаар зарцуулахгүй
    const { yymmdd, yyyymmdd } = ubDate(now);
    const scopeKey = counterScopeKey(template.seqScope, branchId, yyyymmdd);
    const rows = await tx.$queryRaw<Array<{ seq: number }>>`
      INSERT INTO origination.contract_number_counter (template_id, scope_key, next_seq) VALUES (${template.id}, ${scopeKey}, ${template.nextSeq + 1})
      ON CONFLICT (template_id, scope_key) DO UPDATE SET next_seq = origination.contract_number_counter.next_seq + 1
      RETURNING next_seq - 1 AS seq`;
    return formatContractNo(template.pattern, { prefix: template.prefix, branch, yymmdd, seq: Number(rows[0].seq) });
  }

  /**
   * BR-11 · DECISIONS 2026-11-19: {BRANCH} = admin-ий тохируулсан `contract.branch_codes` (iam.branch.code-ийн origination талын projection).
   * Код байхгүй бол UUID-аас гаргахгүй — 422; загварт {BRANCH} байхгүй бол код шаардахгүй.
   */
  private async branchCode(tx: Tx, orgId: string, branchId: string, pattern: string): Promise<string> {
    if (!hasBranchToken(pattern)) return '';
    const code = (await this.settings.getIn(tx, orgId, 'contract.branch_codes'))[branchId];
    if (!code) throw new DomainError('BRANCH_CODE_MISSING', 'Салбарын код тохируулаагүй тул гэрээний дугаар үүсгэх боломжгүй. Тохиргоо → Салбарын код хэсэгт кодыг оруулна уу', 422);
    return code;
  }
}
