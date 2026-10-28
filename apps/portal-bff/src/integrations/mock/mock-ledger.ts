import { annuityPayment } from '@los/calc';
import type {
  PortalContractInfo,
  PortalCreatePaymentCommand,
  PortalLoanBalance,
  PortalLoanDetail,
  PortalLoanSummary,
  PortalNextInstallment,
  PortalPayment,
  PortalPaymentList,
  PortalPaymentListQuery,
  PortalPaymentMethodLimit,
  PortalProfile,
  PortalSchedule,
  PortalScheduleRow,
  PortalScheduleRowStatus,
} from '@los/contracts';
import { randomToken } from '../../common/crypto';
import type { Clock } from '../../common/clock';
import { addDays, addMonths, diffDays, round2, todayIn } from '../../common/date';
import { maskPhone } from '../../common/mask';
import { PortalError } from '../../common/portal-error';
import { buildMockPdf } from './mock-pdf';

interface Row {
  seq: number;
  dueDate: string;
  days: number;
  principal: number;
  interest: number;
  paidPrincipal: number;
  paidInterest: number;
  paidAt: string | null;
}

interface Loan {
  loanId: string;
  customerId: string;
  contractNo: string;
  productName: string;
  annualRatePercent: number;
  principalAmount: number;
  termMonths: number;
  disbursedAt: string;
  closed: boolean;
  rows: Row[];
  contract: { signed: boolean; signedAt: string | null };
}

interface Customer {
  customerId: string;
  registerNo: string;
  phone: string;
  displayName: string;
}

interface MockPayment {
  paymentId: string;
  customerId: string;
  loanId: string;
  method: PortalPayment['method'];
  amountType: PortalPayment['amountType'];
  amount: number;
  currency: 'MNT' | 'USD';
  status: PortalPayment['status'];
  createdAt: Date;
  expiresAt: Date;
  paidAt: Date | null;
  postedAt: Date | null;
  failureReason: string | null;
  idempotencyKey: string;
  fingerprint: string;
}

const PAYMENT_TTL_MS = 15 * 60 * 1000;

/** Mock-ийн төлбөрийн хэрэгслийн хязгаар. Бодит утгыг origination-ы тохиргооноос авна. */
const METHOD_LIMITS: PortalPaymentMethodLimit[] = [
  { method: 'QPAY', minAmount: 100, maxAmount: 50_000_000 },
  { method: 'SOCIALPAY', minAmount: 100, maxAmount: 20_000_000 },
  { method: 'BANK_ACCOUNT', minAmount: 1000, maxAmount: 100_000_000 },
];

/**
 * Mock горимын нэгдсэн «зээлийн систем + төлбөр хүлээн авагч». Нэг төлөвтэй тул төлбөр хийвэл
 * үлдэгдэл, ЭТХ-ийн төлөв, төлбөрийн түүх зэрэг өөрчлөгдөж frontend end-to-end ажиллуулах боломжтой.
 * Хоёр орны нарийвчлал, ANNUITY ЭТХ (30,000,000₮ / 23.99% / 36 сар ≈ 1,176,828₮ — docs/04 M07 AC).
 * Торгууль (penalty) загварчлаагүй — бодит Core-оос ирнэ.
 */
