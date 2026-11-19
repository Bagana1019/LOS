import { describe, expect, it } from 'vitest';
import { isAdvisoryLockClient } from './advisory-lock';

describe('isAdvisoryLockClient (DB-less stubs skip the cross-pod lock)', () => {
  it('accepts a client with $transaction (Prisma)', () => {
    expect(isAdvisoryLockClient({ $transaction: async () => undefined })).toBe(true);
  });
  it('rejects missing values and DB-less stubs', () => {
    for (const v of [undefined, null, {}, { $transaction: 'x' }, { onModuleInit: async () => undefined }]) expect(isAdvisoryLockClient(v), JSON.stringify(v)).toBe(false);
  });
});
