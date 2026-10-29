import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CreatePaymentInvoiceRequest, InstallmentStatus, PaymentProvider, RepaymentStatusView } from '@los/contracts';
import type { InstallmentView, PaymentAllocationView, PaymentProviderInfo, RepaymentStatusView as RepaymentStatus } from '@los/contracts';
import mnBase from '../../../../../packages/ui/src/i18n/mn.json';
import mnPayment from '../../../../../packages/ui/src/i18n/mn.payment.json';
import {
  AMOUNT_MODES, ERROR_KEYS, INSTALLMENT_COLOR, PROVIDERS, allocatedAmount, amountModeKey, applicationStatusLabel, buildInvoiceRequest, buildNameCheckRequest, canSimulate,
  defaultRowId, describeError, describeReconcile, firstEnabledProvider, formatAmount, formatCountdown, formatDateTime, groupDigits, initialPayForm, installmentStatusKey,
  isAlreadyPaidError, isSafeDeeplink, isStaleStateError, maxPayable, modeOptions, paidPercent, parseDigits, payGate, payableRows, pollInterval, previewAmount, providerHintKey,
  providerKey, providerOptions, qrImageSrc, reasonKey, remainingSeconds, resolveProvider, similarityPercent, sortAllocations, validateCustomAmount, validatePayForm,
  type PayFormValues, type Translate,
} from './payment.utils';

const dict = { ...(mnBase as Record<string, string>), ...(mnPayment as Record<string, string>) };
/** lib/i18n.ts-ийн t()-тэй ижил: олдохгүй түлхүүрийг "!" угтвартай буцаана (тестэд илрүүлнэ). */
const tr: Translate = (key, params) => {
  const raw = dict[key] ?? `!${key}`;
  return params ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : raw;
};

// ── fixtures ────────────────────────────────────────────────────────────────────────
function row(seq: number, over: Partial<InstallmentView> = {}): InstallmentView {
  const base: InstallmentView = {
    id: `row${seq}`, seq, dueDate: `2026-${String(seq + 9).padStart(2, '0')}-05`, principal: 80_000, interest: 20_000, total: 100_000,
    paidInterest: 0, paidPrincipal: 0, paidTotal: 0, outstanding: 100_000, status: 'UPCOMING', daysOverdue: 0,
  };
  return { ...base, ...over };
}

/** 3 мөр: №1 бүрэн төлөгдсөн, №2 хоцорсон (хэсэгчлэн төлсөн), №3 удахгүй. */
function status(over: Partial<RepaymentStatus> = {}): RepaymentStatus {
  const installments = [
    row(1, { dueDate: '2026-09-05', paidInterest: 20_000, paidPrincipal: 80_000, paidTotal: 100_000, outstanding: 0, status: 'PAID' }),
    row(2, { dueDate: '2026-10-05', paidInterest: 20_000, paidPrincipal: 10_000, paidTotal: 30_000, outstanding: 70_000, status: 'OVERDUE', daysOverdue: 23 }),
    row(3, { dueDate: '2026-11-05' }),
  ];
  return {
    applicationId: 'app1', currency: 'MNT', asOf: '2026-10-28', applicationStatus: 'ACTIVE', payable: true, scheduleGeneratedAt: '2026-08-05T02:00:00.000Z',
    installments, totals: { scheduled: 300_000, paid: 130_000, outstanding: 170_000, overdue: 70_000 }, payNowAmount: 70_000,
    nextDue: { scheduleRowId: 'row2', dueDate: '2026-10-05', outstanding: 70_000 }, recentPayments: [], ...over,
  };
}

const infos = (over: Partial<Record<PaymentProviderInfo['provider'], Partial<PaymentProviderInfo>>> = {}): PaymentProviderInfo[] =>
  PROVIDERS.map((provider) => ({ provider, enabled: true, mode: 'mock' as const, reason: null, ...over[provider] }));

const form = (over: Partial<PayFormValues> = {}): PayFormValues => ({ provider: 'QPAY', mode: 'NOW', rowId: null, amount: null, note: '', ...over });

// ── fixture нь DTO-той таарч байгаа эсэх ──────────────────────────────────────────────
describe('fixtures', () => {
  it('RepaymentStatusView DTO-д таарна', () => {
    expect(RepaymentStatusView.safeParse(status()).success).toBe(true);
  });
});

