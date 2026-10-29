import { Injectable } from '@nestjs/common';
import { ProductCollateralChecklist, type BorrowerRole, type CollateralListResponse, type CollateralView } from '@los/contracts';
import type { LoanApplication, Product } from '.prisma/client-origination';
import { Clock } from '@los/nest-common';
import { PrismaService, type Tx } from '../../prisma.service';
import { OrgSettings } from '../../shared/org-settings';
import { todayUB } from '../../shared/clock';
import { customerDisplayName } from '../borrower/customer-directory';
import { num, isoDate } from './collateral-data';
import { evaluateCollateralGate, type GateEvaluation, type GateProduct } from './collateral-gate';
import { bestRole } from './collateral-ownership';
import { findCommittedPledges, findOtherPledges, groupByCollateral } from './collateral-pledge';
import { toCollateralView, toGateCollateral, type CollateralRow } from './collateral-view';
import { computeCollateralWarnings } from './collateral-warnings';
import { DRAFT_STATUSES } from './collateral.constants';

export interface CollateralSnapshot {
  app: LoanApplication;
  rows: CollateralRow[];
  product: Product | null;
  gateProduct: GateProduct | null;
  evaluation: GateEvaluation;
  views: Map<string, CollateralView>;
  /** `GET /collaterals` хариу (items, summary, gate, warnings). */
  response: CollateralListResponse;
  now: Date;
}

export const toGateProduct = (p: Product | null): GateProduct | null => {
  if (!p) return null;
  const checklist = ProductCollateralChecklist.safeParse(p.collateralChecklistJson);
  return { requiresCollateral: p.requiresCollateral, maxLtv: num(p.maxLtv), externalValuationThreshold: num(p.externalValuationThreshold), collateralChecklist: checklist.success ? checklist.data : null };
};

/**
 * G0 хаалтыг DB-ийн төлвөөс тооцно (FR-6, G0). Модуль 10 (илгээх, G1) `evaluate`-ийг дахин дуудаж давхар барьцааг дахин шалгана (docs/05 §6).
 * Уншихад өөрчлөлт хийхгүй — алхмыг мутаци (CollateralTxService.finish) шинэчилнэ.
 */
@Injectable()
export class CollateralGateService {
  constructor(private readonly settings: OrgSettings, private readonly clock: Clock) {}

  /** Хүсэлтийн барьцааны бүрэн төлөв: мөр, G0, хураангуй, анхааруулга, харагдац. */
  async snapshot(db: Tx | PrismaService, app: LoanApplication): Promise<CollateralSnapshot> {
    const tx = db as Tx;
    const now = this.clock.now();
    const rows = await tx.collateral.findMany({ where: { applicationId: app.id }, include: { documents: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const borrowers = await tx.loanApplicationBorrower.findMany({ where: { applicationId: app.id }, select: { customerId: true, role: true } });
    const rolesOf = new Map<string, BorrowerRole[]>();
    for (const b of borrowers) rolesOf.set(b.customerId, [...(rolesOf.get(b.customerId) ?? []), b.role as BorrowerRole]);
    const customerIds = [...new Set([...borrowers.map((b) => b.customerId), ...rows.map((r) => r.ownerCustomerId).filter((id): id is string => !!id)])];
    const customers = customerIds.length ? await tx.customer.findMany({ where: { id: { in: customerIds }, orgId: app.orgId }, select: { id: true, lastName: true, firstName: true } }) : [];
    const nameOf = new Map(customers.map((c) => [c.id, customerDisplayName(c)]));
    const product = app.productId ? await tx.product.findFirst({ where: { id: app.productId, orgId: app.orgId } }) : null;
    const gateProduct = toGateProduct(product);

    // Тохиргоог ЭНЭ холболтоор уншина (tx дотор өөр pool холболт авбал зэрэгцээ мутаци pool-д түгжигдэнэ; OrgSettings.getIn)
    const staleDays = await this.settings.getIn(tx, app.orgId, 'inquiry.stale_days');
    const ltvMax = await this.settings.getIn(tx, app.orgId, 'br3.ltv_max');
    const insuranceReminderDays = await this.settings.getIn(tx, app.orgId, 'collateral.insurance_reminder_days');

    // Давхар барьцаа: хатуу (өөр идэвхтэй хүсэлт) → G0 issue; зөөлөн (өөр ноорог) → анхааруулга.
    const live = rows.filter((r) => r.releasedAt == null);
    const keys = { assetKeys: [...new Set(live.map((r) => r.assetKey).filter((k): k is string => !!k))], registryNos: [...new Set(live.map((r) => r.registryNo).filter((k): k is string => !!k))] };
    const committed = groupByCollateral(await findCommittedPledges(tx, app.orgId, app.id, keys), live);
    const drafts = groupByCollateral(await findOtherPledges(tx, app.orgId, app.id, keys, DRAFT_STATUSES), live);

    const evaluation = evaluateCollateralGate({
      now, product: gateProduct, loanAmount: num(app.amount), collaterals: rows.map((r) => toGateCollateral(r, bestRole(rolesOf.get(r.ownerCustomerId ?? '') ?? []))),
      settings: { staleDays, ltvMax }, duplicatePledges: committed,
    });

    const views = new Map<string, CollateralView>();
    for (const r of rows) {
      const ownerRole = bestRole(rolesOf.get(r.ownerCustomerId ?? '') ?? []);
      views.set(r.id, toCollateralView(r, { now, product: gateProduct, ownerName: r.ownerCustomerId ? nameOf.get(r.ownerCustomerId) ?? null : null, ownerRole, issues: evaluation.perCollateralIssues[r.id] ?? [] }));
    }
    const warnings = computeCollateralWarnings({
      subjects: rows.map((r) => ({ id: r.id, releasedAt: r.releasedAt, insuranceExpiresAt: isoDate(r.insuranceExpiresAt), nextRevaluationAt: isoDate(r.nextRevaluationAt) })),
      today: todayUB(this.clock), insuranceReminderDays, otherDrafts: drafts,
    });
    return {
      app, rows, product, gateProduct, evaluation, views, now,
      response: { items: rows.map((r) => views.get(r.id) as CollateralView), summary: evaluation.summary, gate: evaluation.gate, warnings },
    };
  }

  /** Модуль 10 (G1 илгээх) энэ функцийг дуудаж G0-г дахин шалгана. Хүсэлт олдохгүй бол Error. */
  async evaluate(db: Tx | PrismaService, orgId: string, applicationId: string): Promise<GateEvaluation> {
    const app = await (db as Tx).loanApplication.findFirst({ where: { id: applicationId, orgId } });
    if (!app) throw new Error(`Application not found: ${applicationId}`);
    return (await this.snapshot(db, app)).evaluation;
  }
}
