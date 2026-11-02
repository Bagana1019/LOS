import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MethodReason, ScoreOverview, ScoreTerms } from '@los/contracts';
import { ScoreSkeleton, ScoreView, type ScoreViewActions, type ScoreViewModel } from './ScoreView';
import { resolveSource } from './score.utils';
import { buttonByText, buttons, dataAttrs, links, radios, visibleText } from './testing/html';
import {
  APP_ID, MIXED_INPUTS, TERMS, VERDICT_INPUTS, VERDICT_TERMS, emptyOverview, fakeUnderwrite, makeCalculation, makeOverview, previewResponse, reason, soscoInsufficient, soscoScored,
} from './testing/fixtures';

// Компонент тест: react-dom/server (jsdom-гүй, esign-тэй адил). Интерактив урсгалыг Playwright (e2e/score.spec.ts) шалгана.
// antd-ийн "deprecated" анхааруулга зэрэг console.error/warn гарахгүй байх ёстой.
let consoleErrors: unknown[][];
beforeEach(() => {
  consoleErrors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => void consoleErrors.push(a));
  vi.spyOn(console, 'warn').mockImplementation((...a) => void consoleErrors.push(a));
});
afterEach(() => {
  expect(consoleErrors, 'console errors/warnings').toEqual([]);
  vi.restoreAllMocks();
});

const actions: ScoreViewActions = {
  onTermsChange: vi.fn(),
  onResetTerms: vi.fn(),
  onCalculate: vi.fn(),
  onRetryPreview: vi.fn(),
  onRetryRefresh: vi.fn(),
  onPick: vi.fn(),
  onConfirmSelect: vi.fn(),
  onCancelSelect: vi.fn(),
};

interface Over extends Partial<Omit<ScoreViewModel, 'overview' | 'source'>> {
  overview?: ScoreOverview;
  /** Slider өөрчлөгдсөн гэж үзэж, энэ нөхцөлийн preview-г харуулна */
  previewTerms?: ScoreTerms;
  previewInputs?: typeof MIXED_INPUTS;
}

function model(over: Over = {}): ScoreViewModel {
  const overview = over.overview ?? makeOverview();
  const dirty = over.dirty ?? over.previewTerms !== undefined;
  const preview = over.previewTerms ? previewResponse(over.previewTerms, over.previewInputs) : overview.calculation === null && overview.terms ? previewResponse(overview.terms, over.previewInputs) : null;
  const { overview: _o, previewTerms: _p, previewInputs: _i, ...rest } = over;
  return {
    applicationId: APP_ID,
    overview,
    source: resolveSource({ calculation: overview.calculation, dirty, preview }),
    draft: over.previewTerms ?? overview.terms,
    dirty,
    previewPending: false,
    previewError: null,
    refreshError: null,
    calculating: false,
    calculateError: null,
    selectTarget: null,
    selecting: false,
    selectError: null,
    announcement: '',
    ...rest,
  };
}

const render = (over: Over = {}) => renderToString(<ScoreView model={model(over)} actions={actions} />);
const row = (html: string, key: string): string => new RegExp(`<tr[^>]*data-row="${key}"[^>]*>([\\s\\S]*?)</tr>`).exec(html)?.[1] ?? '';
const cells = (html: string, key: string): string[] => [...row(html, key).matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].slice(1).map((m) => visibleText(m[1] ?? ''));
/** antd Table `scroll.x` үед толгойг хэмжих aria-hidden хуулбар tbody-д орно — жинхэнэ толгой нь эхний <thead> */
const head = (html: string): string => /<thead[\s\S]*?<\/thead>/.exec(html)?.[0] ?? '';
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const hrefs = (html: string) => links(html).map((l) => l.href);
const loanHref = (step: string) => `/los/loan-application/${APP_ID}/${step}`;