// ── мөнгө, огноо ────────────────────────────────────────────────────────────────────
describe('formatAmount', () => {
  it('таслалаар бүлэглэж, төгрөгийг ₮ гэж харуулна', () => {
    expect(formatAmount(1_250_000)).toBe('1,250,000 ₮');
    expect(formatAmount(0)).toBe('0 ₮');
    expect(formatAmount(999)).toBe('999 ₮');
  });
  it('бутархайг 2 орноор, .00-г нууна', () => {
    expect(formatAmount(1250.5)).toBe('1,250.50 ₮');
    expect(formatAmount(1250.05)).toBe('1,250.05 ₮');
    expect(formatAmount(1250.0)).toBe('1,250 ₮');
  });
  it('өөр валютыг кодоор нь харуулна', () => {
    expect(formatAmount(1250.5, 'USD')).toBe('1,250.50 USD');
  });
  it('сөрөг дүн; бараг 0 бол "-0" гаргахгүй', () => {
    expect(formatAmount(-1500)).toBe('-1,500 ₮');
    expect(formatAmount(-0.001)).toBe('0 ₮');
  });
});

describe('groupDigits / parseDigits', () => {
  it('InputNumber formatter/parser', () => {
    expect(groupDigits(1250000.5)).toBe('1,250,000.5');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits(undefined)).toBe('');
    expect(groupDigits(null)).toBe('');
    expect(parseDigits('1,250,000.5')).toBe('1250000.5');
    expect(parseDigits('₮ 1,000')).toBe('1000');
    expect(parseDigits(undefined)).toBe('');
  });
});

