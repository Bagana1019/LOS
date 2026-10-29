import type { ComponentProps } from 'react';
import { renderToString } from 'react-dom/server';
import { SigningFailureReason } from '@los/contracts';
import { describe, expect, it, vi } from 'vitest';
import { API } from '../../lib/api';
import { EsignApiError } from './api';
import type { FlowStep } from './flow';
import { SigningView, type SigningViewActions, type SigningViewModel } from './SigningView';
import { buttonByText, buttons, visibleText } from './testing/html';
import { NOW_MS, sessionFixture, signedSession, TOKEN, waitingSession } from './testing/fixtures';

const actions: SigningViewActions = {
  onFrameLoad: vi.fn(),
  onOpenFull: vi.fn(),
  onContinue: vi.fn(),
  onStart: vi.fn(),
  onDecline: vi.fn(),
  onRetry: vi.fn(),
  onCountdownElapsed: vi.fn(),
};

function model(step: FlowStep | null, overrides: Partial<SigningViewModel> = {}): SigningViewModel {
  return {
    token: TOKEN,
    session: null,
    step,
    loadError: null,
    connectionLost: false,
    starting: false,
    startError: null,
    declining: false,
    declineError: null,
    initialNowMs: NOW_MS,
    ...overrides,
  };
}

function render(props: SigningViewModel): string {
  return renderToString(<SigningView model={props} actions={actions} />);
}

const DOCUMENT_URL = `${API}/public/esign/${TOKEN}/document`;
const SIGNED_URL = `${API}/public/esign/${TOKEN}/signed-document`;

/** Токен зөвхөн PDF-ийн хоёр URL-д (iframe src, татах холбоос) байж болно; бусад газар (текст, aria, title) хэзээ ч. */
function expectTokenOnlyInDocumentUrls(html: string): void {
  const stripped = html.replaceAll(DOCUMENT_URL, '<document-url>').replaceAll(SIGNED_URL, '<signed-url>');
  expect(stripped).not.toContain(TOKEN);
}

describe('ачаалж байна / алдаа / олдсонгүй', () => {
  it('session ирээгүй үед ачаалж байна', () => {
    const html = render(model(null));
    expect(visibleText(html)).toContain('Ачаалж байна…');
    expect(visibleText(html)).toContain('Цахим гарын үсэг');
  });

  it.each([
    ['NETWORK', 'Сүлжээний холболт алдаатай байна'],
    ['SERVER', 'Үйлчилгээ түр хугацаанд боломжгүй байна'],
    ['RATE_LIMITED', 'Хэт олон хүсэлт илгээлээ'],
    ['INVALID_RESPONSE', 'Серверээс буруу хариу ирлээ'],
  ] as const)('түр алдаа %s → монгол тайлбар + "Дахин оролдох"', (kind, expected) => {
    const html = render(model(null, { loadError: new EsignApiError(kind) }));
    expect(visibleText(html)).toContain(expected);
    expect(buttonByText(html, 'Дахин оролдох')).toBeDefined();
  });

  it('404 → "Холбоос олдсонгүй", дахин оролдох товчгүй', () => {
    const html = render(model({ step: 'notFound' }));
    expect(visibleText(html)).toContain('Холбоос олдсонгүй');
    expect(buttonByText(html, 'Дахин оролдох')).toBeUndefined();
  });
});

describe('review алхам', () => {
  it('гэрээний дугаар, далдалсан нэр, PDF iframe, "Гэрээг бүтнээр нээх" шинэ tab-д; үзээгүй бол "Үргэлжлүүлэх" идэвхгүй', () => {
    const html = render(model({ step: 'review' }, { session: sessionFixture({ documentViewed: false }) }));
    const text = visibleText(html);
    expect(text).toContain('ГЭР-2026-000123');
    expect(text).toContain('Б. Болд');
    expect(text).toContain('Гэрээгээ уншина уу');
    expect(html).toContain(`<iframe src="${DOCUMENT_URL}"`);
    expect(html).toContain('referrerPolicy="no-referrer"');
    const open = buttonByText(html, 'Гэрээг бүтнээр нээх');
    expect(open?.href).toBe(DOCUMENT_URL);
    expect(html).toMatch(/<a[^>]*href="[^"]*\/document"[^>]*target="_blank"[^>]*rel="noopener noreferrer"|<a[^>]*rel="noopener noreferrer"[^>]*target="_blank"/);
    expect(buttonByText(html, 'Үргэлжлүүлэх')?.disabled).toBe(true);
    expect(text).toContain('Үргэлжлүүлэхийн тулд гэрээг нээж үзсэн байх шаардлагатай');
    expectTokenOnlyInDocumentUrls(html);
  });

  it('documentViewed болсны дараа "Үргэлжлүүлэх" идэвхжинэ', () => {
    const html = render(model({ step: 'review' }, { session: sessionFixture({ documentViewed: true }) }));
    expect(buttonByText(html, 'Үргэлжлүүлэх')?.disabled).toBe(false);
    expect(visibleText(html)).toContain('Гэрээг үзсэн нь бүртгэгдлээ');
  });

  it('алхамын заагч: Унших → Сонгох → Батлах', () => {
    const text = visibleText(render(model({ step: 'review' }, { session: sessionFixture() })));
    expect(text).toMatch(/1\. Унших.*2\. Сонгох.*3\. Батлах/);
  });

  it('алхамын заагч: идэвхтэй алхамд aria-current', () => {
    const current = (step: FlowStep, session = sessionFixture({ documentViewed: true })) =>
      [...render(model(step, { session })).matchAll(/<li[^>]*aria-current="step"[^>]*>[\s\S]*?<\/li>/g)].map((m) => visibleText(m[0]));
    expect(current({ step: 'review' })).toEqual(['1. Унших']);
    expect(current({ step: 'choose', retryReason: null })).toEqual(['2. Сонгох']);
    expect(current({ step: 'waiting', phase: 'approve' }, waitingSession())).toEqual(['3. Батлах']);
    expect(current({ step: 'signed' }, signedSession())).toEqual([]);
  });
});

