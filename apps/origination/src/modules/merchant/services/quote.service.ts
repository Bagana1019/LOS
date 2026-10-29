import { Inject, Injectable } from '@nestjs/common';
import { quotePosLease } from '@los/calc';
import type { GoodsCategory, PosQuote, PosQuoteRequest } from '@los/contracts';
import { ceilRateOf, roundMoney } from '../common/money';
import type { RequestContext } from '../common/request-context';
import { DomainError } from '../domain/errors';
import { assertMerchantActive } from '../domain/merchant-state';
import type { MerchantRecord, PlanRecord } from '../domain/records';
import { Clock, PricingProvider } from '../ports';
import { MerchantRepository } from '../persistence/repositories';
import { merchantScope } from './access';
import { PlanService } from './plan.service';

export interface QuoteInput { planCode: string; goodsPrice: number; downPayment: number; termMonths: number; goodsCategory?: GoodsCategory }
export interface PricedQuote { plan: PlanRecord; quote: PosQuote }

/** POS-FR-4 үнийн санал + лизинг үүсгэхэд дахин ашиглагдах НЭГ валидаци. Сервер бүгдийг дахин бодно — клиентийн дүнд итгэхгүй. */
@Injectable()
export class QuoteService {
  constructor(
    @Inject(MerchantRepository) private readonly merchants: MerchantRepository,
    @Inject(PlanService) private readonly plans: PlanService,
    @Inject(PricingProvider) private readonly pricing: PricingProvider,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  async quote(ctx: RequestContext, req: PosQuoteRequest): Promise<PosQuote> {
    const scope = merchantScope(ctx);
    const merchant = await this.merchants.findMerchant(ctx.orgId, scope.merchantId);
    if (!merchant) throw new DomainError('NOT_FOUND', 'Merchant not found');
    return (await this.price(merchant, req)).quote;
  }

  /** Мерчант ACTIVE; хөтөлбөр боломжтой; ангилал/хугацаа/урьдчилгаа/дүн/тасалбарын хязгаар (POS-BR-1, -2, -3, -10, -11). */
  async price(merchant: MerchantRecord, req: QuoteInput): Promise<PricedQuote> {
    assertMerchantActive(merchant.status);
    const now = this.clock.now();
    const plan = (await this.plans.availablePlansFor(merchant, now)).find((p) => p.code === req.planCode);
    if (!plan) throw new DomainError('PLAN_NOT_AVAILABLE', 'The leasing plan is not available');
    if (req.goodsCategory !== undefined && !plan.goodsCategories.includes(req.goodsCategory)) {
      throw new DomainError('GOODS_CATEGORY_NOT_ALLOWED', 'Goods category is not allowed for this plan', { allowed: plan.goodsCategories });
    }
    if (!plan.termOptions.includes(req.termMonths)) throw new DomainError('TERM_NOT_ALLOWED', 'Term is not offered by this plan', { allowed: plan.termOptions });
    const minDown = ceilRateOf(plan.minDownPaymentRate, req.goodsPrice);
    if (req.downPayment >= req.goodsPrice) throw new DomainError('DOWN_PAYMENT_TOO_HIGH', 'Down payment must be less than the goods price');
    if (req.downPayment < minDown) throw new DomainError('DOWN_PAYMENT_TOO_LOW', 'Down payment is below the plan minimum', { minDownPayment: minDown });
    const financed = roundMoney(req.goodsPrice - req.downPayment);
    if (financed < plan.minAmount || financed > plan.maxAmount) {
      throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Financed amount is outside the plan range', { minAmount: plan.minAmount, maxAmount: plan.maxAmount });
    }
    if (financed > merchant.maxTicketAmount) throw new DomainError('TICKET_LIMIT_EXCEEDED', 'Financed amount exceeds the merchant ticket limit', { maxTicketAmount: merchant.maxTicketAmount });
    const rates = this.pricing.resolve(plan);
    try {
      const quote = quotePosLease({
        planCode: plan.code, goodsPrice: req.goodsPrice, downPayment: req.downPayment, termMonths: req.termMonths,
        annualRate: rates.annualRate, feeRate: rates.feeRate, commissionRate: plan.commissionRate ?? merchant.commissionRate,
      });
      return { plan, quote };
    } catch (e) {
      if (e instanceof RangeError) throw new DomainError('VALIDATION_FAILED', 'Quote parameters are out of range');
      throw e;
    }
  }
}
