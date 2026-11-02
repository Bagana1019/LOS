import { describe, expect, it } from 'vitest';
import { ReasonCode, ReasonStep, SOSCO_COMPONENTS } from '@los/contracts';
import type { MethodReason, ScoreTerms } from '@los/contracts';
import { t } from '../../lib/i18n';
import { MIXED_INPUTS, VERDICT_INPUTS, VERDICT_TERMS, LIMITS, TERMS, emptyOverview, fakeUnderwrite, makeCalculation, makeOverview, previewResponse, reason } from './testing/fixtures';
import {
  amountStep, autoBasisText, calculateBlock, checkTerms, collateralTone, debounceMode, describeScoreError, formatDscr, formatLimit, formatMoney, formatPoints, formatRatio,
  formatShare, formatSignedPercent, formatSoscoInput, formatTermsSummary, formatUpperPercent, fractionBar, groupDigits, isBlockedByCollateral, isDirty, isPreviewPending,
  previewFetchEnabled,
  isStaleStateError, isTermsValid, methodLetter, parseGrouped, pointsBar, ratioTone, reasonText, reconcileDraft, referenceMethod, resolveSource, selectionBlock, sliderSpecs,
  stepHref, termsEqual, termsKey, verdictTone, ERROR_KEYS,
} from './score.utils';

describe('форматлалт (UI-д тооцоолол хийхгүй)', () => {
  it('formatMoney: мянгатын таслал + ₮; бутархай байвал 2 орон', () => {
    expect(formatMoney(20_000_000)).toBe('20,000,000₮');
    expect(formatMoney(2_176_828.35)).toBe('2,176,828.35₮');
    expect(formatMoney(null)).toBe('—');
  });

  it('formatUpperPercent: ӨОХ/LTV 1 орон, ДЭЭШ тоймлоно (55.89…% → 55.9%, хязгаартай тэнцэхгүй)', () => {
    expect(formatUpperPercent(0.5589)).toBe('55.9%');
    expect(formatUpperPercent(0.55)).toBe('55.0%');
    expect(formatUpperPercent(0.5501)).toBe('55.1%'); // 55.0% гэж харуулбал хязгаартай (55%) тэнцэх мэт
    expect(formatUpperPercent(0.7)).toBe('70.0%');
    expect(formatUpperPercent(0)).toBe('0.0%');
    expect(formatUpperPercent(null)).toBe('—');
  });

  it('formatUpperPercent: хөвөгч таслалын шуугианд автахгүй', () => {
    // 0.57 * 100 = 56.99999999999999, 0.29 * 100 = 28.999999999999996
    expect(formatUpperPercent(0.57)).toBe('57.0%');
    expect(formatUpperPercent(0.29)).toBe('29.0%');
    expect(formatUpperPercent(0.1 + 0.2)).toBe('30.0%');
  });

  it('formatDscr: ӨТЧХ 2 орон, ДООШ тоймлоно (15,205,822 ÷ 2,176,828 = 6.9853… → 6.98)', () => {
    expect(formatDscr(6.98)).toBe('6.98');
    expect(formatDscr(6.9853)).toBe('6.98');
    expect(formatDscr(1.25)).toBe('1.25');
    expect(formatDscr(1.2499)).toBe('1.24'); // 1.25 хязгаараас бага байхад 1.25 гэж харуулахгүй
    expect(formatDscr(0)).toBe('0.00');
    expect(formatDscr(null)).toBe('—');
  });

  it('formatShare / formatSignedPercent / formatPoints', () => {
    expect(formatShare(0.55)).toBe('55%');
    expect(formatShare(0.525)).toBe('52.5%');
    expect(formatShare(0.7)).toBe('70%');
    expect(formatSignedPercent(-0.2)).toBe('-20%');
    expect(formatSignedPercent(0.055)).toBe('+5.5%');
    expect(formatSignedPercent(0)).toBe('0%');
    expect(formatPoints(146.3)).toBe('146.3');
    expect(formatPoints(215)).toBe('215');
    expect(formatPoints(null)).toBe('—');
  });

  it('formatRatio / formatLimit: A — ӨОХ %, B/C — ӨТЧХ тоо', () => {
    const [a, b] = fakeUnderwrite(TERMS).methods;
    expect(formatRatio({ ratioKind: 'DTI', ratio: 0.5589 })).toBe('55.9%');
    expect(formatRatio({ ratioKind: 'DSCR', ratio: 6.98 })).toBe('6.98');
    expect(formatRatio({ ratioKind: 'DSCR', ratio: null })).toBe('—');
    expect(formatLimit(a!)).toEqual({ sign: '≤', value: '55%' });
    expect(formatLimit(b!)).toEqual({ sign: '≥', value: '1.25' });
  });

  it('groupDigits / parseGrouped: InputNumber formatter/parser', () => {
    expect(groupDigits(1250000)).toBe('1,250,000');
    expect(groupDigits('1250000.5')).toBe('1,250,000.5');
    expect(groupDigits(undefined)).toBe('');
    expect(parseGrouped('1,250,000 ₮')).toBe('1250000');
    expect(parseGrouped(undefined)).toBe('');
    expect(parseGrouped('')).toBe(''); // хоосон оролт 0 болохгүй
  });

  it('formatTermsSummary', () => {
    expect(formatTermsSummary(TERMS, t)).toBe('20,000,000₮, 24 сар, 23.99%');
    expect(formatTermsSummary({ amount: 5_000_000, termMonths: 12, interestRate: 24 }, t)).toBe('5,000,000₮, 12 сар, 24%');
  });

  it('formatSoscoInput: нэгж бүрийн', () => {
    expect(formatSoscoInput('fico', 702)).toBe('702');
    expect(formatSoscoInput('dti', 41.3)).toBe('41.3%');
    expect(formatSoscoInput('ltv', 0.5)).toBe('50.0%');
    expect(formatSoscoInput('reliability', 82)).toBe('82');
    expect(formatSoscoInput('reliability', 82.54)).toBe('82.5');
    expect(formatSoscoInput('suspicious', 1)).toBe('1');
    expect(formatSoscoInput('history', null)).toBe('—');
  });

  it('progress bar: зөвхөн дүрслэлийн хөрвүүлэлт, 0..100-д хавчина', () => {
    expect(fractionBar(0.7309)).toBe(73.09);
    expect(fractionBar(1.2)).toBe(100);
    expect(fractionBar(-0.1)).toBe(0);
    expect(fractionBar(null)).toBe(0);
    expect(pointsBar(250)).toBe(25);
    expect(pointsBar(1200)).toBe(100);
    expect(pointsBar(undefined)).toBe(0);
  });

  it('methodLetter', () => {
    expect(['A_SALARY', 'B_BUSINESS', 'C_COMBINED'].map((m) => methodLetter(m as 'A_SALARY'))).toEqual(['A', 'B', 'C']);
  });
});

