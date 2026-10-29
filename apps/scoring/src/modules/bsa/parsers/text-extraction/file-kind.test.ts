import { describe, expect, it } from 'vitest';
import { detectFileKind, inspectFile, looksLikeText } from './file-kind';
import { encodeCp1251, encodeUtf16, utf8Bom } from './testing/encodings';

const bytes = (...b: number[]) => Buffer.concat([Buffer.from(b), Buffer.alloc(32, 0x20)]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'latin1');
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const TIFF_LE = bytes(0x49, 0x49, 0x2a, 0x00);
const TIFF_BE = bytes(0x4d, 0x4d, 0x00, 0x2a);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(20)]);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04);
const OLE2 = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const CSV = Buffer.from('Date,Desc,Amount\n2026-03-01,Salary,1000\n');

const kind = (fileName: string, content: Buffer, mimeType?: string) => detectFileKind({ fileName, mimeType, content });

describe('detectFileKind: бит (magic bytes)', () => {
  it.each([
    ['PDF', PDF, 'PDF'],
    ['PNG', PNG, 'IMAGE'],
    ['JPEG', JPEG, 'IMAGE'],
    ['TIFF II*', TIFF_LE, 'IMAGE'],
    ['TIFF MM*', TIFF_BE, 'IMAGE'],
    ['WEBP', WEBP, 'IMAGE'],
    ['ZIP/XLSX', ZIP, 'XLSX'],
  ] as const)('%s → %s (нэр, MIME байхгүй ч)', (_n, content, expected) => {
    expect(kind('noname', content)).toBe(expected);
  });

  it('каноник MIME агуулгаас гарна', () => {
    expect(inspectFile({ fileName: 'a', content: PDF }).mimeType).toBe('application/pdf');
    expect(inspectFile({ fileName: 'a', content: PNG }).mimeType).toBe('image/png');
    expect(inspectFile({ fileName: 'a', content: JPEG }).mimeType).toBe('image/jpeg');
    expect(inspectFile({ fileName: 'a', content: TIFF_BE }).mimeType).toBe('image/tiff');
    expect(inspectFile({ fileName: 'a', content: WEBP }).mimeType).toBe('image/webp');
    expect(inspectFile({ fileName: 'a', content: ZIP }).mimeType).toContain('spreadsheetml');
    expect(inspectFile({ fileName: 'a.csv', content: CSV }).mimeType).toBe('text/csv');
    expect(inspectFile({ fileName: 'a.txt', content: CSV }).mimeType).toBe('text/plain');
    expect(inspectFile({ fileName: 'a.bin', content: bytes(1, 2, 3, 0, 0) }).mimeType).toBe('application/octet-stream');
  });

  it('PDF зөвхөн файлын ЭХЭНД %PDF-: урд нь хог/шинэ мөр байвал PDF биш (polyglot)', () => {
    expect(kind('a.pdf', Buffer.concat([Buffer.from('\n'), PDF]), 'application/pdf')).toBe('UNKNOWN');
    expect(kind('a.pdf', Buffer.concat([Buffer.from('GIF89a'), PDF]), 'application/pdf')).toBe('UNKNOWN');
    expect(kind('a.pdf', Buffer.from('%PDF'))).toBe('UNKNOWN'); // "-" дутуу
  });

  it('хоосон агуулга → UNKNOWN', () => {
    expect(kind('a.csv', Buffer.alloc(0), 'text/csv')).toBe('UNKNOWN');
  });
});

describe('detectFileKind: клиентийн MIME/өргөтгөлд итгэхгүй', () => {
  it('PNG-г .pdf нэр, application/pdf MIME-ээр хуурсан → IMAGE', () => {
    expect(kind('statement.pdf', PNG, 'application/pdf')).toBe('IMAGE');
  });

  it('PDF-г .png нэр, image/png MIME-ээр хуурсан → PDF', () => {
    expect(kind('scan.png', PDF, 'image/png')).toBe('PDF');
  });

  it('CSV текстийг PDF MIME-ээр хуурсан → CSV (өргөтгөлөөр)', () => {
    expect(kind('x.csv', CSV, 'application/pdf')).toBe('CSV');
  });

  it('PDF/зураг MIME нэрлэсэн ч агуулга текст/хог бол PDF/IMAGE БИШ', () => {
    expect(kind('a.pdf', Buffer.from('<html><body>Error 500</body></html>'), 'application/pdf')).toBe('UNKNOWN');
    expect(kind('a.png', Buffer.from('not an image'), 'image/png')).toBe('UNKNOWN');
    expect(kind('a.jpg', bytes(1, 2, 3, 0, 0, 0), 'image/jpeg')).toBe('UNKNOWN');
  });

  it('XLSX MIME/өргөтгөл нэрлэсэн ч zip бит байхгүй бол XLSX БИШ', () => {
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    expect(kind('a.xlsx', CSV, mime)).toBe('UNKNOWN');
    expect(kind('a.xlsx', bytes(9, 9, 9, 0), mime)).toBe('UNKNOWN');
  });

  it('zip бит бол нэр/MIME юу ч байсан XLSX (дэмжигдэхгүй гэж үзэх зам)', () => {
    expect(kind('statement.csv', ZIP, 'text/csv')).toBe('XLSX');
    expect(kind('statement.pdf', ZIP, 'application/pdf')).toBe('XLSX');
  });

  it('хоёртын хог: .csv/.txt нэр, text/csv MIME-тэй ч UNKNOWN', () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x10, 0x11]);
    expect(kind('a.csv', garbage, 'text/csv')).toBe('UNKNOWN');
    expect(kind('a.txt', Buffer.concat([Buffer.from('hello'), Buffer.from([0])]), 'text/plain')).toBe('UNKNOWN');
  });
});

