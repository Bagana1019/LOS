import { describe, expect, it } from 'vitest';
import { EnvConfigError } from '../common/env';
import { IMPORT_DEFAULTS, resolveImportOptions, SYSTEM_CLOCK } from './import.defaults';

describe('resolveImportOptions', () => {
  it('uses the documented defaults for an empty environment', () => {
    expect(resolveImportOptions({})).toEqual(IMPORT_DEFAULTS);
    expect(Object.isFrozen(resolveImportOptions({}))).toBe(true);
  });

  it('reads every documented environment variable', () => {
    expect(resolveImportOptions({
      BSA_IMPORT_MAX_ROWS: '1000',
      BSA_IMPORT_EXTRACT_TIMEOUT_MS: '2000',
      BSA_IMPORT_JOB_TIMEOUT_MS: '3000',
      BSA_IMPORT_CHUNK_ROWS: '50',
      BSA_RETENTION_BATCH: '7',
      BSA_RETENTION_INTERVAL_MS: '60000',
    })).toMatchObject({
      maxRowsPerFile: 1000, extractTimeoutMs: 2000, jobTimeoutMs: 3000, insertChunkRows: 50, retentionBatchSize: 7, retentionIntervalMs: 60_000,
    });
  });

  it('overrides win over the environment, and a zero interval disables the timer', () => {
    expect(resolveImportOptions({ BSA_IMPORT_MAX_ROWS: '10' }, { maxRowsPerFile: 20 }).maxRowsPerFile).toBe(20);
    expect(resolveImportOptions({ BSA_RETENTION_INTERVAL_MS: '0' }).retentionIntervalMs).toBe(0);
  });

  it('rejects invalid values loudly', () => {
    expect(() => resolveImportOptions({ BSA_IMPORT_MAX_ROWS: '0' })).toThrow(EnvConfigError);
    expect(() => resolveImportOptions({ BSA_IMPORT_CHUNK_ROWS: 'abc' })).toThrow(EnvConfigError);
    expect(() => resolveImportOptions({ BSA_IMPORT_CHUNK_ROWS: '100000' })).toThrow(EnvConfigError);
    expect(() => resolveImportOptions({}, { jobTimeoutMs: 0 })).toThrow(EnvConfigError);
    expect(() => resolveImportOptions({}, { retentionIntervalMs: -1 })).toThrow(EnvConfigError);
  });

  it('the system clock returns a fresh Date', () => {
    const a = SYSTEM_CLOCK.now();
    expect(a).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - a.getTime())).toBeLessThan(1000);
  });
});
