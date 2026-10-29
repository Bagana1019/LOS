import { describe, expect, it } from 'vitest';
import { contentDisposition, fileResponse } from './file-response';

describe('contentDisposition', () => {
  it('ASCII нэр: fallback ба UTF-8 хувилбар ижил', () => {
    expect(contentDisposition('attachment', 'contract-2026.pdf')).toBe(`attachment; filename="contract-2026.pdf"; filename*=UTF-8''contract-2026.pdf`);
  });

  it('кирилл нэр: fallback-д `_`, filename* нь RFC 5987 хувиар кодлогдсон; inline/attachment', () => {
    const header = contentDisposition('inline', 'ГЭР-2026-000123-signed.pdf');
    expect(header).toBe(`inline; filename="___-2026-000123-signed.pdf"; filename*=UTF-8''%D0%93%D0%AD%D0%A0-2026-000123-signed.pdf`);
    const encoded = /filename\*=UTF-8''(.+)$/.exec(header)?.[1] ?? '';
    expect(decodeURIComponent(encoded)).toBe('ГЭР-2026-000123-signed.pdf');
  });

  it('header injection: хашилт, шинэ мөр, `;`, `\\`, `%` fallback-д орохгүй; `\'()*` кодлогдоно', () => {
    const header = contentDisposition('attachment', 'a"b\r\nSet-Cookie: x=1;c\\d%e\'(f)*.pdf');
    const fallback = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
    expect(fallback).toMatch(/^[A-Za-z0-9._ -]+$/);
    expect(header).not.toMatch(/[\r\n]/);
    const encoded = /filename\*=UTF-8''(.+)$/.exec(header)?.[1] ?? '';
    expect(encoded).toMatch(/^[A-Za-z0-9%._-]+$/);
    expect(encoded).toContain('%27');
    expect(encoded).toContain('%2A');
    expect(decodeURIComponent(encoded)).toBe('a"b\r\nSet-Cookie: x=1;c\\d%e\'(f)*.pdf');
  });
});

describe('fileResponse', () => {
  it('төрөл, disposition, урт нь StreamableFile-д тавигдана', () => {
    const bytes = Buffer.from('%PDF-1.7 test');
    const streamable = fileResponse({ fileName: 'ГЭР.pdf', mime: 'application/pdf', bytes, sha256: 'x' }, 'attachment');
    expect(streamable.getHeaders()).toEqual({
      type: 'application/pdf',
      disposition: `attachment; filename="___.pdf"; filename*=UTF-8''%D0%93%D0%AD%D0%A0.pdf`,
      length: bytes.length,
    });
  });
});