describe('хадгалсан тооцоолол (C автомат)', () => {
  const html = render();
  const text = visibleText(html);

  it('гарчиг, төлөвийн шошго: хадгалсан цаг (УБ), сонгосон арга + автомат', () => {
    expect(text).toContain('Тооцоолол');
    expect(text).toContain('Хадгалсан · 2026-10-29 14:05');
    expect(text).toContain('Сонгосон: C · Хосолсон · Автомат');
  });

  it('гурван багана A/B/C; зөвхөн C-д «Автомат» ба «Сонгосон»; radio-ууд толгойд биш мөрөнд (давхар radio байхгүй)', () => {
    expect(dataAttrs(head(html), 'method')).toEqual(['A_SALARY', 'B_BUSINESS', 'C_COMBINED']);
    const r = radios(html);
    expect(r.map((x) => x.value)).toEqual(['A_SALARY', 'B_BUSINESS', 'C_COMBINED']);
    expect(r.map((x) => x.checked)).toEqual([false, false, true]);
    expect(r.every((x) => !x.disabled)).toBe(true);
    expect(r[0]!.label).toBe('A · Цалин аргыг сонгох');
    expect(count(head(html), '>Автомат<')).toBe(1);
    expect(count(head(html), '>Сонгосон<')).toBe(1);
    expect(head(html).indexOf('>Автомат<')).toBeGreaterThan(head(html).indexOf('data-method="C_COMBINED"'));
  });

  it('мөрүүд: суурь орлого, нийт өрийн үйлчилгээ, харьцаа/хязгаар, дүгнэлт, шалтгаан, дээд дүн, stress', () => {
    expect(cells(html, 'baseIncome')).toEqual(['4,500,000₮', '6,000,000₮', '9,300,000₮']);
    expect(cells(html, 'totalDebtService').every((c) => c === cells(html, 'totalDebtService')[0])).toBe(true);
    const ratios = cells(html, 'ratio');
    expect(ratios[0]).toBe('ӨОХ 41.3% хязгаар ≤ 55%');
    expect(ratios[1]).toMatch(/^ӨТЧХ 3\.2\d хязгаар ≥ 1\.25$/);
    expect([...row(html, 'ratio').matchAll(/data-tone="(\w+)"/g)].map((m) => m[1])).toEqual(['pass', 'pass', 'pass']);
    expect(cells(html, 'verdict')).toEqual(['Хангана', 'Хангана', 'Хангана']);
    expect(cells(html, 'reasons')).toEqual(['—', '—', '—']);
    expect(cells(html, 'maxAffordable')).toHaveLength(3);
    expect(cells(html, 'stress')[0]).toMatch(/^ӨОХ \d+\.\d%$/);
  });

  it('бодлогын шалгуур (policy-оос форматлана)', () => {
    expect(text).toContain('ӨОХ ≤ 55% (BR-1)');
    expect(text).toContain('ӨТЧХ ≥ 1.25 (BR-2)');
    expect(text).toContain('LTV ≤ 70% (BR-3)');
    expect(text).toContain('Автомат сонголтын жин > 70% (BR-4)');
  });

  it('автомат сонголтын үндэслэл, шууд тоонууд (серверийн утга, форматлагдсан)', () => {
    expect(text).toContain('Автомат сонголтын үндэслэл: цалин (42.9%), бизнес (57.1%) аль нь ч 70%-аас даваагүй тул C арга');
    const result = makeCalculation().result;
    expect(text).toContain(`Сарын төлбөр ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(result.loan.monthlyPayment)}₮`);
    expect(dataAttrs(html, 'live')).toEqual(['monthlyPayment', 'totalDebtService', 'totalInterest']);
  });

  it('товч: «Тооцоолох (хадгалах)» идэвхтэй; хадгалсан нөхцөлийн тайлбар; анхааруулга байхгүй', () => {
    expect(buttonByText(html, 'Тооцоолох (хадгалах)')).toMatchObject({ disabled: false });
    expect(text).toContain('Хадгалах тооцоо нь «Зээлийн мэдээлэл» алхамд хадгалсан нөхцөлөөр хийгдэнэ.');
    expect(html).not.toContain('ant-alert');
    expect(html).not.toContain('score-dirty');
  });

  it('slider: нэртэй handle, product-ийн хязгаар, label-тай тоон оролт', () => {
    expect(html).toMatch(/role="slider"[^>]*aria-valuemin="500000"[^>]*aria-valuemax="50000000"[^>]*aria-valuenow="20000000"/);
    expect(html).toContain('aria-label="Зээлийн дүн"');
    expect(html).toContain('aria-label="Хугацаа (сар)"');
    expect(html).toContain('aria-label="Жилийн хүү (%)"');
    for (const id of ['score-amount', 'score-term', 'score-rate']) {
      expect(html).toContain(`<label for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(text).toContain('Хязгаар: 500,000₮ – 50,000,000₮');
    expect(text).toContain('Хязгаар: 3 – 60');
    expect(text).toContain('Хязгаар: 12% – 36%');
  });

  it('live region: утгууд aria-live, мэдэгдэл бүхий нууц status', () => {
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-testid="score-announcer"');
  });
});

describe('гурван төлөв нэг дор: A хангана · B хамаарахгүй · C хангахгүй (FR-8.4, FR-8.6)', () => {
  const overview = makeOverview({ calculation: makeCalculation({ terms: VERDICT_TERMS, inputs: VERDICT_INPUTS }) });
  const html = render({ overview });

  it('дүгнэлтийн шошго + дүрс (өнгөөр ганцаараа биш)', () => {
    expect(cells(html, 'verdict')).toEqual(['Хангана', 'Хамаарахгүй', 'Хангахгүй']);
    const verdict = row(html, 'verdict');
    expect([...verdict.matchAll(/data-tone="(\w+)"/g)].map((m) => m[1])).toEqual(['pass', 'na', 'fail']);
    expect(verdict).toContain('anticon-check-circle');
    expect(verdict).toContain('anticon-minus-circle');
    expect(verdict).toContain('anticon-close-circle');
  });

  it('шалтгаан бүр засах алхам руу линктэй', () => {
    const [a, b, c] = cells(html, 'reasons');
    expect(a).toBe('—');
    expect(b).toBe('Бизнесийн орлого (ЦМУ) байхгүй Засах: Орлого');
    expect(c).toBe('Өрийн төлбөр чадварын харьцаа (ӨТЧХ) доод хязгаараас бага байна Засах: Зээлийн мэдээлэл');
    expect(hrefs(row(html, 'reasons'))).toEqual([loanHref('income'), loanHref('loan')]);
  });

  it('хамаарахгүй аргын радио идэвхгүй, бусад нь идэвхтэй', () => {
    expect(radios(html).map((r) => r.disabled)).toEqual([false, true, false]);
  });

  it('хамаарахгүй аргад ратио/дээд дүн «—», харьцаа хангаагүйд хязгаар харагдана', () => {
    const [ratioA, ratioB, ratioC] = cells(html, 'ratio');
    expect(ratioA).toMatch(/^ӨОХ 51\.\d% хязгаар ≤ 55%$/);
    expect(ratioB).toBe('ӨТЧХ — хязгаар ≥ 1.25');
    expect(ratioC).toMatch(/^ӨТЧХ 1\.1\d хязгаар ≥ 1\.25$/);
    expect([...row(html, 'ratio').matchAll(/data-tone="(\w+)"/g)].map((m) => m[1])).toEqual(['pass', 'na', 'fail']);
    expect(cells(html, 'maxAffordable')[1]).toBe('—');
    expect(cells(html, 'maxLoanAmount')[1]).toBe('—');
  });
});

describe('барьцаа (LTV)', () => {
  it('LTV хэтэрсэн: барьцааны карт улаан + шалтгаан /collateral линктэй; A-ийн нийт дүгнэлт «Хангахгүй» + тайлбар', () => {
    const calc = makeCalculation({ inputs: { ...MIXED_INPUTS, collateralValue: 20_000_000 } });
    const html = render({ overview: makeOverview({ calculation: calc }) });
    const text = visibleText(html);
    expect(text).toContain('Барьцааны шалгуур (LTV)');
    expect(html).toContain('data-tone="fail"');
    expect(text).toContain('Зээл/барьцааны харьцаа (LTV) зөвшөөрөгдөх дээд хязгаараас хэтэрсэн Засах: Барьцаа');
    expect(hrefs(html)).toContain(loanHref('collateral'));
    expect(cells(html, 'verdict')).toEqual(Array(3).fill('Хангахгүй Барьцааны LTV хангаагүй'));
    expect([...row(html, 'ratio').matchAll(/data-tone="(\w+)"/g)].map((m) => m[1])).toEqual(['pass', 'pass', 'pass']); // харьцаа хангасан, барьцаа саад
    expect(text).toMatch(/LTV ба хязгаар 100\.0% \(хязгаар ≤ 70%\)/);
  });

  it('барьцаа шаардахгүй, хөрөнгөгүй: «Хамаарахгүй» (саарал), дээд дүн хязгааргүй', () => {
    const calc = makeCalculation({ inputs: { ...MIXED_INPUTS, collateralRequired: false, collateralValue: 0 } });
    const html = render({ overview: makeOverview({ calculation: calc }) });
    const text = visibleText(html);
    expect(text).toContain('Барьцаа шаардахгүй бөгөөд хөрөнгө бүртгэгдээгүй тул LTV хамаарахгүй.');
    expect(text).toContain('Барьцаагаар олгох дээд дүн Хязгааргүй');
    expect(text).toContain('LTV ба хязгаар — (хязгаар ≤ 70%)');
    expect(html).toMatch(/ant-card-extra[\s\S]*?data-tone="na"/);
  });

  it('барьцаа шаардлагатай ч үнэлгээ 0: NO_COLLATERAL_VALUE', () => {
    const calc = makeCalculation({ inputs: { ...MIXED_INPUTS, collateralValue: 0 } });
    const text = visibleText(render({ overview: makeOverview({ calculation: calc }) }));
    expect(text).toContain('Барьцаа шаардлагатай боловч барьцааны үнэлгээ байхгүй');
    expect(text).toContain('Барьцаагаар олгох дээд дүн 0₮');
    expect(text).toContain('LTV ба хязгаар — (хязгаар ≤ 70%)');
  });
});

describe('stress (FR-8.5)', () => {
  it('сценарийн нөхцөл + мэдээллийн шинжтэй тэмдэглэл', () => {
    const text = visibleText(render());
    expect(text).toContain('Хүү өсөх +5 п.п.');
    expect(text).toContain('Орлого буурах -20%');
    expect(text).toContain('Stress-ийн сарын төлбөр');
    expect(text).toContain('Мэдээллийн шинжтэй: stress хангаагүй байсан ч сонгох, илгээхийг хаахгүй.');
  });
  it('stress тохиргоогүй: тайлбар, мөр «—»', () => {
    const html = render({ overview: makeOverview({ calculation: makeCalculation({ stress: false }) }) });
    expect(visibleText(html)).toContain('Stress тохиргоо идэвхгүй байна.');
    expect(cells(html, 'stress')).toEqual(['—', '—', '—']);
  });
});

describe('тооцоолол хараахан хадгалагдаагүй — одоогийн нөхцөлийн урьдчилсан харагдац', () => {
  const html = render({ overview: emptyOverview() });
  const text = visibleText(html);

  it('мэдэгдэл, шошго, Sosco хоосон', () => {
    expect(text).toContain('Тооцолол хараахан хадгалагдаагүй'.replace('Тооцолол', 'Тооцоолол'));
    expect(text).toContain('Одоогийн нөхцөлөөр урьдчилан харуулж байна: 20,000,000₮, 24 сар, 23.99%.');
    expect(text).toContain('Урьдчилсан харагдац');
    expect(text).toContain('Sosco Score хараахан тооцоологдоогүй.');
  });

  it('сонголт хаалттай (хадгалсан тооцоололгүй), тайлбартай; хадгалах товч идэвхтэй', () => {
    expect(radios(html).every((r) => r.disabled && !r.checked)).toBe(true);
    expect(text).toContain('Арга сонгох боломжгүй: тооцоолол хадгалагдаагүй байна.');
    expect(buttonByText(html, 'Тооцоолох (хадгалах)')?.disabled).toBe(false);
  });

  it('preview ирээгүй, хүлээж байна: skeleton', () => {
    const waiting = renderToString(
      <ScoreView model={{ ...model({ overview: emptyOverview() }), source: { kind: 'none' }, previewPending: true }} actions={actions} />,
    );
    expect(waiting).toContain('ant-skeleton');
    expect(visibleText(waiting)).toContain('Шинэчилж байна…');
  });

  it('preview ирээгүй, хүлээхгүй: хоосон төлөв', () => {
    const empty = renderToString(<ScoreView model={{ ...model({ overview: emptyOverview() }), source: { kind: 'none' } }} actions={actions} />);
    expect(visibleText(empty)).toContain('Харуулах тооцоолол алга.');
    expect(visibleText(empty)).toContain('Тооцоолоогүй');
  });
});

describe('slider өөрчлөгдсөн (хадгалагдаагүй урьдчилсан харагдац)', () => {
  const longer: ScoreTerms = { ...TERMS, termMonths: 48 };
  const html = render({ previewTerms: longer });
  const text = visibleText(html);

  it('урьдчилсан үр дүнг харуулна: сервер нөхцөлийг буцаасан утгаараа', () => {
    expect(text).toContain('Урьдчилсан харагдац: хадгалагдаагүй');
    expect(text).toContain('Slider-ийн нөхцөлөөр харуулж байна: 20,000,000₮, 48 сар, 23.99%.');
    const payment = fakeUnderwrite(longer).loan.monthlyPayment;
    expect(text).toContain(`${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(payment)}₮`);
  });

  it('хадгалсан нөхцөл + «буцах» товч; «Хадгалах» тайлбар өөрчлөгдөнө; сонголт хаалттай', () => {
    expect(text).toContain('Хадгалсан нөхцөл: 20,000,000₮, 24 сар, 23.99%');
    expect(buttonByText(html, 'Хадгалсан нөхцөл рүү буцах')).toMatchObject({ disabled: false });
    expect(text).toContain('Slider-ийн утга хадгалагдахгүй: хадгалсан нөхцөлөөр тооцоолно.');
    expect(radios(html).every((r) => r.disabled)).toBe(true);
    expect(text).toContain('Арга сонгохын тулд slider-ийг хадгалсан нөхцөл рүү буцаана уу.');
    expect(radios(html).map((r) => r.checked)).toEqual([false, false, false]); // сонголт хадгалсан тооцоонд хамаарна
  });

  it('Sosco хадгалсан тооцооллынх гэдгийг сануулна; хуучин хадгалсан шошго байхгүй', () => {
    expect(text).toContain('Sosco нь хадгалсан тооцооллынх: slider-ээр өөрчлөгдөхгүй.');
    expect(text).not.toContain('Сонгосон: C');
  });

  it('preview хүлээгдэж байгаа үед хүснэгт бүдгэрч aria-busy', () => {
    const busy = render({ previewTerms: longer, previewPending: true });
    expect(busy).toContain('aria-busy="true"');
    expect(visibleText(busy)).toContain('Урьдчилсан харагдац: хадгалагдаагүй');
  });

  it('preview алдаатай: хадгалсан тооцоог fallback-аар харуулж, slider-ийн хажууд алдаа + дахин оролдох', () => {
    const calc = makeOverview();
    const failing = renderToString(
      <ScoreView
        model={{ ...model({ overview: calc, dirty: true, draft: longer }), source: resolveSource({ calculation: calc.calculation, dirty: true, preview: null }), previewError: Object.assign(new Error('x'), { status: 503, code: 'SCORING_UNAVAILABLE' }) }}
        actions={actions}
      />,
    );
    const t2 = visibleText(failing);
    expect(t2).toContain('Урьдчилсан тооцоо хийгдэх хүртэл хадгалсан тооцоог харуулж байна.');
    expect(t2).toContain('Урьдчилсан тооцоо хийж чадсангүй');
    expect(t2).toContain('Тооцооллын үйлчилгээ түр ажиллахгүй байна. Дахин оролдоно уу.');
    expect(buttonByText(failing, 'Дахин оролдох')).toBeDefined();
  });
});

describe('хуучирсан тооцоолол', () => {
  const stale = makeOverview({ calculation: makeCalculation({ isStale: true, staleReason: 'Зээлийн хүү өөрчлөгдсөн' }) });
  const html = render({ overview: stale });
  const text = visibleText(html);

  it('анхааруулга + шалтгаан + «Дахин тооцоолох»', () => {
    expect(text).toContain('Тооцоолол хуучирсан');
    expect(text).toContain('Шалтгаан: Зээлийн хүү өөрчлөгдсөн');
    expect(buttonByText(html, 'Дахин тооцоолох')).toMatchObject({ disabled: false });
    expect(text).toContain('Хуучирсан');
  });
  it('сонголт хаалттай: тооцоолол хуучирсан', () => {
    expect(radios(html).every((r) => r.disabled)).toBe(true);
    expect(text).toContain('Арга сонгох боломжгүй: тооцоолол хуучирсан. Дахин тооцоолно уу.');
  });
  it('шалтгаангүй бол ерөнхий тайлбар', () => {
    const t3 = visibleText(render({ overview: makeOverview({ calculation: makeCalculation({ isStale: true }) }) }));
    expect(t3).toContain('Хүсэлтийн нөхцөл өөрчлөгдсөн тул дахин тооцоолно уу.');
  });
});

describe('саад (blockers) — нөхцөл дутуу', () => {
  const overview = emptyOverview({ terms: null, limits: null, blockers: [reason('LOAN_TERMS_MISSING')] });
  const html = render({ overview });
  const text = visibleText(html);

  it('анхааруулга + засах линк; тооцоолох товч идэвхгүй, шалтгаантай', () => {
    expect(text).toContain('Тооцоолол хийх боломжгүй');
    expect(text).toContain('Зээлийн нөхцөл (дүн, хугацаа, хүү) бөглөгдөөгүй байна Засах: Зээлийн мэдээлэл');
    expect(hrefs(html)).toContain(loanHref('loan'));
    expect(buttonByText(html, 'Тооцоолох (хадгалах)')?.disabled).toBe(true);
    expect(text).toContain('Эхлээд тооцоолоход саад болж буй зүйлсийг засна уу.');
  });
  it('slider байхгүй, «нөхцөл бөглөгдөөгүй» тайлбар; хоосон төлөв', () => {
    expect(html).not.toContain('role="slider"');
    expect(text).toContain('Зээлийн нөхцөл (дүн, хугацаа, хүү) бөглөгдөөгүй байна.');
    expect(text).toContain('Харуулах тооцоолол алга.');
  });
  it('нөхцөл бий боловч бусад саадтай: slider идэвхгүй', () => {
    const blocked = emptyOverview({ blockers: [{ code: 'NO_INCOME', step: 'income', message: 'x' } satisfies MethodReason] });
    const h = render({ overview: blocked });
    expect(h).toMatch(/ant-slider-disabled/);
    expect(buttonByText(h, 'Тооцоолох (хадгалах)')?.disabled).toBe(true);
  });
});

describe('зөвхөн харах горим (батлагч)', () => {
  const html = render({ overview: makeOverview({ editable: false }) });
  const text = visibleText(html);
  it('тооцоолох, сонгох боломжгүй; тайлбартай', () => {
    expect(text).toContain('Зөвхөн харах горим');
    expect(buttonByText(html, 'Тооцоолох (хадгалах)')?.disabled).toBe(true);
    expect(text).toContain('Энэ хүсэлтийн төлөв эсвэл таны эрхээр тооцоолох боломжгүй.');
    expect(radios(html).every((r) => r.disabled)).toBe(true);
    expect(radios(html).map((r) => r.checked)).toEqual([false, false, true]); // одоогийн сонголт харагдана
    expect(text).toContain('Арга сонгох боломжгүй: зөвхөн харах горим.');
  });
  it('slider (унших эрх) ашиглагдана', () => {
    expect(html).not.toContain('ant-slider-disabled');
  });
});

describe('гараар сонгосон', () => {
  it('«Сонгосон (Гараар)» шошго, толгой дахь шошго', () => {
    const calc = makeCalculation({ selectedMethod: 'A_SALARY', selection: 'MANUAL', selectionReason: 'Цалин найдвартай' });
    const html = render({ overview: makeOverview({ calculation: calc }) });
    expect(visibleText(html)).toContain('Сонгосон: A · Цалин · Гараар');
    expect(visibleText(html)).toContain('Сонгосон (Гараар)');
    expect(radios(html).map((r) => r.checked)).toEqual([true, false, false]);
    expect(count(head(html), '>Автомат<')).toBe(1); // автомат нь C хэвээр
    expect(head(html).indexOf('>Автомат<')).toBeGreaterThan(head(html).indexOf('data-method="C_COMBINED"'));
  });
});

describe('Sosco Score', () => {
  it('оноо, зэрэг, хамрах хувь; мэдэгдэхгүй бүрэлдэхүүн; прогресс', () => {
    const html = render();
    const text = visibleText(html);
    expect(html).toMatch(/data-testid="score-sosco-score">724/);
    expect(html).toContain('data-grade="B"');
    expect(text).toContain('Загвар v3');
    expect(text).toContain('Хамрах хувь 85%');
    expect(text).toContain('Тооцсон: 2026-10-29 14:05');
    expect(text).toContain('ЗМС / FICO оноо 702 73.1% 29.4% 215');
    expect(text).toContain('Өр/орлогын харьцаа (%) 41.3% 62.2% 23.5% 146.3');
    expect(text).toContain('Хугацаа хэтрэлтийн түүх (сар) — мэдэгдэхгүй — —');
    expect(count(html, 'data-unavailable')).toBe(1);
    expect((html.match(/role="progressbar"/g) ?? []).length).toBeGreaterThanOrEqual(5 * 2 + 1);
  });
  it('INSUFFICIENT_DATA: оноо «—», зэрэг байхгүй, тайлбар', () => {
    const html = render({ overview: makeOverview({ sosco: soscoInsufficient() }) });
    const text = visibleText(html);
    expect(html).toMatch(/data-testid="score-sosco-score">—/);
    expect(html).not.toContain('data-grade=');
    expect(text).toContain('Мэдээлэл хангалтгүй: оноо өгөөгүй');
    expect(text).toContain('Мэдэгдэж буй бүрэлдэхүүнүүдийн жин 35% байгаа нь оноо гаргахад хүрэлцэхгүй.');
    expect(text).toContain('Үнэ тогтоолт default шатлалаар явна (FR-5.5).');
  });
  it('зэрэг бүрийн шошго зэрэгтэйгээ', () => {
    for (const grade of ['A', 'C', 'D', 'E'] as const) {
      const html = render({ overview: makeOverview({ sosco: soscoScored({ grade }) }) });
      expect(html).toContain(`data-grade="${grade}"`);
    }
  });
});

describe('алдаа', () => {
  const unavailable = Object.assign(new Error('x'), { status: 503, code: 'SCORING_UNAVAILABLE' });
  it('calculate: SCORING_UNAVAILABLE → дахин оролдох товч', () => {
    const html = render({ calculateError: unavailable });
    expect(visibleText(html)).toContain('Тооцоолж чадсангүй');
    expect(visibleText(html)).toContain('Тооцооллын үйлчилгээ түр ажиллахгүй байна. Дахин оролдоно уу.');
    expect(buttonByText(html, 'Дахин оролдох')).toBeDefined();
  });
  it('calculate: 422 APPLICATION_NOT_EDITABLE → мессеж, дахин оролдох товчгүй', () => {
    const html = render({ calculateError: Object.assign(new Error('x'), { status: 422, code: 'APPLICATION_NOT_EDITABLE' }) });
    expect(visibleText(html)).toContain('Хүсэлтийн одоогийн төлөвт тооцоолох, арга сонгох боломжгүй.');
    expect(buttonByText(html, 'Дахин оролдох')).toBeUndefined();
  });
  it('overview дахин татахад алдаа: хуучин өгөгдөл + анхааруулга + дахин оролдох', () => {
    const html = render({ refreshError: new TypeError('Failed to fetch') });
    expect(visibleText(html)).toContain('Шинэчлэхэд алдаа гарлаа. Өмнөх өгөгдлийг харуулж байна.');
    expect(visibleText(html)).toContain('Сүлжээний алдаа');
    expect(visibleText(html)).toContain('Автомат'); // өгөгдөл хэвээр
    expect(buttonByText(html, 'Дахин оролдох')).toBeDefined();
  });
  it('calculate явж байна: товч loading', () => {
    const html = render({ calculating: true });
    expect(buttons(html).find((b) => b.text === 'Тооцоолох (хадгалах)')).toBeDefined();
    expect(html).toContain('ant-btn-loading');
  });
  it('хязгаараас гарсан утга: оролт улаан, тайлбар, preview явуулахгүй гэсэн анхааруулга', () => {
    const html = render({ previewTerms: { ...TERMS, amount: 100_000 }, dirty: true });
    const text = visibleText(html);
    expect(text).toContain('Бүтээгдэхүүний хязгаараас гарсан: 500,000₮ – 50,000,000₮');
    expect(text).toContain('Хязгаараас гарсан утгад урьдчилсан тооцоо хийхгүй.');
    expect(html).toContain('ant-input-number-status-error');
    expect(html).toContain('aria-invalid="true"');
  });
});

describe('ScoreSkeleton', () => {
  it('ачаалж байна: status role, aria-busy', () => {
    const html = renderToString(<ScoreSkeleton />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('ant-skeleton');
  });
});
