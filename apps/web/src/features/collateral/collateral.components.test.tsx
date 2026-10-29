import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GateIssueCode } from '@los/contracts';
import { CollateralCard } from './CollateralCard';
import { CollateralSummaryBar } from './CollateralSummaryBar';
import { GateIssueList } from './GateIssueList';
import { StatusTag } from './StatusTag';
import { IDS, makeApartment, makeCollateral, makeEncumbrance, makeGate, makeIssue, makeOwnership, makeSummary, makeValuation } from './collateral.fixtures';
import { countOf, tagsWithTestId, textOfTestId, visibleText } from './html.fixtures';

describe('CollateralSummaryBar', () => {
  const render = (summary = makeSummary(), gate = makeGate()) => renderToString(<CollateralSummaryBar summary={summary} gate={gate} />);

  it('дүн, LTV, хязгаар, барьцаа шаардах эсэх (API-ийн тоогоор, UI тооцоолохгүй)', () => {
    const html = render(makeSummary({ count: 1, totalMarketValue: 20_000_000, totalCollateralValue: 14_000_000, loanAmount: 10_000_000, ltv: 0.7143, ltvPass: false }));
    expect(textOfTestId(html, 'summary-market-value')).toContain('20,000,000₮');
    expect(textOfTestId(html, 'summary-collateral-value')).toContain('14,000,000₮');
    expect(textOfTestId(html, 'summary-loan-amount')).toContain('10,000,000₮');
    expect(textOfTestId(html, 'summary-ltv')).toContain('71.43%');
    expect(textOfTestId(html, 'summary-ltv')).toContain('Дээд хязгаар 70%');
    const text = visibleText(html);
    expect(text).toContain('LTV хязгаараас хэтэрсэн');
    expect(text).toContain('Барьцаа шаардлагатай');
  });

  it('LTV хязгаарт багтсан бол «багтсан» шошго; тооцох боломжгүй бол шошго үгүй', () => {
    expect(visibleText(render(makeSummary({ ltv: 0.5, ltvPass: true })))).toContain('LTV хязгаарт багтсан');
    const unknown = visibleText(render(makeSummary({ ltv: null, ltvPass: null, loanAmount: null })));
    expect(unknown).not.toContain('LTV хязгаар');
    expect(unknown).toContain('Зээлийн дүнг «Зээл» алхамд оруулна');
    expect(textOfTestId(render(makeSummary({ ltv: null, loanAmount: null })), 'summary-ltv')).toContain('—');
  });

  it('G0 төлөв: role=status шошго, текстээр', () => {
    const incomplete = render(makeSummary(), makeGate({ issues: [makeIssue('NO_COLLATERAL'), makeIssue('LTV_EXCEEDED')] }));
    expect(tagsWithTestId(incomplete, 'gate-status')[0]).toContain('role="status"');
    expect(textOfTestId(incomplete, 'gate-status')).toBe('G0 дутуу (2)');
    expect(textOfTestId(render(makeSummary(), makeGate({ complete: true })), 'gate-status')).toBe('G0 хангагдсан');
    expect(textOfTestId(render(makeSummary({ requiresCollateral: false }), makeGate({ complete: true, skipped: true })), 'gate-status')).toBe('G0 алгасагдсан');
  });

  it('барьцаа шаардахгүй бүтээгдэхүүн', () => {
    const text = visibleText(render(makeSummary({ requiresCollateral: false })));
    expect(text).toContain('Барьцаа шаардахгүй');
    expect(text).toContain('Барьцаагүй зээл боловч нэмсэн барьцаа бүр шалгагдана.');
  });
});