describe('тон (өнгө) — хангасан / хангаагүй / хамаарахгүй (FR-8.4)', () => {
  it('ratioTone', () => {
    expect(ratioTone({ applicable: true, pass: true })).toBe('pass');
    expect(ratioTone({ applicable: true, pass: false })).toBe('fail');
    expect(ratioTone({ applicable: false, pass: false })).toBe('na');
  });

  it('verdictTone: eligible-ээр; хамаарахгүй бол саарал', () => {
    expect(verdictTone({ applicable: true, eligible: true })).toBe('pass');
    expect(verdictTone({ applicable: true, eligible: false })).toBe('fail');
    expect(verdictTone({ applicable: false, eligible: false })).toBe('na');
  });

  it('isBlockedByCollateral: харьцаа хангасан ч барьцаа хангаагүй', () => {
    expect(isBlockedByCollateral({ applicable: true, pass: true, eligible: false })).toBe(true);
    expect(isBlockedByCollateral({ applicable: true, pass: true, eligible: true })).toBe(false);
    expect(isBlockedByCollateral({ applicable: true, pass: false, eligible: false })).toBe(false);
    expect(isBlockedByCollateral({ applicable: false, pass: false, eligible: false })).toBe(false);
  });

  it('collateralTone: барьцаа шаардахгүй + хөрөнгөгүй → na', () => {
    expect(collateralTone({ required: false, ltv: null, pass: true })).toBe('na');
    expect(collateralTone({ required: true, ltv: 0.5, pass: true })).toBe('pass');
    expect(collateralTone({ required: true, ltv: null, pass: false })).toBe('fail'); // NO_COLLATERAL_VALUE
    expect(collateralTone({ required: false, ltv: 0.9, pass: false })).toBe('fail');
  });

  it('fixture-ийн гурван төлөв нэг дор: A ногоон, B саарал, C улаан', () => {
    const tones = fakeUnderwrite(VERDICT_TERMS, VERDICT_INPUTS).methods.map((m) => verdictTone(m));
    expect(tones).toEqual(['pass', 'na', 'fail']);
  });
});

