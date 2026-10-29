import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  normalizeRegisterNo,
  type AssetType, type BorrowerRole, type CollateralCandidatesResponse, type CollateralMutationResponse, type EncumbranceCheckView, type OwnershipCheck, type RequestContext,
  type RunEncumbranceCheckRequest, type OwnershipCheckRequest,
} from '@los/contracts';
import { Clock, DomainError } from '@los/nest-common';
import type { Prisma } from '.prisma/client-origination';
import { PrismaService, type Tx } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { customerDisplayName, customerRegisterNo, CustomerDirectory } from '../borrower/customer-directory';
import { toCandidates } from './collateral-candidates';
import { auditSnapshot, collateralFingerprint, descriptionOf } from './collateral-data';
import { findCommittedPledges } from './collateral-pledge';
import {
  bestRole, buildOwnershipCheck, encumbranceDeclaredAllowed, encumbranceIdentifier, encumbranceRegistryAvailable, maskRegister, ownershipDeclaredAllowed, ownershipRegistrySource,
  type MatchedOwner,
} from './collateral-ownership';
import { CollateralTxService, TX_OPTIONS } from './collateral-tx.service';
import { RULE_EDITABLE } from './collateral.constants';
import { KYC_ASSETS_PORT, type KycAssetsPort } from './ports/kyc-assets.port';
import { VALUATION_PORT, type ValuationPort } from './ports/valuation.port';

const CHANGED = 'Шалгалт хийж байх хугацаанд барьцаа өөрчлөгдсөн тул шалгалтыг дахин ажиллуулна уу';

/**
 * Модуль 6 · өмчлөлийн KYC (FR-6.5), ачаалал шалгалт (FR-6.6), ХУР-ын хөрөнгө (FR-6.3).
 * Гадны дуудлага (kyc, valuation) DB-ийн транзакцаас ГАДНА хийгдэнэ (FOR UPDATE түгжээг HTTP дуудлага даяар барихгүй); буцаж ирсний дараа
 * транзакц дотор төлөв, барьцааны "хурууны хээ"-г дахин шалгана — өөрчлөгдсөн бол 409 COLLATERAL_CHANGED. Шалгалтын үр дүн (VERIFIED биш ч) хадгалагдана.
 * Регистр, нэр, улсын дугаар логд бичигдэхгүй.
 */
@Injectable()
export class CollateralChecksService {
  private readonly logger = new Logger(CollateralChecksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly clock: Clock,
    private readonly directory: CustomerDirectory,
    private readonly tx: CollateralTxService,
    @Inject(KYC_ASSETS_PORT) private readonly kyc: KycAssetsPort,
    @Inject(VALUATION_PORT) private readonly valuation: ValuationPort,
  ) {}

  // ── FR-6.3 ХУР-аас хөрөнгө татах ────────────────────────────────────────────────────────
  async xypAssets(ctx: RequestContext, applicationId: string, ownerCustomerId: string): Promise<CollateralCandidatesResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.tx.assertStatus(app, RULE_EDITABLE);
    await this.tx.requireOwner(this.prisma, app.id, ownerCustomerId);
    const owner = await this.directory.findById(this.prisma, app.orgId, ownerCustomerId);
    if (!owner) throw new DomainError('OWNER_NOT_ON_APPLICATION', 'Өмчлөгч харилцагч олдсонгүй', 422);
    const assets = await this.kyc.fetchAssets(ctx, customerRegisterNo(owner));
    const { items, skipped } = toCandidates(assets);
    if (skipped > 0) this.logger.warn({ msg: 'xyp assets skipped (do not match collateral description schema)', skipped, correlationId: ctx.correlationId });

