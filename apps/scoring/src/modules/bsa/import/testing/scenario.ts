// ТЕСТИЙН өгөгдөл (SYNTHETIC): нэг харилцагчийн хоёр данс (TDB + MBANK), 2026-04-01..2026-06-30, хоорондын шилжүүлэг (5/28 14:10)-тэй.
// Дүнгүүд гараар тооцоолоход амар: сар бүр ижил, DTI-ийн хүлээгдэх утга тест дотор «гараар» бичигдсэн (кодоос хуулаагүй).
// Бодит банкны хуулга ОГТ ашиглаагүй; parser-ийн формат нь TODO(samples) таамаг.
import type { TxnDirection } from '@los/contracts';
import type { SynTxn } from '../../parsers/engine/testing/synthetic-statement';
import type { Harness } from './harness';
import { buildStatementFile, type FileFormat, type SynFile } from './statement-files';

export const ACCOUNT_A = '5011223344';
export const ACCOUNT_B = '7799001122';
export const HOLDER = 'Bat-Erdene Bold';
export const OPENING_A = 3_000_000;
export const OPENING_B = 2_000_000;
export const TRANSFER_AMOUNT = 500_000;

/** PII-ийн хуурамч тэмдэг: хадгалагдсан issue/event/history/лог-д эдгээр ХЭЗЭЭ Ч орох ёсгүй */
export const PII_MARKERS: readonly string[] = [
  ACCOUNT_A, ACCOUNT_B, '5011', '7799001', 'Bat-Erdene', 'Bold', 'УБ90010203', '90010203', 'ZXQ', 'zxq-secret',
];

/** Санамсаргүй UUID / hex hash-д '5011' мэт богино тэмдэг давхцаж (flaky) худал дохио өгөхөөс сэргийлж, шалгахаас өмнө хасна */
export const withoutRandomIds = (text: string): string =>
  text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/[0-9a-f]{16,}/gi, '');

const MONTHS = ['04', '05', '06'] as const;

const txn = (date: string, time: string, direction: TxnDirection, amount: number, description: string): SynTxn => ({
  date, time, direction, amount, description,
});

/** Helvetica (WinAnsi) Кирилл бичиж чадахгүй тул PDF-д зориулсан Latin тайлбар: «Цалин ZXQ-S04» → «Salary ZXQ-S04» */
const LATIN: Readonly<Record<string, string>> = {
  'Цалин': 'Salary', 'Борлуулалт': 'Sales', 'Зээлийн төлбөр': 'Loan payment', 'Бараа материал': 'Goods', 'Хүнс': 'Food',
  'Шилжүүлэг': 'Transfer', 'Шимтгэл': 'Fee', 'Түрээс': 'Rent',
};
export const toLatin = (rows: SynTxn[]): SynTxn[] =>
  rows.map((t) => {
    const key = Object.keys(LATIN).find((k) => t.description.startsWith(k));
    return key ? { ...t, description: t.description.replace(key, LATIN[key]) } : t;
  });

