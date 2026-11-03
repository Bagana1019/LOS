import { describe, expect, it } from 'vitest';
import { combineBsa } from './bsa-combine';

const m = (o: Partial<Parameters<typeof combineBsa>[0][number]> = {}) => ({
  dtiIncome: 1_000_000, existingDebtServiceMonthly: 100_000, businessIncomeMonthly: 2_000_000, businessExpenseMonthly: 500_000,
  incomeReliability: 80, pendingSuspiciousCount: 0, ...o,
});

describe('combineBsa (BSA-BR-9)', () => {
  it('нэг зээлдэгч: утгууд хэвээр, санал болгосон төлбөр нэг л удаа', () => {
    const r = combineBsa([m()], 200_000);
    expect(r.dtiIncome).toBe(1_000_000);
    expect(r.dtiPercent).toBe(30);
    expect(r.netCashFlowMonthly).toBe(1_500_000);
  });
  it('хамтран зээлдэгч 2 → орлого Σ, өрийн үйлчилгээ Σ', () => {
    const r = combineBsa([m(), m({ dtiIncome: 3_000_000, existingDebtServiceMonthly: 300_000, incomeReliability: 40, pendingSuspiciousCount: 2 })], 600_000);
    expect(r.dtiIncome).toBe(4_000_000);
    expect(r.existingDebtServiceMonthly).toBe(400_000);
    expect(r.dtiPercent).toBe(25);
    expect(r.incomeReliability).toBe(50);
    expect(r.pendingSuspiciousCount).toBe(2);
    expect(r.businessIncomeMonthly).toBe(4_000_000);
  });
  it('орлого 0: найдвар энгийн дундаж; төлбөртэй бол DTI cap, төлбөргүй бол 0', () => {
    const z = { dtiIncome: 0, incomeReliability: 10 };
    expect(combineBsa([m(z), m({ ...z, incomeReliability: 30 })], 1000).dtiPercent).toBe(999.9);
    const none = combineBsa([m({ ...z, existingDebtServiceMonthly: 0 })], 0);
    expect(none.dtiPercent).toBe(0);
    expect(combineBsa([m(z), m({ ...z, incomeReliability: 30 })], 0).incomeReliability).toBe(20);
  });
  it('гишүүнгүй: тэг', () => {
    const r = combineBsa([], 0);
    expect(r).toMatchObject({ dtiIncome: 0, incomeReliability: 0, dtiPercent: 0 });
  });
  it('өндөр DTI cap-д хязгаарлагдана', () => {
    expect(combineBsa([m({ dtiIncome: 1 })], 1e9).dtiPercent).toBe(999.9);
  });
});
