import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { UnderwriteResult } from '@los/contracts';
import type { CalcMethod, MethodVerdict, ScoreRequest } from '@los/contracts';
import { annuityPayment } from './schedule';
import { maxPrincipalForPayment, underwrite } from './underwriting';

// Deterministic pseudo-random (seeded LCG, шинэ dependency-гүй) property тест.
// Oracle нь BigInt цент (бүхэл тоо) дээр хөндлөн үржвэрээр харьцуулдаг — underwrite-ийн Decimal логиктой хамааралгүй.

const SAMPLES = 3000;
const SEED = 20261029;

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

const IDS: readonly CalcMethod[] = ['A_SALARY', 'B_BUSINESS', 'C_COMBINED'];

/** Бүх мөнгө БҮХЭЛ ЦЕНТ (number, < 2^53); хувь/босго бүхэл «хувь» эсвэл «зуутын нэг» */
interface Sample {
  amt: number; // ₮ × 100 (бүхэл ₮)
  term: number;
  rate: number;
  sal: number;
  ncf: number;
  hh: number;
  ex: number;
  val: number;
  required: boolean;
  dtiPct: number; // maxDti = dtiPct / 100
  dscrH: number; // minDscr = dscrH / 100
  ltvPct: number;
  thrPct: number;
  stress: { rateDelta: number; incomePct: number } | null; // incomeChange = −incomePct / 100
}

const cents = (c: number): number => c / 100;

/** origination-ийн адил: шинэ төлбөр = annuity (2 оронтой цент). Дүнтэй хамт өөрчлөгдөнө (монотон шинж чанарт хэрэгтэй) */
const paymentCents = (s: Pick<Sample, 'amt' | 'rate' | 'term'>): number => new Decimal(annuityPayment(cents(s.amt), s.rate, s.term)).toDecimalPlaces(2).mul(100).toNumber();

const toReq = (s: Sample): ScoreRequest => ({
  applicationId: 'PROP',
  amount: cents(s.amt),
  termMonths: s.term,
  interestRate: s.rate,
  monthlyPayment: cents(paymentCents(s)),
  salaryMonthly: cents(s.sal),
  businessNcfMonthly: cents(s.ncf),
  householdExpenseMonthly: cents(s.hh),
  existingDebtServiceMonthly: cents(s.ex),
  collateralValueTotal: cents(s.val),
  collateralRequired: s.required,
  policy: { maxDti: s.dtiPct / 100, minDscr: s.dscrH / 100, maxLtv: s.ltvPct / 100, weightThreshold: s.thrPct / 100 },
  ...(s.stress ? { stress: { rateDeltaPoints: s.stress.rateDelta, incomeChange: -s.stress.incomePct / 100 } } : {}),
});

function generate(rand: () => number): Sample {
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const chance = (p: number): boolean => rand() < p;
  const amtWhole = chance(0.1) ? int(1, 5_000) : int(100_000, 200_000_000);
  const base = { amt: amtWhole * 100, term: chance(0.05) ? int(100, 600) : int(1, 120), rate: chance(0.05) ? 0 : int(100, 6000) / 100 };
  const pay = paymentCents(base) / 100 || 1_000; // ₮
  const money = (mult: number): number => Math.round(pay * mult * 100);
  const sal = chance(0.15) ? 0 : money(0.3 + rand() * 8);
  const ncf = chance(0.08) ? 0 : chance(0.12) ? -money(rand() * 2) : money(0.3 + rand() * 6);
  return {
    ...base,
    sal,
    ncf,
    hh: chance(0.2) ? 0 : money(rand() * 2),
    ex: chance(0.3) ? 0 : money(rand() * 1.5),
    val: chance(0.1) ? 0 : Math.round(amtWhole * (0.5 + rand() * 2)) * 100,
    required: chance(0.8),
    dtiPct: int(5, 100),
    dscrH: int(50, 300),
    ltvPct: int(10, 100),
    thrPct: int(0, 100),
    stress: chance(0.5) ? { rateDelta: int(0, 2000) / 100, incomePct: int(0, 100) } : null,
  };
}

// ───────────────────────────── Oracle (BigInt) ─────────────────────────────

interface Scn { sal: bigint; ncf: bigint; hh: bigint; ex: bigint; pay: bigint }