const byTime = (a: SynTxn, b: SynTxn): number => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`);

/** A данс (TDB, сар бүр: цалин 1.2М, бизнес 0.9М, зээл 0.4М, бараа материал 0.15М, хүнс 0.1М) — 18 мөр */
export function accountATxns(): SynTxn[] {
  const rows: SynTxn[] = [txn('2026-04-01', '08:00:00', 'EXPENSE', 1_000, 'Шимтгэл ZXQ-FEE-A1')];
  for (const m of MONTHS) {
    rows.push(
      txn(`2026-${m}-05`, '09:10:00', 'INCOME', 1_200_000, `Цалин ZXQ-S${m}`),
      txn(`2026-${m}-10`, '10:20:00', 'INCOME', 900_000, `Борлуулалт ZXQ-B${m}`),
      txn(`2026-${m}-12`, '11:30:00', 'EXPENSE', 400_000, `Зээлийн төлбөр ZXQ-L${m}`),
      txn(`2026-${m}-15`, '12:40:00', 'EXPENSE', 150_000, `Бараа материал ZXQ-E${m}`),
      txn(`2026-${m}-18`, '13:50:00', 'EXPENSE', 100_000, `Хүнс ZXQ-F${m}`),
    );
  }
  rows.push(txn('2026-05-28', '14:10:00', 'EXPENSE', TRANSFER_AMOUNT, 'Шилжүүлэг ZXQ-T1'), txn('2026-06-30', '08:00:00', 'EXPENSE', 1_000, 'Шимтгэл ZXQ-FEE-A2'));
  return rows.sort(byTime);
}

/** B данс (MBANK, сар бүр: түрээс 0.6М, Unitel 0.08М) + A-аас орсон шилжүүлэг — 9 мөр */
export function accountBTxns(): SynTxn[] {
  const rows: SynTxn[] = [txn('2026-04-01', '08:30:00', 'EXPENSE', 500, 'Шимтгэл ZXQ-FEE-B1')];
  for (const m of MONTHS) {
    rows.push(
      txn(`2026-${m}-07`, '09:00:00', 'INCOME', 600_000, `Түрээс ZXQ-R${m}`),
      txn(`2026-${m}-20`, '10:00:00', 'EXPENSE', 80_000, `Unitel ZXQ-U${m}`),
    );
  }
  rows.push(txn('2026-05-28', '14:10:00', 'INCOME', TRANSFER_AMOUNT, 'Шилжүүлэг ZXQ-T1'), txn('2026-06-30', '08:30:00', 'EXPENSE', 500, 'Шимтгэл ZXQ-FEE-B2'));
  return rows.sort(byTime);
}

const signed = (t: SynTxn): number => (t.direction === 'INCOME' ? t.amount : -t.amount);
/** rows[0..index) гүйлгээний дараах үлдэгдэл */
export const balanceBefore = (rows: readonly SynTxn[], index: number, opening: number): number =>
  rows.slice(0, index).reduce((acc, t) => acc + signed(t), opening);

export interface HappyFiles {
  a: SynFile;
  b: SynFile;
}

export interface HappyOptions {
  format?: FileFormat;
  /** Файлын нэр дэх PII хуурамч тэмдэг (job.fileName-д л хадгалагдана) */
  nameA?: string;
  nameB?: string;
}

export async function happyFiles(o: HappyOptions = {}): Promise<HappyFiles> {
  const format = o.format ?? 'csv';
  const ext = format === 'pdf' ? 'pdf' : format === 'csv' ? 'csv' : 'txt';
  const pdf = format === 'pdf';
  const a = await buildStatementFile({
    bank: 'TDB', txns: pdf ? toLatin(accountATxns()) : accountATxns(), opening: OPENING_A, format, accountNo: ACCOUNT_A, iban: null, holder: HOLDER,
    fileName: o.nameA ?? `zxq-secret-a.${ext}`,
  });
  const b = await buildStatementFile({
    bank: 'MBANK', txns: pdf ? toLatin(accountBTxns()) : accountBTxns(), opening: OPENING_B, format, accountNo: ACCOUNT_B, iban: null, holder: HOLDER,
    fileName: o.nameB ?? `zxq-secret-b.${ext}`,
  });
  return { a, b };
}

/** Гараар тооцсон хүлээгдэх үр дүн (3 сар, ББӨ 0.1, санал болгосон төлбөр 500,000) */
export const EXPECTED_HAPPY = {
  transactionCount: 27,
  periodFrom: '2026-04-01',
  periodTo: '2026-06-30',
  periodMonths: 3,
  // Нийт орлого: 1,200,000 + 900,000 + 600,000
  totalMonthlyIncome: 2_700_000,
  // Баталгаажсан: 1,200,000 + 0.85 * 900,000 + 600,000
  verifiedMonthlyIncome: 2_565_000,
  // × (1 - 0.1)
  dtiIncome: 2_308_500,
  businessIncomeMonthly: 765_000,
  businessExpenseMonthly: 150_000,
  netCashFlowMonthly: 615_000,
  existingDebtServiceMonthly: 400_000,
  // (500,000 + 400,000) / 2,308,500 = 0.38986...
  /** ScoringInput.householdExpenseMonthly: хүнс 100,000 + Unitel 80,000 */
  householdExpenseMonthly: 180_000,
  dtiPercent: 39,
  dtiLevel: 'MEDIUM',
} as const;

/** Rent-ийг «Тогтмол бус»-д шилжүүлсний дараах (гараар) дүн: баталгаажсан 1,965,000; DTI-орлого 1,768,500; 900,000 / 1,768,500 = 50.89% */
export const EXPECTED_AFTER_RENT_RECLASSIFY = {
  verifiedMonthlyIncome: 1_965_000,
  dtiIncome: 1_768_500,
  dtiPercent: 50.9,
} as const;

/** Хоёр хуулгыг импортлосон шинжилгээ (sync queue ⇒ буцахад ажлууд дууссан) */
export async function importHappy(h: Harness, over: Record<string, unknown> = {}): Promise<{ analysisId: string; files: HappyFiles }> {
  const analysis = await h.createAnalysis(over);
  const files = await happyFiles();
  const res = await h.uploadFiles(analysis.id, [files.a, files.b]);
  if (res.accepted !== 2) throw new Error('test setup: both statements must be accepted');
  return { analysisId: analysis.id, files };
}
