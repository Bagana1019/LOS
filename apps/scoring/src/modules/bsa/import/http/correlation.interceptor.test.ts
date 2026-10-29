// X-Correlation-Id-ийг хариуны толгойд буцаана; хүчингүй толгойд юу ч нэмэхгүй.
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { CorrelationInterceptor } from './correlation.interceptor';

function run(headers: Record<string, string>, type = 'http') {
  const res = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; } };
  const host = { getType: () => type, switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => res }) } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of('ok') };
  return { res, result: lastValueFrom(new CorrelationInterceptor().intercept(host, next)) };
}

describe('CorrelationInterceptor', () => {
  it('sets the response header from the request context', async () => {
    const { res, result } = run({ 'x-user-id': 'u1', 'x-roles': 'ADMIN', 'x-correlation-id': 'corr-7' });
    await expect(result).resolves.toBe('ok');
    expect(res.headers['X-Correlation-Id']).toBe('corr-7');
  });

  it('generates one when the client sent none', async () => {
    const { res, result } = run({ 'x-user-id': 'u1', 'x-roles': 'ADMIN' });
    await result;
    expect(res.headers['X-Correlation-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('adds nothing for invalid identity headers or non-http contexts', async () => {
    const invalid = run({});
    await invalid.result;
    expect(invalid.res.headers).toEqual({});
    const rpc = run({ 'x-user-id': 'u1', 'x-roles': 'ADMIN' }, 'rpc');
    await rpc.result;
    expect(rpc.res.headers).toEqual({});
  });
});