export class MockLedger {
  private readonly customers: Customer[] = [];
  private readonly loans = new Map<string, Loan>();
  private readonly payments = new Map<string, MockPayment>();
  private failNext: string | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly opts: { timezone: string; paymentConfirmMs: number },
  ) {
    this.seed();
  }

  // ───────────── Харилцагч ─────────────
  findCustomer(registerNo: string, phone: string): { customerId: string; displayName: string } | null {
    const c = this.customers.find((x) => x.registerNo === registerNo && x.phone === phone);
    return c ? { customerId: c.customerId, displayName: c.displayName } : null;
  }

  profile(customerId: string): PortalProfile {
    const c = this.customers.find((x) => x.customerId === customerId);
    if (!c) throw new PortalError('UNAUTHENTICATED');
    return { displayName: c.displayName, phoneMasked: maskPhone(c.phone) };
  }

  // ───────────── Зээл ─────────────
  listLoans(customerId: string): PortalLoanSummary[] {
    return [...this.loans.values()].filter((l) => l.customerId === customerId).map((l) => this.summary(l));
  }

  getLoan(customerId: string, loanId: string): PortalLoanDetail {
    const l = this.owned(customerId, loanId);
    return {
      ...this.summary(l),
      repaymentType: 'ANNUITY',
      firstPaymentDate: l.rows[0]?.dueDate ?? null,
      contractAvailable: true,
    };
  }

  getBalance(customerId: string, loanId: string): PortalLoanBalance {
    return this.balance(this.owned(customerId, loanId));
  }

  getSchedule(customerId: string, loanId: string): PortalSchedule {
    const l = this.owned(customerId, loanId);
    const today = this.today();
    const rows = l.rows.map((r) => this.scheduleRow(l, r, today));
    const sum = (f: (r: Row) => number) => round2(l.rows.reduce((s, r) => s + f(r), 0));
    return {
      loanId,
      currency: 'MNT',
      generatedAt: this.clock.now().toISOString(),
      rows,
      totals: {
        principal: sum((r) => r.principal),
        interest: sum((r) => r.interest),
        total: sum((r) => r.principal + r.interest),
        paid: sum((r) => r.paidPrincipal + r.paidInterest),
      },
    };
  }

  // ───────────── Гэрээ ─────────────
  contractInfo(customerId: string, loanId: string): PortalContractInfo {
    const l = this.owned(customerId, loanId);
    return {
      loanId,
      contractNo: l.contractNo,
      signed: l.contract.signed,
      signedAt: l.contract.signedAt,
      fileName: `${l.contractNo}.pdf`,
      mime: 'application/pdf',
      sizeBytes: this.contractPdf(customerId, loanId).length,
    };
  }

  contractPdf(customerId: string, loanId: string): Buffer {
    const l = this.owned(customerId, loanId);
    return buildMockPdf([
      `LOAN AGREEMENT No. ${l.contractNo}`,
      `Product: ${l.productName.replace(/[^\x20-\x7e]/g, '')}`,
      `Amount: ${l.principalAmount.toFixed(2)} MNT, rate ${l.annualRatePercent}% p.a., term ${l.termMonths} months`,
      `Disbursed: ${l.disbursedAt}`,
      l.contract.signed ? 'Signed copy (MOCK DOCUMENT - not a legal contract)' : 'Unsigned copy (MOCK DOCUMENT)',
    ]);
  }

  // ───────────── Төлбөр ─────────────
  methods(customerId: string, loanId: string): PortalPaymentMethodLimit[] {
    this.owned(customerId, loanId);
    return METHOD_LIMITS.map((m) => ({ ...m }));
  }

  createPayment(customerId: string, cmd: PortalCreatePaymentCommand, idempotencyKey: string): PortalPayment {
    const loan = this.owned(customerId, cmd.loanId);
    const fingerprint = JSON.stringify([cmd.loanId, cmd.method, cmd.amountType, cmd.amount]);
    const existing = [...this.payments.values()].find((p) => p.customerId === customerId && p.idempotencyKey === idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new PortalError('IDEMPOTENCY_KEY_REUSED');
      return this.view(this.settle(existing));
    }
    if (loan.closed) throw new PortalError('LOAN_NOT_PAYABLE');
    if (!METHOD_LIMITS.some((m) => m.method === cmd.method)) throw new PortalError('METHOD_NOT_AVAILABLE');

    const now = this.clock.now();
    const payment: MockPayment = {
      paymentId: `pay_${randomToken(9)}`,
      customerId,
      loanId: cmd.loanId,
      method: cmd.method,
      amountType: cmd.amountType,
      amount: cmd.amount,
      currency: cmd.currency,
      status: 'PENDING',
      createdAt: now,
      expiresAt: new Date(now.getTime() + PAYMENT_TTL_MS),
      paidAt: null,
      postedAt: null,
      failureReason: this.failNext,
      idempotencyKey,
      fingerprint,
    };
    this.failNext = null;
    this.payments.set(payment.paymentId, payment);
    return this.view(this.settle(payment));
  }

  getPayment(customerId: string, paymentId: string): PortalPayment {
    const p = this.payments.get(paymentId);
    if (!p || p.customerId !== customerId) throw new PortalError('PAYMENT_NOT_FOUND');
    return this.view(this.settle(p));
  }

  listPayments(customerId: string, loanId: string, query: PortalPaymentListQuery): PortalPaymentList {
    this.owned(customerId, loanId);
    const all = [...this.payments.values()]
      .filter((p) => p.customerId === customerId && p.loanId === loanId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.paymentId.localeCompare(a.paymentId));
    const start = query.cursor ? all.findIndex((p) => p.paymentId === query.cursor) + 1 : 0;
    const page = all.slice(start, start + query.limit);
    const next = start + query.limit < all.length ? page[page.length - 1].paymentId : null;
    return { items: page.map((p) => this.view(this.settle(p))), nextCursor: next };
  }

  /** Тест/dev: дараагийн үүсэх төлбөр өгөгдсөн шалтгаанаар FAILED болно. */
  failNextPayment(reason: string): void {
    this.failNext = reason;
  }

  // ───────────── Дотоод ─────────────
  private today(): string {
    return todayIn(this.opts.timezone, this.clock.now());
  }

  private owned(customerId: string, loanId: string): Loan {
    const l = this.loans.get(loanId);
    if (!l || l.customerId !== customerId) throw new PortalError('LOAN_NOT_FOUND');
    return l;
  }

  private remaining(r: Row): number {
    return round2(r.principal + r.interest - r.paidPrincipal - r.paidInterest);
  }

  private nextInstallment(l: Loan): PortalNextInstallment | null {
    const r = l.rows.find((x) => this.remaining(x) > 0);
    if (!r) return null;
    return { seq: r.seq, dueDate: r.dueDate, principal: r.principal, interest: r.interest, total: round2(r.principal + r.interest), amountDue: this.remaining(r) };
  }

  private balance(l: Loan): PortalLoanBalance {
    const today = this.today();
    const overdueRows = l.rows.filter((r) => r.dueDate < today && this.remaining(r) > 0);
    const od = {
      principal: round2(overdueRows.reduce((s, r) => s + (r.principal - r.paidPrincipal), 0)),
      interest: round2(overdueRows.reduce((s, r) => s + (r.interest - r.paidInterest), 0)),
      penalty: 0,
      days: overdueRows.length ? diffDays(overdueRows[0].dueDate, today) : 0,
    };
    const outstandingPrincipal = round2(l.rows.reduce((s, r) => s + (r.principal - r.paidPrincipal), 0));
    const accruedInterest = l.closed ? 0 : round2(od.interest + this.currentPeriodAccrual(l, today));
    return {
      loanId: l.loanId,
      currency: 'MNT',
      asOf: this.clock.now().toISOString(),
      outstandingPrincipal,
      accruedInterest,
      accruedPenalty: 0,
      overdue: { ...od, total: round2(od.principal + od.interest + od.penalty) },
      nextInstallment: this.nextInstallment(l),
      payoff: { amount: l.closed ? 0 : round2(outstandingPrincipal + accruedInterest), validUntil: today },
    };
  }

  /** Одоогийн (хугацаа нь болоогүй) мөрийн хүүгийн хоногоор хуримтлагдсан хэсэг, төлсөн хүүг хасч. */
  private currentPeriodAccrual(l: Loan, today: string): number {
    const idx = l.rows.findIndex((r) => r.dueDate >= today && this.remaining(r) > 0);
    if (idx < 0) return 0;
    const row = l.rows[idx];
    const start = idx === 0 ? l.disbursedAt : l.rows[idx - 1].dueDate;
    const span = diffDays(start, row.dueDate);
    const fraction = span > 0 ? Math.min(1, Math.max(0, diffDays(start, today) / span)) : 1;
    return Math.max(0, round2(row.interest * fraction) - row.paidInterest);
  }

  private summary(l: Loan): PortalLoanSummary {
    const b = this.balance(l);
    return {
      loanId: l.loanId,
      contractNo: l.contractNo,
      productName: l.productName,
      currency: 'MNT',
      status: l.closed ? 'CLOSED' : 'ACTIVE',
      principalAmount: l.principalAmount,
      annualInterestRatePercent: l.annualRatePercent,
      termMonths: l.termMonths,
      disbursedAt: l.disbursedAt,
      maturityDate: l.rows[l.rows.length - 1]?.dueDate ?? null,
      outstandingPrincipal: b.outstandingPrincipal,
      overdueAmount: b.overdue.total,
      overdueDays: b.overdue.days,
      nextInstallment: b.nextInstallment,
    };
  }

  private scheduleRow(l: Loan, r: Row, today: string): PortalScheduleRow {
    const total = round2(r.principal + r.interest);
    const paid = round2(r.paidPrincipal + r.paidInterest);
    const remaining = this.remaining(r);
    // Үлдэгдэл: энэ мөрийг төлсний дараах үндсэн зээлийн үлдэгдэл
    const balance = round2(l.rows.filter((x) => x.seq > r.seq).reduce((s, x) => s + x.principal, 0));
    let status: PortalScheduleRowStatus;
    if (remaining <= 0) status = 'PAID';
    else if (r.dueDate < today) status = 'OVERDUE';
    else if (r.dueDate === today) status = 'DUE';
    else status = paid > 0 ? 'PARTIALLY_PAID' : 'UPCOMING';
    return { seq: r.seq, dueDate: r.dueDate, days: r.days, principal: r.principal, interest: r.interest, total, balance, paidAmount: paid, paidAt: r.paidAt, status };
  }

  /** PENDING төлбөрийг цаг хугацаагаар урагшлуулна (mock провайдерын callback-ийг орлоно). */
  private settle(p: MockPayment): MockPayment {
    if (p.status !== 'PENDING') return p;
    const now = this.clock.now();
    const confirmAt = new Date(p.createdAt.getTime() + this.opts.paymentConfirmMs);
    if (now >= confirmAt && confirmAt <= p.expiresAt) {
      if (p.failureReason) {
        p.status = 'FAILED';
        return p;
      }
      p.status = 'PAID';
      p.paidAt = confirmAt;
      this.apply(p);
      p.postedAt = confirmAt;
    } else if (now >= p.expiresAt) {
      p.status = 'EXPIRED';
    }
    return p;
  }

  private apply(p: MockPayment): void {
    const l = this.loans.get(p.loanId);
    if (!l || l.closed) return;
    const today = this.today();
    const payoff = this.balance(l).payoff.amount;
    let left = Math.min(p.amount, payoff);

    if (left >= payoff - 0.005) {
      // Бүрэн хаалт: үндсэн зээл бүгд, хугацаа хэтэрсэн хүү, одоогийн хугацааны хуримтлагдсан хүү; ирээдүйн хүү уучлагдана.
      const accrual = this.currentPeriodAccrual(l, today);
      const currentIdx = l.rows.findIndex((x) => x.dueDate >= today && this.remaining(x) > 0);
      l.rows.forEach((r, i) => {
        if (this.remaining(r) <= 0) return;
        r.paidPrincipal = r.principal;
        if (r.dueDate < today) r.paidInterest = r.interest;
        else if (i === currentIdx) {
          r.interest = round2(r.paidInterest + accrual);
          r.paidInterest = r.interest;
        } else r.interest = r.paidInterest;
        r.paidAt = today;
      });
      l.closed = true;
      return;
    }

    for (const r of l.rows) {
      if (left <= 0) break;
      const interestDue = round2(r.interest - r.paidInterest);
      const payInterest = Math.min(left, interestDue);
      r.paidInterest = round2(r.paidInterest + payInterest);
      left = round2(left - payInterest);
      const principalDue = round2(r.principal - r.paidPrincipal);
      const payPrincipal = Math.min(left, principalDue);
      r.paidPrincipal = round2(r.paidPrincipal + payPrincipal);
      left = round2(left - payPrincipal);
      if (this.remaining(r) <= 0) r.paidAt = today;
    }
    if (l.rows.every((r) => this.remaining(r) <= 0)) l.closed = true;
  }

  private view(p: MockPayment): PortalPayment {
    const pending = p.status === 'PENDING';
    return {
      paymentId: p.paymentId,
      loanId: p.loanId,
      method: p.method,
      amountType: p.amountType,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      expiresAt: p.expiresAt.toISOString(),
      paidAt: p.paidAt?.toISOString() ?? null,
      postedAt: p.postedAt?.toISOString() ?? null,
      failureReason: p.status === 'FAILED' ? p.failureReason : null,
      checkout: pending
        ? {
            qrText: `MOCK-${p.method}-${p.paymentId}`,
            deeplinks: [{ name: p.method, description: 'Mock deeplink', link: `mockpay://pay/${p.paymentId}` }],
            webUrl: `https://pay.mock.invalid/checkout/${p.paymentId}`,
          }
        : null,
    };
  }

  // ───────────── Fixture ─────────────
  private seed(): void {
    const today = this.today();
    this.customers.push(
      { customerId: 'cust_demo_001', registerNo: 'УБ90010112', phone: '99112233', displayName: 'Б. Болд' },
      { customerId: 'cust_demo_002', registerNo: 'УА85050505', phone: '88112233', displayName: 'С. Сараа' },
    );
    // Харилцагч 1: идэвхтэй (11/36 төлсөн) + хаагдсан зээл
    this.addLoan({ loanId: 'loan_demo_001', customerId: 'cust_demo_001', contractNo: 'B10026102801', productName: 'Хэрэглээний зээл', principal: 30_000_000, rate: 23.99, term: 36, disbursedAt: addDays(addMonths(today, -11), -10), paidCount: 11 });
    this.addLoan({ loanId: 'loan_demo_002', customerId: 'cust_demo_001', contractNo: 'B10025030701', productName: 'Бизнесийн эргэлтийн зээл', principal: 5_000_000, rate: 28.8, term: 12, disbursedAt: addMonths(today, -14), paidCount: 12 });
    // Харилцагч 2: 3 сар хэтэрсэн
    this.addLoan({ loanId: 'loan_demo_003', customerId: 'cust_demo_002', contractNo: 'B10026060301', productName: 'Хэрэглээний зээл', principal: 10_000_000, rate: 30, term: 12, disbursedAt: addDays(addMonths(today, -5), -5), paidCount: 2 });
  }

  private addLoan(a: { loanId: string; customerId: string; contractNo: string; productName: string; principal: number; rate: number; term: number; disbursedAt: string; paidCount: number }): void {
    const payment = annuityPayment(a.principal, a.rate, a.term);
    const r = a.rate / 100 / 12;
    let balance = a.principal;
    let prev = a.disbursedAt;
    const rows: Row[] = [];
    for (let seq = 1; seq <= a.term; seq++) {
      const dueDate = addMonths(a.disbursedAt, seq);
      const interest = round2(balance * r);
      const principal = seq === a.term ? round2(balance) : round2(payment - interest);
      balance = round2(balance - principal);
      const paid = seq <= a.paidCount;
      rows.push({ seq, dueDate, days: diffDays(prev, dueDate), principal, interest, paidPrincipal: paid ? principal : 0, paidInterest: paid ? interest : 0, paidAt: paid ? dueDate : null });
      prev = dueDate;
    }
    this.loans.set(a.loanId, {
      loanId: a.loanId,
      customerId: a.customerId,
      contractNo: a.contractNo,
      productName: a.productName,
      annualRatePercent: a.rate,
      principalAmount: a.principal,
      termMonths: a.term,
      disbursedAt: a.disbursedAt,
      closed: a.paidCount >= a.term,
      rows,
      contract: { signed: true, signedAt: `${a.disbursedAt}T02:00:00.000Z` },
    });
  }
}
