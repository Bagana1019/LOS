import { IntegrationNotImplementedError } from '../errors';
import { InquiryRejectedError, type ExternalInquirySource, type InquiryContext, type InquiryProvider, type ProviderResult } from './inquiry.provider';
import { mapCibRows } from './sainscore/cib.mapper';
import { SainScoreClient } from './sainscore/sainscore.client';
import { loadSainScoreConfig } from './sainscore/sainscore.config';

export interface RealInquiryProviderOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const blank = (v: string | null | undefined): boolean => v === null || v === undefined || v.trim() === '';

/**
 * Бодит холболт: CIB (ЗМС) = SainScore (Python лавлагаа). Бусад эх сурвалж (FICO, ӨОХ, малын тоо, ХУР-ын 6) vendor-ийн лавлагаа/баримтгүй тул
 * зохиомол хариу өгөхгүй — fail closed (IntegrationNotImplementedError; kyc нь эх сурвалж тус бүрийн алдааг failures-д задалж, бусдыг нь үргэлжлүүлнэ).
 */
export class RealInquiryProvider implements InquiryProvider {
  private client: SainScoreClient | null = null;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => Date;

  constructor(private readonly opts: RealInquiryProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
  }

  async fetch(source: ExternalInquirySource, registerNo: string, ctx?: InquiryContext): Promise<ProviderResult> {
    if (source !== 'CIB') throw new IntegrationNotImplementedError(`inquiry:${source}`);
    const cfg = loadSainScoreConfig(this.env); // тохиргоо дутуу → IntegrationNotConfiguredError (vendor руу дуудлагагүй)
    const { phone, email } = ctx?.contact ?? {};
    // Vendor утас, имэйлийг заавал шаарддаг (SR0260/0261/0270/0271): төлбөртэй хүсэлтийг дэмий явуулахгүй.
    if (blank(phone) || blank(email)) {
      throw new InquiryRejectedError(source, 'CONTACT_REQUIRED', 'ЗМС лавлагаанд харилцагчийн утас, имэйл шаардлагатай (харилцагчийн мэдээллийг бөглөнө үү)');
    }
    this.client ??= new SainScoreClient({ baseUrl: cfg.baseUrl, username: cfg.username, passwordHash: cfg.passwordHash, fetchImpl: this.opts.fetchImpl, sleep: this.opts.sleep });
    const vendor = await this.client.inquiry(source, { registerNo, productNo: cfg.productNo, phone: (phone as string).trim(), email: (email as string).trim() });
    return mapCibRows(vendor, this.now(), cfg.policy);
  }
}
