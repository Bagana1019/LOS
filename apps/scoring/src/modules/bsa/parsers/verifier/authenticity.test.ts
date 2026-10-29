// PDF metadata эвристик (BSA-FR-2.3). SYNTHETIC metadata: бодит банкны PDF-ийн producer мэдэгдэхгүй (samples/ хоосон).
import { describe, expect, it } from 'vitest';
import type { PdfMetadata, StatementFileMeta } from '../statement.types';
import { checkAuthenticity } from './authenticity';
import { VERIFY_DEFAULTS } from './verify-defaults';

const pdf = (over: Partial<PdfMetadata> = {}): StatementFileMeta => ({
  fileName: 'synthetic.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1,
  sha256: '0'.repeat(64),
  pdf: {
    producer: 'SYNTHETIC Report Engine',
    creator: 'SYNTHETIC Service',
    title: null,
    author: null,
    creationDate: '2026-03-31T10:00:00Z',
    modDate: '2026-03-31T10:00:00Z',
    pageCount: 2,
    isEncrypted: false,
    hasSignature: false,
    ...over,
  },
});

const codes = (meta: StatementFileMeta, opts = {}): string[] => checkAuthenticity(meta, opts).issues.map((i) => i.code);

describe('checkAuthenticity — producer / creator signatures', () => {
  it('a clean producer/creator has no issue', () => {
    const r = checkAuthenticity(pdf());
    expect(r.issues).toEqual([]);
    expect(r.report).toMatchObject({ checked: true, suspiciousSignatures: [], modifiedAfterSeconds: 0, isEncrypted: false, hasSignature: false });
  });

  it.each([
    ['Adobe Photoshop 25.1', 'Photoshop'],
    ['Microsoft® Word 2019', 'Microsoft Word'],
    ['Microsoft Word for Microsoft 365', 'Microsoft Word'],
    ['Canva', 'Canva'],
    ['iLovePDF', 'iLovePDF'],
    ['www.ilovepdf.com', 'iLovePDF'],
    ['Smallpdf.com', 'Smallpdf'],
    ['Sejda 5.1', 'Sejda'],
    ['PDFescape Desktop', 'PDFescape'],
    ['LibreOffice 7.5', 'LibreOffice'],
  ])('producer "%s" matches %s', (producer, signature) => {
    const r = checkAuthenticity(pdf({ producer }));
    expect(r.issues.map((i) => i.code)).toEqual(['PDF_METADATA_SUSPICIOUS']);
    expect(r.issues[0].severity).toBe('WARNING');
    expect(r.report.suspiciousSignatures).toContain(signature);
    expect(r.report.producer).toBe(producer);
  });

  it('the creator field is checked too, case-insensitively', () => {
    expect(codes(pdf({ creator: 'ADOBE PHOTOSHOP' }))).toEqual(['PDF_METADATA_SUSPICIOUS']);
  });

  it('typical report-generator producers are not flagged', () => {
    for (const producer of ['iText 7.1.9', 'JasperReports Library', 'Crystal Reports', 'wkhtmltopdf 0.12', 'Skia/PDF m110', 'Apache FOP']) {
      expect(codes(pdf({ producer, creator: null })), producer).toEqual([]);
    }
  });

  it('missing producer and creator are fine', () => {
    expect(codes(pdf({ producer: null, creator: null }))).toEqual([]);
  });

  it('the signature list is configurable', () => {
    expect(codes(pdf({ producer: 'Some Internal Tool' }), { suspiciousProducerSignatures: ['internal tool'] })).toEqual(['PDF_METADATA_SUSPICIOUS']);
    expect(codes(pdf({ producer: 'Adobe Photoshop' }), { suspiciousProducerSignatures: [] })).toEqual([]);
  });

  it('the default signature list covers the tools named in the requirements', () => {
    const names = VERIFY_DEFAULTS.suspiciousProducerSignatures.map((s) => s.toLowerCase());
    for (const required of ['photoshop', 'microsoft word', 'canva', 'ilovepdf', 'smallpdf', 'sejda', 'pdfescape']) expect(names).toContain(required);
  });
});

describe('checkAuthenticity — modification date', () => {
  it('modified long after creation is flagged and the delay is reported', () => {
    const r = checkAuthenticity(pdf({ modDate: '2026-04-02T10:00:00Z' }));
    expect(r.issues.map((i) => i.code)).toEqual(['PDF_MODIFIED']);
    expect(r.report.modifiedAfterSeconds).toBe(2 * 86400);
  });

  it('within the tolerance (default 60 s) is not flagged; just beyond it is', () => {
    expect(codes(pdf({ modDate: '2026-03-31T10:01:00Z' }))).toEqual([]);
    expect(codes(pdf({ modDate: '2026-03-31T10:01:01Z' }))).toEqual(['PDF_MODIFIED']);
  });

  it('the tolerance is configurable', () => {
    expect(codes(pdf({ modDate: '2026-03-31T10:10:00Z' }), { pdfModifiedToleranceSeconds: 3600 })).toEqual([]);
    expect(codes(pdf({ modDate: '2026-03-31T10:00:05Z' }), { pdfModifiedToleranceSeconds: 1 })).toEqual(['PDF_MODIFIED']);
  });

  it('a modification date before the creation date is reported but not flagged', () => {
    const r = checkAuthenticity(pdf({ modDate: '2026-03-30T10:00:00Z' }));
    expect(r.issues).toEqual([]);
    expect(r.report.modifiedAfterSeconds).toBe(-86400);
  });

  it('missing or unparsable dates give null and no issue', () => {
    for (const over of [{ creationDate: null }, { modDate: null }, { creationDate: 'not a date' }]) {
      const r = checkAuthenticity(pdf(over));
      expect(r.report.modifiedAfterSeconds).toBeNull();
      expect(r.issues).toEqual([]);
    }
  });
});

describe('checkAuthenticity — other cases', () => {
  it('encryption and signature are reported, not flagged', () => {
    const r = checkAuthenticity(pdf({ isEncrypted: true, hasSignature: true }));
    expect(r.report).toMatchObject({ isEncrypted: true, hasSignature: true });
    expect(r.issues).toEqual([]);
  });

  it('a file without PDF metadata (image, CSV) is not checked', () => {
    const r = checkAuthenticity({ fileName: 'a.png', mimeType: 'image/png', sizeBytes: 1, sha256: '0'.repeat(64) });
    expect(r.report).toMatchObject({ checked: false, producer: null, creator: null, suspiciousSignatures: [], modifiedAfterSeconds: null });
    expect(r.issues).toEqual([]);
  });

  it('suspicious producer and late modification are both reported', () => {
    expect(codes(pdf({ producer: 'Canva', modDate: '2026-05-01T00:00:00Z' }))).toEqual(['PDF_METADATA_SUSPICIOUS', 'PDF_MODIFIED']);
  });
});