describe('formatDateTime / similarityPercent', () => {
  it('ISO instant-ийг Улаанбаатарын цагаар (UTC+8) харуулна', () => {
    expect(formatDateTime('2026-10-28T09:10:00.000Z')).toBe('2026-10-28 17:10');
    expect(formatDateTime('2026-10-28T20:30:00.000Z')).toBe('2026-10-29 04:30');
  });
  it('буруу огноог хэвээр буцаана', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
  it('ижил төстэй байдлыг хувиар', () => {
    expect(similarityPercent(0.8571)).toBe('86%');
    expect(similarityPercent(1)).toBe('100%');
    expect(similarityPercent(0)).toBe('0%');
    expect(similarityPercent(1.5)).toBe('100%');
    expect(similarityPercent(-1)).toBe('0%');
  });
});

// ── ЭТХ ────────────────────────────────────────────────────────────────────────────
describe('installment status', () => {
  it('төлөв бүр өнгө ба монгол нэртэй', () => {
    for (const s of InstallmentStatus) {
      expect(INSTALLMENT_COLOR[s], s).toBeTruthy();
      expect(dict[installmentStatusKey(s)], s).toBeTruthy();
    }
  });
});

describe('payableRows', () => {
  it('зөвхөн үлдэгдэлтэй мөр, хугацааны дарааллаар (оролтыг өөрчлөхгүй)', () => {
    const s = status();
    const reversed = [...s.installments].reverse();
    expect(payableRows(reversed).map((r) => r.id)).toEqual(['row2', 'row3']);
    expect(reversed.map((r) => r.id)).toEqual(['row3', 'row2', 'row1']);
  });
  it('огноо ижил бол seq-ээр', () => {
    const rows = [row(2, { dueDate: '2026-10-05' }), row(1, { dueDate: '2026-10-05' })];
    expect(payableRows(rows).map((r) => r.seq)).toEqual([1, 2]);
  });
});

describe('paidPercent', () => {
  it('хувийг бүхэлд бөөрөнхийлж 0..100 хооронд барина', () => {
    expect(paidPercent({ scheduled: 300_000, paid: 130_000 })).toBe(43);
    expect(paidPercent({ scheduled: 100, paid: 100 })).toBe(100);
    expect(paidPercent({ scheduled: 100, paid: 250 })).toBe(100);
    expect(paidPercent({ scheduled: 0, paid: 0 })).toBe(0);
  });
});

describe('applicationStatusLabel / payGate', () => {
  it('мэдэгдэх төлвийг монголоор, үл мэдэгдэхийг анхных нь хэвээр', () => {
    expect(applicationStatusLabel('CLOSED', tr)).toBe('Хаасан');
    expect(applicationStatusLabel('SOMETHING_NEW', tr)).toBe('SOMETHING_NEW');
  });
  it('payable бол хориглохгүй', () => {
    expect(payGate(status(), tr)).toBeNull();
  });
  it('ACTIVE/MIGRATED биш төлөвт төлвийн нэрээр шалтгаан', () => {
    const g = payGate(status({ payable: false, applicationStatus: 'CLOSED' }), tr);
    expect(g?.key).toBe('payment.gate.status');
    expect(g?.params).toEqual({ status: 'Хаасан' });
  });
  it('ЭТХ байхгүй', () => {
    expect(payGate(status({ payable: false, scheduleGeneratedAt: null, installments: [] }), tr)?.key).toBe('payment.gate.noSchedule');
    expect(payGate(status({ payable: false, installments: [] }), tr)?.key).toBe('payment.gate.noSchedule');
  });
  it('үлдэгдэл 0 бол бүрэн төлөгдсөн', () => {
    expect(payGate(status({ payable: false, applicationStatus: 'MIGRATED' }), tr)?.key).toBe('payment.gate.fullyPaid');
  });
});

// ── төлбөрийн хэлбэр ───────────────────────────────────────────────────────────────
describe('providerOptions', () => {
  it('3 хэлбэрийг тогтмол дарааллаар буцаана', () => {
    expect(providerOptions(infos(), 'MNT').map((o) => o.provider)).toEqual(['QPAY', 'SOCIALPAY', 'BANK_TRANSFER']);
    expect(providerOptions(infos().reverse(), 'MNT').map((o) => o.provider)).toEqual([...PaymentProvider]);
  });
  it('идэвхгүйг backend-ийн шалтгаантай нь буцаана', () => {
    const o = providerOptions(
      infos({ QPAY: { enabled: false, mode: 'real', reason: 'NOT_CONFIGURED' }, SOCIALPAY: { enabled: false, mode: 'real', reason: 'NOT_IMPLEMENTED' }, BANK_TRANSFER: { enabled: false, reason: 'ACCOUNT_MISSING' } }),
      'MNT',
    );
    expect(o.map((x) => [x.enabled, x.reason])).toEqual([[false, 'NOT_CONFIGURED'], [false, 'NOT_IMPLEMENTED'], [false, 'ACCOUNT_MISSING']]);
    expect(o[0].mode).toBe('real');
  });
  it('enabled=false боловч reason null бол NOT_CONFIGURED', () => {
    expect(providerOptions(infos({ QPAY: { enabled: false, reason: null } }), 'MNT')[0].reason).toBe('NOT_CONFIGURED');
  });
  it('мэдээлэл ирээгүй (ачаалаагүй/дутуу) үед бүгд идэвхгүй', () => {
    expect(providerOptions(undefined, 'MNT').every((o) => !o.enabled && o.reason === 'NOT_CONFIGURED')).toBe(true);
    expect(providerOptions(infos().slice(0, 1), 'MNT').map((o) => o.enabled)).toEqual([true, false, false]);
  });
  it('MNT биш зээлд QPay/SocialPay идэвхгүй (CURRENCY), банкны шилжүүлэг хэвээр', () => {
    const o = providerOptions(infos(), 'USD');
    expect(o.map((x) => [x.provider, x.enabled, x.reason])).toEqual([['QPAY', false, 'CURRENCY'], ['SOCIALPAY', false, 'CURRENCY'], ['BANK_TRANSFER', true, null]]);
  });
  it('шалтгаан бүр, хэлбэр бүр монгол мессежтэй', () => {
    for (const r of ['NOT_CONFIGURED', 'NOT_IMPLEMENTED', 'ACCOUNT_MISSING', 'CURRENCY'] as const) expect(dict[reasonKey(r)], r).toBeTruthy();
    for (const p of PROVIDERS) {
      expect(dict[providerKey(p)], p).toBeTruthy();
      expect(dict[providerHintKey(p)], p).toBeTruthy();
    }
  });
});

describe('firstEnabledProvider / resolveProvider', () => {
  it('эхний идэвхтэйг сонгоно', () => {
    const o = providerOptions(infos({ QPAY: { enabled: false, reason: 'NOT_CONFIGURED' } }), 'MNT');
    expect(firstEnabledProvider(o)).toBe('SOCIALPAY');
    expect(firstEnabledProvider(providerOptions(undefined, 'MNT'))).toBeNull();
  });
  it('сонгосон нь идэвхтэй бол хэвээр, үгүй бол эхний идэвхтэй', () => {
    const o = providerOptions(infos({ QPAY: { enabled: false, reason: 'NOT_CONFIGURED' } }), 'MNT');
    expect(resolveProvider('BANK_TRANSFER', o)).toBe('BANK_TRANSFER');
    expect(resolveProvider('QPAY', o)).toBe('SOCIALPAY');
    expect(resolveProvider(null, o)).toBe('SOCIALPAY');
    expect(resolveProvider('QPAY', providerOptions(undefined, 'MNT'))).toBeNull();
  });
});

describe('canSimulate', () => {
  it('зөвхөн mock горим ба production биш', () => {
    expect(canSimulate({ mode: 'mock' }, 'development')).toBe(true);
    expect(canSimulate({ mode: 'mock' }, undefined)).toBe(true);
    expect(canSimulate({ mode: 'mock' }, 'production')).toBe(false);
    expect(canSimulate({ mode: 'real' }, 'development')).toBe(false);
    expect(canSimulate(undefined, 'development')).toBe(false);
  });
});

// ── төлөх дүн ──────────────────────────────────────────────────────────────────────
describe('defaultRowId / initialPayForm', () => {
  it('хүссэн мөр төлөх боломжтой бол түүнийг', () => {
    expect(defaultRowId(status(), 'row3')).toBe('row3');
  });
  it('хүссэн мөр төлөгдсөн бол дараагийн төлөлт, түүнгүй бол эхний төлөх мөр', () => {
    expect(defaultRowId(status(), 'row1')).toBe('row2');
    expect(defaultRowId(status({ nextDue: null }), null)).toBe('row2');
    expect(defaultRowId(status({ nextDue: { scheduleRowId: 'gone', dueDate: '2026-12-05', outstanding: 1 } }))).toBe('row2');
  });
  it('төлөх мөр огт байхгүй бол null', () => {
    const paid = status({ installments: [row(1, { outstanding: 0, status: 'PAID' })], nextDue: null });
    expect(defaultRowId(paid, 'row1')).toBeNull();
  });
  it('мөр заасан бол ROW горим, үгүй бол NOW; хэлбэр сонгоогүй (null)', () => {
    expect(initialPayForm(status(), 'row3')).toEqual({ provider: null, mode: 'ROW', rowId: 'row3', amount: null, note: '' });
    expect(initialPayForm(status(), null)).toMatchObject({ mode: 'NOW', rowId: 'row2' });
    expect(initialPayForm(status(), 'row1')).toMatchObject({ mode: 'NOW', rowId: 'row2' });
  });
});

describe('modeOptions / maxPayable / previewAmount', () => {
  it('горим бүрийн боломж', () => {
    expect(modeOptions(status())).toEqual([{ mode: 'NOW', enabled: true }, { mode: 'ROW', enabled: true }, { mode: 'CUSTOM', enabled: true }]);
    const done = status({ installments: [row(1, { outstanding: 0, status: 'PAID' })], payNowAmount: 0, totals: { scheduled: 100_000, paid: 100_000, outstanding: 0, overdue: 0 } });
    expect(modeOptions(done).every((m) => !m.enabled)).toBe(true);
  });
  it('дээд хэмжээ: ROW — мөрийн үлдэгдэл, бусад — нийт үлдэгдэл', () => {
    expect(maxPayable(status(), 'ROW', 'row2')).toBe(70_000);
    expect(maxPayable(status(), 'ROW', 'missing')).toBe(0);
    expect(maxPayable(status(), 'CUSTOM', null)).toBe(170_000);
    expect(maxPayable(status(), 'NOW', null)).toBe(170_000);
  });
  it('төлөх дүнгийн урьдчилсан харагдац', () => {
    expect(previewAmount(status(), { mode: 'NOW', rowId: null, amount: null })).toBe(70_000);
    expect(previewAmount(status(), { mode: 'ROW', rowId: 'row3', amount: null })).toBe(100_000);
    expect(previewAmount(status(), { mode: 'ROW', rowId: 'row1', amount: null })).toBeNull();
    expect(previewAmount(status(), { mode: 'ROW', rowId: null, amount: null })).toBeNull();
    expect(previewAmount(status(), { mode: 'CUSTOM', rowId: null, amount: 12_345.678 })).toBe(12_345.68);
    expect(previewAmount(status(), { mode: 'CUSTOM', rowId: null, amount: null })).toBeNull();
    expect(previewAmount(status(), { mode: 'CUSTOM', rowId: null, amount: 0 })).toBeNull();
    expect(previewAmount(status({ payNowAmount: 0 }), { mode: 'NOW', rowId: null, amount: null })).toBeNull();
  });
  it('горим бүр монгол нэртэй', () => {
    for (const m of AMOUNT_MODES) expect(dict[amountModeKey(m)], m).toBeTruthy();
  });
});

describe('validateCustomAmount', () => {
  const max = 170_000;
  it('зөв дүн', () => {
    expect(validateCustomAmount(50_000, max, 'MNT')).toBeNull();
    expect(validateCustomAmount(max, max, 'MNT')).toBeNull();
    expect(validateCustomAmount(1234.56, max, 'MNT')).toBeNull();
    expect(validateCustomAmount(0.1 + 0.2, max, 'MNT')).toBeNull(); // 0.30000000000000004 — хөвөгч таслалын алдаа
  });
  it('хоосон / тоо биш', () => {
    expect(validateCustomAmount(null, max, 'MNT')?.key).toBe('payment.validation.amountRequired');
    expect(validateCustomAmount(undefined, max, 'MNT')?.key).toBe('payment.validation.amountRequired');
    expect(validateCustomAmount(Number.NaN, max, 'MNT')?.key).toBe('payment.validation.amountRequired');
    expect(validateCustomAmount(Number.POSITIVE_INFINITY, max, 'MNT')?.key).toBe('payment.validation.amountRequired');
  });
  it('0 ба сөрөг', () => {
    expect(validateCustomAmount(0, max, 'MNT')?.key).toBe('payment.validation.amountPositive');
    expect(validateCustomAmount(-5, max, 'MNT')?.key).toBe('payment.validation.amountPositive');
  });
  it('2-оос олон орон (сервер 400 VALIDATION_FAILED өгдөг)', () => {
    expect(validateCustomAmount(10.005, max, 'MNT')?.key).toBe('payment.validation.amountDecimals');
  });
  it('нийт үлдэгдлээс их — хязгаарыг мессежид', () => {
    const r = validateCustomAmount(170_000.01, max, 'MNT');
    expect(r?.key).toBe('payment.validation.amountMax');
    expect(tr(r?.key ?? '', r?.params)).toBe('Дүн 170,000 ₮-аас хэтрэхгүй байх ёстой');
  });
});

describe('validatePayForm', () => {
  const s = status();
  const opts = providerOptions(infos(), 'MNT');
  it('бүрэн форм', () => {
    expect(validatePayForm(s, opts, form())).toBeNull();
    expect(validatePayForm(s, opts, form({ mode: 'ROW', rowId: 'row3' }))).toBeNull();
    expect(validatePayForm(s, opts, form({ mode: 'CUSTOM', amount: 5_000 }))).toBeNull();
  });
  it('хэлбэр сонгоогүй / идэвхгүй', () => {
    expect(validatePayForm(s, opts, form({ provider: null }))?.key).toBe('payment.validation.providerRequired');
    const off = providerOptions(infos({ QPAY: { enabled: false, reason: 'NOT_CONFIGURED' } }), 'MNT');
    expect(validatePayForm(s, off, form({ provider: 'QPAY' }))?.key).toBe('payment.validation.providerRequired');
  });
  it('ROW: мөр сонгоогүй эсвэл төлөгдсөн мөр', () => {
    expect(validatePayForm(s, opts, form({ mode: 'ROW', rowId: null }))?.key).toBe('payment.validation.rowRequired');
    expect(validatePayForm(s, opts, form({ mode: 'ROW', rowId: 'row1' }))?.key).toBe('payment.validation.rowRequired');
  });
  it('CUSTOM: дүнгийн шалгалт', () => {
    expect(validatePayForm(s, opts, form({ mode: 'CUSTOM', amount: null }))?.key).toBe('payment.validation.amountRequired');
    expect(validatePayForm(s, opts, form({ mode: 'CUSTOM', amount: 999_999 }))?.key).toBe('payment.validation.amountMax');
  });
  it('үлдэгдэл 0 бол горим боломжгүй', () => {
    const done = status({ installments: [row(1, { outstanding: 0, status: 'PAID' })], payNowAmount: 0, totals: { scheduled: 100_000, paid: 100_000, outstanding: 0, overdue: 0 } });
    expect(validatePayForm(done, opts, form())?.key).toBe('payment.validation.modeUnavailable');
  });
});

describe('buildInvoiceRequest', () => {
  const ok = (req: ReturnType<typeof buildInvoiceRequest>) => CreatePaymentInvoiceRequest.safeParse(req).success;
  it('NOW: зөвхөн хүсэлт ба хэлбэр (сервер payNowAmount-аар)', () => {
    const req = buildInvoiceRequest('app1', form({ amount: 123, rowId: 'row2' }));
    expect(req).toEqual({ applicationId: 'app1', provider: 'QPAY' });
    expect(ok(req)).toBe(true);
  });
  it('ROW: scheduleRowId, дүн явуулахгүй', () => {
    const req = buildInvoiceRequest('app1', form({ provider: 'BANK_TRANSFER', mode: 'ROW', rowId: 'row3', amount: 1 }));
    expect(req).toEqual({ applicationId: 'app1', provider: 'BANK_TRANSFER', scheduleRowId: 'row3' });
    expect(ok(req)).toBe(true);
  });
  it('CUSTOM: amount (2 оронд), мөр явуулахгүй', () => {
    const req = buildInvoiceRequest('app1', form({ provider: 'SOCIALPAY', mode: 'CUSTOM', rowId: 'row3', amount: 12_345.678 }));
    expect(req).toEqual({ applicationId: 'app1', provider: 'SOCIALPAY', amount: 12_345.68 });
    expect(ok(req)).toBe(true);
  });
  it('тайлбар: trim, 200 тэмдэгтээр таслах, хоосон бол оруулахгүй', () => {
    expect(buildInvoiceRequest('app1', form({ note: '  11-р сар  ' }))?.note).toBe('11-р сар');
    expect(buildInvoiceRequest('app1', form({ note: '   ' }))).not.toHaveProperty('note');
    const long = buildInvoiceRequest('app1', form({ note: 'а'.repeat(250) }));
    expect(long?.note).toHaveLength(200);
    expect(ok(long)).toBe(true);
  });
  it('дутуу талбартай бол null', () => {
    expect(buildInvoiceRequest('app1', form({ provider: null }))).toBeNull();
    expect(buildInvoiceRequest('app1', form({ mode: 'ROW', rowId: null }))).toBeNull();
    expect(buildInvoiceRequest('app1', form({ mode: 'CUSTOM', amount: null }))).toBeNull();
    expect(buildInvoiceRequest('app1', form({ mode: 'CUSTOM', amount: 0 }))).toBeNull();
    expect(buildInvoiceRequest('app1', form({ mode: 'CUSTOM', amount: Number.NaN }))).toBeNull();
  });
});

// ── invoice ────────────────────────────────────────────────────────────────────────
describe('pollInterval', () => {
  it('PENDING үед 3 секунд, эцсийн төлөвт зогсоно', () => {
    expect(pollInterval('PENDING')).toBe(3000);
    expect(pollInterval('PAID')).toBe(false);
    expect(pollInterval('EXPIRED')).toBe(false);
    expect(pollInterval('CANCELLED')).toBe(false);
    expect(pollInterval(undefined)).toBe(false);
  });
});

describe('remainingSeconds / formatCountdown', () => {
  const now = Date.parse('2026-10-28T09:00:00.000Z');
  it('үлдсэн секунд (дээш бөөрөнхийлнө), хугацаа дууссан бол 0', () => {
    expect(remainingSeconds('2026-10-28T09:05:00.000Z', now)).toBe(300);
    expect(remainingSeconds('2026-10-28T09:00:00.400Z', now)).toBe(1);
    expect(remainingSeconds('2026-10-28T08:59:00.000Z', now)).toBe(0);
    expect(remainingSeconds('garbage', now)).toBe(0);
  });
  it('mm:ss ба h:mm:ss', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(65)).toBe('01:05');
    expect(formatCountdown(3599)).toBe('59:59');
    expect(formatCountdown(3600)).toBe('1:00:00');
    expect(formatCountdown(3725)).toBe('1:02:05');
    expect(formatCountdown(-4)).toBe('00:00');
  });
});

