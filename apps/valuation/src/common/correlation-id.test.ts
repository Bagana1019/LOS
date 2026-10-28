import { describe, it, expect, vi } from 'vitest';
import { correlationIdMiddleware } from './correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function run(incoming: string | string[] | undefined) {
  const req = { headers: { 'x-correlation-id': incoming } as Record<string, string | string[] | undefined> };
  const res = { setHeader: vi.fn() };
  const next = vi.fn();
  correlationIdMiddleware(req, res, next);
  return { req, res, next };
}

describe('correlationIdMiddleware', () => {
  it('keeps a conventional incoming id and echoes it', () => {
    const { req, res, next } = run('app-123:req.7_a');
    expect(req.headers['x-correlation-id']).toBe('app-123:req.7_a');
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', 'app-123:req.7_a');
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['with a space', 'a b'],
    ['with a line break', 'abc\r\nSet-Cookie: x=1'],
    ['too long', 'a'.repeat(129)],
    ['repeated header', ['a', 'b']],
  ])('replaces an id that is %s with a fresh UUID', (_label, incoming) => {
    const { req, res, next } = run(incoming);
    expect(req.headers['x-correlation-id']).toMatch(UUID);
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-Id', req.headers['x-correlation-id']);
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts the longest allowed id', () => {
    expect(run('a'.repeat(128)).req.headers['x-correlation-id']).toBe('a'.repeat(128));
  });
});
