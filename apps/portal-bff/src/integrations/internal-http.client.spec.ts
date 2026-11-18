import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InternalHttpClient } from './internal-http.client';

// Review M1: origination's ContextAuthGuard rejects calls without X-Internal-Token once INTERNAL_AUTH_SECRET is set.
const ctx = { correlationId: 'corr-1', customerId: 'cust-1' };

function capture(internalToken?: string) {
  const seen: Record<string, string>[] = [];
  const fetchImpl = (async (_url: URL, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const client = new InternalHttpClient({ baseUrl: 'http://origination:4001', timeoutMs: 1000, maxStreamBytes: 1024, fetchImpl, internalToken });
  return { client, seen };
}

describe('InternalHttpClient internal token', () => {
  it('sends x-internal-token when a secret is configured', async () => {
    const { client, seen } = capture('q7Zp3kLm9VxT2rWs8YbN');
    await client.json({ method: 'GET', path: '/api/internal/portal/x', ctx, schema: z.object({}) } as never);
    expect(seen[0]['x-internal-token']).toBe('q7Zp3kLm9VxT2rWs8YbN');
  });

  it('omits the header when no secret is configured', async () => {
    const { client, seen } = capture(undefined);
    await client.json({ method: 'GET', path: '/api/internal/portal/x', ctx, schema: z.object({}) } as never);
    expect(seen[0]).not.toHaveProperty('x-internal-token');
  });

  it('caller-supplied headers cannot override the token', async () => {
    const { client, seen } = capture('q7Zp3kLm9VxT2rWs8YbN');
    await client.json({ method: 'GET', path: '/api/internal/portal/x', ctx, headers: { 'x-internal-token': 'forged' }, schema: z.object({}) } as never);
    expect(seen[0]['x-internal-token']).toBe('q7Zp3kLm9VxT2rWs8YbN');
  });
});