describe('choose алхам', () => {
  const choose = (overrides: Partial<ComponentProps<typeof SigningView>['model']> = {}, retryReason: (typeof SigningFailureReason)[number] | null = null) =>
    render(model({ step: 'choose', retryReason }, { session: sessionFixture({ documentViewed: true }), ...overrides }));

  it('хууль зүйн хүчинтэй гэдгийг заасан зөвшөөрөл, Tridum/Monpass карт, mock-д "ТЕСТ" тэмдэг', () => {
    const html = choose();
    const text = visibleText(html);
    expect(text).toContain('хууль зүйн хүчинтэй');
    expect(text).toContain('гэрээг бүрэн уншиж танилцсан');
    expect(text).toContain('Tridum');
    expect(text).toContain('Monpass');
    // ТЕСТ тэмдэг зөвхөн mock провайдерт (Tridum)
    expect(html.match(/ТЕСТ/g)).toHaveLength(1);
    expect(html).toMatch(/Tridum[\s\S]*ТЕСТ/);
    expect(html.indexOf('ТЕСТ')).toBeLessThan(html.indexOf('Monpass'));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('type="checkbox"');
  });

  it('зөвшөөрөл/үйлчилгээ сонгоогүй үед "Гарын үсэг зурах" идэвхгүй, тайлбар харагдана', () => {
    const html = choose();
    expect(buttonByText(html, 'Гарын үсэг зурах')?.disabled).toBe(true);
    expect(visibleText(html)).toContain('Үргэлжлүүлэхийн тулд дээрх зөвшөөрлийг тэмдэглэнэ үү');
  });

  it('нэг л үйлчилгээтэй бол урьдчилан сонгогдоно', () => {
    const html = choose({ session: sessionFixture({ documentViewed: true, providers: [{ code: 'MONPASS', displayName: 'Monpass', mock: false }] }) });
    expect(html).toContain('aria-checked="true"');
  });

  it('үйлчилгээ байхгүй бол тайлбар', () => {
    expect(visibleText(choose({ session: sessionFixture({ documentViewed: true, providers: [] }) }))).toContain('Одоогоор гарын үсгийн үйлчилгээ боломжгүй байна');
  });

  it('өмнөх оролдлого амжилтгүй болсон бол шалтгаан, дахин оролдох заавар', () => {
    const text = visibleText(choose({}, 'PROVIDER_ERROR'));
    expect(text).toContain('Өмнөх оролдлого амжилтгүй боллоо');
    expect(text).toContain('Гарын үсгийн үйлчилгээнд алдаа гарлаа');
    expect(text).toContain('Холбоос хүчинтэй хэвээр байна');
  });

  it('start-ийн алдааг монголоор харуулна', () => {
    expect(visibleText(choose({ startError: new EsignApiError('RATE_LIMITED') }))).toContain('Хэт олон хүсэлт илгээлээ');
    expect(visibleText(choose({ startError: new EsignApiError('CONFLICT') }))).toContain('Хүсэлтийн төлөв өөрчлөгдсөн байна');
  });
});

