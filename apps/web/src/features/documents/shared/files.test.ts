import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../../../lib/api';
import { DMS_ACCEPT, DmsFile, formatBytes, uploadDmsFile } from './files';

describe('formatBytes', () => {
  it('нэгжүүд', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(1536)).toBe('1.5 КБ');
    expect(formatBytes(20 * 1024)).toBe('20 КБ');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 МБ');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 МБ');
  });
  it('буруу утга', () => {
    for (const v of [null, undefined, Number.NaN, -1]) expect(formatBytes(v as number)).toBe('—');
  });
});

describe('DMS_ACCEPT', () => {
  it('dms-ийн зөвшөөрсөн өргөтгөлүүд', () => {
    expect(DMS_ACCEPT.split(',')).toEqual(['.pdf', '.png', '.jpg', '.jpeg', '.docx', '.xlsx', '.csv', '.txt']);
  });
});

describe('uploadDmsFile', () => {
  let calls: Array<{ url: string; init: RequestInit }>;
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  const stub = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    });

  it('POST /api/dms/files, multipart «file» талбар', async () => {
    const file = { id: '0a1b2c3d-4444-4a44-8a44-000000000001', name: 'a.pdf', mime: 'application/pdf', size: 3, extra: 'ignored' };
    stub(201, file);
    const parsed = await uploadDmsFile(new File(['abc'], 'a.pdf', { type: 'application/pdf' }));
    expect(parsed).toEqual(DmsFile.parse(file));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API}/dms/files`);
    expect(calls[0]?.init.method).toBe('POST');
    const body = calls[0]?.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect((body.get('file') as File).name).toBe('a.pdf');
    // content-type-ийг хөтөч boundary-тай тавина
    expect(Object.keys(calls[0]?.init.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('алдааны хариу → ApiError (код, статус)', async () => {
    stub(415, { code: 'FILE_TYPE_NOT_ALLOWED', message: 'Файлын төрөл зөвшөөрөгдөөгүй' });
    await expect(uploadDmsFile(new File(['x'], 'a.exe'))).rejects.toMatchObject({ status: 415, code: 'FILE_TYPE_NOT_ALLOWED' });
  });
});
