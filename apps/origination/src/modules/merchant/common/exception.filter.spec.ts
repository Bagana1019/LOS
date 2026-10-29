import { BadRequestException, ForbiddenException, HttpException, Logger, NotFoundException, UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '../domain/errors';
import { CapturingLogger } from '../testing/capturing-logger';
import { MerchantExceptionFilter } from './exception.filter';

function run(exception: unknown, correlationId?: string) {
  const sent: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  const res = { setHeader: () => res, status(code: number) { sent.status = code; return res; }, json(body: Record<string, unknown>) { sent.body = body; return res; } };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ headers: {}, ctx: correlationId ? { correlationId } : undefined }) }) } as unknown as ArgumentsHost;
  new MerchantExceptionFilter().catch(exception, host);
  return sent;
}

describe('MerchantExceptionFilter', () => {
  const logger = new CapturingLogger();
  beforeEach(() => { Logger.overrideLogger(logger); logger.lines.length = 0; });
  afterEach(() => { Logger.overrideLogger(false); vi.restoreAllMocks(); });

  it('maps DomainError to its status, code and details', () => {
    expect(run(new DomainError('NOT_FOUND', 'Lease not found'))).toEqual({ status: 404, body: { code: 'NOT_FOUND', message: 'Lease not found' } });
    expect(run(new DomainError('DOWN_PAYMENT_TOO_LOW', 'low', { minDownPayment: 5 })).body).toEqual({ code: 'DOWN_PAYMENT_TOO_LOW', message: 'low', details: { minDownPayment: 5 } });
  });
  it('logs a 5xx DomainError by code only (no message) with the correlation id', () => {
    const out = run(new DomainError('SCREENING_UNAVAILABLE', 'upstream 99111005 timed out'), 'corr-1');
    expect(out.status).toBe(503);
    expect(logger.text).toContain('[corr-1] SCREENING_UNAVAILABLE');
    expect(logger.text).not.toContain('99111005');
  });
  it('maps ZodError to 400 with issues', () => {
    const parsed = z.object({ a: z.string() }).safeParse({ a: 1 });
    if (parsed.success) throw new Error('unreachable');
    const out = run(parsed.error);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Validation failed', details: { issues: [{ path: 'a' }] } });
  });
  it('maps 4xx HttpExceptions to static messages, hiding the original text', () => {
    expect(run(new BadRequestException('secret detail 99111005')).body).toEqual({ code: 'VALIDATION_FAILED', message: 'Bad request' });
    expect(run(new UnauthorizedException('x')).body).toEqual({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    expect(run(new ForbiddenException('x')).body).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' });
    expect(run(new NotFoundException('Cannot GET /x')).body).toEqual({ code: 'NOT_FOUND', message: 'Not found' });
    expect(run(new HttpException('teapot', 418)).body).toEqual({ code: 'VALIDATION_FAILED', message: 'Request rejected' }); // тодорхойгүй 4xx
  });
  it('turns 5xx HttpExceptions, plain errors and non-errors into an opaque 500 and scrubs PII from the log', () => {
    for (const thrown of [new HttpException('bad gateway', 502), new Error('boom УЕ90050600 99111005'), 'a string', undefined]) {
      logger.lines.length = 0;
      const out = run(thrown, 'corr-9');
      expect(out).toEqual({ status: 500, body: { code: 'INTERNAL', message: 'Internal error' } });
      expect(logger.text).toContain('[corr-9] unhandled');
      expect(logger.text).not.toContain('УЕ90050600');
      expect(logger.text).not.toContain('99111005');
    }
    expect(run(new Error('x')).body).toEqual({ code: 'INTERNAL', message: 'Internal error' });
    expect(logger.text).toContain('[-] unhandled'); // correlation id байхгүй үед
  });
});
