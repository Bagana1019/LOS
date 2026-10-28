import { describe, expect, it } from 'vitest';
import { EsignApiError, type EsignErrorKind } from './api';
import { createEsignQueryClient, retryDelay, sessionKey, shouldRetry, toApiError } from './query';
import { TOKEN } from './testing/fixtures';

describe('shouldRetry', () => {
  it('сүлжээ/5xx-ийг 2 удаа л давтана', () => {
    for (const kind of ['NETWORK', 'SERVER'] as const) {
      expect(shouldRetry(0, new EsignApiError(kind))).toBe(true);
      expect(shouldRetry(1, new EsignApiError(kind))).toBe(true);
      expect(shouldRetry(2, new EsignApiError(kind))).toBe(false);
    }
  });
  it('404/410/429/409/буруу хариуг, мөн үл мэдэгдэх алдааг давтахгүй', () => {
    const kinds: EsignErrorKind[] = ['NOT_FOUND', 'GONE', 'RATE_LIMITED', 'CONFLICT', 'INVALID_REQUEST', 'INVALID_RESPONSE'];
    for (const kind of kinds) expect(shouldRetry(0, new EsignApiError(kind)), kind).toBe(false);
    expect(shouldRetry(0, new Error('boom'))).toBe(false);
  });
  it('ухралт 1 с, 2 с, 4 с-ээр хязгаарлагдана', () => {
    expect([0, 1, 2, 3, 10].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
  });
});

describe('toApiError / sessionKey / createEsignQueryClient', () => {
  it('EsignApiError-ийг хэвээр, бусдыг INVALID_REQUEST болгоно', () => {
    const err = new EsignApiError('GONE', 410);
    expect(toApiError(err)).toBe(err);
    expect(toApiError(new Error('x')).kind).toBe('INVALID_REQUEST');
    expect(toApiError('x').kind).toBe('INVALID_REQUEST');
  });
  it('QueryClient бүр тусдаа; mutation давтахгүй', () => {
    const a = createEsignQueryClient();
    expect(a).not.toBe(createEsignQueryClient());
    expect(a.getDefaultOptions().mutations?.retry).toBe(false);
    expect(sessionKey(TOKEN)).toEqual(['esign', 'session', TOKEN]);
  });
});