    // alreadyPledged: энэ хүсэлтэд бүртгэгдсэн эсвэл өөр "хүлээн авсан" хүсэлтэд барьцаалагдсан (чөлөөлөгдөөгүй)
    const keys = [...new Set(items.map((i) => i.assetKey).filter((k): k is string => !!k))];
    const own = keys.length ? await this.prisma.collateral.findMany({ where: { applicationId: app.id, assetKey: { in: keys } }, select: { assetKey: true } }) : [];
    const others = await findCommittedPledges(this.prisma, app.orgId, app.id, { assetKeys: keys, registryNos: [] });
    const pledged = new Set([...own.map((o) => o.assetKey), ...others.map((o) => o.assetKey)]);
    return {
      items: items.map((i) => ({ xypRef: i.xypRef, assetType: i.assetType, label: i.label, description: i.description, alreadyPledged: i.assetKey != null && pledged.has(i.assetKey) })),
      fetchedAt: assets.fetchedAt,
    };
  }

  // ── FR-6.5 өмчлөлийн KYC ────────────────────────────────────────────────────────────────
  async checkOwnership(ctx: RequestContext, applicationId: string, collateralId: string, input: OwnershipCheckRequest): Promise<CollateralMutationResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.tx.assertStatus(app, RULE_EDITABLE);
    const row = await this.tx.row(this.prisma, app.id, collateralId);
    const assetType = row.assetType as AssetType;
    const description = descriptionOf(row);
    const source = ownershipRegistrySource(assetType);

    if (input.method === 'DECLARED' && !ownershipDeclaredAllowed(assetType)) {
      throw new DomainError('DECLARED_NOT_ALLOWED', 'Бүртгэлтэй хөрөнгийн (автомашин, үл хөдлөх) өмчлөлийг "Зарласан" аргаар баталгаажуулахгүй — бүртгэлээс шалгана уу', 422);
    }
    if (input.method === 'REGISTRY' && !source) {
      throw new DomainError('REGISTRY_NOT_AVAILABLE', 'Энэ төрлийн хөрөнгөд өмчлөлийн бүртгэл байхгүй тул "Зарласан" аргаар баталгаажуулна уу', 422);
    }
    const propertyId = typeof description.propertyId === 'string' && description.propertyId.trim() ? description.propertyId.trim() : null;
    if (input.method === 'REGISTRY' && source === 'XYP' && !propertyId) {
      throw new DomainError('PROPERTY_ID_REQUIRED', 'ХУР-аас шалгахад өмчлөх эрхийн дугаар (propertyId) заавал шаардлагатай. Хөрөнгийн мэдээллийг засаж дугаарыг оруулна уу', 422);
    }

    // Гадны дуудлага — транзакцаас гадна
    const fingerprint = collateralFingerprint(row);
    let registryOwners: Array<{ registerNo: string; name: string }> | null = null;
    if (input.method === 'REGISTRY') {
      if (source === 'ATUT') registryOwners = [(await this.valuation.lookupVehicle(ctx, String(description.plateNo))).vehicle.owner];
      else registryOwners = (await this.kyc.fetchProperty(ctx, propertyId as string)).owners.map((o) => ({ registerNo: o.registerNo, name: o.name }));
    }

    return this.prisma.$transaction(async (db) => {
      const lockedApp = await this.tx.begin(db, ctx, applicationId, RULE_EDITABLE);
      const fresh = await this.tx.row(db, lockedApp.id, collateralId);
      if (collateralFingerprint(fresh) !== fingerprint) throw new DomainError('COLLATERAL_CHANGED', CHANGED, 409);

      const roles = await this.rolesByCustomer(db, lockedApp.id);
      const owners: MatchedOwner[] = [];
      if (registryOwners) {
        for (const o of registryOwners) {
          const normalized = normalizeRegisterNo(o.registerNo);
          const customer = await this.directory.findByRegisterNo(db, lockedApp.orgId, normalized);
          const role = customer ? bestRole(roles.get(customer.id) ?? []) : null;
          owners.push({ registerMasked: maskRegister(normalized), name: o.name, matchedCustomerId: customer && role ? customer.id : null, role });
        }
      } else {
        // DECLARED: ЗЭЗ өмчлөгчийг баталгаажуулна — өмчлөгч нь хүсэлтийн барьцаалагч мөн эсэхийг л шалгана
        const ownerRow = fresh.ownerCustomerId ? await this.directory.findById(db, lockedApp.orgId, fresh.ownerCustomerId) : null;
        const role = ownerRow ? bestRole(roles.get(ownerRow.id) ?? []) : null;
        owners.push({ registerMasked: ownerRow ? maskRegister(customerRegisterNo(ownerRow)) : '', name: ownerRow ? customerDisplayName(ownerRow) : '', matchedCustomerId: ownerRow && role ? ownerRow.id : null, role });
      }
      const check: OwnershipCheck = buildOwnershipCheck({
        method: input.method, source: input.method === 'DECLARED' ? 'DECLARED' : (source as 'ATUT' | 'XYP'), checkedAt: this.clock.now(), owners,
        collateralOwnerCustomerId: fresh.ownerCustomerId, note: input.note ?? null,
      });
      const updated = await db.collateral.update({ where: { id: fresh.id }, data: { ownershipCheckJson: check as unknown as Prisma.InputJsonValue, ownershipVerified: check.status === 'VERIFIED', updatedBy: ctx.userId }, include: { documents: true } });
      const snap = await this.tx.finish(db, ctx, lockedApp, {
        collateralId: fresh.id, assetType, change: 'OWNERSHIP_CHECKED', action: 'COLLATERAL_OWNERSHIP_CHECKED', before: auditSnapshot(fresh),
        after: { ...auditSnapshot(updated), status: check.status, method: check.method, source: check.source }, updateSteps: true,
      });
      return this.tx.mutation(snap, fresh.id);
    }, TX_OPTIONS);
  }

  // ── FR-6.6 ачаалал шалгах ───────────────────────────────────────────────────────────────
  async checkEncumbrance(ctx: RequestContext, applicationId: string, collateralId: string, input: RunEncumbranceCheckRequest): Promise<CollateralMutationResponse> {
    const app = await this.access.load(ctx, applicationId, 'write');
    this.tx.assertStatus(app, RULE_EDITABLE);
    const row = await this.tx.row(this.prisma, app.id, collateralId);
    const assetType = row.assetType as AssetType;
    const description = descriptionOf(row);

    let identifier: string | null = null;
    if (input.method === 'REGISTRY') {
      if (!encumbranceRegistryAvailable(assetType)) {
        throw new DomainError('REGISTRY_NOT_AVAILABLE', 'Энэ төрлийн хөрөнгийн ачааллыг шалгах бүртгэл байхгүй тул "Зарласан" аргаар баталгаажуулна уу', 422);
      }
      identifier = encumbranceIdentifier(assetType, description);
      if (!identifier) throw new DomainError('IDENTIFIER_REQUIRED', 'Ачаалал шалгахад хөрөнгийн тодорхойлогч (улсын дугаар, өмчлөх эрхийн дугаар, серийн дугаар) заавал шаардлагатай', 422);
    } else if (!encumbranceDeclaredAllowed(assetType, description)) {
      throw new DomainError('DECLARED_NOT_ALLOWED', 'Бүртгэлтэй хөрөнгийн (автомашин, үл хөдлөх, серийн дугаартай тоног төхөөрөмж) ачааллыг "Зарласан" аргаар баталгаажуулахгүй — ЗМС, ЭБ-ээс шалгана уу', 422);
    }

    const fingerprint = collateralFingerprint(row);
    // fail closed: kyc 503 ENCUMBRANCE_UNAVAILABLE / 501 нь шууд дамжина, юу ч "цэвэр" гэж хадгалагдахгүй
    const result = identifier ? await this.kyc.checkEncumbrance(ctx, { assetType, identifier }) : null;

    return this.prisma.$transaction(async (db) => {
      const lockedApp = await this.tx.begin(db, ctx, applicationId, RULE_EDITABLE);
      const fresh = await this.tx.row(db, lockedApp.id, collateralId);
      if (collateralFingerprint(fresh) !== fingerprint) throw new DomainError('COLLATERAL_CHANGED', CHANGED, 409);
      const view: EncumbranceCheckView = result
        ? { status: result.status, method: 'REGISTRY', checkedAt: this.clock.now().toISOString(), sources: result.sources.map((s) => ({ source: s.source, status: s.status, pledgee: s.pledgee, registeredAt: s.registeredAt, note: s.note })), note: input.note ?? null }
        : { status: 'CLEAR', method: 'DECLARED', checkedAt: this.clock.now().toISOString(), sources: [], note: input.note ?? null };
      const updated = await db.collateral.update({ where: { id: fresh.id }, data: { encumbranceCheckJson: view as unknown as Prisma.InputJsonValue, encumbranceStatus: view.status, updatedBy: ctx.userId }, include: { documents: true } });
      const snap = await this.tx.finish(db, ctx, lockedApp, {
        collateralId: fresh.id, assetType, change: 'ENCUMBRANCE_CHECKED', action: 'COLLATERAL_ENCUMBRANCE_CHECKED', before: auditSnapshot(fresh),
        after: { ...auditSnapshot(updated), method: view.method }, updateSteps: true,
      });
      return this.tx.mutation(snap, fresh.id);
    }, TX_OPTIONS);
  }

  private async rolesByCustomer(db: Tx, applicationId: string): Promise<Map<string, BorrowerRole[]>> {
    const rows = await db.loanApplicationBorrower.findMany({ where: { applicationId }, select: { customerId: true, role: true } });
    const out = new Map<string, BorrowerRole[]>();
    for (const r of rows) out.set(r.customerId, [...(out.get(r.customerId) ?? []), r.role as BorrowerRole]);
    return out;
  }
}
