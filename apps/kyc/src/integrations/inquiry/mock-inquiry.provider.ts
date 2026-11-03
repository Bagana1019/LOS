import { createHash } from 'node:crypto';
import { InquiryUnavailableError, type ExternalInquirySource, type InquiryProvider, type ProviderResult } from './inquiry.provider';

/** Туршилтын тогтмол: энэ регистрээр бүх лавлагаа "түр ажиллахгүй" (ХУР mock-ийн `УБ99999999`-тэй адил). */
export const UNAVAILABLE_REGISTER = /99999999$/;
/** Туршилтын тогтмол: идэвхтэй зээл 2, сарын төлбөр 600,000, хугацаа хэтэрсэн (WARNING) — тест, демо. */
export const OVERDUE_REGISTER = /77777777$/;

const LENDERS = ['Хаан банк', 'Голомт банк', 'ХХБ', 'Төрийн банк', 'Хас банк', 'Мобификом ББСБ', 'Ард Кредит'];
const EMPLOYERS = ['Монгол Шуудан ХХК', 'Оюу Толгой ХХК', 'Төв аймгийн ЗДТГ', 'Номин Холдинг'];

/** DEMO — бодит ЗМС/ХУР биш! Регистр + эх сурвалжийн hash-аас гарсан deterministic fixture (ижил регистр = үргэлж ижил хариу). */
function bytes(source: string, registerNo: string): Buffer {
  return createHash('sha256').update(`inquiry-demo:${source}:${registerNo}`).digest();
}
const monthAgo = (n: number): string => {
  const d = new Date(Date.UTC(2026, 9, 1));
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
};

export class MockInquiryProvider implements InquiryProvider {
  readonly demo = true;

  async fetch(source: ExternalInquirySource, registerNo: string): Promise<ProviderResult> {
    if (UNAVAILABLE_REGISTER.test(registerNo)) throw new InquiryUnavailableError(source);
    const h = bytes(source, registerNo);
    switch (source) {
      case 'CIB': return this.cib(registerNo, h);
      case 'FICO': {
        const score = 520 + (h.readUInt16BE(0) % 300);
        const band = score >= 740 ? 'EXCELLENT' : score >= 670 ? 'GOOD' : score >= 580 ? 'FAIR' : 'POOR';
        return { summary: { fico_score: score, band }, detail: { score, band, model: 'FICO-DEMO' }, warningLevel: score < 580 ? 'WARNING' : 'NONE' };
      }
      case 'DTI': {
        const dti = Math.round((0.1 + (h.readUInt16BE(0) % 50) / 100) * 100) / 100; // 0.10 … 0.59
        return { summary: { dti }, detail: { dti, note: 'ЗМС-ийн ӨОХ (DEMO)' }, warningLevel: 'NONE' };
      }
      case 'LIVESTOCK': {
        const horse = h[0]! % 40, cattle = h[1]! % 30, sheep = h[2]! % 200, goat = h[3]! % 150, camel = h[4]! % 6 === 0 ? h[5]! % 10 : 0;
        return { summary: { total_heads: horse + cattle + sheep + goat + camel }, detail: { horse, cattle, sheep, goat, camel }, warningLevel: 'NONE' };
      }
      case 'XYP_PROPERTY': {
        const count = h[0]! % 3;
        const items = Array.from({ length: count }, (_, i) => ({ propertyId: `MOCK-${registerNo}-${i + 1}`, kind: i % 2 ? 'APARTMENT' : 'LAND', areaM2: 40 + (h[i + 1]! % 160) }));
        return { summary: { count }, detail: { items }, warningLevel: 'NONE' };
      }
      case 'XYP_VEHICLE': {
        const count = h[1]! % 3;
        const items = Array.from({ length: count }, (_, i) => ({ plateNo: `${1000 + (h[i + 2]! * 7) % 9000}УБА`, year: 2008 + (h[i + 3]! % 16) }));
        return { summary: { count }, detail: { items }, warningLevel: 'NONE' };
      }
      case 'XYP_PENSION': {
        const pensioner = h[2]! % 8 === 0;
        const monthly = pensioner ? 500_000 + (h[3]! % 6) * 50_000 : 0;
        return { summary: { is_pensioner: pensioner, monthly_pension: monthly }, detail: { pensioner, monthlyPension: monthly }, warningLevel: 'NONE' };
      }
      case 'XYP_LEGAL': {
        const count = h[3]! % 5 === 0 ? 1 : 0;
        const items = count ? [{ name: `${EMPLOYERS[h[4]! % EMPLOYERS.length]}`, role: 'FOUNDER', share: 100 }] : [];
        return { summary: { count }, detail: { items }, warningLevel: 'NONE' };
      }
      case 'XYP_CRIMINAL': {
        const has = h[4]! % 25 === 0;
        return { summary: { has_record: has, count: has ? 1 : 0 }, detail: { records: has ? [{ article: 'DEMO', year: 2019 }] : [] }, warningLevel: has ? 'WARNING' : 'NONE' };
      }
      case 'XYP_COURT_DEBT': {
        const has = h[5]! % 15 === 0;
        const total = has ? 1_000_000 + (h[6]! % 20) * 250_000 : 0;
        return { summary: { has_debt: has, total_amount: total }, detail: { cases: has ? [{ court: 'DEMO', amount: total }] : [] }, warningLevel: has ? 'WARNING' : 'NONE' };
      }
    }
  }

