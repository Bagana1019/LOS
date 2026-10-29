import { describe, expect, it } from 'vitest';
import { detectOcrMime, normalizeOcrMime } from './mime';

const buf = (...bytes: number[]) => Buffer.from(bytes);

describe('detectOcrMime (magic bytes)', () => {
  it('PNG, JPEG, TIFF (II/MM), WebP, PDF-ийг танина', () => {
    expect(detectOcrMime(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(detectOcrMime(buf(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(detectOcrMime(buf(0x49, 0x49, 0x2a, 0x00, 8))).toBe('image/tiff');
    expect(detectOcrMime(buf(0x4d, 0x4d, 0x00, 0x2a, 0))).toBe('image/tiff');
    expect(detectOcrMime(Buffer.concat([Buffer.from('RIFF'), buf(1, 2, 3, 4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(detectOcrMime(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('текст, WAV (RIFF боловч WEBP биш), богино, хоосон, эхлэлийн өмнө хог бүхий PDF-ийг татгалзана', () => {
    expect(detectOcrMime(Buffer.from('hello world'))).toBeNull();
    expect(detectOcrMime(Buffer.concat([Buffer.from('RIFF'), buf(1, 2, 3, 4), Buffer.from('WAVEfmt ')]))).toBeNull();
    expect(detectOcrMime(buf(0x89, 0x50))).toBeNull();
    expect(detectOcrMime(Buffer.alloc(0))).toBeNull();
    expect(detectOcrMime(Buffer.from('\n%PDF-1.7'))).toBeNull();
    expect(detectOcrMime('png' as unknown as Buffer)).toBeNull();
  });
});

describe('normalizeOcrMime', () => {
  it('параметр, том/жижиг үсэг, alias-ыг зөвшөөрнө', () => {
    expect(normalizeOcrMime('IMAGE/PNG')).toBe('image/png');
    expect(normalizeOcrMime('image/jpeg; charset=binary')).toBe('image/jpeg');
    expect(normalizeOcrMime('image/jpg')).toBe('image/jpeg');
    expect(normalizeOcrMime('application/pdf')).toBe('application/pdf');
  });

  it('дэмжигдээгүй/буруу утгыг null болгоно', () => {
    expect(normalizeOcrMime('text/plain')).toBeNull();
    expect(normalizeOcrMime('image/gif')).toBeNull();
    expect(normalizeOcrMime('')).toBeNull();
    expect(normalizeOcrMime(undefined)).toBeNull();
    expect(normalizeOcrMime(null)).toBeNull();
  });
});
