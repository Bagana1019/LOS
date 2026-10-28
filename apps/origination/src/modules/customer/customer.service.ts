import { Inject, Injectable } from '@nestjs/common';
import {
  CustomerInput, customerTypeOfRegister, normalizeRegisterNo,
  type CreateCustomerRequest, type CustomerApplicationRef, type CustomerCard, type CustomerLookup, type CustomerPage, type CustomerView, type RequestContext,
  type UpdateCustomerRequest, type XypFetchResult,
} from '@los/contracts';
import { auditDiff, blindIndex, encryptedField, recordAudit } from '@los/database';
import { DomainError, conflict, notFound, scopeWhere } from '@los/nest-common';
import { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { BlacklistLookupService } from '../blacklist/blacklist-lookup.service';
import { auditSnapshot, toRawInput, toSummary, toView } from './customer.mapper';
import { XYP_LOOKUP, type XypLookup } from './xyp-lookup';
import { citizenPrefill, leafPaths, mergeXyp } from './xyp-mapper';

export interface ListQuery { q?: string; registerNo?: string; customerType?: 'INDIVIDUAL' | 'LEGAL_ENTITY'; page: number; pageSize: number }

const WITH_CONTACTS = { contacts: true } as const;
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
  async xypFetch(ctx: RequestContext, registerNoRaw: string): Promise<XypFetchResult> {
    const registerNo = normalizeRegisterNo(registerNoRaw);
    const customerType = customerTypeOfRegister(registerNo);
    if (!customerType) throw invalidRegister();
    const [existing, warnings] = await Promise.all([this.findByRegister(ctx.orgId, registerNo), this.blacklist.warningsForRegisterNo(ctx.orgId, registerNo)]);
    if (existing) { // Дахин бүртгэхгүй — гадаад ХУР-ыг дуудахгүй.
      return { registerNo, customerType, fetchedAt: null, prefill: {}, prefilledFields: [], missing: [], existing: toSummary(existing, warnings.length > 0), warnings };
    }
    const citizen = await this.xyp.fetchCitizen(ctx, registerNo);
    const prefill = citizenPrefill(citizen);
    const parsed = CustomerInput.safeParse(prefill);
    // "ХУР-аас татсаны дараа зөвхөн дутууг асуух": дутсан заавал талбарын жагсаалт
    const missing = parsed.success ? [] : [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    return { registerNo, customerType, fetchedAt: citizen.fetchedAt, prefill, prefilledFields: leafPaths(prefill), missing, existing: null, warnings };
  }

  // ── Үүсгэх ──
  async create(ctx: RequestContext, req: CreateCustomerRequest): Promise<CustomerView> {
    const registerNo = req.registerNo;
    const inferred = customerTypeOfRegister(registerNo);
    if (!inferred) throw invalidRegister();
    const { source, ...fields } = req;
    const dup = await this.findByRegister(ctx.orgId, registerNo);
    if (dup) throw this.exists(dup.id); // ХУР дуудахаас өмнө

    let raw: Record<string, unknown> = { ...fields, customerType: fields.customerType ?? inferred };
    let xypFetchedAt: Date | null = null;
    if (source === 'XYP') {
      const citizen = await this.xyp.fetchCitizen(ctx, registerNo);
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
  async update(ctx: RequestContext, id: string, patch: UpdateCustomerRequest): Promise<CustomerView> {
    const row = await this.load(ctx, id);
    const before = toRawInput(toView(row, []));
    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const merged: Record<string, unknown> = { ...before, ...changes };
    // Оршин суугаа хаягийг тусад нь өгвөл "ижил" чекбокс автоматаар арилна
    if (patch.residenceAddress && patch.residenceSameAsOfficial === undefined) merged.residenceSameAsOfficial = false;
    const input = CustomerInput.parse(merged);
    const beforeInput = CustomerInput.parse(before);

    const saved = await this.db.$transaction(async (tx) => {
      if (patch.contacts) await tx.customerContact.deleteMany({ where: { customerId: id, orgId: ctx.orgId } });
      const updated = await tx.customer.update({
        where: { id },
        data: { ...this.columns(input), updatedBy: ctx.userId, ...(patch.contacts ? { contacts: { create: this.contactRows(ctx, input) } } : {}) },
        include: WITH_CONTACTS,
      });
      const diff = auditDiff(auditSnapshot(beforeInput), auditSnapshot(input));
      if (Object.keys(diff.after).length) {
        await recordAudit(tx, { orgId: ctx.orgId, entity: 'CUSTOMER', entityId: id, action: 'CUSTOMER_UPDATED', actorId: ctx.userId, beforeJson: diff.before, afterJson: diff.after, correlationId: ctx.correlationId });
      }
      return updated;
    });
    return toView(saved, await this.blacklist.warningsForHash(ctx.orgId, saved.registerNoHash));
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
      lastName: i.lastName ?? null, firstName: i.firstName, gender: i.gender ?? null, birthDate: i.birthDate ? new Date(`${i.birthDate}T00:00:00Z`) : null,
      phone: i.phone ?? null, email: i.email ?? null, photoFileId: i.photoFileId ?? null, familySize: i.familySize ?? null, activitySector: i.activitySector ?? null,
      maritalStatus: i.maritalStatus ?? null, segment: i.segment ?? null, education: i.education ?? null, isRelatedParty: i.isRelatedParty, isPep: i.isPep,
      officialAddressJson: i.officialAddress ?? Prisma.DbNull, residenceAddressJson: residence ?? Prisma.DbNull, employmentJson: i.employment ?? Prisma.DbNull,
    };
  }

  private contactRows(ctx: RequestContext, i: CustomerInput) {
    return i.contacts.map((c) => ({
      orgId: ctx.orgId, relation: c.relation, registerNoEncrypted: c.registerNo ? encryptedField(c.registerNo) : null, lastName: c.lastName ?? null, firstName: c.firstName,
      phone: c.phone, employment: c.employment ?? null, homeAddress: c.homeAddress ?? null, createdBy: ctx.userId, updatedBy: ctx.userId,
    }));
  }
}
