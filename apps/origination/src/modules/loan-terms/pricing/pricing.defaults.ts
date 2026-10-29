import type { PricingTierInput } from '@los/contracts';

// DEMO-ийн анхдагч шатлал (BR-6: 18–42%). interestRate = жилийн хувь, feeRate = бутархай. Бодит утга бизнес эзэмшигчээс ирж admin-аар солигдоно (docs/04 "Хүний оролцоо" №4).
export const DEFAULT_PRICING_TIERS: PricingTierInput[] = [
  { code: 'A', name: 'Маш сайн', band: 'GREEN', minScore: 800, interestRate: 18, feeRate: 0.005, isDefault: false },
  { code: 'B', name: 'Сайн', band: 'GREEN', minScore: 650, interestRate: 22, feeRate: 0.01, isDefault: false },
  { code: 'C', name: 'Дунд', band: 'YELLOW', minScore: 500, interestRate: 28, feeRate: 0.015, isDefault: true },
  { code: 'D', name: 'Эрсдэлтэй', band: 'RED', minScore: 350, interestRate: 34, feeRate: 0.02, isDefault: false },
  { code: 'E', name: 'Өндөр эрсдэлтэй', band: 'RED', minScore: 0, interestRate: 42, feeRate: 0.03, isDefault: false },
];
