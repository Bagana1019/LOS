// docs/02 §4: жинлэсэн орлого, DTI орлого, DTI (= LOS ӨОХ, нэг томьёо)
export interface CategoryTotal { code: string; monthlyAvg: number; weight: number; dtiRole: 'INCOME'|'DEBT_SERVICE'|'HOUSEHOLD'|'BUSINESS_EXPENSE'|'EXCLUDE'|'INFO'; }
export function weightedIncome(cats: CategoryTotal[]): number { return cats.filter(c => c.dtiRole === 'INCOME').reduce((s, c) => s + c.monthlyAvg * c.weight, 0); }
export function dtiIncome(weighted: number, costOfGoodsRate: number): number { return weighted * (1 - costOfGoodsRate); }
export function dti(proposedMonthlyPayment: number, existingDebtService: number, dtiIncomeValue: number): number {
  if (dtiIncomeValue <= 0) return Infinity; return (proposedMonthlyPayment + existingDebtService) / dtiIncomeValue;
}