/** `dtiPct`/`dscrH` нь limit-ийн зуутын нэг: ӨОХ ≤ dtiPct/100, ӨТЧХ ≥ dscrH/100. Бүх утга ЯГ НЭГ масштабтай */
function oracleMethod(id: CalcMethod, v: Scn, dtiPct: bigint, dscrH: bigint): { applicable: boolean; pass: boolean } {
  const total = v.ex + v.pay;
  const base = id === 'A_SALARY' ? v.sal : id === 'B_BUSINESS' ? v.ncf : v.sal + v.ncf - v.hh;
  const applicable = id === 'A_SALARY' ? v.sal > 0n : id === 'B_BUSINESS' ? v.ncf > 0n : v.sal > 0n || v.ncf > 0n;
  if (!applicable) return { applicable, pass: false };
  if (id === 'A_SALARY') return { applicable, pass: total * 100n <= dtiPct * v.sal };
  return { applicable, pass: total === 0n ? base > 0n : base * 100n >= dscrH * total };
}

const baseScn = (s: Sample): Scn => ({ sal: BigInt(s.sal), ncf: BigInt(s.ncf), hh: BigInt(s.hh), ex: BigInt(s.ex), pay: BigInt(paymentCents(s)) });

const stressPaymentCents = (s: Sample): number =>
  new Decimal(annuityPayment(cents(s.amt), new Decimal(s.rate).plus(s.stress!.rateDelta).toNumber(), s.term)).toDecimalPlaces(2).mul(100).toNumber();

/** stress сценари — бүх утга ×100 масштабтай (орлогын коэффициент 100 − incomePct бүхэл) */
const stressScn = (s: Sample): Scn => {
  const k = BigInt(100 - s.stress!.incomePct);
  const b = baseScn(s);
  return { sal: b.sal * k, ncf: b.ncf > 0n ? b.ncf * k : b.ncf * 100n, hh: b.hh * 100n, ex: b.ex * 100n, pay: BigInt(stressPaymentCents(s)) * 100n };
};

// ───────────────────────────── Шалгалт ─────────────────────────────

const allFinite = (x: unknown): boolean =>
  typeof x === 'number' ? Number.isFinite(x) : Array.isArray(x) ? x.every(allFinite) : x !== null && typeof x === 'object' ? Object.values(x).every(allFinite) : true;

/** Oracle-ийн өндөр нарийвчлалтай Decimal (underwrite-ийн clone-оос тусдаа) */
const OD = Decimal.clone({ precision: 60 });
const limitOf = (m: MethodVerdict, s: Sample): Decimal =>
  m.method === 'A_SALARY' ? new OD(m.baseIncome).mul(s.dtiPct).div(100) : new OD(m.baseIncome).mul(100).div(s.dscrH);