describe('шалтгаан (FR-8.6)', () => {
  it('reasonText: i18n түлхүүр байвал монгол текст, үгүй бол серверийн мессеж', () => {
    const known: MethodReason = reason('DTI_ABOVE_LIMIT');
    expect(reasonText({ code: known.code, message: 'server text' }, t)).toBe(t('score.reason.DTI_ABOVE_LIMIT'));
    expect(reasonText({ code: 'FUTURE_CODE' as MethodReason['code'], message: 'Серверийн мессеж' }, t)).toBe('Серверийн мессеж');
  });

  it('i18n-ийн fallback нь тестэд солигдож болно', () => {
    expect(reasonText({ code: 'NO_INCOME', message: 'srv' }, (k) => `#${k}`, () => false)).toBe('srv');
    expect(reasonText({ code: 'NO_INCOME', message: 'srv' }, (k) => `#${k}`, () => true)).toBe('#score.reason.NO_INCOME');
  });

  it('stepHref: reason.step → wizard-ийн алхам', () => {
    expect(stepHref('abc-1', 'income')).toBe('/los/loan-application/abc-1/income');
    expect(stepHref('a/b', 'loan')).toBe('/los/loan-application/a%2Fb/loan');
  });

  it('шалтгаан бүр, алхам бүр монгол орчуулгатай', () => {
    for (const code of ReasonCode.options) expect(t(`score.reason.${code}`), code).not.toBe(`score.reason.${code}`);
    for (const step of ReasonStep.options) expect(t(`score.step.${step}`), step).not.toBe(`score.step.${step}`);
  });
});

