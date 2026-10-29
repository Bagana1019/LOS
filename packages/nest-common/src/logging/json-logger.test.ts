import { describe, expect, it } from 'vitest';
import { runWithContext, systemContext } from '../context/request-context';
import { JsonLogger, redact } from './json-logger';

describe('JsonLogger', () => {
  const make = (level?: string) => { const lines: string[] = []; return { lines, log: new JsonLogger('svc', level, (l) => lines.push(l)) }; };
  it('writes one JSON line with service, level and correlationId', () => {
    const { lines, log } = make();
    runWithContext(systemContext('o1', 'corr-9'), () => log.log('hello', 'Ctx'));
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({ level: 'log', service: 'svc', msg: 'hello', context: 'Ctx', correlationId: 'corr-9' });
  });
  it('respects the minimum level', () => {
    const { lines, log } = make('warn');
    log.debug('x'); log.log('y'); log.warn('z');
    expect(lines).toHaveLength(1);
  });
  it('redacts personal data and secrets in structured payloads (CLAUDE.md §6.5)', () => {
    expect(redact({ registerNo: 'УБ12345678', accountNo: '5000', password: 'p', nested: { token: 't', ok: 1 }, list: [{ iban: 'MN12' }] }))
      .toEqual({ registerNo: '[redacted]', accountNo: '[redacted]', password: '[redacted]', nested: { token: '[redacted]', ok: 1 }, list: [{ iban: '[redacted]' }] });
    const { lines, log } = make();
    log.log('evt', { registerNo: 'УБ12345678', amount: 5 });
    expect(lines[0]).not.toContain('УБ12345678');
  });
});
