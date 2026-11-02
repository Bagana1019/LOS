import { Inject, Injectable } from '@nestjs/common';
import type {
  AssetType, CollateralMutationResponse, CollateralValuationRecord, ExternalValuationRequest, RecordExternalValuationRequest, RequestContext, SaveCollateralValuationRequest,
  SaveValuationRequest, SuggestValuationRequest, SuggestValuationResponse, ValuationHistoryResponse,
} from '@los/contracts';
import { Clock, DomainError } from '@los/nest-common';
import type { LoanApplication, Prisma } from '.prisma/client-origination';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { todayUB } from '../../shared/clock';
import { OrgSettings } from '../../shared/org-settings';
import { auditSnapshot, collateralFingerprint, descriptionOf, num, valuationColumnsFromRecord } from './collateral-data';
import { decideValuationEvent, type ValuationCompletedEvent } from './collateral-valuation-event';
import { CollateralTxService, TX_OPTIONS } from './collateral-tx.service';
import type { CollateralRow } from './collateral-view';
import { EDITABLE_STATUSES, RULE_VALUATION, VALUATION_STATUSES } from './collateral.constants';
import { FILE_PORT, type FilePort } from './ports/file.port';
import { VALUATION_PORT, type ValuationPort } from './ports/valuation.port';

const CHANGED = 'Үнэлгээ хийж байх хугацаанд барьцаа өөрчлөгдсөн тул дахин үнэлнэ үү';

type Kind = 'internal' | 'external';

/**
 * Модуль 6 · барьцааны үнэлгээ (FR-14.1–14.4, 14.6). Үнэ тогтоох логик valuation сервист; origination нь хүсэлтийг барьцаа + бүтээгдэхүүнээс бүрдүүлж,
 * үр дүнг барьцааны мөрөнд хуулна (docs/05 §2). Гадны дуудлага DB-ийн транзакцаас гадна. ACTIVE зээлд дахин үнэлж болно (алхамд хүрэхгүй).
 */
