import { describe, expect, it } from 'vitest';
import { auditErrorClass, isTransientAuditError } from './audit-errors';

const err = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });

describe('audit write error classification (M10)', () => {
  it.each([
    ['connection reset', new Error('Connection terminated unexpectedly')],
    ['socket', Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' })],
    ['cannot reach DB', err('PrismaClientInitializationError', "Can't reach database server")],
    ['P1001', err('PrismaClientKnownRequestError', 'x', { code: 'P1001' })],
    ['P1017 server closed', err('PrismaClientKnownRequestError', 'x', { code: 'P1017' })],
    ['P2024 pool timeout', err('PrismaClientKnownRequestError', 'x', { code: 'P2024' })],
    ['P2034 write conflict', err('PrismaClientKnownRequestError', 'x', { code: 'P2034' })],
    ['raw 40001 serialization', err('PrismaClientKnownRequestError', 'x', { code: 'P2010', meta: { code: '40001' } })],
    ['raw 57P01 admin shutdown', err('PrismaClientKnownRequestError', 'x', { code: 'P2010', meta: { code: '57P01' } })],
    ['unknown error (keep, never drop)', new Error('something odd')],
    ['non-error value', 'boom'],
  ])('%s → transient', (_n, e) => { expect(isTransientAuditError(e)).toBe(true); });

  it.each([
    ['P2000 value too long', err('PrismaClientKnownRequestError', 'x', { code: 'P2000' }), 'P2000'],
    ['P2007 validation', err('PrismaClientKnownRequestError', 'x', { code: 'P2007' }), 'P2007'],
    ['P2023 inconsistent column', err('PrismaClientKnownRequestError', 'x', { code: 'P2023' }), 'P2023'],
    ['prisma validation', err('PrismaClientValidationError', 'Argument entity: Invalid value'), 'PrismaClientValidationError'],
    ['raw 22021 invalid byte (NUL)', err('PrismaClientUnknownRequestError', 'QueryError(PostgresError { code: "22021", message: "invalid byte" })'), 'PG_22021'],
    ['raw 22P02 invalid text', err('PrismaClientKnownRequestError', 'x', { code: 'P2010', meta: { code: '22P02' } }), 'PG_22P02'],
  ])('%s → permanent, class without payload', (_n, e, cls) => {
    expect(isTransientAuditError(e)).toBe(false);
    expect(auditErrorClass(e)).toBe(cls);
  });
});