describe('qrImageSrc / isSafeDeeplink', () => {
  it('base64 PNG-ийг data URL болгоно, аль хэдийн data URL бол хэвээр', () => {
    expect(qrImageSrc('iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(qrImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(qrImageSrc(null)).toBeNull();
    expect(qrImageSrc('')).toBeNull();
  });
  it('банкны апп-ын scheme ба https зөвшөөрч, скрипт scheme хаана', () => {
    expect(isSafeDeeplink('khanbank://q?qPay_QRcode=abc')).toBe(true);
    expect(isSafeDeeplink('https://example.mn/pay')).toBe(true);
    expect(isSafeDeeplink('javascript:alert(1)')).toBe(false);
    expect(isSafeDeeplink('  JavaScript:alert(1)')).toBe(false);
    expect(isSafeDeeplink('data:text/html;base64,AAAA')).toBe(false);
    expect(isSafeDeeplink('vbscript:x')).toBe(false);
    expect(isSafeDeeplink('/relative/path')).toBe(false);
    expect(isSafeDeeplink('')).toBe(false);
  });
});

// ── түүх ───────────────────────────────────────────────────────────────────────────
describe('allocatedAmount / sortAllocations', () => {
  it('хуваарилсан = төлбөр − хуваарилаагүй (хөвөгч таслалгүй)', () => {
    expect(allocatedAmount({ amount: 100_000, unallocatedAmount: 0 })).toBe(100_000);
    expect(allocatedAmount({ amount: 100_000, unallocatedAmount: 30_000.1 })).toBe(69_999.9);
    expect(allocatedAmount({ amount: 0.3, unallocatedAmount: 0.1 })).toBe(0.2);
    expect(allocatedAmount({ amount: 5_000, unallocatedAmount: 5_000 })).toBe(0);
  });
  it('мөрийн дугаараар эрэмбэлж, оролтыг өөрчлөхгүй', () => {
    const a = (seq: number): PaymentAllocationView => ({ scheduleRowId: `r${seq}`, seq, dueDate: '2026-10-05', interestPaid: 1, principalPaid: 1, totalPaid: 2 });
    const input = [a(3), a(1), a(2)];
    expect(sortAllocations(input).map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(input.map((x) => x.seq)).toEqual([3, 1, 2]);
  });
});

// ── алдаа ──────────────────────────────────────────────────────────────────────────
describe('describeError', () => {
  const api = (status: number, code: string | null, message = 'серверийн мессеж', issues?: Array<{ path: string; message: string }>) => ({ status, code, message, issues });

  it('мэдэгдэх код бүрийг монгол мессежээр (серверийн текстээс үл хамааран)', () => {
    for (const code of Object.keys(ERROR_KEYS)) {
      if (code === 'AMOUNT_OUT_OF_RANGE') continue;
      const d = describeError(api(409, code, 'ENGLISH'), tr);
      expect(d.code).toBe(code);
      expect(d.message, code).toBe(dict[ERROR_KEYS[code as keyof typeof ERROR_KEYS]]);
      expect(d.message, code).not.toContain('!payment');
    }
  });
  it('AMOUNT_OUT_OF_RANGE: серверийн мессеж (зөвшөөрөгдөх муж дотор) түрүүлнэ, хоосон бол манай текст', () => {
    expect(describeError(api(422, 'AMOUNT_OUT_OF_RANGE', 'Төлөх дүн 1,000-аас 170,000 хооронд байх ёстой (оруулсан: 5)'), tr).message).toContain('1,000-аас 170,000');
    expect(describeError(api(422, 'AMOUNT_OUT_OF_RANGE', ''), tr).message).toBe(dict['payment.error.AMOUNT_OUT_OF_RANGE']);
  });
  it('VALIDATION_FAILED: талбар бүрийн тайлбар', () => {
    const d = describeError(api(400, 'VALIDATION_FAILED', 'Оролтын өгөгдөл буруу', [{ path: 'amount', message: 'Дүн 2 оронтой байх ёстой' }, { path: '', message: 'Буруу' }, { path: 'x', message: '' }]), tr);
    expect(d.issues).toEqual(['amount: Дүн 2 оронтой байх ёстой', 'Буруу']);
    expect(d.message).toBe(dict['payment.error.VALIDATION_FAILED']);
  });
  it('код үл мэдэгдэх үед HTTP статусаар', () => {
    expect(describeError(api(401, null), tr).message).toBe(dict['payment.error.UNAUTHENTICATED']);
    expect(describeError(api(403, 'SOMETHING'), tr).message).toBe(dict['payment.error.FORBIDDEN']);
    expect(describeError(api(404, null), tr).message).toBe(dict['payment.error.NOT_FOUND']);
    expect(describeError(api(500, null), tr).message).toBe(dict['payment.error.SERVER']);
    expect(describeError(api(503, 'UNKNOWN_X'), tr).message).toBe(dict['payment.error.SERVER']);
  });
  it('код үл мэдэгдэх 4xx бол серверийн мессеж', () => {
    expect(describeError(api(418, 'TEAPOT', 'Цай'), tr).message).toBe('Цай');
  });
  it('сүлжээний алдаа (fetch TypeError) ба тодорхойгүй', () => {
    expect(describeError(new TypeError('Failed to fetch'), tr).message).toBe(dict['payment.error.NETWORK']);
    expect(describeError(null, tr).message).toBe(dict['payment.error.UNKNOWN']);
    expect(describeError('boom', tr).message).toBe(dict['payment.error.UNKNOWN']);
    expect(describeError({}, tr).message).toBe(dict['payment.error.UNKNOWN']);
  });
  it('prototype-ийн түлхүүрийг код гэж андуурахгүй', () => {
    expect(describeError(api(400, 'toString', 'Серверийн мессеж'), tr).message).toBe('Серверийн мессеж');
  });
});

describe('error helpers', () => {
  it('isAlreadyPaidError', () => {
    expect(isAlreadyPaidError({ status: 409, code: 'INVOICE_ALREADY_PAID' })).toBe(true);
    expect(isAlreadyPaidError({ status: 409, code: 'INVOICE_NOT_PENDING' })).toBe(false);
    expect(isAlreadyPaidError(null)).toBe(false);
  });
  it('isStaleStateError: 404/409', () => {
    expect(isStaleStateError({ status: 404 })).toBe(true);
    expect(isStaleStateError({ status: 409 })).toBe(true);
    expect(isStaleStateError({ status: 422 })).toBe(false);
    expect(isStaleStateError(new TypeError('x'))).toBe(false);
    expect(isStaleStateError(null)).toBe(false);
  });
});

// ── нэр шалгалт, тулгалт ────────────────────────────────────────────────────────────
describe('buildNameCheckRequest', () => {
  it('bankCode том үсэг, accountNo-оос зай хасна, нэрийг trim', () => {
    expect(buildNameCheckRequest({ bankCode: ' khan ', accountNo: '5000 0000 01', holderName: '  Бат-Эрдэнэ ' })).toEqual({ bankCode: 'KHAN', accountNo: '5000000001', holderName: 'Бат-Эрдэнэ' });
  });
  it('DTO-ийн доод хязгаар (accountNo ≥ 4)', () => {
    expect(buildNameCheckRequest({ bankCode: 'KHAN', accountNo: '123', holderName: 'Бат' })).toBeNull();
    expect(buildNameCheckRequest({ bankCode: 'KHAN', accountNo: '1 2 3', holderName: 'Бат' })).toBeNull();
    expect(buildNameCheckRequest({ bankCode: '', accountNo: '12345', holderName: 'Бат' })).toBeNull();
    expect(buildNameCheckRequest({ bankCode: 'KHAN', accountNo: '12345', holderName: '  ' })).toBeNull();
    expect(buildNameCheckRequest({})).toBeNull();
  });
});

describe('describeReconcile', () => {
  it('үр дүнг нэг мөрөөр', () => {
    expect(describeReconcile({ fetched: 5, matched: 3, duplicates: 1, unmatched: 1, errors: 0 }, tr)).toBe('Татсан: 5 · Таарсан: 3 · Давхардсан: 1 · Таараагүй: 1');
  });

  it('алдаатай гүйлгээ байвал тоог нэмж харуулна', () => {
    expect(describeReconcile({ fetched: 5, matched: 3, duplicates: 0, unmatched: 0, errors: 2 }, tr)).toBe('Татсан: 5 · Таарсан: 3 · Давхардсан: 0 · Таараагүй: 0 · Алдаатай: 2');
  });
});

// ── i18n ───────────────────────────────────────────────────────────────────────────
describe('i18n', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const sources = readdirSync(dir)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(`${dir}${f}`, 'utf8'));
  const payment = mnPayment as Record<string, string>;

  it('кодонд хэрэглэсэн `payment.…` түлхүүр бүр JSON-д бий, JSON-ы түлхүүр бүр хаа нэгтээ хэрэглэгдсэн', () => {
    const literal = new Set<string>();
    const prefixes = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/['"`](payment\.[A-Za-z0-9_.]+)['"`]/g)) literal.add(m[1]);
      for (const m of src.matchAll(/`(payment\.[A-Za-z0-9_.]*)\$\{/g)) prefixes.add(m[1]);
    }
    expect([...literal].filter((k) => !(k in payment)), 'JSON-д байхгүй түлхүүр').toEqual([]);
    const unused = Object.keys(payment).filter((k) => !literal.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
    expect(unused, 'хэрэглэгдээгүй түлхүүр').toEqual([]);
  });

  it('JSON-ы бүх түлхүүр `payment.` угтвартай, утга нь хоосон биш', () => {
    for (const [k, v] of Object.entries(payment)) {
      expect(k.startsWith('payment.'), k).toBe(true);
      expect(v.trim().length, k).toBeGreaterThan(0);
    }
  });

  it('{param} бүхий мессежүүд хаалтаа зөв хаасан', () => {
    for (const [k, v] of Object.entries(payment)) expect((v.match(/\{/g) ?? []).length, k).toBe((v.match(/\}/g) ?? []).length);
  });

  it('ERROR_KEYS-ийн түлхүүр бүр JSON-д бий', () => {
    for (const [code, key] of Object.entries(ERROR_KEYS)) expect(payment[key], code).toBeTruthy();
  });

  it('component дотор hard-code монгол мөр байхгүй (JSX текст, title/placeholder/message пропс)', () => {
    const cyr = /[Ѐ-ӿ]/;
    const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(`${dir}${f}`, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').replace(/^\s*\*.*$/, '');
        if (cyr.test(code)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ── backend-тэй уялдаа (унших зөвхөн) ───────────────────────────────────────────────
describe('backend гэрээ', () => {
  const backendDir = fileURLToPath(new URL('../../../../origination/src/modules/payment/', import.meta.url));
  it.skipIf(!existsSync(backendDir))('backend-ийн payment модулийн алдааны код бүрийг UI таньдаг', () => {
    const codes = new Set<string>();
    for (const f of readdirSync(backendDir).filter((n) => n.endsWith('.ts') && !n.includes('.test.') && !n.includes('test-helpers'))) {
      for (const m of readFileSync(`${backendDir}${f}`, 'utf8').matchAll(/code: '([A-Z_]+)'/g)) codes.add(m[1]);
    }
    expect(codes.size).toBeGreaterThan(5);
    expect([...codes].filter((c) => !(c in ERROR_KEYS)), 'UI танихгүй backend код').toEqual([]);
  });
});