@Injectable()
export class CollateralValuationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly settings: OrgSettings,
    private readonly clock: Clock,
    private readonly tx: CollateralTxService,
    @Inject(VALUATION_PORT) private readonly valuation: ValuationPort,
    @Inject(FILE_PORT) private readonly files: FilePort,
  ) {}

  // ── системийн санал (хадгалахгүй) ───────────────────────────────────────────────────────
  async suggest(ctx: RequestContext, applicationId: string, collateralId: string, input: Pick<SaveValuationRequest, 'mileageKm'>): Promise<SuggestValuationResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.tx.assertStatus(app, RULE_VALUATION);
    const row = await this.tx.row(this.prisma, app.id, collateralId);
    this.assertMileage(row, input.mileageKm);
    return this.valuation.suggest(ctx, await this.buildRequest(app, row, 'internal', input.mileageKm));
  }

  // ── FR-14.2 үнэлгээ хадгалах ────────────────────────────────────────────────────────────
  async save(ctx: RequestContext, applicationId: string, collateralId: string, input: SaveValuationRequest): Promise<CollateralMutationResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.tx.assertStatus(app, RULE_VALUATION);
    const row = await this.tx.row(this.prisma, app.id, collateralId);
    this.assertMileage(row, input.mileageKm);
    const request: SaveCollateralValuationRequest = {
      ...(await this.buildRequest(app, row, 'internal', input.mileageKm)),
      ...(input.marketValue !== undefined ? { marketValue: input.marketValue } : {}),
      ...(input.overrideReason !== undefined ? { overrideReason: input.overrideReason } : {}),
    };
    // OVERRIDE_REASON_REQUIRED, MARKET_VALUE_REQUIRED, VALIDATION_FAILED нь valuation-оос код/мессежтэй нь дамжина
    const { valuation } = await this.valuation.save(ctx, request);
    return this.apply(ctx, applicationId, collateralId, collateralFingerprint(row), valuation, input.mileageKm);
  }

  // ── FR-14.3 гадны лицензтэй үнэлгээ ─────────────────────────────────────────────────────
  async recordExternal(ctx: RequestContext, applicationId: string, collateralId: string, input: ExternalValuationRequest): Promise<CollateralMutationResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.tx.assertStatus(app, RULE_VALUATION);
    const row = await this.tx.row(this.prisma, app.id, collateralId);
    if (input.valuedAt > todayUB(this.clock)) throw new DomainError('VALUATION_DATE_IN_FUTURE', 'Үнэлгээний огноо ирээдүйд байж болохгүй', 422);
    if (input.validUntil && input.validUntil < input.valuedAt) throw new DomainError('VALIDITY_BEFORE_VALUATION', 'Хүчинтэй хугацаа үнэлгээний огнооноос өмнө байж болохгүй', 422);
    // Тайлан (dms файл) заавал байх ёстой — valuation дуудахаас өмнө шалгана
    if (!(await this.files.getMeta(ctx, input.reportFileId))) throw new DomainError('REPORT_FILE_NOT_FOUND', 'Үнэлгээний тайлангийн файл олдсонгүй. Эхлээд файлыг байршуулна уу', 422);
    const request: RecordExternalValuationRequest = {
      ...(await this.buildRequest(app, row, 'external')),
      appraiser: input.appraiser, valuedAt: input.valuedAt, marketValue: input.marketValue, reportFileId: input.reportFileId,
      ...(input.licenseNo !== undefined ? { licenseNo: input.licenseNo } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    const record = await this.valuation.recordExternal(ctx, request);
    return this.apply(ctx, applicationId, collateralId, collateralFingerprint(row), record);
  }

  // ── FR-14.6 түүх ────────────────────────────────────────────────────────────────────────
  async history(ctx: RequestContext, applicationId: string, collateralId: string): Promise<ValuationHistoryResponse> {
    const app = await this.access.load(ctx, applicationId, 'read');
    await this.tx.row(this.prisma, app.id, collateralId);
    return this.valuation.history(ctx, collateralId);
  }

  /** Үнэлгээг барьцааны мөрөнд хуулна (sync хариуг шууд). Барьцаа гадны дуудлага даяар өөрчлөгдсөн бол 409. */
  private async apply(ctx: RequestContext, applicationId: string, collateralId: string, fingerprint: string, record: CollateralValuationRecord, mileageKm?: number): Promise<CollateralMutationResponse> {
    const interval = await this.settings.get(ctx.orgId, 'collateral.revaluation_interval_days');
    return this.prisma.$transaction(async (db) => {
      const app = await this.tx.begin(db, ctx, applicationId, RULE_VALUATION);
      const fresh = await this.tx.row(db, app.id, collateralId);
      if (collateralFingerprint(fresh) !== fingerprint) throw new DomainError('COLLATERAL_CHANGED', CHANGED, 409);
      const data: Prisma.CollateralUncheckedUpdateInput = { ...valuationColumnsFromRecord(record, interval), updatedBy: ctx.userId };
      if (mileageKm !== undefined) data.descriptionJson = { ...descriptionOf(fresh), mileageKm } as Prisma.InputJsonValue; // FR-14.1: гүйлт ЗЭЗ оруулна → тодорхойлолт руу
      const updated = await db.collateral.update({ where: { id: fresh.id }, data, include: { documents: true } });
      const snap = await this.tx.finish(db, ctx, app, {
        collateralId: fresh.id, assetType: fresh.assetType, change: 'VALUED', action: 'COLLATERAL_VALUED', before: auditSnapshot(fresh),
        after: { ...auditSnapshot(updated), valuationMethod: record.method, externalRequired: record.externalRequired },
        scoreAffected: true, updateSteps: (EDITABLE_STATUSES as readonly string[]).includes(app.status), // ACTIVE: дахин үнэлгээ — алхмыг хөндөхгүй
      });
      return this.tx.mutation(snap, fresh.id);
    }, TX_OPTIONS);
  }

  // ── event: ValuationCompleted (нөөц синк) ────────────────────────────────────────────────
  /**
   * `idempotentHandler`-ийн транзакц дотор дуудна. Үл мэдэгдэх / хуучин / давхар event-ийг үл тоомсорлоно (`decideValuationEvent`).
   * Хэрэглэвэл: үнэлгээний багана, G0 дахин тооцоо, (ноорог/буцаасан хүсэлтэд) 5-р алхам, аудит + CollateralChanged. Буцаах утга: хэрэглэсэн эсэх.
   */
  async handleValuationCompleted(db: Tx, event: ValuationCompletedEvent): Promise<boolean> {
    const hit = await db.collateral.findFirst({ where: { id: event.collateralId, orgId: event.orgId }, select: { applicationId: true } });
    if (!hit || hit.applicationId !== event.applicationId) return false;
    const ctx: RequestContext = { userId: null, roles: [], branchId: null, orgId: event.orgId, customerId: null, correlationId: event.correlationId };
    const app = await this.tx.lock(db, event.orgId, hit.applicationId);
    // Үнэлгээ зөвхөн RULE_VALUATION төлөвт (ноорог/буцаасан/идэвхтэй) хадгалагддаг; илгээсэн/батлагдсан хүсэлтийн дүнг хоцорсон event чимээгүй өөрчлөхгүй.
    if (!(VALUATION_STATUSES as readonly string[]).includes(app.status)) return false;
    const row = await db.collateral.findFirst({ where: { id: event.collateralId, applicationId: app.id }, include: { documents: true } });
    if (!row) return false;
    const decision = decideValuationEvent(row, event, await this.settings.getIn(db, event.orgId, 'collateral.revaluation_interval_days'));
    if (!decision.apply) return false;
    const updated = await db.collateral.update({ where: { id: row.id }, data: { ...decision.columns }, include: { documents: true } });
    await this.tx.finish(db, ctx, app, {
      collateralId: row.id, assetType: row.assetType, change: 'VALUED', action: 'COLLATERAL_VALUATION_SYNCED', before: auditSnapshot(row), after: auditSnapshot(updated),
      scoreAffected: true, updateSteps: (EDITABLE_STATUSES as readonly string[]).includes(app.status),
    });
    return true;
  }

  // ── туслахууд ───────────────────────────────────────────────────────────────────────────
  private assertMileage(row: CollateralRow, mileageKm: number | undefined): void {
    if (mileageKm !== undefined && row.assetType !== 'VEHICLE') throw new DomainError('MILEAGE_NOT_APPLICABLE', 'Гүйлтийг зөвхөн автомашинд оруулна', 422);
  }

  /** valuation-ий хүсэлт: барьцааны мөр + бүтээгдэхүүн (haircut_json, гадны босго) + setting (хүчинтэй хоног). */
  private async buildRequest(app: LoanApplication, row: CollateralRow, kind: Kind, mileageKm?: number): Promise<SuggestValuationRequest> {
    const assetType = row.assetType as AssetType;
    const product = app.productId ? await this.prisma.product.findFirst({ where: { id: app.productId, orgId: app.orgId } }) : null;
    const haircuts = product?.haircutJson && typeof product.haircutJson === 'object' && !Array.isArray(product.haircutJson) ? (product.haircutJson as Record<string, unknown>) : {};
    const rate = haircuts[assetType];
    const validityDays = await this.settings.get(app.orgId, kind === 'external' ? 'valuation.external_validity_days' : 'valuation.internal_validity_days');
    return {
      collateralId: row.id, applicationId: app.id, productId: app.productId, assetType,
      description: { ...descriptionOf(row), ...(mileageKm !== undefined ? { mileageKm } : {}) },
      productHaircutRate: typeof rate === 'number' && rate >= 0 && rate <= 1 ? rate : null,
      externalValuationThreshold: num(product?.externalValuationThreshold),
      validityDays,
    };
  }
}
