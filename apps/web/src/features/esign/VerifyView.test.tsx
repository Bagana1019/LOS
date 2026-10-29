import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VerifyNotFound, VerifyView } from './VerifyView';
import { visibleText } from './testing/html';
import { verificationFixture } from './testing/fixtures';

const render = (overrides: Parameters<typeof verificationFixture>[0] = {}) => renderToString(<VerifyView verification={verificationFixture(overrides)} />);

describe('VerifyView', () => {
  it('хүчинтэй: амжилтын тэмдэг + бүх талбар (гэрээ, далдалсан нэр, үйлчилгээ, UB цаг, гэрчилгээ, хоёр SHA-256)', () => {
    const html = render();
    const text = visibleText(html);
    expect(html).toContain('ant-alert-success');
    expect(text).toContain('Хүчинтэй гарын үсэг');
    expect(text).toContain('ГЭР-2026-000123');
    expect(text).toContain('Б. Болд');
    expect(text).toContain('Monpass');
    expect(text).toContain('2026-10-28 14:05:09 (Улаанбаатар, UTC+8)');
    expect(text).toContain('Monpass CA');
    expect(text).toContain('0A1B2C3D4E5F');
    expect(text).toContain('a'.repeat(64));
    expect(text).toContain('b'.repeat(64));
    expect(text).toContain('Анхны гэрээний SHA-256');
    expect(text).toContain('Гарын үсэгтэй файлын SHA-256');
    expect(text).not.toContain('ТЕСТ ХҮЧИНГҮЙ');
  });

  it('хэшийг хэрхэн тулгахыг заана (Windows, macOS/Linux)', () => {
    const text = visibleText(render());
    expect(text).toContain('Татаж авсан гэрээгээ хэрхэн шалгах вэ');
    expect(text).toContain('certutil -hashfile contract.pdf SHA256');
    expect(text).toContain('shasum -a 256 contract.pdf');
  });

  it('TRIDUM үйлчилгээ', () => {
    expect(visibleText(render({ provider: 'TRIDUM' }))).toContain('Tridum');
  });

  it('mock: "ТЕСТ ХҮЧИНГҮЙ" анхааруулга, ногоон (амжилтын) тэмдэггүй', () => {
    const html = render({ mock: true, certificateIssuer: 'LOS MOCK CA (ТЕСТ)' });
    expect(visibleText(html)).toContain('ТЕСТ ХҮЧИНГҮЙ');
    expect(visibleText(html)).toContain('туршилтын горимд үүссэн');
    expect(html).toContain('ant-alert-warning');
    expect(html).not.toContain('ant-alert-success');
  });

  it('хүчингүй: алдааны тэмдэг; mock бол хоёр анхааруулга', () => {
    const invalid = render({ valid: false });
    expect(invalid).toContain('ant-alert-error');
    expect(invalid).not.toContain('ant-alert-success');
    expect(visibleText(invalid)).toContain('Хүчингүй');
    const both = render({ valid: false, mock: true });
    expect(both).toContain('ant-alert-error');
    expect(both).toContain('ant-alert-warning');
    expect(visibleText(both)).toContain('ТЕСТ ХҮЧИНГҮЙ');
  });

  it('урт хэшийг таслана (гар утсанд хэвтээ гүйлгэлт үүсгэхгүй)', () => {
    expect(render()).toContain('word-break:break-all');
  });
});

describe('VerifyNotFound', () => {
  it('404 → "Баталгаажуулах код олдсонгүй"', () => {
    const text = visibleText(renderToString(<VerifyNotFound />));
    expect(text).toContain('Баталгаажуулах код олдсонгүй');
    expect(text).toContain('Гарын үсгийн баталгаажуулалт');
  });
});
