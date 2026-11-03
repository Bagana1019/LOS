import { Inject, Injectable } from '@nestjs/common';
import {
  INQUIRY_SOURCES, type CreditHistorySummary, type InquiryFetchFailure, type InquiryFetchRequest, type InquiryFetchResponse, type InquiryListResponse,
  type InquiryRecord, type KycUnregisteredLoanRequest, type RequestContext, type UnregisteredLoan,
} from '@los/contracts';
import { encryptedField } from '@los/database';
import { Clock, DomainError } from '@los/nest-common';
import type { Prisma } from '.prisma/client-kyc';
import { IntegrationNotImplementedError } from '../../integrations/errors';
import { INQUIRY_PROVIDER, InquiryUnavailableError, type ExternalInquirySource, type InquiryProvider, type ProviderResult } from '../../integrations/inquiry/inquiry.provider';
import { PrismaService } from '../../prisma.service';
import { INQUIRY_RAW_AAD, toLoan, toRecord } from './inquiry.mapper';
import { blacklistInquiry, creditHistoryFrom, expiresAt, latestPerSource } from './inquiry.rules';

/**
 * FR-3 · Лавлагаа (kyc.inquiry). Дуудагч: origination (хүсэлтийн эрхийг тэнд шалгасан). Регистр хадгалагдахгүй, лог-д бичигдэхгүй.
 * Эх сурвалж тус бүр тусдаа: нэг нь унасан ч бусад нь хадгалагдана (failures-д буцаана). Дахин татах = шинэ мөр (түүх хадгалагдана).
 */
@Injectable()
export class InquiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(INQUIRY_PROVIDER) private readonly provider: InquiryProvider,
  ) {}

  async fetch(ctx: RequestContext, req: InquiryFetchRequest): Promise<InquiryFetchResponse> {
    const sources = [...new Set(req.sources ?? INQUIRY_SOURCES)];
    const results: Array<{ source: (typeof INQUIRY_SOURCES)[number]; result: ProviderResult }> = [];
    const failures: InquiryFetchFailure[] = [];

    // Гадаад дуудлагууд зэрэг (эх сурвалж хоорондоо хамааралгүй); BLACKLIST нь дуудагчийн өгсөн үр дүн.
    const external = sources.filter((s): s is ExternalInquirySource => s !== 'BLACKLIST');
    await Promise.all(external.map(async (source) => {
      try {
        results.push({ source, result: await this.provider.fetch(source, req.registerNo) });
      } catch (e) {
        if (e instanceof InquiryUnavailableError) failures.push({ source, code: 'INQUIRY_UNAVAILABLE', message: e.message });
        else if (e instanceof IntegrationNotImplementedError) failures.push({ source, code: 'INTEGRATION_NOT_IMPLEMENTED', message: 'Бодит холболт хараахан хийгдээгүй (INTEGRATION_MODE=mock)' });
        else throw e;
      }
    }));
    if (sources.includes('BLACKLIST')) {
      if (req.blacklist) results.push({ source: 'BLACKLIST', result: blacklistInquiry(req.blacklist) });
      else failures.push({ source: 'BLACKLIST', code: 'BLACKLIST_RESULT_MISSING', message: 'Хар жагсаалтын шалгалтын үр дүн дамжуулаагүй байна' });
    }
    if (!results.length && failures.length && failures.every((f) => f.code === 'INTEGRATION_NOT_IMPLEMENTED')) {
      throw new DomainError('INTEGRATION_NOT_IMPLEMENTED', 'Лавлагааны бодит холболт хараахан хийгдээгүй (INTEGRATION_MODE=mock)', 501);
    }

    const fetchedAt = this.clock.now();
    const expires = expiresAt(fetchedAt, req.staleDays);
    const order = new Map<string, number>(INQUIRY_SOURCES.map((s, i) => [s, i]));
    results.sort((a, b) => (order.get(a.source) ?? 99) - (order.get(b.source) ?? 99));
    const rows = await this.prisma.$transaction(results.map(({ source, result }) => this.prisma.inquiry.create({
      data: {
        orgId: ctx.orgId, applicationId: req.applicationId, customerId: req.customerId, source, fetchedAt, fetchedBy: ctx.userId, expiresAt: expires,
        rawJson: { v: 1, enc: encryptedField(JSON.stringify(result.detail), INQUIRY_RAW_AAD) } as Prisma.InputJsonValue,
        summaryJson: result.summary as Prisma.InputJsonValue, warningLevel: result.warningLevel, createdBy: ctx.userId, updatedBy: ctx.userId,
      },
    })));
    return { items: rows.map((r) => toRecord(r)), failures: failures.sort((a, b) => (order.get(a.source) ?? 99) - (order.get(b.source) ?? 99)) };
  }

  async list(ctx: RequestContext, applicationId: string, customerId?: string): Promise<InquiryListResponse> {
    const where = { orgId: ctx.orgId, applicationId, ...(customerId ? { customerId } : {}) };
    const [rows, loans] = await Promise.all([
      this.prisma.inquiry.findMany({ where, orderBy: { fetchedAt: 'desc' } }),
      this.prisma.unregisteredLoan.findMany({ where, orderBy: { createdAt: 'asc' } }),
    ]);
    const items: InquiryRecord[] = latestPerSource(rows.map((r) => toRecord(r)));
    return { items, unregisteredLoans: loans.map(toLoan) };
  }

  async creditHistory(ctx: RequestContext, applicationId: string, customerId: string): Promise<CreditHistorySummary> {
    const { items, unregisteredLoans } = await this.list(ctx, applicationId, customerId);
    return creditHistoryFrom(items, unregisteredLoans);
  }

  async addUnregisteredLoan(ctx: RequestContext, req: KycUnregisteredLoanRequest): Promise<UnregisteredLoan> {
    const row = await this.prisma.unregisteredLoan.create({
      data: { orgId: ctx.orgId, applicationId: req.applicationId, customerId: req.customerId, lenderName: req.lenderName, amount: req.amount, monthlyPayment: req.monthlyPayment, note: req.note ?? null, createdBy: ctx.userId, updatedBy: ctx.userId },
    });
    return toLoan(row);
  }

  async removeUnregisteredLoan(ctx: RequestContext, applicationId: string, id: string): Promise<void> {
    const res = await this.prisma.unregisteredLoan.deleteMany({ where: { id, applicationId, orgId: ctx.orgId } });
    if (!res.count) throw new DomainError('UNREGISTERED_LOAN_NOT_FOUND', 'Бүртгэлгүй зээл олдсонгүй', 404);
  }
}
