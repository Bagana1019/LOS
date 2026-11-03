// BSA-BR-9 / BSA-FR-4.10: хамтран зээлдэгчийн шинжилгээг хүсэлтийн түвшинд нэгтгэх. Цэвэр функц.
//  - DTI орлого = Σ, өрийн үйлчилгээ = Σ, бизнесийн орлого/зардал = Σ.
//  - Санал болгосон сарын төлбөр нь ХҮСЭЛТИЙН (нэг) утга: гишүүн бүрд давхардуулж нэмэхгүй.
//  - Найдвар = DTI орлогоор жигнэсэн дундаж (орлого 0 бол энгийн дундаж).
//  - Зээлдэгч хоорондын шилжүүлгийг өөрийн данс мэт хасах нь ангиллын шатанд (own-transfer) шийдэгдсэн; энд дахин тоолохгүй.
import Decimal from 'decimal.js';
import { DTI_PERCENT_CAP } from './bsa-dti';

export interface BsaCombineMember {
  dtiIncome: number;
  existingDebtServiceMonthly: number;
  businessIncomeMonthly: number;
  businessExpenseMonthly: number;
  incomeReliability: number;
  pendingSuspiciousCount: number;
}

export interface BsaCombined {
  dtiIncome: number;
  existingDebtServiceMonthly: number;
  businessIncomeMonthly: number;
  businessExpenseMonthly: number;
  netCashFlowMonthly: number;
  incomeReliability: number;
  pendingSuspiciousCount: number;
  dtiPercent: number;
}

const D = (n: number) => new Decimal(n);
const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

export function combineBsa(members: readonly BsaCombineMember[], proposedMonthlyPayment: number): BsaCombined {
  const sum = (pick: (m: BsaCombineMember) => number) => members.reduce((a, m) => a.plus(pick(m)), D(0));
  const dtiIncome = sum((m) => m.dtiIncome);
  const debt = sum((m) => m.existingDebtServiceMonthly);
  const bizIncome = sum((m) => m.businessIncomeMonthly);
  const bizExpense = sum((m) => m.businessExpenseMonthly);
  const pending = members.reduce((a, m) => a + m.pendingSuspiciousCount, 0);

  let reliability = D(0);
  if (members.length > 0) {
    reliability = dtiIncome.gt(0)
      ? members.reduce((a, m) => a.plus(D(m.incomeReliability).mul(m.dtiIncome)), D(0)).div(dtiIncome)
      : members.reduce((a, m) => a.plus(m.incomeReliability), D(0)).div(members.length);
  }

  const numerator = D(proposedMonthlyPayment).plus(debt);
  const ratio = dtiIncome.gt(0) ? numerator.div(dtiIncome) : numerator.gt(0) ? null : D(0);
  const dtiPercent = ratio === null ? DTI_PERCENT_CAP : Math.min(DTI_PERCENT_CAP, ratio.mul(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toNumber());

  return {
    dtiIncome: money(dtiIncome),
    existingDebtServiceMonthly: money(debt),
    businessIncomeMonthly: money(bizIncome),
    businessExpenseMonthly: money(bizExpense),
    netCashFlowMonthly: money(bizIncome.minus(bizExpense)),
    incomeReliability: reliability.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toNumber(),
    pendingSuspiciousCount: pending,
    dtiPercent,
  };
}
