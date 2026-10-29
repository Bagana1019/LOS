import { Injectable } from '@nestjs/common';
import { checkLtv } from '@los/calc';
import {
  COLLATERAL_DESCRIPTION_SCHEMAS, collateralAssetKey, collateralKindOf, parseCollateralDescription,
  type AssetType, type CollateralListResponse, type CollateralMonitoringItem, type CollateralMonitoringQuery, type CollateralMonitoringResponse, type CollateralMutationResponse,
  type CreateCollateralRequest, type RegisterPledgeRequest, type RequestContext, type UpdateCollateralRequest,
} from '@los/contracts';
import { Clock, DomainError, scopeWhere } from '@los/nest-common';
import type { LoanApplication, Prisma } from '.prisma/client-origination';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { todayUB } from '../../shared/clock';
import { OrgSettings } from '../../shared/org-settings';
import {
  CLEARED_VALUATION, auditSnapshot, clearedChecks, dateOnly, descriptionOf, isoDate, num, stableStringify,
} from './collateral-data';
import { CollateralGateService } from './collateral-gate.service';
import { compareMonitoring, monitoringReasons } from './collateral-monitoring';
import { assetLockKey, findCommittedPledges, lockAssetKeys, registryLockKey } from './collateral-pledge';
import { CollateralTxService, TX_OPTIONS } from './collateral-tx.service';
import { describeCollateral } from './collateral-view';
import { MONITORED_STATUS, RULE_EDITABLE, RULE_REGISTRY, RULE_RELEASE } from './collateral.constants';

const MSG = {
  duplicate: 'Энэ хөрөнгө энэ хүсэлтэд аль хэдийн бүртгэгдсэн байна',
  pledged: (nos: string[]) => `Энэ хөрөнгө өөр идэвхтэй хүсэлтэд (${nos.join(', ')}) барьцаалагдсан байна`,
  registryInUse: 'Энэ ЭБ-ийн бүртгэлийн дугаар өөр барьцаанд бүртгэлтэй байна',
  released: 'Барьцааг чөлөөлсөн тул өөрчилж болохгүй',
} as const;

/** Хадгалагдсан тодорхойлолтыг схемээр нормчилно (анхдагч утга нөхөгдөнө); буруу хэлбэр бол хэвээр — харьцуулалтад. */
function normalizedStored(assetType: AssetType, stored: Record<string, unknown>): Record<string, unknown> {
  const r = COLLATERAL_DESCRIPTION_SCHEMAS[assetType].safeParse(stored);
  return r.success ? (r.data as Record<string, unknown>) : stored;
}

/**
 * Модуль 6 · барьцаа (FR-6.1, 6.2, 6.4, 6.9, FR-14.4, G0): CRUD, дахин тооцоо, ЭБ бүртгэл, чөлөөлөлт, мониторинг.
 * Мутаци бүр: эрх (ApplicationAccessService) → нэг транзакц { хүсэлтийн мөрийг FOR UPDATE → төлөв → бичих → G0 → 5-р алхам → аудит + CollateralChanged }.
 * Гадны дуудлагатай үйлдлүүд (өмчлөл, ачаалал, үнэлгээ) тусдаа сервист (collateral-checks / collateral-valuation).
 */
