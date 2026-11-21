import { describe, expect, it } from 'vitest';
import type { PricingTierInput } from '@los/contracts';
import { firstTierProblem, rowsToTiers, tierProblems, tierToRow, type TierRow } from './pricing-form';

// Шатлалын мөр: хүү = жилийн % (24.5), шимтгэл = форм дээр % (1.5), API-д бутархай (0.015). Оноо = бүхэл 0–1000.
const tier: PricingTierInput = { code: 'B', name: 'Сайн', band: 'GREEN', minScore: 650, interestRate: 22, feeRate: 0.0125, isDefault: false };
const row = (over: Partial<TierRow> = {}): TierRow => ({ ...tierToRow(tier), ...over });

describe('tierToRow / rowsToTiers', () => {
  it('шимтгэлийг форм дээр хувиар харуулна (0.0125 → 1.25), буцаахад бутархай', () => {
    expect(tierToRow(tier).feePercent).toBe(1.25);
    expect(rowsToTiers([tierToRow(tier)])).toEqual([tier]);
  });

  it('хувиар бичсэн 2.5 нь бутархай 0.025 болж явна (clamp 1 биш)', () => {
    expect(rowsToTiers([row({ feePercent: 2.5 })])[0]!.feeRate).toBe(0.025);
  });
});

describe('tierProblems', () => {
  it('зөв мөрөнд алдаа байхгүй', () => {
    expect(tierProblems(row())).toEqual({});
    expect(firstTierProblem([row(), row({ code: 'C' })])).toBeNull();
  });

  it('хүү 300 → хүрээний алдаа (100 болгож clamp хийхгүй)', () => {
    expect(tierProblems(row({ interestRate: 300 })).interestRate).toBe('Хүү 0–100% хооронд байх ёстой');
  });

  it('шимтгэл 150% → алдаа; 1.555 → бутархайн алдаа', () => {
    expect(tierProblems(row({ feePercent: 150 })).feePercent).toBe('Шимтгэл 0–100% хооронд байх ёстой');
    expect(tierProblems(row({ feePercent: 1.555 })).feePercent).toBe('Бутархай хэсэг 2 оронгоос ихгүй байх ёстой');
  });

  it('оноо: "5сая" (NaN) → тоо биш; 1500 → хүрээ; 12.5 → бүхэл биш', () => {
    expect(tierProblems(row({ minScore: Number.NaN })).minScore).toBe('Зөвхөн тоо оруулна уу (жишээ: 12)');
    expect(tierProblems(row({ minScore: 1500 })).minScore).toBe('Доод оноо 0–1000 хооронд байх ёстой');
    expect(tierProblems(row({ minScore: 12.5 })).minScore).toBe('Доод оноо бүхэл тоо байх ёстой');
  });

  it('хоосон талбар чимээгүй 0 болохгүй: заавал бөглөнө', () => {
    const p = tierProblems(row({ minScore: undefined, interestRate: undefined, feePercent: undefined }));
    expect(p.minScore).toBe('Доод оноо оруулна уу');
    expect(p.interestRate).toBe('Хүү оруулна уу');
    expect(p.feePercent).toBe('Шимтгэл оруулна уу');
  });

  it('firstTierProblem: эхний алдаатай мөрийн мессеж', () => {
    expect(firstTierProblem([row(), row({ code: 'C', interestRate: 300 })])).toBe('C: Хүү 0–100% хооронд байх ёстой');
  });
});
