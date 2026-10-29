import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from './client';
import { DomainError } from '../../domain/errors';
import type { PlanRecord } from '../../domain/records';
import { PlanRepository } from '../repositories';
import { planMutable, planToCreate, planToRecord } from './mappers';
import { isUuid, uniqueViolation, violates } from './prisma-errors';
import { PrismaService } from './prisma.service';

// POS-FR-3: лизингийн хөтөлбөр (plan). (org_id, code) unique.
const byCode = (a: PlanRecord, b: PlanRecord) => a.code.localeCompare(b.code);

@Injectable()
export class PrismaPlanRepository extends PlanRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) { super(); }

  async createPlan(p: PlanRecord): Promise<PlanRecord> {
    try {
      return planToRecord(await this.prisma.posLeasePlan.create({ data: planToCreate(p) }));
    } catch (e) {
      throw this.duplicateCode(e, p.code);
    }
  }

  /** Optimistic lock (version) — saveMerchant-тай ижил: тэнцүү үед л шинэчилж +1; зөрвөл CONCURRENT_UPDATE, байхгүй бол NOT_FOUND. */
  async savePlan(p: PlanRecord): Promise<PlanRecord> {
    if (!isUuid(p.id)) throw new DomainError('NOT_FOUND', 'plan not found');
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const res = await tx.posLeasePlan.updateMany({ where: { id: p.id, orgId: p.orgId, version: p.version }, data: { ...planMutable(p), version: { increment: 1 } } });
        if (res.count === 0) {
          const exists = (await tx.posLeasePlan.count({ where: { id: p.id, orgId: p.orgId } })) > 0;
          throw exists ? new DomainError('CONCURRENT_UPDATE', 'plan was modified concurrently') : new DomainError('NOT_FOUND', 'plan not found');
        }
        return tx.posLeasePlan.findUniqueOrThrow({ where: { id: p.id } });
      });
      return planToRecord(row);
    } catch (e) {
      throw this.duplicateCode(e, p.code);
    }
  }

  async findPlan(orgId: string, id: string): Promise<PlanRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.posLeasePlan.findFirst({ where: { id, orgId } });
    return row ? planToRecord(row) : null;
  }

  async findPlanByCode(orgId: string, code: string): Promise<PlanRecord | null> {
    const row = await this.prisma.posLeasePlan.findUnique({ where: { orgId_code: { orgId, code } } });
    return row ? planToRecord(row) : null;
  }

  async listPlans(orgId: string, filter: { merchantId?: string; isActive?: boolean }): Promise<PlanRecord[]> {
    if (filter.merchantId !== undefined && !isUuid(filter.merchantId)) return [];
    const where: Prisma.PosLeasePlanWhereInput = {
      orgId,
      ...(filter.merchantId !== undefined ? { merchantId: filter.merchantId } : {}),
      ...(filter.isActive !== undefined ? { isActive: filter.isActive } : {}),
    };
    return (await this.prisma.posLeasePlan.findMany({ where })).map(planToRecord).sort(byCode);
  }

  /** merchantId = null (бүх мерчант) эсвэл тухайн мерчантынх; идэвхгүй, хугацаа дууссаныг ч оруулна (service шүүнэ — POS-BR-11). */
  async listPlansForMerchant(orgId: string, merchantId: string): Promise<PlanRecord[]> {
    const merchantScope: Prisma.PosLeasePlanWhereInput[] = [{ merchantId: null }, ...(isUuid(merchantId) ? [{ merchantId }] : [])];
    return (await this.prisma.posLeasePlan.findMany({ where: { orgId, OR: merchantScope } })).map(planToRecord).sort(byCode);
  }

  private duplicateCode(e: unknown, code: string): unknown {
    return violates(uniqueViolation(e), 'PosLeasePlan', 'code') ? new DomainError('DUPLICATE_CODE', `plan code ${code} already exists`) : e;
  }
}
