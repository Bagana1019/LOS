import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { tagsWithTestId, textOfTestId, visibleText } from '../collateral/html.fixtures';
import { XypOtpStep } from './XypOtpStep';

// Иргэний зөвшөөрөл: ХУР иргэний БҮРТГЭЛТЭЙ утсанд нэг удаагийн код илгээсний дараах алхам. SSR (jsdom-гүй) — эхний төлөв, disabled/loading, зурвас.
const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const base = { requestedAt: '2026-11-19T10:00:00.000Z', nowMs: T0 + 10_000, errorMessage: null, submitting: false, resending: false, onSubmit: () => undefined, onResend: () => undefined, onManual: () => undefined, onCancel: () => undefined };
const render = (over: Partial<Parameters<typeof XypOtpStep>[0]> = {}) => renderToString(<XypOtpStep {...base} {...over} />);

describe('XypOtpStep', () => {
  it('тайлбар: кодыг иргэний ХУР-д бүртгэлтэй утсанд илгээсэн; ажилтан утас сонгохгүй', () => {
    const text = visibleText(render());
    expect(text).toContain('нэг удаагийн код');
    expect(text).toContain('бүртгэлтэй утсанд');
    expect(text).toContain('Иргэнээс кодыг асууж');
  });

  it('кодын талбар: тоон гар, SMS-ээс автоматаар бөглөх, 8 оронгоос ихгүй; эхэндээ хоосон тул баталгаажуулах товч идэвхгүй', () => {
    const [input] = tagsWithTestId(render(), 'xyp-otp-input');
    // React SSR атрибутын нэрийг camelCase-ээр гаргадаг (inputMode); HTML-д том/жижиг үсэг ялгаагүй тул регистр үл хамаарна.
    expect(input).toMatch(/inputmode="numeric"/i);
    expect(input).toMatch(/autocomplete="one-time-code"/i);
    expect(input).toMatch(/maxlength="8"/i);
    expect(tagsWithTestId(render(), 'xyp-otp-submit')[0]).toContain('disabled');
  });

  it('дахин авах: илгээснээс хойш 60 секунд хүртэл идэвхгүй, үлдсэн секундыг харуулна; дараа нь идэвхтэй', () => {
    const early = render({ nowMs: T0 + 10_000 });
    expect(tagsWithTestId(early, 'xyp-otp-resend')[0]).toContain('disabled');
    expect(textOfTestId(early, 'xyp-otp-resend')).toContain('50');
    const late = render({ nowMs: T0 + 61_000 });
    expect(tagsWithTestId(late, 'xyp-otp-resend')[0]).not.toContain('disabled');
    expect(textOfTestId(late, 'xyp-otp-resend')).toBe('Код дахин авах');
  });

  it('алдааны зурвас (сервер: код буруу / хэт олон оролдлого) харагдана; байхгүй үед хоосон', () => {
    expect(textOfTestId(render({ errorMessage: 'Иргэний код буруу. Шинэ код авна уу' }), 'xyp-otp-error')).toContain('Иргэний код буруу');
    expect(tagsWithTestId(render(), 'xyp-otp-error')).toHaveLength(0);
  });

  it('татаж байх / дахин илгээж байх үед товч loading', () => {
    expect(tagsWithTestId(render({ submitting: true }), 'xyp-otp-submit')[0]).toContain('ant-btn-loading');
    expect(tagsWithTestId(render({ resending: true, nowMs: T0 + 90_000 }), 'xyp-otp-resend')[0]).toContain('ant-btn-loading');
  });

  it('гараар бөглөх, өөр регистр (цуцлах) гарцууд үргэлж байна — ХУР код ирэхгүй байсан ч ажил зогсохгүй', () => {
    const html = render();
    expect(tagsWithTestId(html, 'xyp-otp-manual')).toHaveLength(1);
    expect(tagsWithTestId(html, 'xyp-otp-cancel')).toHaveLength(1);
    expect(tagsWithTestId(html, 'xyp-otp-manual')[0]).not.toContain('disabled');
  });
});