@Injectable()
export class CollateralService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly settings: OrgSettings,
    private readonly clock: Clock,
    private readonly gate: CollateralGateService,
    private readonly tx: CollateralTxService,
  ) {}

  // ── унших ───────────────────────────────────────────────────────────────────────────
  async list(ctx: RequestContext, applicationId: string): Promise<CollateralListResponse> {
    const app = await this.access.load(ctx, applicationId, 'read');
    return (await this.gate.snapshot(this.prisma, app)).response;
  }

  // ── FR-6.1 нэмэх ────────────────────────────────────────────────────────────────────
  async create(ctx: RequestContext, applicationId: string, input: CreateCollateralRequest): Promise<CollateralMutationResponse> {
    this.tx.assertStatus(await this.access.load(ctx, applicationId, 'write'), RULE_EDITABLE);
    return this.prisma.$transaction(async (db) => {
      const app = await this.tx.begin(db, ctx, applicationId, RULE_EDITABLE);
      await this.tx.requireOwner(db, app.id, input.ownerCustomerId);
      const description = input.description as Record<string, unknown>;
      const assetKey = collateralAssetKey(input.assetType, description);
      const registryNo = input.registryNo ?? null;
      await this.assertNoConflict(db, app, { assetKey, registryNo, exceptCollateralId: null });
      const created = await db.collateral.create({
        data: {
          orgId: app.orgId, applicationId: app.id, kind: collateralKindOf(input.assetType), assetType: input.assetType, ownerCustomerId: input.ownerCustomerId,
          descriptionJson: description as Prisma.InputJsonValue, source: input.source, assetKey, xypRef: input.xypRef ?? null,
          registryNo, registryDate: input.registryDate ? dateOnly(input.registryDate) : null, insuranceExpiresAt: input.insuranceExpiresAt ? dateOnly(input.insuranceExpiresAt) : null,
          note: input.note ?? null, createdBy: ctx.userId, updatedBy: ctx.userId,
        },
        include: { documents: true },
      });
      const snap = await this.tx.finish(db, ctx, app, {
        collateralId: created.id, assetType: created.assetType, change: 'ADDED', action: 'COLLATERAL_CREATED', after: auditSnapshot(created), scoreAffected: true, updateSteps: true,
      });
      return this.tx.mutation(snap, created.id);
    }, TX_OPTIONS);
  }

  // ── засах ───────────────────────────────────────────────────────────────────────────
  /**
   * PATCH: өмчлөгч / тодорхойлолт (тодорхойлогч) ҮНЭХЭЭР өөрчлөгдвөл өмчлөл, ачаалал шалгалт, үнэлгээ хүчингүй болно (FR-6.5, 6.6, FR-14).
   * Өөрчлөлтгүй PATCH нь юу ч бичихгүй (аудит, event байхгүй).
   */
  async update(ctx: RequestContext, applicationId: string, collateralId: string, patch: UpdateCollateralRequest): Promise<CollateralMutationResponse> {
    this.tx.assertStatus(await this.access.load(ctx, applicationId, 'write'), RULE_EDITABLE);
    return this.prisma.$transaction(async (db) => {
      const app = await this.tx.begin(db, ctx, applicationId, RULE_EDITABLE);
      const row = await this.tx.row(db, app.id, collateralId);
      const assetType = row.assetType as AssetType;
      const data: Prisma.CollateralUncheckedUpdateInput = { updatedBy: ctx.userId };
      const changed: string[] = [];
      let invalidates = false;

      if (patch.ownerCustomerId !== undefined && patch.ownerCustomerId !== row.ownerCustomerId) {
        await this.tx.requireOwner(db, app.id, patch.ownerCustomerId);
        data.ownerCustomerId = patch.ownerCustomerId;
        changed.push('owner');
        invalidates = true;
      }
      let assetKey = row.assetKey;
      if (patch.description !== undefined) {
        const next = parseCollateralDescription(assetType, patch.description) as Record<string, unknown>; // ZodError → 400 VALIDATION_FAILED
        if (stableStringify(next) !== stableStringify(normalizedStored(assetType, descriptionOf(row)))) {
          data.descriptionJson = next as Prisma.InputJsonValue;
          changed.push('description');
          invalidates = true;
          assetKey = collateralAssetKey(assetType, next);
          if (assetKey !== row.assetKey) {
            data.assetKey = assetKey;
            // Тодорхойлогч гараар өөрчлөгдсөн → ХУР-аас татсан өгөгдөл биш болсон
            data.source = 'MANUAL';
            data.xypRef = null;
          }
        }
      }
      let registryNo = row.registryNo;
      if (patch.registryNo !== undefined && (patch.registryNo ?? null) !== row.registryNo) {
        registryNo = patch.registryNo ?? null;
        data.registryNo = registryNo;
        changed.push('registryNo');
      }
      if (patch.registryDate !== undefined && (patch.registryDate ?? null) !== isoDate(row.registryDate)) {
        data.registryDate = patch.registryDate ? dateOnly(patch.registryDate) : null;
        changed.push('registryDate');
      }
      if (patch.insuranceExpiresAt !== undefined && (patch.insuranceExpiresAt ?? null) !== isoDate(row.insuranceExpiresAt)) {
        data.insuranceExpiresAt = patch.insuranceExpiresAt ? dateOnly(patch.insuranceExpiresAt) : null;
        changed.push('insuranceExpiresAt');
      }
      if (patch.note !== undefined && ((patch.note?.trim() || null) !== row.note)) {
        data.note = patch.note?.trim() || null;
        changed.push('note');
      }

      if (!changed.length) return this.tx.mutation(await this.tx.finish(db, ctx, app, { updateSteps: false }), row.id); // өөрчлөлтгүй — идемпотент

      if ((assetKey !== row.assetKey && assetKey != null) || (registryNo !== row.registryNo && registryNo != null)) {
        await this.assertNoConflict(db, app, { assetKey, registryNo, exceptCollateralId: row.id });
      }
      if (invalidates) Object.assign(data, clearedChecks(), CLEARED_VALUATION);
      const updated = await db.collateral.update({ where: { id: row.id }, data, include: { documents: true } });
      const snap = await this.tx.finish(db, ctx, app, {
        collateralId: row.id, assetType, change: 'UPDATED', action: 'COLLATERAL_UPDATED', before: auditSnapshot(row), after: { ...auditSnapshot(updated), changed, invalidated: invalidates },
        scoreAffected: invalidates, updateSteps: true,
      });
      return this.tx.mutation(snap, row.id);
    }, TX_OPTIONS);
  }

  // ── устгах ──────────────────────────────────────────────────────────────────────────
  async remove(ctx: RequestContext, applicationId: string, collateralId: string): Promise<void> {
    this.tx.assertStatus(await this.access.load(ctx, applicationId, 'write'), RULE_EDITABLE);
    await this.prisma.$transaction(async (db) => {
      const app = await this.tx.begin(db, ctx, applicationId, RULE_EDITABLE);
      const row = await this.tx.row(db, app.id, collateralId);
      await db.collateral.delete({ where: { id: row.id } }); // баримтууд cascade
      await this.tx.finish(db, ctx, app, {
        collateralId: row.id, assetType: row.assetType, change: 'REMOVED', action: 'COLLATERAL_REMOVED', before: auditSnapshot(row), scoreAffected: true, updateSteps: true,
      });
    }, TX_OPTIONS);
  }

  // ── G0-г дахин тооцох (Модуль 5: зээлийн дүн өөрчлөгдөхөд) ──────────────────────────────
  /** Идемпотент: алхам өөрчлөгдөөгүй бол аудит, event бичихгүй. */
  async recheck(ctx: RequestContext, applicationId: string): Promise<CollateralListResponse> {
    this.tx.assertStatus(await this.access.load(ctx, applicationId, 'write'), RULE_EDITABLE);
    return this.prisma.$transaction(async (db) => {
      const app = await this.tx.begin(db, ctx, applicationId, RULE_EDITABLE);
      return (await this.tx.finish(db, ctx, app, { updateSteps: true, auditStepChangeOnly: true })).response;
    }, TX_OPTIONS);
  }

  // ── FR-6.9 ЭБ бүртгэл ───────────────────────────────────────────────────────────────
  /** `registry_no` нь байгууллагын чөлөөлөгдөөгүй барьцаанд давхцахгүй (409 REGISTRY_NO_IN_USE). Ижил дугаар, огноогоор давтвал өөрчлөлтгүй. */
  async registerPledge(ctx: RequestContext, applicationId: string, collateralId: string, input: RegisterPledgeRequest): Promise<CollateralMutationResponse> {
    this.tx.assertStatus(await this.access.load(ctx, applicationId, 'write'), RULE_REGISTRY);
    return this.prisma.$transaction(async (db) => {
      const app = await this.tx.begin(db, ctx, applicationId, RULE_REGISTRY);
      const row = await this.tx.row(db, app.id, collateralId);
      if (row.releasedAt) throw new DomainError('COLLATERAL_RELEASED', MSG.released, 409);
      const registryNo = input.registryNo.trim();
      if (row.registryNo === registryNo && isoDate(row.registryDate) === input.registryDate) return this.tx.mutation(await this.tx.finish(db, ctx, app, { updateSteps: false }), row.id);
      await lockAssetKeys(db, app.orgId, [registryLockKey(registryNo)]);
      const clash = await db.collateral.findFirst({ where: { orgId: app.orgId, registryNo, releasedAt: null, id: { not: row.id } }, select: { id: true } });
      if (clash) throw new DomainError('REGISTRY_NO_IN_USE', MSG.registryInUse, 409);
      const updated = await db.collateral.update({ where: { id: row.id }, data: { registryNo, registryDate: dateOnly(input.registryDate), updatedBy: ctx.userId }, include: { documents: true } });
      const snap = await this.tx.finish(db, ctx, app, {
        collateralId: row.id, assetType: row.assetType, change: 'PLEDGE_REGISTERED', action: 'COLLATERAL_PLEDGE_REGISTERED',
        before: { registered: row.registryNo != null }, after: { registryNo, registryDate: input.registryDate, ...auditSnapshot(updated) }, updateSteps: false,
      });
      return this.tx.mutation(snap, row.id);
    }, TX_OPTIONS);
  }

  // ── FR-6.9 чөлөөлөх ─────────────────────────────────────────────────────────────────
  /** Хүсэлт CLOSED үед л. Хоёр дахь дуудлага нь аюулгүй no-op (200, аудит/event давхардахгүй) — сүлжээний дахин оролдлого. */
  async release(ctx: RequestContext, applicationId: string, collateralId: string): Promise<CollateralMutationResponse> {
    this.tx.assertStatus(await this.access.load(ctx, applicationId, 'write'), RULE_RELEASE);
    return this.prisma.$transaction(async (db) => {
      const app = await this.tx.begin(db, ctx, applicationId, RULE_RELEASE);
      const row = await this.tx.row(db, app.id, collateralId);
      if (row.releasedAt) return this.tx.mutation(await this.tx.finish(db, ctx, app, { updateSteps: false }), row.id);
      const updated = await db.collateral.update({ where: { id: row.id }, data: { releasedAt: this.clock.now(), updatedBy: ctx.userId }, include: { documents: true } });
      const snap = await this.tx.finish(db, ctx, app, {
        collateralId: row.id, assetType: row.assetType, change: 'RELEASED', action: 'COLLATERAL_RELEASED', before: auditSnapshot(row), after: auditSnapshot(updated), updateSteps: false,
      });
      return this.tx.mutation(snap, row.id);
    }, TX_OPTIONS);
  }

  // ── FR-6.9, FR-14.6 мониторинг ──────────────────────────────────────────────────────
  /** Идэвхтэй (ACTIVE) зээлийн чөлөөлөгдөөгүй барьцаа; хүрээ NFR-3: ЗЭЗ өөрийн, салбарын захирал салбарын, батлагч/админ бүгд. */
  async monitoring(ctx: RequestContext, query: CollateralMonitoringQuery): Promise<CollateralMonitoringResponse> {
    const now = this.clock.now();
    const today = todayUB(this.clock);
    const rows = await this.prisma.collateral.findMany({
      where: { orgId: ctx.orgId, releasedAt: null, application: { orgId: ctx.orgId, status: MONITORED_STATUS, ...scopeWhere(ctx) } },
      include: { application: { include: { product: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const ltvMax = await this.settings.get(ctx.orgId, 'br3.ltv_max');
    // LTV хүсэлт бүрээр (нэг хүсэлтийн бүх барьцааны нийлбэр); хүрээ нь хүсэлтээр тул хүсэлтийн бүх барьцаа цуг орно.
    const ltvByApp = new Map<string, { ltv: number | null; limit: number; pass: boolean | null }>();
    for (const appId of new Set(rows.map((r) => r.applicationId))) {
      const own = rows.filter((r) => r.applicationId === appId);
      const app = own[0]!.application;
      const limit = num(app.product?.maxLtv) ?? ltvMax;
      const check = checkLtv(num(app.amount), own.map((r) => num(r.collateralValue)), limit);
      ltvByApp.set(appId, { ltv: check.ltv, limit, pass: check.ltv == null ? null : check.pass });
    }
    const items: CollateralMonitoringItem[] = [];
    for (const r of rows) {
      const ltv = ltvByApp.get(r.applicationId)!;
      const reasons = monitoringReasons({ today, withinDays: query.withinDays, nextRevaluationAt: isoDate(r.nextRevaluationAt), insuranceExpiresAt: isoDate(r.insuranceExpiresAt), ltvPass: ltv.pass });
      if (!reasons.length) continue;
      items.push({
        collateralId: r.id, applicationId: r.applicationId, appNo: r.application.appNo, assetType: r.assetType as AssetType, label: describeCollateral(r.assetType as AssetType, descriptionOf(r)),
        reasons, nextRevaluationAt: isoDate(r.nextRevaluationAt), insuranceExpiresAt: isoDate(r.insuranceExpiresAt), ltv: ltv.ltv, ltvLimit: ltv.limit,
      });
    }
    return { items: items.sort(compareMonitoring), asOf: now.toISOString() };
  }

  // ── давхар барьцаа (FR-6.6) ─────────────────────────────────────────────────────────
  /**
   * Хөрөнгийн түлхүүр, ЭБ-ийн дугаарыг түгжиж (pg_advisory_xact_lock) шалгана:
   *  - энэ хүсэлтэд аль хэдийн байвал 409 COLLATERAL_DUPLICATE;
   *  - өөр "хүлээн авсан" хүсэлтийн чөлөөлөгдөөгүй барьцаанд байвал 409 COLLATERAL_ALREADY_PLEDGED (details: зөвхөн тэр хүсэлтийн дугаар).
   * Өөр ноорог хүсэлтэд байвал хориглохгүй (анхааруулга `IN_OTHER_DRAFT` жагсаалтад).
   */
  private async assertNoConflict(db: Tx, app: LoanApplication, c: { assetKey: string | null; registryNo: string | null; exceptCollateralId: string | null }): Promise<void> {
    if (!c.assetKey && !c.registryNo) return;
    await lockAssetKeys(db, app.orgId, [assetLockKey(c.assetKey), registryLockKey(c.registryNo)]);
    const or = [...(c.assetKey ? [{ assetKey: c.assetKey }] : []), ...(c.registryNo ? [{ registryNo: c.registryNo }] : [])];
    const same = await db.collateral.findFirst({ where: { applicationId: app.id, OR: or, ...(c.exceptCollateralId ? { id: { not: c.exceptCollateralId } } : {}) }, select: { id: true } });
    if (same) throw new DomainError('COLLATERAL_DUPLICATE', MSG.duplicate, 409);
    const others = await findCommittedPledges(db, app.orgId, app.id, { assetKeys: c.assetKey ? [c.assetKey] : [], registryNos: c.registryNo ? [c.registryNo] : [] });
    if (others.length) {
      const applicationNos = [...new Set(others.map((o) => o.appNo))];
      throw new DomainError('COLLATERAL_ALREADY_PLEDGED', MSG.pledged(applicationNos), 409, { applicationNos });
    }
  }
}