describe('waiting алхам', () => {
  const waiting = (session = waitingSession(), overrides: Partial<SigningViewModel> = {}) => render(model({ step: 'waiting', phase: 'approve' }, { session, ...overrides }));

  it('том код, deep link, тоолуур, "Болих"', () => {
    const html = waiting();
    const text = visibleText(html);
    expect(text).toContain('Утсан дээрх код ийм байх ёстой');
    expect(text).toContain('4821');
    expect(text).toContain('Үлдсэн хугацаа: 04:30');
    expect(buttonByText(html, 'Апп-аа нээх')?.href).toBe('mock-tridum://sign/TRD-MOCK-1');
    expect(buttonByText(html, 'Болих')).toBeDefined();
    expect(text).toContain('Таны баталгаажуулалтыг хүлээж байна');
    expectTokenOnlyInDocumentUrls(html);
  });

  it('аюултай deep link (javascript:, data:, үл мэдэгдэх scheme) товч болж гарахгүй', () => {
    for (const deepLink of ['javascript:alert(document.cookie)', 'data:text/html,<script>1</script>', 'evil-app://x', 'https://user:pw@evil.example']) {
      const html = waiting(waitingSession({ deepLink }));
      expect(buttonByText(html, 'Апп-аа нээх'), deepLink).toBeUndefined();
      expect(html.toLowerCase()).not.toContain('javascript:');
      expect(html).not.toContain('evil');
      expect(visibleText(html)).toContain('аппаа нээж, гарын үсгийн хүсэлтийг зөвшөөрнө үү');
    }
  });

  it('deep link байхгүй бол зөвхөн заавар', () => {
    const html = waiting(waitingSession({ deepLink: null }));
    expect(buttonByText(html, 'Апп-аа нээх')).toBeUndefined();
    expect(visibleText(html)).toContain('Tridum аппаа нээж');
  });

  it('код хараахан ирээгүй үед "холбогдож байна"', () => {
    const text = visibleText(waiting(waitingSession({ challengeCode: null, deepLink: null })));
    expect(text).toContain('Гарын үсгийн үйлчилгээтэй холбогдож байна');
    expect(text).not.toContain('Утсан дээрх код ийм байх ёстой');
  });

  it('mock провайдерт ТЕСТ анхааруулга', () => {
    expect(visibleText(waiting())).toContain('ТЕСТ ГОРИМ');
    expect(visibleText(waiting(waitingSession({ provider: 'MONPASS' })))).not.toContain('ТЕСТ ГОРИМ');
  });

  it('хугацаа дууссан / сүлжээ тасарсан / татгалзах алдаа', () => {
    expect(visibleText(waiting(waitingSession({ sessionExpiresAt: '2026-10-28T05:59:00.000Z' })))).toContain('Хугацаа дууссан');
    expect(visibleText(waiting(waitingSession(), { connectionLost: true }))).toContain('Сүлжээний холболт тасарлаа');
    expect(visibleText(waiting(waitingSession(), { declineError: new EsignApiError('SERVER') }))).toContain('Үйлчилгээ түр хугацаанд боломжгүй байна');
  });

  it('finalizing үед "Болих" байхгүй, баталгаажуулж байна гэж харуулна', () => {
    const html = render(model({ step: 'waiting', phase: 'finalizing' }, { session: waitingSession({ status: 'FINALIZING' }) }));
    expect(visibleText(html)).toContain('Гэрээг баталгаажуулж байна');
    expect(buttonByText(html, 'Болих')).toBeUndefined();
    expect(buttons(html).map((b) => b.text)).not.toContain('Апп-аа нээх');
  });
});

describe('signed алхам', () => {
  it('амжилт, XXXX-XXXX-XXXX код, татах холбоос, /verify холбоос, UB цаг', () => {
    const html = render(model({ step: 'signed' }, { session: signedSession() }));
    const text = visibleText(html);
    expect(text).toContain('Гэрээнд амжилттай гарын үсэг зурлаа');
    expect(text).toContain('7K3M-9QZ4-T8VX');
    expect(text).toContain('2026-10-28 14:05:09');
    expect(buttonByText(html, 'Гарын үсэгтэй гэрээг татах')?.href).toBe(SIGNED_URL);
    expect(buttonByText(html, 'Гарын үсгийг баталгаажуулах')?.href).toBe('/verify/7K3M9QZ4T8VX');
    expectTokenOnlyInDocumentUrls(html);
  });

  it('гарын үсэгтэй PDF бэлэн биш бол татах холбоос гарахгүй', () => {
    const html = render(model({ step: 'signed' }, { session: signedSession({ signedDocumentAvailable: false }) }));
    expect(buttonByText(html, 'Гарын үсэгтэй гэрээг татах')).toBeUndefined();
    expect(visibleText(html)).toContain('Гарын үсэгтэй гэрээ бэлтгэгдэж байна');
  });

  it('гарын үсэгтэй хувийг татах сүүлийн хугацааг харуулна; хугацаа дууссан бол "салбараас авна уу"', () => {
    const live = visibleText(render(model({ step: 'signed' }, { session: signedSession() })));
    expect(live).toContain('2026-11-27 14:05:09 хүртэл');
    const gone = visibleText(render(model({ step: 'signed' }, { session: signedSession({ signedDocumentAvailable: false, signedCopyExpiresAt: '2026-10-28T00:00:00.000Z' }) })));
    expect(gone).toContain('Холбоосоор татах хугацаа дууссан');
    expect(gone).not.toContain('бэлтгэгдэж байна');
  });

  it('mock provider-оор зурсан бол ТЕСТ ГОРИМ анхааруулга гарна, жинхэнэ бол гарахгүй', () => {
    expect(visibleText(render(model({ step: 'signed' }, { session: signedSession({ providerMock: true }) })))).toContain('ТЕСТ ГОРИМ');
    expect(visibleText(render(model({ step: 'signed' }, { session: signedSession() })))).not.toContain('ТЕСТ ГОРИМ');
  });

  it('баталгаажуулах код байхгүй бол /verify холбоос гаргахгүй', () => {
    const html = render(model({ step: 'signed' }, { session: signedSession({ verificationCode: null }) }));
    expect(buttonByText(html, 'Гарын үсгийг баталгаажуулах')).toBeUndefined();
  });
});

