import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '.prisma/client-valuation';
import { PrismaService, type Tx } from '../../prisma.service';

export type CollateralValuationRow = Prisma.CollateralValuationGetPayload<Record<string, never>>;

export interface ProjectionInput {
  orgId: string;
  collateralId: string;
  applicationId: string;
  productId: string | null;
  assetType: string;
  descriptionJson: Prisma.InputJsonValue;
  actorId: string | null;
}

export interface ValuationInsert {
  orgId: string;
  collateralRefId: string;
  source: string;
  method: string;
  appraiser: string | null;
  licenseNo: string | null;
  valuedAt: Date;
  validUntil: Date | null;
  marketValue: number;
  suggestedValue: number | null;
  haircutRate: number;
  haircutSource: string;
  collateralValue: number;
  methodJson: Prisma.InputJsonValue;
  reportFileId: string | null;
  overrideReason: string | null;
  externalRequired: boolean;
  actorId: string | null;
}

@Injectable()
export class CollateralValuationRepository {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn);
  }

  /** valuation-side projection of origination.collateral (CLAUDE.md §4): one row per (org, collateralId). */
  async upsertProjection(tx: Tx, p: ProjectionInput): Promise<string> {
    const data = { applicationId: p.applicationId, productId: p.productId, assetType: p.assetType, descriptionJson: p.descriptionJson, updatedBy: p.actorId };
    const row = await tx.collateral.upsert({
      where: { orgId_collateralId: { orgId: p.orgId, collateralId: p.collateralId } },
      create: { orgId: p.orgId, collateralId: p.collateralId, createdBy: p.actorId, ...data },
      update: data,
      select: { id: true },
    });
    return row.id;
  }

  insertValuation(tx: Tx, v: ValuationInsert): Promise<CollateralValuationRow> {
    return tx.collateralValuation.create({
      data: {
        orgId: v.orgId,
        collateralRefId: v.collateralRefId,
        source: v.source,
        method: v.method,
        appraiser: v.appraiser,
        licenseNo: v.licenseNo,
        valuedAt: v.valuedAt,
        validUntil: v.validUntil,
        marketValue: v.marketValue,
        suggestedValue: v.suggestedValue,
        haircutRate: v.haircutRate,
        haircutSource: v.haircutSource,
        collateralValue: v.collateralValue,
        methodJson: v.methodJson,
        reportFileId: v.reportFileId,
        overrideReason: v.overrideReason,
        externalRequired: v.externalRequired,
        createdBy: v.actorId,
        updatedBy: v.actorId,
      },
    });
  }

  /** Newest first: by valuation date (an external report may be back-dated), then by when it was recorded. Org-scoped. */
  history(orgId: string, collateralId: string): Promise<CollateralValuationRow[]> {
    return this.db.collateralValuation.findMany({
      where: { orgId, collateral: { orgId, collateralId } },
      orderBy: [{ valuedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
  }
}
