// HIGH (C3): a DWH outage must never consume bus delivery attempts; only deterministic failures may lead to the DLQ.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isTransientDwhError } from './transient-error';

const withCode = (code: string, message = 'x') => Object.assign(new Error(message), { code });

describe('isTransientDwhError', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'])('network error %s → transient', (code) => {
    expect(isTransientDwhError(withCode(code))).toBe(true);
  });
  it.each([
    ['08006', 'connection_failure'], ['08001', 'sqlclient_unable_to_establish_sqlconnection'], ['57P01', 'admin_shutdown'], ['57P03', 'cannot_connect_now'],
    ['53300', 'too_many_connections'], ['40001', 'serialization_failure'], ['40P01', 'deadlock_detected'], ['55P03', 'lock_not_available'],
    ['28P01', 'invalid_password (credential rotation)'], ['3D000', 'database does not exist'],
    ['42P01', 'undefined_table (schema behind the code)'], ['42703', 'undefined_column (schema behind the code)'],
  ])('pg SQLSTATE %s (%s) → transient', (code) => {
    expect(isTransientDwhError(withCode(code))).toBe(true);
  });
  it.each(['Connection terminated unexpectedly', 'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect', 'Cannot use a pool after calling end on the pool'])(
    'pg driver message "%s" → transient', (msg) => { expect(isTransientDwhError(new Error(msg))).toBe(true); });
  it('Node AggregateError (all addresses refused, e.g. localhost → ::1 + 127.0.0.1) → transient', () => {
    expect(isTransientDwhError(new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNREFUSED')], ''))).toBe(true);
  });
  it('transient cause wrapped in another error → transient', () => {
    expect(isTransientDwhError(new Error('apply failed', { cause: withCode('ECONNRESET') }))).toBe(true);
  });

  it.each([['22P02', 'invalid_text_representation'], ['22003', 'numeric_value_out_of_range'], ['23505', 'unique_violation'], ['23502', 'not_null_violation'], ['42601', 'syntax_error (code bug)']])(
    'pg SQLSTATE %s (%s) → deterministic', (code) => { expect(isTransientDwhError(withCode(code))).toBe(false); });
  it('schema-invalid payload (ZodError) and malformed JSON → deterministic', () => {
    expect(isTransientDwhError(z.object({ a: z.string() }).safeParse({}).error)).toBe(false);
    expect(isTransientDwhError(new SyntaxError('Unexpected token'))).toBe(false);
  });
  it.each([[null], [undefined], ['ECONNREFUSED'], [42], [{}], [new Error('boom')]])('non-classifiable %j → deterministic', (v) => {
    expect(isTransientDwhError(v)).toBe(false);
  });
  it('a self-referencing cause chain terminates', () => {
    const e = new Error('loop') as Error & { cause?: unknown }; e.cause = e;
    expect(isTransientDwhError(e)).toBe(false);
  });
});