describe('slider (FR-8.3)', () => {
  it('amountStep: 100,000 ₮-ийг илүүд үзнэ, муж хэт том/жижиг бол тохируулна', () => {
    expect(amountStep(500_000, 50_000_000)).toBe(100_000);
    expect(amountStep(1_000_000, 500_000_000)).toBe(1_000_000); // >1000 байрлал → бүдүүлнэ
    expect(amountStep(1_000_000, 3_000_000)).toBe(100_000); // яг 20 байрлал — 100,000 хэвээр
    expect(amountStep(1_000_000, 2_500_000)).toBe(10_000); // <20 байрлал → нарийсгана
    expect(amountStep(100_000, 100_000)).toBe(1_000);
    expect(amountStep(0, 1e15)).toBe(100_000_000);
  });

  it('sliderSpecs: хязгаар product-оос; min ≥ max бол fixed', () => {
    const s = sliderSpecs(LIMITS);
    expect(s.amount).toEqual({ min: 500_000, max: 50_000_000, step: 100_000, fixed: false });
    expect(s.termMonths).toEqual({ min: 3, max: 60, step: 1, fixed: false });
    expect(s.interestRate).toMatchObject({ min: 12, max: 36, step: 0.1, inputStep: 0.01, fixed: false });
    expect(sliderSpecs({ ...LIMITS, minTermMonths: 12, maxTermMonths: 12 }).termMonths.fixed).toBe(true);
  });

  it('checkTerms / isTermsValid: хязгаарын шалгалт (формын оролт)', () => {
    expect(isTermsValid(TERMS, LIMITS)).toBe(true);
    expect(checkTerms({ ...TERMS, amount: 100_000 }, LIMITS)).toEqual({ amount: false, termMonths: true, interestRate: true });
    expect(checkTerms({ ...TERMS, termMonths: 61 }, LIMITS).termMonths).toBe(false);
    expect(checkTerms({ ...TERMS, termMonths: 12.5 }, LIMITS).termMonths).toBe(false);
    expect(checkTerms({ ...TERMS, interestRate: 36.01 }, LIMITS).interestRate).toBe(false);
    expect(checkTerms({ ...TERMS, amount: Number.NaN }, LIMITS).amount).toBe(false);
    // хязгаар үл мэдэгдэх бол зөвхөн утгын хүчинтэй байдал
    expect(isTermsValid({ amount: 1, termMonths: 1, interestRate: 0 }, null)).toBe(true);
    expect(isTermsValid({ amount: 0, termMonths: 1, interestRate: 0 }, null)).toBe(false);
  });

  it('termsEqual / termsKey: утгаар', () => {
    expect(termsEqual(TERMS, { ...TERMS })).toBe(true);
    expect(termsEqual(TERMS, { ...TERMS, termMonths: 25 })).toBe(false);
    expect(termsEqual(null, null)).toBe(true);
    expect(termsEqual(TERMS, null)).toBe(false);
    expect(termsKey(TERMS)).toBe('20000000|24|23.99');
    expect(termsKey(null)).toBe('');
  });

  it('reconcileDraft: суурь өөрчлөгдвөл ноорог шинэ суурь руу сэргэнэ, өөрчлөгдөөгүй бол ноорог хэвээр', () => {
    const edited: ScoreTerms = { ...TERMS, termMonths: 36 };
    const state = { base: TERMS, draft: edited };
    expect(reconcileDraft(state, { ...TERMS })).toBe(state); // ижил утга → ижил обьект (re-render давталтгүй)
    const next = { ...TERMS, amount: 15_000_000 };
    expect(reconcileDraft(state, next)).toEqual({ base: next, draft: next });
    expect(reconcileDraft({ base: null, draft: null }, TERMS)).toEqual({ base: TERMS, draft: TERMS });
  });

  it('isDirty: ноорог суурьтай ялгаатай үед', () => {
    expect(isDirty({ base: TERMS, draft: TERMS })).toBe(false);
    expect(isDirty({ base: TERMS, draft: { ...TERMS, interestRate: 20 } })).toBe(true);
    expect(isDirty({ base: null, draft: null })).toBe(false);
  });

  it('debounceMode / isPreviewPending: hook-ийн шийдвэр', () => {
    expect(debounceMode(null, TERMS)).toBe('immediate'); // эхний хүчинтэй утга — хүлээхгүй
    expect(debounceMode(TERMS, { ...TERMS, termMonths: 30 })).toBe('delayed');
    expect(debounceMode(null, null)).toBe('delayed');

    const base = { enabled: true, draft: TERMS, debounced: TERMS, fetching: false };
    expect(isPreviewPending(base)).toBe(false);
    expect(isPreviewPending({ ...base, debounced: { ...TERMS, termMonths: 12 } })).toBe(true); // debounce хүлээж байна
    expect(isPreviewPending({ ...base, fetching: true })).toBe(true);
    expect(isPreviewPending({ ...base, enabled: false, fetching: true })).toBe(false);
    expect(isPreviewPending({ ...base, draft: null, fetching: true })).toBe(false); // хүчингүй утга
  });

  it('previewFetchEnabled: debounce хүлээж буй (хуучин утгаар) илүү хүсэлт явуулахгүй', () => {
    const edited = { ...TERMS, amount: 30_000_000 };
    expect(previewFetchEnabled(true, TERMS, TERMS)).toBe(true);
    expect(previewFetchEnabled(true, edited, TERMS)).toBe(false); // slider дөнгөж хөдөлсөн: debounced нь хуучин хадгалсан утга хэвээр
    expect(previewFetchEnabled(true, edited, edited)).toBe(true); // тогтворжсон
    expect(previewFetchEnabled(false, edited, edited)).toBe(false);
    expect(previewFetchEnabled(true, null, TERMS)).toBe(false); // хүчингүй утга
    expect(previewFetchEnabled(true, TERMS, null)).toBe(false);
  });
});