describe('GateIssueList', () => {
  const items = [makeCollateral(), makeApartment()];
  const render = (issues = [] as ReturnType<typeof makeIssue>[], gate = makeGate({ issues }), canAdd = true) =>
    renderToString(<GateIssueList applicationId={IDS.app} gate={gate} collaterals={items} canAdd={canAdd} onOpen={() => undefined} onAdd={() => undefined} />);

  it('дутагдалгүй бол амжилтын мэдэгдэл', () => {
    expect(visibleText(render([], makeGate({ complete: true })))).toBe('G0 хаалт хангагдсан: барьцааны бүх шалгуур биелсэн.');
    expect(visibleText(render([], makeGate({ complete: true, skipped: true })))).toContain('G0 хаалт алгасагдсан');
  });

  it('дутагдал бүр: i18n гарчиг, зөвлөмж, API мессеж, код, түвшин', () => {
    const html = render([makeIssue('OWNERSHIP_NOT_CHECKED', IDS.vehicle, 'Өмчлөлийг шалгаагүй байна (Toyota)'), makeIssue('LTV_EXCEEDED', null, 'LTV 82% > 70%')]);
    expect(countOf(html, 'data-testid="gate-issue"')).toBe(2);
    expect(html).toContain('data-code="LTV_EXCEEDED"');
    expect(html).toContain('data-code="OWNERSHIP_NOT_CHECKED"');
    const text = visibleText(html);
    expect(text).toContain('G0 хаалтыг хангаагүй шалтгаан: 2');
    expect(text).toContain('LTV дээд хязгаараас хэтэрсэн');
    expect(text).toContain('LTV 82% > 70%'); // API-ийн тодорхой мессеж
    expect(text).toContain('Өмчлөлийг шалгаагүй');
    expect(text).toContain('Барьцааны «Шалгалт» хэсгээс өмчлөлийг шалгана уу.');
    expect(text).toContain('Асуудалтай'); // LTV_EXCEEDED = error
    expect(text).toContain('Дутуу'); // OWNERSHIP_NOT_CHECKED = warning
  });

  it('хүсэлтийн түвшний дутагдал эхэнд; барьцааг нэрээр нь заана', () => {
    const html = render([makeIssue('NOT_VALUED', IDS.apartment), makeIssue('LTV_EXCEEDED', null)]);
    const codes = [...html.matchAll(/data-code="([A-Z_]+)"/g)].map((m) => m[1]);
    expect(codes).toEqual(['LTV_EXCEEDED', 'NOT_VALUED']);
    expect(visibleText(html)).toContain('Орон сууц: Хан-Уул, 11-р хороо, 15-р байр 43 тоот · 56.5 м² · 4-р давхар');
  });

  it('үйлдлийн зорилт: табыг нээх, алхам руу очих холбоос, барьцаа нэмэх', () => {
    const html = render([makeIssue('NOT_VALUED', IDS.vehicle), makeIssue('LOAN_AMOUNT_MISSING'), makeIssue('OWNER_NOT_ON_APPLICATION', IDS.vehicle), makeIssue('NO_COLLATERAL')]);
    expect(html).toContain(`href="/los/loan-application/${IDS.app}/loan"`);
    expect(html).toContain(`href="/los/loan-application/${IDS.app}/client"`);
    const text = visibleText(html);
    expect(text).toContain('«Зээл» алхам руу очих');
    expect(text).toContain('«Харилцагч» алхам руу очих');
    expect(text).toContain('Барьцаа нэмэх');
    expect(html).toMatch(/aria-label="Нээх: Барьцааг үнэлээгүй байна"/);
  });

  it('барьцаа нэмэх товч эрхгүй үед идэвхгүй', () => {
    const html = render([makeIssue('NO_COLLATERAL')], undefined, false);
    const add = /<button[^>]*>\s*<span>Барьцаа нэмэх<\/span>/.exec(html)?.[0] ?? '';
    expect(add).toContain('disabled=""');
  });

  it.each(GateIssueCode.map((c) => [c]))('%s: код бүр гарчигтай (түлхүүр өөрөө гарахгүй)', (code) => {
    const text = visibleText(render([makeIssue(code, IDS.vehicle)]));
    expect(text).not.toContain('collateral.issue.');
    expect(text).not.toContain('collateral.gate.');
  });

  it('үл мэдэгдэх шинэ код: API-ийн мессеж гарчиг болно', () => {
    const text = visibleText(render([{ code: 'BRAND_NEW' as never, collateralId: null, message: 'Шинэ дүрэм зөрчигдсөн' }]));
    expect(text).toContain('Шинэ дүрэм зөрчигдсөн');
  });
});

