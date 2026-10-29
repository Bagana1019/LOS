import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { BankReconcileResponse } from '@los/contracts';
import { maskAccountNo } from '@los/database';
import type { BankTransferEntry } from '.prisma/client-origination';
import { Clock } from '@los/nest-common';
import { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import type { IncomingTransfer } from '../../integrations/bank-transfer/bank-transfer.client';
import { sanitizeRaw } from '../../integrations/payment-provider/sanitize';
import { safeLogText, withProvider } from './payment.errors';
import { Actor, PaymentService } from './payment.service';
import { ProviderRegistry } from './provider-registry';
import { extractContractCandidates, extractInvoiceCandidates } from './transfer-reference';

const Decimal = Prisma.Decimal;
const DAY_MS = 86_400_000;
interface Match { applicationId: string; invoiceId: string | null }

/**
 * FR-12.4-тэй холбоотой банкны тулгалт: орж ирсэн шилжүүлгийг BankTransferEntry-д бүртгэж, ЭТХ-ийн төлбөр болгоно (бизнес дүрэм 4: recordPayment).
 * BankTransferEntry.status: MATCHED | UNMATCHED (таарах хүсэлт олдоогүй) | FAILED (олдсон ч бүртгэхэд алдаа гарсан — дараагийн тулгалт дахин оролдоно).
 */
@Injectable()
export class BankReconciliationService {
  private readonly logger = new Logger('BankReconciliation');
  constructor(private readonly prisma: PrismaService, private readonly registry: ProviderRegistry, private readonly payments: PaymentService, private readonly clock: Clock) {}

  async reconcile(actor: Actor, opts: { since?: Date } = {}): Promise<BankReconcileResponse> {
    const account = await this.registry.collectionAccount(actor.orgId);
    if (!account) throw new HttpException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'Банкны шилжүүлгийн хүлээн авах данс тохируулаагүй байна' }, 503);
    const since = opts.since ?? (await this.defaultSince(actor.orgId, account.accountNo));
    const transfers = await withProvider(() => this.registry.bank.listIncomingTransfers({ since, accountNo: account.accountNo }));

    const stats: BankReconcileResponse = { fetched: transfers.length, matched: 0, duplicates: 0, unmatched: 0, errors: 0 };
    for (const t of transfers) {
      // Зөвхөн манай данс руу орсон (credit) шилжүүлэг; 2 оронд бөөрөнхийлөхөд 0 болох дүн (жишээ нь 0.004) хуваарилагдахгүй тул алгасна.
      if (t.accountNo !== account.accountNo || !Number.isFinite(t.amount) || new Decimal(t.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).lte(0)) continue;
      // Нэг гүйлгээний алдаа бусдыг хаахгүй: ижил (since, valueDate эрэмбэ) мөр дараагийн тулгалт бүрт эхэнд нь таарч, хойно орсон бүх гүйлгээ бүртгэгдэхгүй үлдэх байсан.
      let entry: BankTransferEntry | undefined;
      try {
        entry = await this.upsertEntry(actor.orgId, t);
        if (entry.status === 'MATCHED') { stats.duplicates++; continue; }
        const match = await this.match(actor.orgId, t);
        if (!match) { stats.unmatched++; continue; }

        const entryId = entry.id;
        let claimed = false;
        await this.payments.recordPayment(actor, {
          applicationId: match.applicationId, invoiceId: match.invoiceId, provider: 'BANK_TRANSFER', providerPaymentId: `${t.bankCode}:${t.bankReference}`,
          amount: t.amount, currency: t.currency, paidAt: t.valueDate, payerName: t.payerName, payerAccount: t.payerAccount, raw: t,
        }, async (tx, result) => {
          // Зэрэг ажиллаж буй өөр тулгалт аль хэдийн MATCHED болгосон бол давхарт тооцно. FAILED (өмнө унасан) мөр дахин оролдогдоно.
          const { count } = await tx.bankTransferEntry.updateMany({ where: { id: entryId, status: { not: 'MATCHED' } }, data: { status: 'MATCHED', paymentId: result.payment.id } });
          claimed = count > 0;
        });
        if (claimed) stats.matched++; else stats.duplicates++;
      } catch (e) {
        stats.errors++;
        this.logger.error(`Тулгалт: гүйлгээг боловсруулж чадсангүй (${safeLogText(t.bankCode)}:${safeLogText(t.bankReference)}): ${e instanceof Error ? safeLogText(e.message, 120) : 'үл мэдэгдэх'}`);
        if (entry) await this.prisma.bankTransferEntry.updateMany({ where: { id: entry.id, status: { not: 'MATCHED' } }, data: { status: 'FAILED' } }).catch(() => undefined);
      }
    }
    this.logger.log(`Тулгалт: fetched=${stats.fetched} matched=${stats.matched} duplicates=${stats.duplicates} unmatched=${stats.unmatched} errors=${stats.errors}`);
    return stats;
  }

  private async defaultSince(orgId: string, accountNo: string): Promise<Date> {
    const last = await this.prisma.bankTransferEntry.findFirst({ where: { orgId, accountNo }, orderBy: { valueDate: 'desc' }, select: { valueDate: true } });
    return last ? new Date(last.valueDate.getTime() - DAY_MS) : new Date(this.clock.now().getTime() - 30 * DAY_MS);
  }

  private async upsertEntry(orgId: string, t: IncomingTransfer): Promise<BankTransferEntry> {
    const key = { bankCode_bankReference: { bankCode: t.bankCode, bankReference: t.bankReference } };
    const found = await this.prisma.bankTransferEntry.findUnique({ where: key });
    if (found) return found;
    try {
      return await this.prisma.bankTransferEntry.create({
        data: {
          orgId, bankCode: t.bankCode, bankReference: t.bankReference, accountNo: t.accountNo, amount: t.amount, currency: t.currency, valueDate: t.valueDate,
          description: t.description, payerName: t.payerName, payerAccountMasked: t.payerAccount ? maskAccountNo(t.payerAccount) : null, status: 'UNMATCHED',
          rawJson: sanitizeRaw(t) as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return this.prisma.bankTransferEntry.findUniqueOrThrow({ where: key });
      throw e;
    }
  }

  /** Гүйлгээний утгаас senderInvoiceNo (BANK_TRANSFER invoice) → олдохгүй бол гэрээний дугаар. */
  private async match(orgId: string, t: IncomingTransfer): Promise<Match | null> {
    const candidates = extractInvoiceCandidates(t.description);
    if (candidates.length) {
      const found = await this.prisma.paymentInvoice.findMany({ where: { orgId, provider: 'BANK_TRANSFER', senderInvoiceNo: { in: candidates } }, select: { id: true, applicationId: true, senderInvoiceNo: true } });
      // Нэр дэвшигчийн дарааллаар (хамгийн урт нь түрүүлж) — тааруулалтыг тодорхой болгоно.
      for (const c of candidates) {
        const invoice = found.find((i) => i.senderInvoiceNo === c);
        if (invoice) return { applicationId: invoice.applicationId, invoiceId: invoice.id };
      }
    }
    const contracts = extractContractCandidates(t.description);
    if (contracts.length) {
      const app = await this.prisma.loanApplication.findFirst({ where: { orgId, contractNo: { in: contracts } }, select: { id: true } });
      if (app) return { applicationId: app.id, invoiceId: null };
    }
    this.logger.warn(`Тулгалт: таарах хүсэлт олдсонгүй (${safeLogText(t.bankCode)}:${safeLogText(t.bankReference)})`);
    return null;
  }
}
