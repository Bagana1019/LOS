import { describe, expect, it } from 'vitest';
import { resolveDwhUrl } from './dwh-config';

// CLAUDE.md §2 / §3: dwh-sync writes only to the DWH and never to the operational DB.
describe('resolveDwhUrl', () => {
  it('returns DWH_DATABASE_URL when it points to a different database than DATABASE_URL', () => {
    const env = { DWH_DATABASE_URL: 'postgresql://dwh:dwh@localhost:5433/dwh', DATABASE_URL: 'postgresql://los:los@localhost:5432/los' };
    expect(resolveDwhUrl(env)).toBe(env.DWH_DATABASE_URL);
  });
  it('allows the same server when the database name differs', () => {
    expect(resolveDwhUrl({ DWH_DATABASE_URL: 'postgresql://a:b@h:5432/dwh', DATABASE_URL: 'postgresql://a:b@h:5432/los' })).toContain('/dwh');
  });
  it('fails fast when DWH_DATABASE_URL is missing or empty', () => {
    expect(() => resolveDwhUrl({})).toThrow(/DWH_DATABASE_URL/);
    expect(() => resolveDwhUrl({ DWH_DATABASE_URL: '' })).toThrow(/DWH_DATABASE_URL/);
  });
  it('fails on an unparseable URL', () => {
    expect(() => resolveDwhUrl({ DWH_DATABASE_URL: 'nope' })).toThrow(/DWH_DATABASE_URL/);
  });
  it('refuses to run against the operational database (same host, port and db; credentials/query ignored)', () => {
    expect(() => resolveDwhUrl({ DWH_DATABASE_URL: 'postgresql://x:y@LOCALHOST:5432/los?schema=dwh', DATABASE_URL: 'postgresql://los:los@localhost:5432/los' })).toThrow(/operational/);
    expect(() => resolveDwhUrl({ DWH_DATABASE_URL: 'postgresql://x:y@localhost/los', DATABASE_URL: 'postgresql://los:los@localhost:5432/los' })).toThrow(/operational/);
  });
  it('never echoes credentials in the error message', () => {
    try { resolveDwhUrl({ DWH_DATABASE_URL: 'postgresql://u:s3cret@localhost:5432/los', DATABASE_URL: 'postgresql://u:s3cret@localhost:5432/los' }); } catch (e) {
      expect(String(e)).not.toContain('s3cret');
      return;
    }
    throw new Error('expected throw');
  });
});