describe('CollateralCard', () => {
  const render = (item = makeCollateral(), props: Partial<Parameters<typeof CollateralCard>[0]> = {}) =>
    renderToString(<CollateralCard item={item} warnings={[]} canRemove removeBlockedReason={null} removing={false} onOpen={() => undefined} onRemove={() => undefined} {...props} />);

  it('төрөл, нэг мөр тодорхойлолт, өмчлөгч, шалгаагүй төлвүүд', () => {
    const html = render();
    const text = visibleText(html);
    expect(text).toContain('Тээврийн хэрэгсэл');
    expect(text).toContain('Toyota Prius · 2012 он · 1234УБА');
    expect(text).toContain('Өмчлөгч: Бат Болд (Үндсэн зээлдэгч)');
    expect(text).toContain('Өмчлөл: Шалгаагүй');
    expect(text).toContain('Ачаалал: Шалгаагүй');
    expect(text).toContain('Үнэлгээ: Үнэлээгүй');
    expect(text).toContain('Баримт: 0 / 1'); // заавал баримт 1 (даатгал заавал биш)
  });

  it('шалгасан, үнэлсэн: төлөв текстээр, үнэ API-ийнхаар', () => {
    const item = makeCollateral({ ownership: makeOwnership(), encumbrance: makeEncumbrance(), valuation: makeValuation() });
    const tags = textOfTestId(render(item), 'collateral-tags') ?? '';
    expect(tags).toContain('Өмчлөл: Баталгаажсан');
    expect(tags).toContain('Ачаалал: Ачаалалгүй');
    expect(tags).toContain('Үнэлгээ: Үнэлэгдсэн');
    const text = visibleText(render(item));
    expect(text).toContain('20,000,000₮');
    expect(text).toContain('70%');
    expect(text).toContain('14,000,000₮');
  });

  it('ачаалалтай, хугацаа дууссан: алдааны төлөв', () => {
    const item = makeCollateral({ encumbrance: makeEncumbrance({ status: 'ENCUMBERED' }), valuation: makeValuation({ expired: true }) });
    const tags = textOfTestId(render(item), 'collateral-tags') ?? '';
    expect(tags).toContain('Ачаалал: Ачаалалтай');
    expect(tags).toContain('Үнэлгээ: Хугацаа дууссан');
  });

  it('ХУР-аас, чөлөөлсөн шошго; чөлөөлсөн бол устгах товчгүй', () => {
    const html = render(makeCollateral({ source: 'XYP', releasedAt: '2026-10-29T03:00:00.000Z' }));
    const text = visibleText(html);
    expect(text).toContain('ХУР-аас');
    expect(text).toContain('Чөлөөлсөн');
    expect(text).not.toContain('Устгах');
  });

  it('анхааруулга шошго (тухайн барьцааных л)', () => {
    const html = render(makeCollateral(), { warnings: [{ code: 'INSURANCE_EXPIRING', collateralId: IDS.vehicle, message: 'Даатгал 10 хоногийн дараа дуусна' }, { code: 'REVALUATION_DUE', collateralId: 'other', message: 'x' }] });
    const text = visibleText(html);
    expect(text).toContain('Даатгал дуусч байна');
    expect(text).not.toContain('Дахин үнэлэх хугацаа');
  });

  it('устгах: зөвшөөрөлгүй бол идэвхгүй, нээх товч нэртэй', () => {
    const html = render(makeCollateral(), { canRemove: false, removeBlockedReason: 'Хүсэлт засах боломжгүй' });
    const remove = /<button[^>]*aria-label="Устгах: Toyota Prius[^>]*>/.exec(html)?.[0] ?? '';
    expect(remove).toContain('disabled=""');
    expect(html).toContain('aria-label="Дэлгэрэнгүй: Toyota Prius · 2012 он · 1234УБА"');
  });

  it('барьцааны тодорхойлолт хоосон үед хөрөнгийн төрлийн нэр', () => {
    expect(visibleText(render(makeCollateral({ description: {} })))).toContain('Тээврийн хэрэгсэл');
  });
});

describe('StatusTag', () => {
  it('шошго + текст (өнгө ганцаараа утга илэрхийлэхгүй)', () => {
    expect(visibleText(renderToString(<StatusTag tone="success" label="Өмчлөл" textKey="collateral.status.ownership.VERIFIED" />))).toBe('Өмчлөл: Баталгаажсан');
    expect(visibleText(renderToString(<StatusTag tone="default" textKey="collateral.status.released" />))).toBe('Чөлөөлсөн');
  });
});
