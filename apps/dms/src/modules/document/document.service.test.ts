import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OcrError } from '@los/ocr';
import { DomainError } from '@los/nest-common';
import type { RequestContext } from '@los/contracts';
import type { PrismaService } from '../../prisma.service';
import type { ObjectStorage } from '../file/storage';
import type { OcrService, ExtractResponse } from '../ocr/ocr.service';
import { DocumentService, toDocumentView } from './document.service';

// Сангүй нэгж тест: OCR-ийн хэмжээ/хадгалалтын алдааны салбарууд (DB-тэй тест `test/document.e2e.test.ts`-д).
const CTX: RequestContext = { userId: 'u-1', roles: ['OFFICER'], branchId: null, orgId: 'org-1', customerId: null, correlationId: 'corr-1' };
const ID = '11111111-1111-4111-8111-111111111111';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

const row = (over: { size?: number; checklistKey?: string | null } = {}) => ({
  id: ID, orgId: 'org-1', applicationId: 'app-1', type: 'id_card', relatedEntity: 'APPLICATION', relatedId: null, note: null, fileId: 'f-1', checklistKey: over.checklistKey === undefined ? 'id_card' : over.checklistKey,
  createdAt: new Date('2026-10-29T01:00:00Z'), updatedAt: new Date('2026-10-29T01:00:00Z'), createdBy: 'u-1', updatedBy: 'u-1',
  file: { id: 'f-1', orgId: 'org-1', bucket: 'b', storageKey: 'k', name: 'id-card.png', mime: 'image/png', size: over.size ?? PNG.length, sha256: 'x', uploadedBy: 'u-1', retentionUntil: null, purgedAt: null, createdAt: new Date(), updatedAt: new Date(), createdBy: null, updatedBy: null },
});

const extraction = (withText = false): ExtractResponse => ({
  docType: 'ID_CARD', detectedDocType: 'ID_CARD', fields: {}, warnings: ['w'],
  ocr: { engine: 'mock', meanConfidence: 0.9, pageCount: 1, durationMs: 3, ...(withText ? { text: 'СЕКРЕТ ТЕКСТ' } : {}) },
});

function make(opts: { document?: ReturnType<typeof row> | null; stream?: () => Promise<Readable>; extract?: OcrService['extract'] } = {}) {
  const findFirst = vi.fn().mockResolvedValue(opts.document === undefined ? row() : opts.document);
  const get = vi.fn(opts.stream ?? (async () => Readable.from([PNG])));
  const extract = vi.fn(opts.extract ?? (async () => extraction()));
  const service = new DocumentService({ document: { findFirst } } as unknown as PrismaService, { get } as unknown as ObjectStorage, { extract } as unknown as OcrService);
  return { service, findFirst, get, extract };
}

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof DomainError ? [e.getStatus(), e.code] : e instanceof OcrError ? ['OCR', e.code] : e; }
  return 'resolved';
};

describe('DocumentService.extract (OCR guards)', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.OCR_MAX_FILE_BYTES; process.env.OCR_MAX_FILE_BYTES = '64'; });
  afterEach(() => { if (saved === undefined) delete process.env.OCR_MAX_FILE_BYTES; else process.env.OCR_MAX_FILE_BYTES = saved; });

  it('reads the stored bytes, asks for no text, and passes the checklist-selected doc type', async () => {
    const { service, extract, findFirst } = make();
    const out = await service.extract(CTX, ID);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: ID, orgId: 'org-1' }) }));
    expect(extract).toHaveBeenCalledWith({ content: PNG, mimeType: 'image/png', fileName: 'id-card.png', docType: 'ID_CARD', includeText: false, correlationId: 'corr-1' });
    expect(out).toMatchObject({ documentId: ID, docType: 'ID_CARD', warnings: ['w'], ocr: { engine: 'mock', meanConfidence: 0.9, pageCount: 1, durationMs: 3 } });
  });

  it('drops any OCR text the engine returned (the response never carries text)', async () => {
    const { service } = make({ extract: async () => extraction(true) });
    const out = await service.extract(CTX, ID);
    expect('text' in out.ocr).toBe(false);
    expect(JSON.stringify(out)).not.toContain('СЕКРЕТ');
  });

  it('a file over the OCR limit is 413 before any storage read', async () => {
    const { service, get, extract } = make({ document: row({ size: 65 }) });
    expect(await code(service.extract(CTX, ID))).toEqual([413, 'OCR_FILE_TOO_LARGE']);
    expect(get).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it('a stream larger than the recorded size (lying metadata) is cut off at the limit', async () => {
    const { service, extract } = make({ document: row({ size: 10 }), stream: async () => Readable.from([Buffer.alloc(40), Buffer.alloc(40)]) });
    expect(await code(service.extract(CTX, ID))).toEqual([413, 'OCR_FILE_TOO_LARGE']);
    expect(extract).not.toHaveBeenCalled();
  });

  it('a storage failure (open or mid-stream) is 502 FILE_CONTENT_UNAVAILABLE with no internals', async () => {
    const open = make({ stream: async () => { throw Object.assign(new Error('NoSuchKey: secret/key'), { code: 'NoSuchKey' }); } });
    const midStream = make({ stream: async () => new Readable({ read() { this.destroy(new Error('socket hang up')); } }) });
    for (const { service } of [open, midStream]) {
      const err = await service.extract(CTX, ID).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).getStatus()).toBe(502);
      expect(JSON.stringify((err as DomainError).getResponse())).not.toMatch(/NoSuchKey|secret|socket/);
    }
  });

  it('non-image bytes → OcrError UNSUPPORTED_MIME (mapped to 415 by OcrErrorFilter); the engine is not called', async () => {
    const { service, extract } = make({ stream: async () => Readable.from([Buffer.from('plain text')]) });
    expect(await code(service.extract(CTX, ID))).toEqual(['OCR', 'UNSUPPORTED_MIME']);
    expect(extract).not.toHaveBeenCalled();
  });

  it('OcrError from the engine propagates untouched (filter maps it)', async () => {
    const { service } = make({ extract: async () => { throw new OcrError('NO_FIXTURE', 'x'); } });
    expect(await code(service.extract(CTX, ID))).toEqual(['OCR', 'NO_FIXTURE']);
  });

  it('a malformed id never reaches the database', async () => {
    const { service, findFirst } = make();
    expect(await code(service.extract(CTX, 'nope'))).toEqual([404, 'DOCUMENT_NOT_FOUND']);
    expect(await code(service.get(CTX, 'nope'))).toEqual([404, 'DOCUMENT_NOT_FOUND']);
    expect(await code(service.remove(CTX, 'nope'))).toEqual([404, 'DOCUMENT_NOT_FOUND']);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('a missing document is 404', async () => {
    const { service } = make({ document: null });
    expect(await code(service.extract(CTX, ID))).toEqual([404, 'DOCUMENT_NOT_FOUND']);
  });
});

describe('toDocumentView', () => {
  it('uploadedBy = created_by, uploadedAt = created_at, file facts from the file row', () => {
    expect(toDocumentView(row())).toEqual({
      id: ID, applicationId: 'app-1', type: 'id_card', relatedEntity: 'APPLICATION', relatedId: null, note: null, fileId: 'f-1', fileName: 'id-card.png', mime: 'image/png', size: PNG.length,
      checklistKey: 'id_card', uploadedBy: 'u-1', uploadedAt: '2026-10-29T01:00:00.000Z',
    });
  });
});
