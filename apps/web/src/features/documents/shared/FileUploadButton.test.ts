import { describe, expect, it } from 'vitest';
import { DMS_MAX_BYTES, DMS_TYPES_LABEL, fileRejectionMessage } from './FileUploadButton';

// Дүрэм нь dms-ийн бодит хязгаартай таарна: apps/dms/src/modules/file/{file-type.ts,file.service.ts} (docs/DECISIONS.md 2026-10-28).
const MB = 1024 * 1024;
const file = (name: string, size = 1024) => ({ name, size });

describe('хязгаарын тогтмолууд', () => {
  it('дээд хэмжээ нь dms-ийн анхдагч 20 МБ', () => {
    expect(DMS_MAX_BYTES).toBe(20 * MB);
  });
  it('төрлийн шошго нь <input accept>-ээс уламжлагдсан (давхар жагсаалтгүй)', () => {
    expect(DMS_TYPES_LABEL).toBe('PDF, PNG, JPG, JPEG, DOCX, XLSX, CSV, TXT');
  });
});

describe('fileRejectionMessage: зөвшөөрөгдөх файл', () => {
  it.each(['a.pdf', 'a.png', 'a.jpg', 'a.jpeg', 'a.docx', 'a.xlsx', 'a.csv', 'a.txt'])('%s', (name) => {
    expect(fileRejectionMessage(file(name))).toBeNull();
  });
  it('өргөтгөл том/жижиг үсгээс үл хамаарна', () => {
    expect(fileRejectionMessage(file('SCAN.PDF'))).toBeNull();
    expect(fileRejectionMessage(file('Зураг.JpEg'))).toBeNull();
  });
  it('монгол нэр, хоосон зай, олон цэгтэй нэр', () => {
    expect(fileRejectionMessage(file('Иргэний үнэмлэх (урд).pdf'))).toBeNull();
    expect(fileRejectionMessage(file('report.v2.final.xlsx'))).toBeNull();
  });
  it('хэмжээний хил: яг 20 МБ зөвшөөрнө (сервер зөвхөн ХЭТЭРСНИЙГ татгалзана), 1 байт зөвшөөрнө', () => {
    expect(fileRejectionMessage(file('a.pdf', DMS_MAX_BYTES))).toBeNull();
    expect(fileRejectionMessage(file('a.pdf', 1))).toBeNull();
  });
});

describe('fileRejectionMessage: төрөл буруу', () => {
  it.each(['virus.exe', 'README', '.pdf', 'archive.zip', 'page.html', 'logo.svg', 'old.doc', 'old.xls', 'report.pdf.exe', 'trailing.', 'x.pdf.'])('%s', (name) => {
    const msg = fileRejectionMessage(file(name));
    expect(msg).not.toBeNull();
    expect(msg).toContain('дэмжигдэхгүй');
  });
  it('мессеж файлын нэр, зөвшөөрөгдөх төрлүүд, дээд хэмжээг нэрлэнэ', () => {
    const msg = fileRejectionMessage(file('virus.exe'))!;
    expect(msg).toContain('«virus.exe»');
    expect(msg).toContain('PDF, PNG, JPG, JPEG, DOCX, XLSX, CSV, TXT');
    expect(msg).toContain('20 МБ');
  });
  it('хоосон ба буруу төрөлтэй файл: төрлийн мессеж (үндсэн шалтгааныг эхэнд нь засна)', () => {
    expect(fileRejectionMessage(file('virus.exe', 0))).toContain('дэмжигдэхгүй');
  });
});

describe('fileRejectionMessage: хоосон файл', () => {
  it('0 байт', () => {
    const msg = fileRejectionMessage(file('empty.pdf', 0))!;
    expect(msg).toContain('«empty.pdf»');
    expect(msg).toContain('хоосон');
    expect(msg).toContain('20 МБ');
    expect(msg).toContain('PDF, PNG');
  });
});

describe('fileRejectionMessage: хэт том файл', () => {
  it('20 МБ + 1 байт', () => {
    const msg = fileRejectionMessage(file('huge.pdf', DMS_MAX_BYTES + 1))!;
    expect(msg).toContain('«huge.pdf»');
    expect(msg).toContain('хэт том');
    expect(msg).toContain('20 МБ');
    expect(msg).toContain('PDF, PNG');
  });
  it('хэмжээ дөнгөж хэтэрсэн ч мессеж зөрчилгүй: бодит хэмжээг (бөөрөнхийлөлтөөр "20 МБ" болох) харуулахгүй, зөвхөн хязгаарыг', () => {
    const msg = fileRejectionMessage(file('edge.pdf', DMS_MAX_BYTES + 1))!;
    expect(msg.match(/20 МБ/g)).toHaveLength(1);
  });
});

describe('fileRejectionMessage: харуулалт', () => {
  it.each([file('virus.exe'), file('e.pdf', 0), file('h.pdf', 30 * MB)])('түлхүүр, placeholder үлдэхгүй (%o)', (f) => {
    const msg = fileRejectionMessage(f)!;
    expect(msg).not.toMatch(/document\.upload\./);
    expect(msg).not.toMatch(/[{}]/);
  });
  it('нэр дэх < >, emoji-г өөрчлөхгүй', () => {
    expect(fileRejectionMessage(file('<b>😀</b>.exe'))).toContain('«<b>😀</b>.exe»');
  });
});