describe(`underwrite property test (${SAMPLES} санамсаргүй хүсэлт, seed ${SEED})`, () => {
  const rand = lcg(SEED);
  const samples = Array.from({ length: SAMPLES }, () => generate(rand));
  const failures: string[] = [];
  const check = (ok: boolean, msg: string, i: number): void => {
    if (!ok && failures.length < 20) failures.push(`#${i} ${msg} :: ${JSON.stringify(samples[i])}`);
  };
  const seen = new Map<string, number>();
  const tally = (key: string): void => void seen.set(key, (seen.get(key) ?? 0) + 1);

  it('гаралт UnderwriteResult-тэй таарна; pass/applicable/eligible/collateral/autoSelect нь BigInt oracle-той тэнцүү', () => {
    samples.forEach((s, i) => {
      const req = toReq(s);
      const r = underwrite(req);
      const parsed = UnderwriteResult.safeParse(r);
      check(parsed.success, 'zod parse', i);
      check(allFinite(r), 'бүх тоо төгсгөлөг (NaN/Infinity байхгүй)', i);
      check(r.methods.map((m) => m.method).join() === IDS.join(), 'method order', i);

      // Барьцаа
      const a = BigInt(s.amt);
      const v = BigInt(s.val);
      const collOk = v === 0n ? !s.required : a * 100n <= BigInt(s.ltvPct) * v;
      check(r.collateral.pass === collOk, `collateral.pass oracle=${collOk}`, i);
      check((v === 0n) === (r.collateral.ltv === null), 'ltv null ⇔ value 0', i);
      if (r.collateral.ltv !== null) check((r.collateral.ltv <= s.ltvPct / 100) === r.collateral.pass, 'ltv харуулах утга pass-тай нийцнэ', i);
      tally(`collateral:${r.collateral.pass}`);

      // Арга бүр
      const sc = baseScn(s);
      for (const m of r.methods) {
        const o = oracleMethod(m.method, sc, BigInt(s.dtiPct), BigInt(s.dscrH));
        check(m.applicable === o.applicable, `${m.method} applicable oracle=${o.applicable}`, i);
        check(m.pass === o.pass, `${m.method} pass oracle=${o.pass}`, i);
        check(m.eligible === (o.applicable && o.pass && collOk), `${m.method} eligible`, i);
        check(m.pass ? m.reasons.length === 0 : m.reasons.length >= 1, `${m.method} reasons ⇔ !pass`, i);
        if (m.applicable && m.ratio !== null) {
          const cmp = m.method === 'A_SALARY' ? m.ratio <= m.limit : m.ratio >= m.limit;
          check(cmp === m.pass, `${m.method} харуулах ratio pass-тай нийцнэ`, i);
        }
        if (!m.applicable) check(m.maxPayment === 0 && m.maxAffordable === 0 && m.maxLoanAmount === 0 && m.ratio === null, `${m.method} not-applicable тэг`, i);
        check(m.maxLoanAmount <= m.maxAffordable && (r.collateral.maxAmount === null || m.maxLoanAmount <= r.collateral.maxAmount), `${m.method} maxLoanAmount ≤ хоёр хязгаар`, i);
        tally(`${m.method}:${m.applicable ? (m.pass ? 'pass' : 'fail') : 'n/a'}`);
      }

      // Stress
      if (s.stress) {
        const ss = stressScn(s);
        check(r.stress !== null && Math.round((r.stress?.stressedMonthlyPayment ?? NaN) * 100) === stressPaymentCents(s), 'stressedMonthlyPayment', i);
        for (const m of r.methods) {
          const o = oracleMethod(m.method, ss, BigInt(s.dtiPct), BigInt(s.dscrH));
          check(m.stress !== null && m.stress.pass === o.pass, `${m.method} stress.pass oracle=${o.pass}`, i);
          tally(`stress:${o.pass}`);
        }
      } else {
        check(r.stress === null && r.methods.every((m) => m.stress === null), 'stress null', i);
      }

      // Автомат сонголт (BR-4, хатуу «>»)
      const sPos = BigInt(Math.max(s.sal, 0));
      const nPos = BigInt(Math.max(s.ncf, 0));
      const sum = sPos + nPos;
      const thr = BigInt(s.thrPct);
      const expectedAuto: CalcMethod | null = sum === 0n ? null : sPos * 100n > thr * sum ? 'A_SALARY' : nPos * 100n > thr * sum ? 'B_BUSINESS' : 'C_COMBINED';
      check(r.autoSelected === expectedAuto, `autoSelected oracle=${expectedAuto}`, i);
      check((r.autoSelectReason === 'NO_INCOME') === (expectedAuto === null), 'autoSelectReason', i);
      // Автоматаар сонгогдсон арга үргэлж хэрэглэгдэх
      if (expectedAuto) check(r.methods.find((m) => m.method === expectedAuto)!.applicable, 'autoSelected нь applicable', i);
      tally(`auto:${expectedAuto}`);
    });
    expect(failures).toEqual([]);
  });

  it('Боломжит дээд дүн: maxPayment нь хязгаарт яг (≤ 1 цент зөрүү), maxAffordable-ийн төлбөр хязгаарт багтана (≤ 1 ₮ хүлцэл)', () => {
    failures.length = 0;
    samples.forEach((s, i) => {
      const r = underwrite(toReq(s));
      for (const m of r.methods) {
        if (!m.applicable) continue;
        // Хязгаар L: A — maxDti × цалин; B/C — суурь ÷ minDscr (бөөрөнхийлөөгүй, baseIncome 2 оронтой тул яг)
        const L = limitOf(m, s);
        const room = L.minus(new OD(s.ex).div(100));
        const maxPay = new OD(m.maxPayment);
        check(maxPay.lte(OD.max(room, 0)), `${m.method} maxPayment хязгаараас хэтрэхгүй`, i);
        check(maxPay.plus(0.01).gt(room), `${m.method} maxPayment нягт (floor 2dp)`, i);
        // pass ⇒ шинэ төлбөр maxPayment-д багтана
        if (m.pass) check(new OD(toReq(s).monthlyPayment).lte(maxPay), `${m.method} pass ⇒ төлбөр ≤ maxPayment`, i);
        // Feasibility: яг maxAffordable дүнтэй зээл ижил хүү/хугацаатай бол өрийн үйлчилгээ хязгаарт (≤ 1 ₮) багтана
        if (m.maxAffordable > 0) {
          const pay = new OD(annuityPayment(m.maxAffordable, s.rate, s.term));
          const total = new OD(s.ex).div(100).plus(pay);
          check(total.lte(L.plus(1)), `${m.method} feasibility: ${total.toString()} ≤ ${L.toString()}+1`, i);
          // Нягт: +1,000 ₮ нэмбэл хязгаараас хэтэрнэ
          const over = new OD(s.ex).div(100).plus(annuityPayment(m.maxAffordable + 1000, s.rate, s.term));
          check(over.gt(L), `${m.method} maxAffordable + 1000 хэтэрнэ`, i);
        }
        check(m.maxAffordable === maxPrincipalForPayment(m.maxPayment, s.rate, s.term), `${m.method} maxAffordable = урвуу(maxPayment)`, i);
      }
    });
    expect(failures).toEqual([]);
  });

  it('монотон: орлого өсөхөд pass → fail болохгүй; дүн өсөхөд fail → pass болохгүй; maxPayment/maxAffordable дүнгээс үл хамаарна', () => {
    failures.length = 0;
    const r2 = lcg(SEED ^ 0x5bd1e995);
    samples.forEach((s, i) => {
      const delta = Math.floor(r2() * 3_000_000_00) * (r2() < 0.2 ? 0 : 1);
      const base = underwrite(toReq(s));

      for (const [label, richer] of [['salary', { ...s, sal: s.sal + delta }], ['ncf', { ...s, ncf: s.ncf + delta }]] as const) {
        const up = underwrite(toReq(richer));
        base.methods.forEach((m, k) => {
          const u = up.methods[k];
          check(!m.pass || u.pass, `${label}↑ ${m.method}: pass→fail болохгүй`, i);
          check(!m.applicable || u.applicable, `${label}↑ ${m.method}: applicable алдагдахгүй`, i);
          check(!m.eligible || u.eligible, `${label}↑ ${m.method}: eligible алдагдахгүй`, i);
          check(u.maxPayment >= m.maxPayment, `${label}↑ ${m.method}: maxPayment буурахгүй`, i);
          check(u.maxAffordable >= m.maxAffordable, `${label}↑ ${m.method}: maxAffordable буурахгүй`, i);
          if (m.stress && u.stress) check(!m.stress.pass || u.stress.pass, `${label}↑ ${m.method}: stress pass→fail болохгүй`, i);
        });
      }

      const bigger = { ...s, amt: s.amt + Math.floor(r2() * 50_000_000) * 100 * (r2() < 0.2 ? 0 : 1) };
      const more = underwrite(toReq(bigger));
      base.methods.forEach((m, k) => {
        const u = more.methods[k];
        check(!u.pass || m.pass, `дүн↑ ${m.method}: fail→pass болохгүй`, i);
        check(!u.eligible || m.eligible, `дүн↑ ${m.method}: eligible-д орохгүй`, i);
        check(u.maxPayment === m.maxPayment && u.maxAffordable === m.maxAffordable, `дүн↑ ${m.method}: дээд дүн дүнгээс үл хамаарна`, i);
        if (m.stress && u.stress) check(!u.stress.pass || m.stress.pass, `дүн↑ ${m.method}: stress fail→pass болохгүй`, i);
      });
      check(!more.collateral.pass || base.collateral.pass, 'дүн↑ collateral fail→pass болохгүй', i);
      check(more.loan.totalPayable >= base.loan.totalPayable, 'дүн↑ totalPayable буурахгүй', i);
    });
    expect(failures).toEqual([]);
  });

  it('санамсаргүй дээж бүх ангиллыг хамарсан (generator-ийн чанар)', () => {
    for (const key of [
      'collateral:true', 'collateral:false',
      'A_SALARY:pass', 'A_SALARY:fail', 'A_SALARY:n/a', 'B_BUSINESS:pass', 'B_BUSINESS:fail', 'B_BUSINESS:n/a', 'C_COMBINED:pass', 'C_COMBINED:fail', 'C_COMBINED:n/a',
      'stress:true', 'stress:false', 'auto:A_SALARY', 'auto:B_BUSINESS', 'auto:C_COMBINED', 'auto:null',
    ]) {
      expect(seen.get(key) ?? 0, key).toBeGreaterThanOrEqual(20);
    }
    expect(samples.length).toBeGreaterThanOrEqual(2000);
  });
});