  private cib(registerNo: string, h: Buffer): ProviderResult {
    const overdue = OVERDUE_REGISTER.test(registerNo);
    const activeCount = overdue ? 2 : h[0]! % 4; // 0–3
    const loans = Array.from({ length: activeCount }, (_, i) => {
      const disbursed = 3_000_000 + (h[i + 1]! % 40) * 1_000_000;
      const monthly = overdue ? 300_000 : 150_000 + (h.readUInt16BE(4 + i) % 26) * 10_000;
      return { lender: LENDERS[h[i + 5]! % LENDERS.length]!, status: 'ACTIVE', disbursedAmount: disbursed, outstanding: Math.round(disbursed * 0.6), monthlyPayment: monthly, openedOn: monthAgo(6 + (h[i + 6]! % 24)), overdueDays: overdue && i === 0 ? 45 : 0 };
    });
    const closedCount = h[9]! % 4;
    const closed = Array.from({ length: closedCount }, (_, i) => ({ lender: LENDERS[h[i + 10]! % LENDERS.length]!, status: 'CLOSED', disbursedAmount: 2_000_000 + (h[i + 11]! % 20) * 500_000, monthlyPayment: 0, openedOn: monthAgo(36 + i * 6), closedOn: monthAgo(12 + i * 3), overdueDays: 0 }));
    const totalDisbursed = loans.reduce((s, l) => s + l.disbursedAmount, 0);
    const outstanding = loans.reduce((s, l) => s + l.outstanding, 0);
    const monthlyPayment = loans.reduce((s, l) => s + l.monthlyPayment, 0);
    const overdueMax = Math.max(0, ...loans.map((l) => l.overdueDays));
    const overdueRoll = h[3]! % 10;
    const overdueMonths = overdue ? 2 : overdueRoll < 7 ? 0 : overdueRoll - 6; // 70% нь 0
    return {
      summary: {
        active_loan_count: activeCount, open_loan_count: activeCount, closed_loan_count: closedCount,
        total_disbursed: totalDisbursed, outstanding, monthly_payment: monthlyPayment, overdue_days_max: overdueMax, overdue_months: overdueMonths,
        inquiries_last_90d: h[8]! % 5,
      },
      detail: {
        loans: [...loans, ...closed],
        inquiryHistory: Array.from({ length: h[8]! % 5 }, (_, i) => ({ lender: LENDERS[h[i + 12]! % LENDERS.length]!, on: monthAgo(i) })),
        obligations: [],
        collateral: [],
      },
      warningLevel: overdueMax > 90 ? 'RED' : overdueMax > 0 || overdueMonths > 0 ? 'WARNING' : 'NONE',
    };
  }
}
