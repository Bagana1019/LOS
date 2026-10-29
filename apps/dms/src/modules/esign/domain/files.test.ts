import { describe, expect, it } from 'vitest';
import { looksLikePdf, safeFileStem, signatureFileName, signedPdfName, sourceDocumentName } from './files';

describe('looksLikePdf', () => {
  it('%PDF- header эхэнд, эсвэл эхний 1024 байтад байвал true', () => {
    expect(looksLikePdf(Buffer.from('%PDF-1.7\n...'))).toBe(true);
    expect(looksLikePdf(Buffer.concat([Buffer.alloc(500, 0x20), Buffer.from('%PDF-1.4')]))).toBe(true);
  });

  it('header 1024 байтаас хойно, байхгүй, хоосон бол false', () => {
    expect(looksLikePdf(Buffer.concat([Buffer.alloc(1100, 0x20), Buffer.from('%PDF-1.4')]))).toBe(false);
    expect(looksLikePdf(Buffer.from('PK\u0003\u0004 docx'))).toBe(false);
    expect(looksLikePdf(Buffer.from('PDF-1.7 no percent'))).toBe(false);
    expect(looksLikePdf(Buffer.alloc(0))).toBe(false);
  });
});

describe('файлын нэр', () => {
  it('кирилл гэрээний дугаарыг хадгалж, өргөтгөл нэмнэ', () => {
    expect(sourceDocumentName('ГЭР-2026-000123')).toBe('ГЭР-2026-000123.pdf');
    expect(signedPdfName('ГЭР-2026-000123')).toBe('ГЭР-2026-000123-signed.pdf');
    expect(signatureFileName('ГЭР-2026-000123')).toBe('ГЭР-2026-000123.p7s');
  });

  it('зам салгагч, хяналтын тэмдэгт, reserved тэмдэгтийг "_" болгоно (path traversal, header injection)', () => {
    expect(safeFileStem('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileStem('a\\b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
    expect(safeFileStem('line1\r\nline2\u0000x')).toBe('line1_line2_x');
    expect(signedPdfName('x/y')).not.toContain('/');
  });

  it('зайг нэгтгэж тайрна; хоосон бол "contract"', () => {
    expect(safeFileStem('  ГЭР   2026  ')).toBe('ГЭР 2026');
    expect(safeFileStem('')).toBe('contract');
    expect(safeFileStem('   ')).toBe('contract');
    expect(signedPdfName('')).toBe('contract-signed.pdf');
  });

  it('хэт урт дугаар: өргөтгөлтэй нь 255 тэмдэгтээс хэтрэхгүй; кирилл тэмдэгт дундаа тасрахгүй', () => {
    const name = signedPdfName('Ө'.repeat(400));
    expect(Array.from(name)).toHaveLength(255);
    expect(name.endsWith('-signed.pdf')).toBe(true);
    expect(name).not.toContain('�');
    expect(Array.from(signatureFileName('x'.repeat(400))).length).toBeLessThanOrEqual(255);
  });
});