describe('төгсгөлийн төлвүүд', () => {
  it.each([
    [{ step: 'declined' }, 'Та гарын үсэг зурахаас татгалзсан'],
    [{ step: 'expired' }, 'Холбоосын хугацаа дууссан'],
    [{ step: 'cancelled' }, 'Хүсэлт цуцлагдсан'],
  ] as const)('%j', (step, expected) => {
    const html = render(model(step, { session: sessionFixture({ status: 'DECLINED', documentViewed: true }) }));
    expect(visibleText(html)).toContain(expected);
    expect(visibleText(html)).toMatch(/салбартай холбогдож|салбартай холбогдоно/);
    // Төгсгөлийн төлөвт гарын үсэг зурах/дахин оролдох үйлдэл байхгүй
    expect(buttons(html).filter((b) => b.text !== '')).toEqual([]);
  });

  it('IDENTITY_MISMATCH-ийн нарийн текст', () => {
    const html = render(model({ step: 'failed', reason: 'IDENTITY_MISMATCH' }, { session: sessionFixture({ status: 'FAILED' }) }));
    expect(visibleText(html)).toContain('Таны регистр гарын үсгийн гэрчилгээтэй таарсангүй, салбартай холбогдоно уу');
  });

  it.each([
    ['DECLINED', 'татгалзсан'],
    ['EXPIRED', 'хугацаа дууссан'],
    ['INTEGRITY_ERROR', 'бүрэн бүтэн байдал алдагдсан'],
    ['PROVIDER_ERROR', 'Гарын үсгийн үйлчилгээнд алдаа гарлаа'],
    ['CANCELLED', 'цуцлагдсан'],
    [null, 'тодорхойгүй алдаа'],
  ] as const)('FAILED (%s) → монгол тайлбар', (reason, expected) => {
    const html = render(model({ step: 'failed', reason }, { session: sessionFixture({ status: 'FAILED' }) }));
    expect(visibleText(html)).toContain(expected);
    expect(visibleText(html)).toContain('Гарын үсэг зурах боломжгүй боллоо');
  });
});

describe('нийтлэг шаардлага', () => {
  const cases: Array<[string, SigningViewModel]> = [
    ['loading', model(null)],
    ['review', model({ step: 'review' }, { session: sessionFixture() })],
    ['choose', model({ step: 'choose', retryReason: 'EXPIRED' }, { session: sessionFixture({ documentViewed: true }) })],
    ['waiting', model({ step: 'waiting', phase: 'approve' }, { session: waitingSession() })],
    ['finalizing', model({ step: 'waiting', phase: 'finalizing' }, { session: waitingSession({ status: 'FINALIZING' }) })],
    ['signed', model({ step: 'signed' }, { session: signedSession() })],
    ['failed', model({ step: 'failed', reason: 'IDENTITY_MISMATCH' }, { session: sessionFixture({ status: 'FAILED' }) })],
    ['notFound', model({ step: 'notFound' })],
  ];

  it.each(cases)('%s: токен зөвхөн PDF URL-д, placeholder/undefined/NaN үлдэхгүй, аюултай URL байхгүй', (_name, m) => {
    const html = render(m);
    expectTokenOnlyInDocumentUrls(html);
    const text = visibleText(html);
    expect(text).not.toMatch(/\{\w+\}/);
    expect(text).not.toMatch(/undefined|NaN|\[object/);
    expect(html.toLowerCase()).not.toContain('javascript:');
    // Мөр бүр монгол кирилл (загварын шаардлага)
    expect(text).toMatch(/[А-Яа-яӨөҮүЁё]/);
    // Гарчигт токен орохгүй (SSR title)
    expect(html).not.toMatch(/<title>[^<]*Zx7Qm2/);
  });
});
