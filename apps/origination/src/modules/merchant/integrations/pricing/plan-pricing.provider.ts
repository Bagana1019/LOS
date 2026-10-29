import type { PlanRecord } from '../../domain/records';
import { PricingProvider } from '../../ports';

/** №4 (эрсдэлд суурилсан үнэ) бэлэн болтол plan-ийн хүү/шимтгэл (docs/05 §10). */
export class PlanPricingProvider extends PricingProvider {
  resolve(plan: PlanRecord): { annualRate: number; feeRate: number } {
    return { annualRate: plan.annualRate, feeRate: plan.feeRate };
  }
}
