import { describe, expect, it } from 'vitest';
import { isStatementTimeout, statementTimeout } from './report-db';

describe('statementTimeout', () => {
  it('SET LOCAL statement_timeout = <мс>, параметргүй (SET нь $n авдаггүй)', () => {
    const q = statementTimeout(30_000);
    expect(q.text).toBe('SET LOCAL statement_timeout = 30000');
    expect(q.values).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('буруу утга %s → алдаа (SQL-д string холихгүй)', (ms) => {
    expect(() => statementTimeout(ms)).toThrow('statement_timeout');
  });
});

describe('isStatementTimeout', () => {
  it('Prisma P2010 + Postgres 57014 (meta.code эсвэл мессеж)', () => {
    expect(isStatementTimeout({ code: 'P2010', meta: { code: '57014', message: 'canceling statement due to statement timeout' } })).toBe(true);
    expect(isStatementTimeout(new Error('Raw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`'))).toBe(true);
    expect(isStatementTimeout({ message: 'ERROR: canceling statement due to statement timeout' })).toBe(true);
  });

  it('бусад алдаа, утга → false', () => {
    expect(isStatementTimeout(new Error('connection refused'))).toBe(false);
    expect(isStatementTimeout({ code: 'P2024', message: 'Timed out fetching a new connection from the connection pool' })).toBe(false);
    expect(isStatementTimeout({ code: 'P2010', meta: { code: '42P01' } })).toBe(false);
    expect(isStatementTimeout(null)).toBe(false);
    expect(isStatementTimeout('statement timeout')).toBe(false);
    expect(isStatementTimeout(undefined)).toBe(false);
  });
});