describe('аль үр дүнг харуулах (resolveSource)', () => {
  const calc = makeCalculation();
  const prev = previewResponse({ ...TERMS, termMonths: 36 });

  it('тооцоолол байхгүй, preview байхгүй → none', () => {
    expect(resolveSource({ calculation: null, dirty: false, preview: null })).toEqual({ kind: 'none' });
  });
  it('тооцоолол байхгүй → одоогийн нөхцөлийн preview (initial)', () => {
    const s = resolveSource({ calculation: null, dirty: false, preview: prev });
    expect(s).toMatchObject({ kind: 'preview', basis: 'initial' });
  });
  it('тооцоолол байгаа, slider цэвэр → хадгалсан (preview үл тооно)', () => {
    const s = resolveSource({ calculation: calc, dirty: false, preview: prev });
    expect(s).toMatchObject({ kind: 'saved', fallback: false });
    expect(s.kind === 'saved' && s.result).toBe(calc.result);
  });
  it('slider өөрчлөгдсөн → preview (modified)', () => {
    expect(resolveSource({ calculation: calc, dirty: true, preview: prev })).toMatchObject({ kind: 'preview', basis: 'modified' });
    expect(resolveSource({ calculation: null, dirty: true, preview: prev })).toMatchObject({ kind: 'preview', basis: 'modified' });
  });
  it('slider өөрчлөгдсөн ч preview хараахан ирээгүй/алдаатай → хадгалсан (fallback)', () => {
    expect(resolveSource({ calculation: calc, dirty: true, preview: null })).toMatchObject({ kind: 'saved', fallback: true });
  });
});

describe('referenceMethod / autoBasisText', () => {
  const result = fakeUnderwrite(TERMS);
  it('сонгосон → автомат → эхний', () => {
    expect(referenceMethod(result, 'A_SALARY').method).toBe('A_SALARY');
    expect(referenceMethod(result, null).method).toBe('C_COMBINED'); // MIXED → C
    expect(referenceMethod({ ...result, autoSelected: null }, null).method).toBe('A_SALARY');
  });
  it('автомат сонголтын үндэслэл (BR-4)', () => {
    expect(autoBasisText(result, t)).toBe('цалин (42.9%), бизнес (57.1%) аль нь ч 70%-аас даваагүй тул C арга');
    const salary = fakeUnderwrite(TERMS, { ...MIXED_INPUTS, salary: 9_000_000, businessNcf: 1_000_000 });
    expect(autoBasisText(salary, t)).toBe('цалингийн орлогын жин 90% нь босгоос (70%) давсан тул A арга');
    const none = fakeUnderwrite(TERMS, { ...MIXED_INPUTS, salary: 0, businessNcf: 0 });
    expect(autoBasisText(none, t)).toBe('орлого байхгүй тул автомат сонголт хийгдэхгүй');
  });
});

describe('үйлдлийн хаалт', () => {
  const saved = (over = {}) => resolveSource({ calculation: makeCalculation(over), dirty: false, preview: null });
  const preview = (dirty: boolean, calculation = makeCalculation()) => resolveSource({ calculation: dirty ? calculation : null, dirty, preview: previewResponse(TERMS) });

  it('selectionBlock: сонгож болох нөхцөл', () => {
    expect(selectionBlock({ editable: true, source: saved(), busy: false })).toBeNull();
  });
  it('зөвхөн харах → notEditable (бусад бүхнээс түрүүлж)', () => {
    expect(selectionBlock({ editable: false, source: saved(), busy: false })).toBe('notEditable');
    expect(selectionBlock({ editable: false, source: { kind: 'none' }, busy: false })).toBe('notEditable');
  });
  it('хадгалсан тооцоолол байхгүй → noCalculation; slider өөрчилсөн → modified; хуучирсан → stale; хадгалж байна → busy', () => {
    expect(selectionBlock({ editable: true, source: { kind: 'none' }, busy: false })).toBe('noCalculation');
    expect(selectionBlock({ editable: true, source: preview(false), busy: false })).toBe('noCalculation');
    expect(selectionBlock({ editable: true, source: preview(true), busy: false })).toBe('modified');
    expect(selectionBlock({ editable: true, source: resolveSource({ calculation: makeCalculation(), dirty: true, preview: null }), busy: false })).toBe('modified');
    expect(selectionBlock({ editable: true, source: saved({ isStale: true, staleReason: 'Хүү өөрчлөгдсөн' }), busy: false })).toBe('stale');
    expect(selectionBlock({ editable: true, source: saved(), busy: true })).toBe('busy');
  });
  it('calculateBlock: notEditable > blockers > noTerms', () => {
    const ok = makeOverview();
    expect(calculateBlock(ok)).toBeNull();
    expect(calculateBlock({ ...ok, editable: false })).toBe('notEditable');
    expect(calculateBlock({ ...ok, blockers: [reason('LOAN_TERMS_MISSING')], terms: null })).toBe('blockers');
    expect(calculateBlock({ ...ok, terms: null })).toBe('noTerms');
    expect(calculateBlock({ ...emptyOverview(), editable: false, blockers: [reason('NO_INCOME')] })).toBe('notEditable');
  });
});

