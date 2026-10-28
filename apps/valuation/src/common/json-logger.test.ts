import { afterEach, describe, it, expect, vi } from 'vitest';
import { JsonLogger } from './json-logger';

const out = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
const err = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
const lines = (spy: ReturnType<typeof out>): Record<string, unknown>[] => spy.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));

afterEach(() => vi.restoreAllMocks());

describe('JsonLogger', () => {
  it('writes one JSON object per line with level, time and context', () => {
    const stdout = out();
    new JsonLogger().log('Nest application successfully started', 'NestApplication');
    expect(String(stdout.mock.calls[0][0])).toMatch(/^\{.*\}\n$/);
    expect(lines(stdout)[0]).toEqual({
      message: 'Nest application successfully started',
      level: 'log',
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      context: 'NestApplication',
    });
  });

  it('merges a message that is already a JSON object instead of double-encoding it', () => {
    const stdout = out();
    new JsonLogger().warn(JSON.stringify({ event: 'listing_source_failed', source: 'SITE_A', code: 'TIMEOUT', correlationId: 'c-1' }), 'AutoValuationService');
    expect(lines(stdout)[0]).toMatchObject({
      event: 'listing_source_failed',
      source: 'SITE_A',
      code: 'TIMEOUT',
      correlationId: 'c-1',
      level: 'warn',
      context: 'AutoValuationService',
    });
  });

  it('does not let a message override level, time or context', () => {
    const stdout = out();
    new JsonLogger().log(JSON.stringify({ level: 'fake', time: 'yesterday', context: 'spoof', event: 'x' }), 'Real');
    expect(lines(stdout)[0]).toMatchObject({ level: 'log', context: 'Real', event: 'x' });
    expect(lines(stdout)[0].time).not.toBe('yesterday');
  });

  it.each(['[1,2]', '"text"', '12', 'not json', '{broken'])('keeps %s as a plain message', (text) => {
    const stdout = out();
    new JsonLogger().log(text);
    expect(lines(stdout)[0]).toMatchObject({ message: text, level: 'log' });
  });

  it('writes errors and fatals to stderr with the stack', () => {
    const stdout = out();
    const stderr = err();
    const logger = new JsonLogger();
    logger.error('boom', 'Error: boom\n    at x', 'ExceptionsHandler');
    logger.fatal('dead');
    expect(stdout).not.toHaveBeenCalled();
    expect(lines(stderr)[0]).toMatchObject({ message: 'boom', level: 'error', stack: 'Error: boom\n    at x', context: 'ExceptionsHandler' });
    expect(lines(stderr)[1]).toMatchObject({ message: 'dead', level: 'fatal' });
  });

  it('writes debug and verbose to stdout', () => {
    const stdout = out();
    const logger = new JsonLogger();
    logger.debug('d');
    logger.verbose('v');
    expect(lines(stdout).map((l) => l.level)).toEqual(['debug', 'verbose']);
  });

  it('accepts an Error or any other value as the message', () => {
    const stdout = out();
    const logger = new JsonLogger();
    logger.log(new RangeError('bad'));
    logger.log(42);
    logger.log(undefined);
    expect(lines(stdout).map((l) => l.message)).toEqual(['bad', '42', 'undefined']);
  });
});
