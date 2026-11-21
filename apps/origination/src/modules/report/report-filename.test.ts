import { describe, expect, it } from 'vitest';
import { contentDisposition, exportAsciiName, exportDisplayName } from './report-filename';

// F11-4(b): татах файлын нэр монгол тайлангийн нэртэй (RFC 5987 `filename*`), ASCII `filename` нь хуучин клиентийн нөөц.
const TITLE = 'Зээлийн үлдэгдлийн дэлгэрэнгүй';

describe('exportAsciiName', () => {
  it('LOS_<key>_<asOf YYYYMMDD>.xlsx (нөөц нэр өөрчлөгдөөгүй)', () => {
    expect(exportAsciiName('outstanding-balance', '2026-10-28')).toBe('LOS_outstanding-balance_20261028.xlsx');
  });
});

describe('exportDisplayName', () => {
  it('монгол тайлангийн нэр + asOf YYYYMMDD', () => {
    expect(exportDisplayName(TITLE, '2026-10-28')).toBe(`${TITLE}_20261028.xlsx`);
  });

  it('файлын нэрэнд хориотой тэмдэгт, хяналтын тэмдэгтийг хоосон зай болгож, давхар зайг нэгтгэнэ', () => {
    expect(exportDisplayName('A/B:C*D?"E<F>G|H\\I', '2026-10-28')).toBe('A B C D E F G H I_20261028.xlsx');
    expect(exportDisplayName('Тайлан\u0000\n  нэр', '2026-10-28')).toBe('Тайлан нэр_20261028.xlsx');
  });

  it('хоосон нэр → "Тайлан" нөөц', () => {
    expect(exportDisplayName('  /  ', '2026-10-28')).toBe('Тайлан_20261028.xlsx');
  });
});

describe('contentDisposition', () => {
  const ascii = 'LOS_outstanding-balance_20261028.xlsx';
  const display = `${TITLE}_20261028.xlsx`;
  const header = contentDisposition(ascii, display);

  it('зөвхөн хэвлэгдэх ASCII — Node нь >255 кодтой тэмдэгттэй толгойг хүлээж авдаггүй', () => {
    expect(header).toMatch(/^[\x20-\x7e]+$/);
  });

  it('attachment; filename*=UTF-8\'\'<percent-encoded монгол нэр>; filename="<ASCII нөөц>"', () => {
    expect(header).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(display)}; filename="${ascii}"`);
  });

  it('RFC 5987: \' ( ) * тэмдэгтүүд percent-encode хийгдэнэ', () => {
    const h = contentDisposition(ascii, "Хүү (дүн)*'x.xlsx");
    const star = /filename\*=UTF-8''([^;]+)/.exec(h)?.[1] ?? '';
    expect(star).not.toMatch(/['()*]/);
    expect(decodeURIComponent(star)).toBe("Хүү (дүн)*'x.xlsx");
  });

  it('web apiDownload-ийн regex (apps/web/src/lib/api.ts) хамгийн зүүн `filename*`-г олж монгол нэрийг сэргээнэ', () => {
    const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)?.[1];
    expect(name && decodeURIComponent(name)).toBe(display);
  });
});