describe('алдаа', () => {
  const err = (status: number, code: string | null, message = 'srv msg') => Object.assign(new Error(message), { status, code });

  it('SCORING_ERROR_CODES бүр монгол мессежтэй; зөвхөн SCORING_UNAVAILABLE дахин оролдоно', () => {
    for (const key of ERROR_KEYS) expect(t(key), key).not.toBe(key);
    const unavailable = describeScoreError(err(503, 'SCORING_UNAVAILABLE'), t);
    expect(unavailable).toMatchObject({ code: 'SCORING_UNAVAILABLE', retryable: true, message: t('score.error.SCORING_UNAVAILABLE') });
    for (const code of ['CALCULATION_STALE', 'METHOD_NOT_APPLICABLE', 'OUT_OF_PRODUCT_LIMITS', 'APPLICATION_NOT_EDITABLE', 'LOAN_TERMS_MISSING']) {
      expect(describeScoreError(err(409, code), t), code).toMatchObject({ code, retryable: false, message: t(`score.error.${code}`) });
    }
  });
  it('статус/сүлжээний ерөнхий алдаа', () => {
    expect(describeScoreError(err(401, null), t).message).toBe(t('score.error.UNAUTHENTICATED'));
    expect(describeScoreError(err(403, 'FORBIDDEN'), t).message).toBe(t('score.error.FORBIDDEN'));
    expect(describeScoreError(err(500, null), t)).toMatchObject({ message: t('score.error.SERVER'), retryable: true });
    expect(describeScoreError(new TypeError('Failed to fetch'), t)).toMatchObject({ message: t('score.error.NETWORK'), retryable: true });
    expect(describeScoreError(Object.assign(new Error('x'), { name: 'ZodError' }), t)).toMatchObject({ message: t('score.error.INVALID_RESPONSE'), retryable: true });
  });
  it('үл мэдэгдэх 4xx → серверийн мессеж; мэдээлэлгүй → UNKNOWN', () => {
    expect(describeScoreError(err(418, 'TEAPOT', 'Би цайны сав'), t)).toMatchObject({ message: 'Би цайны сав', retryable: false });
    expect(describeScoreError(undefined, t).message).toBe(t('score.error.UNKNOWN'));
    expect(describeScoreError('boom', t).message).toBe(t('score.error.UNKNOWN'));
  });
  it('isStaleStateError: 404/409 ба хуучирсан/хамаарахгүй код', () => {
    expect(isStaleStateError(err(409, null))).toBe(true);
    expect(isStaleStateError(err(404, 'CALCULATION_NOT_FOUND'))).toBe(true);
    expect(isStaleStateError(err(422, 'METHOD_NOT_APPLICABLE'))).toBe(true);
    expect(isStaleStateError(err(500, null))).toBe(false);
    expect(isStaleStateError(null)).toBe(false);
  });
});

describe('Sosco', () => {
  it('бүрэлдэхүүн бүр монгол орчуулгатай', () => {
    for (const k of SOSCO_COMPONENTS) expect(t(`score.sosco.component.${k}`), k).not.toBe(`score.sosco.component.${k}`);
  });
});
