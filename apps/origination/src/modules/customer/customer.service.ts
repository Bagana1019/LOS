import { Inject, Injectable } from '@nestjs/common';
import {
  CustomerInput, customerTypeOfRegister, normalizeRegisterNo,
  type CreateCustomerRequest, type CustomerApplicationRef, type CustomerCard, type CustomerLookup, type CustomerPage, type CustomerView, type RequestContext,
  UpdateCustomerRequest, type XypCitizen, type XypFetchResult, type XypOtpResult,
} from '@los/contracts';
import { auditDiff, blindIndex, encryptedField, recordAudit } from '@los/database';
import { DomainError, conflict, notFound, scopeWhere } from '@los/nest-common';
import { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { BlacklistLookupService } from '../blacklist/blacklist-lookup.service';
import { auditSnapshot, toRawInput, toSummary, toView } from './customer.mapper';
import { claimConsentAttempt, recordConsentOutcome } from './xyp-consent';
import { XYP_LOOKUP, type XypLookup } from './xyp-lookup';
import { openXypSnapshot, sealXypSnapshot } from './xyp-snapshot';
import { citizenPrefill, leafPaths, mergeXyp, xypConflicts } from './xyp-mapper';

export interface ListQuery { q?: string; registerNo?: string; customerType?: 'INDIVIDUAL' | 'LEGAL_ENTITY'; page: number; pageSize: number }

const WITH_CONTACTS = { contacts: true } as const;
/**
 * NFR-3 салбарын хязгаарлалт (эзэмшигчийн шийдвэр 2026-11-18, хувилбар A): харилцагчийг бүх салбар харж, хүсэлтэд холбоно;
 * өгөгдлийг нь зөвхөн бүртгэсэн (эзэмшигч) салбар засна. `branchId = null` (хуучин/шилжүүлсэн) бол эзэмшигчгүй — `customer:write`-тэй хэн ч засна.
 * Салбаргүй хэрэглэгч эзэмшигчтэй харилцагчийг засахгүй (fail-closed).
 */
export function assertOwningBranch(ctx: Pick<RequestContext, 'branchId'>, ownerBranchId: string | null, customerId?: string): void {
  if (ownerBranchId === null || ownerBranchId === ctx.branchId) return;
  // Статус 403 хэвээр; клиентэд засварын хүсэлт (maker-checker CUSTOMER/UPDATE) илгээх замыг зааж өгнө (gateway-ийн зам)
  const editRequest = customerId ? { editRequest: { method: 'POST', path: `/api/origination/customers/${customerId}/edit-requests` } } : {};
  throw new DomainError('CUSTOMER_BRANCH_FORBIDDEN', 'Энэ харилцагчийг өөр салбар бүртгэсэн тул зөвхөн тухайн салбар засна. Засварын хүсэлт илгээж эзэмшигч салбарын захирлаар батлуулна уу', 403, { ownerBranchId, ...editRequest });
}

type Tx = Prisma.TransactionClient;
export type LockedCustomer = Prisma.CustomerGetPayload<{ include: typeof WITH_CONTACTS }>;
/** PUT-ийн нэгтгэх дүрэм: өгсөн талбарыг л солино, `cleared`-ийг арилгана. */
function mergePatch(before: object, patch: UpdateCustomerRequest, cleared: readonly string[]): Record<string, unknown> {
  const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const merged: Record<string, unknown> = { ...before, ...changes };
  for (const k of cleared) if (k in UpdateCustomerRequest.shape) delete merged[k];
  // Оршин суугаа хаягийг тусад нь өгвөл «ижил» чекбокс арилна; чекбоксыг авч хаяг өгөөгүй бол хаягийг заавал шаардана (одоогийн хуулбарыг дахин ашиглахгүй)
  if (patch.residenceAddress && patch.residenceSameAsOfficial === undefined) merged.residenceSameAsOfficial = false;
  if (patch.residenceSameAsOfficial === false && !patch.residenceAddress) delete merged.residenceAddress;
  return merged;
}
const invalidRegister = () => new DomainError('INVALID_REGISTER_NO', 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)', 400);

/**
 * Модуль 1 · Харилцагч (FR-2). Харилцагчийн лавлах нь байгууллага (org) даяар — ЗЭЗ бусдын бүртгэсэн харилцагчийг регистрээр олж дахин бүртгэхгүй байх (FR-2.2).
 * Харин хүсэлт/зээлийн түүх нь хүсэлтийн харагдах хүрээгээр (NFR-3) шүүгдэнэ.
 */
@Injectable()
export class CustomerService {
  constructor(
    private readonly db: PrismaService,
    private readonly blacklist: BlacklistLookupService,
    @Inject(XYP_LOOKUP) private readonly xyp: XypLookup,
  ) {}

  // ── FR-2.2 хайх ──
  async list(ctx: RequestContext, q: ListQuery): Promise<CustomerPage> {
    const where: Prisma.CustomerWhereInput = { orgId: ctx.orgId, ...(q.customerType ? { customerType: q.customerType } : {}) };
    if (q.registerNo) where.registerNoHash = blindIndex(normalizeRegisterNo(q.registerNo));
    if (q.q?.trim()) {
      const term = q.q.trim();
      const or: Prisma.CustomerWhereInput[] = [
        { lastName: { contains: term, mode: 'insensitive' } }, { firstName: { contains: term, mode: 'insensitive' } }, { phone: { contains: term } },
      ];
      if (customerTypeOfRegister(term)) or.push({ registerNoHash: blindIndex(normalizeRegisterNo(term)) });
      where.AND = [{ OR: or }];
    }
    const [total, rows] = await Promise.all([
      this.db.customer.count({ where }),
      this.db.customer.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const listed = await this.blacklist.blacklistedHashes(ctx.orgId, rows.map((r) => r.registerNoHash));
    return { items: rows.map((r) => toSummary(r, listed.has(r.registerNoHash))), total, page: q.page, pageSize: q.pageSize };
  }

  /** Регистрээр байгаа эсэх + хар жагсаалт (FR-2.2). Дахин бүртгэхгүй: `exists` бол UI картыг нээнэ. */
  async lookup(ctx: RequestContext, registerNoRaw: string): Promise<CustomerLookup> {
    const registerNo = normalizeRegisterNo(registerNoRaw);
    const customerType = customerTypeOfRegister(registerNo);
    if (!customerType) throw invalidRegister();
    const [row, warnings] = await Promise.all([this.findByRegister(ctx.orgId, registerNo), this.blacklist.warningsForRegisterNo(ctx.orgId, registerNo)]);
    return { registerNo, customerType, exists: !!row, customer: row && toSummary(row, warnings.length > 0), warnings };
  }

  // ── "ХУР-аас татах": хадгалахгүй, зөвхөн маягтыг бөглөх өгөгдөл ──
  /**
   * Иргэний зөвшөөрөл, 1-р алхам: ХУР иргэний БҮРТГЭЛТЭЙ утсанд нэг удаагийн код илгээнэ (ажилтан утас сонгохгүй).
   * Регистр тус бүрт 15 минутад 3 хүртэл (SMS бөмбөгдөлтөөс хамгаална); хүсэлт бүр аудитад (код, түүхий регистргүйгээр).
   */
  async xypRequestOtp(ctx: RequestContext, registerNoRaw: string): Promise<XypOtpResult> {
    const registerNo = normalizeRegisterNo(registerNoRaw);
    if (!customerTypeOfRegister(registerNo)) throw invalidRegister();
    const [existing, warnings] = await Promise.all([this.findByRegister(ctx.orgId, registerNo), this.blacklist.warningsForRegisterNo(ctx.orgId, registerNo)]);
    if (existing) return { sent: false, requestedAt: null, existing: toSummary(existing, warnings.length > 0), warnings }; // Дахин бүртгэхгүй — ХУР, SMS дуудахгүй.
    await claimConsentAttempt(this.db, ctx, registerNo, 'XYP_OTP_REQUESTED'); // ХУР-аас ӨМНӨ: алдаатай / тодорхойгүй дуудлага ч тоологдоно
    const { requestedAt } = await this.xyp.requestOtp(ctx, registerNo);
    return { sent: true, requestedAt, existing: null, warnings };
  }

  /**
   * Иргэний зөвшөөрөл, 2-р алхам: иргэний утсанд ирсэн кодоор иргэний мэдээлэл татна. Регистр тус бүрт 15 минутад 5 оролдлого (кодыг таахаас хамгаална).
   * Код нэг удаагийнх тул `source=XYP`-ээр үүсгэхэд ХУР-ыг дахин дуудахгүй: энд битүүмжилсэн тэмдэг (`snapshotToken`) буцааж, `create` нээнэ.
   */
  async xypFetch(ctx: RequestContext, registerNoRaw: string, otp: string): Promise<XypFetchResult> {
    const registerNo = normalizeRegisterNo(registerNoRaw);
    const customerType = customerTypeOfRegister(registerNo);
    if (!customerType) throw invalidRegister();
    const [existing, warnings] = await Promise.all([this.findByRegister(ctx.orgId, registerNo), this.blacklist.warningsForRegisterNo(ctx.orgId, registerNo)]);
    if (existing) { // Дахин бүртгэхгүй — гадаад ХУР-ыг дуудахгүй.
      return { registerNo, customerType, fetchedAt: null, prefill: {}, prefilledFields: [], missing: [], existing: toSummary(existing, warnings.length > 0), warnings, snapshotToken: null };
    }
    await claimConsentAttempt(this.db, ctx, registerNo, 'XYP_OTP_VERIFY_ATTEMPTED');
    let citizen: XypCitizen;
    try {
      citizen = await this.xyp.fetchCitizen(ctx, registerNo, otp);
    } catch (e) {
      if (e instanceof DomainError && e.code === 'XYP_OTP_INVALID') await recordConsentOutcome(this.db, ctx, registerNo, 'XYP_OTP_REJECTED');
      throw e;
    }
    await recordConsentOutcome(this.db, ctx, registerNo, 'XYP_CITIZEN_FETCHED'); // иргэний зөвшөөрлийн нотолгоо: хэн, хэзээ, аль регистр
    const prefill = citizenPrefill(citizen);
    const parsed = CustomerInput.safeParse(prefill);
    // "ХУР-аас татсаны дараа зөвхөн дутууг асуух": дутсан заавал талбарын жагсаалт
    const missing = parsed.success ? [] : [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    return {
      registerNo, customerType, fetchedAt: citizen.fetchedAt, prefill, prefilledFields: leafPaths(prefill), missing, existing: null, warnings,
      snapshotToken: sealXypSnapshot(ctx, registerNo, citizen, Date.now()),
    };
  }

  // ── Үүсгэх ──
  async create(ctx: RequestContext, req: CreateCustomerRequest): Promise<CustomerView> {
    const registerNo = req.registerNo;
    const inferred = customerTypeOfRegister(registerNo);
    if (!inferred) throw invalidRegister();
    const { source, xypSnapshotToken, ...fields } = req;
    const dup = await this.findByRegister(ctx.orgId, registerNo);
    if (dup) throw this.exists(dup.id); // ХУР дуудахаас өмнө

    let raw: Record<string, unknown> = { ...fields, customerType: fields.customerType ?? inferred };
    let xypFetchedAt: Date | null = null;
    if (source === 'XYP') {
      // Иргэний код нэг удаагийнх: ХУР-ыг дахин дуудахгүй, `xyp-fetch`-ийн битүүмжилсэн тэмдгийг нээнэ (өөр хэрэглэгч / регистр / хугацаа дууссан → 400 XYP_SNAPSHOT_INVALID).
      const citizen = openXypSnapshot(ctx, registerNo, xypSnapshotToken, Date.now());
      const conflicts = xypConflicts(raw as Omit<CreateCustomerRequest, 'source'>, citizen);
      if (conflicts.length) {
        throw new DomainError('XYP_FIELD_READONLY', 'ХУР-аас татсан талбарыг (албан ёсны хаяг, овог нэр, төрсөн огноо г.м.) өөрчлөх боломжгүй. ХУР-ын утгыг хэвээр үлдээнэ үү', 400, { fields: conflicts });
      }
      raw = mergeXyp(raw as Omit<CreateCustomerRequest, 'source'>, citizen);
      xypFetchedAt = new Date(citizen.fetchedAt);
    }
    const input = CustomerInput.parse(raw); // FR-2.3: заавал талбар дутуу бол ZodError → 400, юу ч хадгалагдахгүй
    const data = this.columns(input);
    try {
      const row = await this.db.$transaction(async (tx) => {
        const created = await tx.customer.create({
          data: {
            ...data, orgId: ctx.orgId, branchId: ctx.branchId, registerNoHash: blindIndex(input.registerNo), registerNoEncrypted: encryptedField(input.registerNo),
            customerType: input.customerType, xypFetchedAt, createdBy: ctx.userId, updatedBy: ctx.userId,
            contacts: { create: this.contactRows(ctx, input) },
          },
          include: WITH_CONTACTS,
        });
        await recordAudit(tx, { orgId: ctx.orgId, entity: 'CUSTOMER', entityId: created.id, action: 'CUSTOMER_CREATED', actorId: ctx.userId, afterJson: { ...auditSnapshot(input), source }, correlationId: ctx.correlationId });
        return created;
      });
      return toView(row, await this.blacklist.warningsForHash(ctx.orgId, row.registerNoHash));
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') { // зэрэг бүртгэх race: unique (org_id, register_no_hash)
        const again = await this.findByRegister(ctx.orgId, registerNo);
        if (again) throw this.exists(again.id);
      }
      throw e;
    }
  }

  // ── Карт (FR-2.6) ──
  async card(ctx: RequestContext, id: string): Promise<CustomerCard> {
    const row = await this.load(ctx, id);
    const links = await this.db.loanApplicationBorrower.findMany({
      where: { orgId: ctx.orgId, customerId: id, application: scopeWhere(ctx) as Prisma.LoanApplicationWhereInput },
      include: { application: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 50,
    });
    const applications: CustomerApplicationRef[] = links.map((l) => ({
      id: l.application.id, appNo: l.application.appNo, status: l.application.status, role: l.role, amount: l.application.amount?.toString() ?? null,
      currency: l.application.currency, contractNo: l.application.contractNo, createdAt: l.application.createdAt.toISOString(),
    }));
    return { ...toView(row, await this.blacklist.warningsForHash(ctx.orgId, row.registerNoHash)), applications };
  }

  // ── Засах: өгсөн талбарыг л солино; нийт үр дүн дахин FR-2.3-аар шалгагдана ──
  /** @param cleared PUT-д хоосон мөр (`""`) илгээсэн талбарууд = «арилгах»: заавал талбар бол 400, заавал биш бол null болно. */
  async update(ctx: RequestContext, id: string, patch: UpdateCustomerRequest, cleared: readonly string[] = []): Promise<CustomerView> {
    const saved = await this.db.$transaction(async (tx) => {
      const row = await this.lockForUpdate(tx, ctx.orgId, id);
      if (!row) throw notFound('Харилцагч', id);
      assertOwningBranch(ctx, row.branchId, id);
      return this.applyLockedUpdate(tx, ctx, row, patch, cleared);
    });
    return toView(saved, await this.blacklist.warningsForHash(ctx.orgId, saved.registerNoHash));
  }

  /**
   * Нэг харилцагчийн зэрэг засварыг дараалуулна (FOR UPDATE): уншаад-нэгтгээд-бичих нь түгжээгүй бол хоёр ЗЭЗ-ийн өөрчлөлт бие биеийг дарна, холбоо барих хүн давхарлана.
   * Maker-checker-ийн checker tx ч үүнийг дуудна (CUSTOMER/UPDATE handler).
   */
  async lockForUpdate(tx: Tx, orgId: string, id: string): Promise<LockedCustomer | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM origination.customer WHERE id = ${id} AND org_id = ${orgId} FOR UPDATE`;
    return locked.length ? tx.customer.findUniqueOrThrow({ where: { id }, include: WITH_CONTACTS }) : null;
  }

  findInTx(tx: Tx, orgId: string, id: string): Promise<LockedCustomer | null> {
    return tx.customer.findFirst({ where: { id, orgId }, include: WITH_CONTACTS });
  }

  /** Засварын үр дүн (FR-2.3-аар бүрэн шалгасан). Буруу бол ZodError — бичихгүй. Засварын хүсэлтийг илгээх үед урьдчилан шалгахад ч ашиглана. */
  previewMerge(row: LockedCustomer, patch: UpdateCustomerRequest, cleared: readonly string[] = []): CustomerInput {
    return CustomerInput.parse(mergePatch(toRawInput(toView(row, [])), patch, cleared));
  }

  /** Одоогийн утгууд (raw), зөвхөн өгсөн талбарууд — maker-checker-ийн `before` (шифрлэгдэж хадгалагдана) */
  currentFields(row: LockedCustomer, keys: readonly string[]): Record<string, unknown> {
    const raw = toRawInput(toView(row, [])) as Record<string, unknown>;
    return Object.fromEntries(keys.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  }

  /**
   * Түгжсэн мөр дээр засварыг бичиж, ердийн `CUSTOMER_UPDATED` аудитыг нэг tx-д бичнэ. Эрхийг (эзэмшигч салбар эсвэл 4 нүдний батлалт) дуудагч шалгасан байх ёстой.
   * Үр дүн FR-2.3-д тэнцэхгүй бол ZodError (шууд PUT-д 400).
   */
  async applyLockedUpdate(tx: Tx, ctx: RequestContext, row: LockedCustomer, patch: UpdateCustomerRequest, cleared: readonly string[] = []): Promise<LockedCustomer> {
    const before = toRawInput(toView(row, []));
    const input = CustomerInput.parse(mergePatch(before, patch, cleared));
    const beforeInput = CustomerInput.parse(before);
    if (patch.contacts) await tx.customerContact.deleteMany({ where: { customerId: row.id, orgId: ctx.orgId } });
    const updated = await tx.customer.update({
      where: { id: row.id },
      data: { ...this.columns(input), updatedBy: ctx.userId, ...(patch.contacts ? { contacts: { create: this.contactRows(ctx, input) } } : {}) },
      include: WITH_CONTACTS,
    });
    const diff = auditDiff(auditSnapshot(beforeInput), auditSnapshot(input));
    if (Object.keys(diff.after).length) {
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'CUSTOMER', entityId: row.id, action: 'CUSTOMER_UPDATED', actorId: ctx.userId, beforeJson: diff.before, afterJson: diff.after, correlationId: ctx.correlationId });
    }
    return updated;
  }

  // ── дотоод ──
  private findByRegister(orgId: string, registerNo: string) {
    return this.db.customer.findUnique({ where: { orgId_registerNoHash: { orgId, registerNoHash: blindIndex(normalizeRegisterNo(registerNo)) } } });
  }

  private async load(ctx: RequestContext, id: string) {
    const row = await this.db.customer.findFirst({ where: { id, orgId: ctx.orgId }, include: WITH_CONTACTS });
    if (!row) throw notFound('Харилцагч', id);
    return row;
  }

  private exists(customerId: string) {
    return conflict('CUSTOMER_EXISTS', 'Энэ регистртэй харилцагч аль хэдийн бүртгэлтэй байна', { customerId });
  }

  /** `CustomerInput` → customer баганууд (регистр, төрөл, org-аас бусад). */
  private columns(i: CustomerInput) {
    const residence = i.residenceSameAsOfficial ? i.officialAddress : i.residenceAddress;
    return {
      lastName: i.lastName ?? null, clanName: i.clanName ?? null, civilId: i.civilId ?? null, firstName: i.firstName, gender: i.gender ?? null, birthDate: i.birthDate ? new Date(`${i.birthDate}T00:00:00Z`) : null,
      phone: i.phone ?? null, email: i.email ?? null, photoFileId: i.photoFileId ?? null, familySize: i.familySize ?? null, activitySector: i.activitySector ?? null,
      maritalStatus: i.maritalStatus ?? null, segment: i.segment ?? null, education: i.education ?? null, isRelatedParty: i.isRelatedParty, isPep: i.isPep,
      officialAddressJson: i.officialAddress ?? Prisma.DbNull, residenceAddressJson: residence ?? Prisma.DbNull, employmentJson: i.employment ?? Prisma.DbNull,
    };
  }

  private contactRows(ctx: RequestContext, i: CustomerInput) {
    return i.contacts.map((c) => ({
      orgId: ctx.orgId, relation: c.relation, registerNoEncrypted: c.registerNo ? encryptedField(c.registerNo) : null, lastName: c.lastName ?? null, firstName: c.firstName,
      phone: c.phone, employment: c.employment ?? null, homeAddressJson: c.homeAddress ?? Prisma.DbNull, createdBy: ctx.userId, updatedBy: ctx.userId,
    }));
  }
}
