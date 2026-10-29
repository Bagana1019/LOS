import { ConsoleLogger, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogAuditSink } from '../audit/audit.service';
import { JsonLogger } from './json-logger';

describe('JsonLogger (CLAUDE.md §3.2-10: JSON logs with correlationId)', () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => (out.push(s), true)) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => (err.push(s), true)) as typeof process.stderr.write);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Logger.overrideLogger(new ConsoleLogger());
  });

  it('puts object fields at the top level of a single JSON line', () => {
    new JsonLogger().log({ msg: 'hello', correlationId: 'corr-123456', customField: 7 }, 'Ctx');
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ level: 'log', service: 'portal-bff', context: 'Ctx', msg: 'hello', correlationId: 'corr-123456', customField: 7 });
  });

  it('payload fields cannot overwrite the envelope (level/time/service)', () => {
    new JsonLogger().warn({ msg: 'x', level: 'fake', service: 'evil', time: 'never' });
    expect(JSON.parse(out[0])).toMatchObject({ level: 'warn', service: 'portal-bff' });
    expect(JSON.parse(out[0]).time).not.toBe('never');
  });

  it('errors go to stderr with stack and context in the right slots', () => {
    new JsonLogger().error({ msg: 'boom', correlationId: 'corr-123456' }, 'STACK', 'Ctx');
    expect(out).toHaveLength(0);
    expect(JSON.parse(err[0])).toMatchObject({ level: 'error', msg: 'boom', stack: 'STACK', context: 'Ctx', correlationId: 'corr-123456' });
  });

  it('a plain string with only a context is not mistaken for a stack', () => {
    new JsonLogger().error('plain failure', 'Ctx');
    expect(JSON.parse(err[0])).toMatchObject({ msg: 'plain failure', context: 'Ctx' });
    expect(JSON.parse(err[0]).stack).toBeUndefined();
  });

  it('audit records are queryable fields (audit=true, action, correlationId), not a JSON string inside msg', () => {
    Logger.overrideLogger(new JsonLogger());
    new LogAuditSink().write({ action: 'AUTH_LOGIN', correlationId: 'corr-abcdef12', outcome: 'SUCCESS', customerId: 'cust_1', at: '2026-10-28T04:00:00.000Z', target: { type: 'SESSION', id: 's1' } });
    const line = JSON.parse(out[0]);
    expect(line).toMatchObject({ audit: true, action: 'AUTH_LOGIN', correlationId: 'corr-abcdef12', outcome: 'SUCCESS', customerId: 'cust_1', context: 'Audit' });
    expect(line.target).toEqual({ type: 'SESSION', id: 's1' });
    expect(line.msg).toBe('AUTH_LOGIN');
  });
});