describe('detectFileKind: текст (CSV | TEXT)', () => {
  it('MIME CSV: text/csv, application/csv, text/x-csv, tab-separated-values, application/vnd.ms-excel (Windows)', () => {
    for (const m of ['text/csv', 'application/csv', 'text/x-csv', 'text/tab-separated-values', 'application/vnd.ms-excel', 'TEXT/CSV; charset=utf-8']) {
      expect(kind('export', CSV, m)).toBe('CSV');
    }
  });

  it('text/plain + .csv өргөтгөл → CSV (өргөтгөл нарийвчлал нэмнэ); text/plain + өөр нэр → TEXT', () => {
    expect(kind('statement.csv', CSV, 'text/plain')).toBe('CSV');
    expect(kind('statement.TSV', CSV, 'text/plain')).toBe('CSV');
    expect(kind('statement.txt', CSV, 'text/plain')).toBe('TEXT');
    expect(kind('statement', CSV, 'text/plain')).toBe('TEXT');
  });

  it('MIME ерөнхий/хоосон (octet-stream) үед өргөтгөл шийднэ', () => {
    expect(kind('a.csv', CSV, 'application/octet-stream')).toBe('CSV');
    expect(kind('a.csv', CSV)).toBe('CSV');
    expect(kind('a.TXT', CSV, '')).toBe('TEXT');
    expect(kind('a.text', CSV)).toBe('TEXT');
    expect(kind('a.dat', CSV, 'application/octet-stream')).toBe('UNKNOWN');
    expect(kind('noext', CSV)).toBe('UNKNOWN');
    expect(kind('a.csv.exe', CSV)).toBe('UNKNOWN'); // сүүлийн өргөтгөл л тооцогдоно
    expect(kind('C:\\fakepath\\statement.csv', CSV)).toBe('CSV'); // зам хасагдана
  });

  it('JSON/HTML гэх мэт бусад MIME + танигдаагүй өргөтгөл → UNKNOWN', () => {
    expect(kind('a.html', Buffer.from('<html></html>'), 'text/html')).toBe('UNKNOWN');
    expect(kind('a.json', Buffer.from('{"a":1}'), 'application/json')).toBe('UNKNOWN');
  });

  it('кодчилол: UTF-8 BOM, UTF-16LE/BE BOM, windows-1251 текст → текст', () => {
    for (const buf of [utf8Bom('Огноо;Дүн\n'), encodeUtf16('Огноо;Дүн\n', 'le'), encodeUtf16('Огноо;Дүн\n', 'be'), encodeCp1251('Огноо;Дүн\n2026-03-01;100\n')]) {
      expect(kind('a.csv', buf, 'text/csv')).toBe('CSV');
    }
  });

  it('хуучин .xls (OLE2): өргөтгөл xls бол хүснэгт, .doc бол UNKNOWN', () => {
    expect(kind('a.xls', OLE2, 'application/vnd.ms-excel')).toBe('XLSX');
    expect(kind('a.doc', OLE2, 'application/msword')).toBe('UNKNOWN');
  });

  it('fileName байхгүй / хоосон / мөр биш үед унахгүй', () => {
    expect(kind(undefined as unknown as string, CSV, 'text/csv')).toBe('CSV');
    expect(kind('', CSV)).toBe('UNKNOWN');
  });
});

describe('looksLikeText', () => {
  it('NUL эсвэл удирдлагын тэмдэгт олонтой бол текст биш', () => {
    expect(looksLikeText(Buffer.from('a,b\r\n1,2\t3\f'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
    expect(looksLikeText(Buffer.alloc(100, 0x01))).toBe(false);
    expect(looksLikeText(Buffer.alloc(0))).toBe(false);
  });
});
