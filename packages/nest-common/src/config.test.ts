import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFilePaths, isProduction, isTestRuntime, loadEnvFiles, requireEnv, resolveEnvFilePaths } from './config';

const PROBE = 'LOS_CONFIG_TEST_PROBE';
const PROD = { NODE_ENV: 'production' } as const;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'los-config-test-')); delete process.env[PROBE]; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env[PROBE]; });

describe('isTestRuntime', () => {
  it.each([[{ NODE_ENV: 'test' }], [{ NODE_ENV: 'TEST' }], [{ NODE_ENV: ' test ' }], [{ VITEST: 'true' }], [{ NODE_ENV: 'production', VITEST: 'true' }]])('is true for %j', (env) => {
    expect(isTestRuntime(env)).toBe(true);
  });

  it.each([[{}], [{ NODE_ENV: 'production' }], [{ NODE_ENV: 'development' }], [{ NODE_ENV: '' }], [{ VITEST: '' }]])('is false for %j', (env) => {
    expect(isTestRuntime(env)).toBe(false);
  });
});

describe('isProduction', () => {
  it.each([['production'], ['Production'], ['PRODUCTION'], [' production ']])('is true for NODE_ENV=%j', (nodeEnv) => {
    expect(isProduction({ NODE_ENV: nodeEnv })).toBe(true);
  });

  it.each([['development'], ['test'], ['staging'], ['']])('is false for NODE_ENV=%j', (nodeEnv) => {
    expect(isProduction({ NODE_ENV: nodeEnv })).toBe(false);
  });

  it('is false when NODE_ENV is unset', () => {
    expect(isProduction({})).toBe(false);
  });
});

describe('env files must not be loaded under test (H7)', () => {
  it('resolveEnvFilePaths returns no files in a test runtime, the app and root .env otherwise', () => {
    expect(resolveEnvFilePaths({ NODE_ENV: 'test' })).toEqual([]);
    expect(resolveEnvFilePaths({ VITEST: 'true' })).toEqual([]);
    expect(resolveEnvFilePaths({ NODE_ENV: 'production' })).toEqual(['.env', '../../.env']);
    expect(resolveEnvFilePaths({})).toEqual(['.env', '../../.env']);
  });

  it('envFilePaths (what every AppModule passes to ConfigModule.forRoot) is empty in this vitest run', () => {
    expect(envFilePaths).toEqual([]);
  });

  it('loadEnvFiles leaves process.env untouched in a test runtime even when a .env exists', () => {
    writeFileSync(join(dir, '.env'), `${PROBE}=from-file\n`);
    loadEnvFiles(dir); // this process is a vitest worker
    expect(process.env[PROBE]).toBeUndefined();
  });

  it('loadEnvFiles loads the app .env outside tests', () => {
    writeFileSync(join(dir, '.env'), `${PROBE}=from-file\n`);
    loadEnvFiles(dir, PROD);
    expect(process.env[PROBE]).toBe('from-file');
  });

  it('loadEnvFiles loads the monorepo root .env (two levels up) outside tests', () => {
    const app = join(dir, 'apps', 'svc');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(dir, '.env'), `${PROBE}=from-root\n`);
    loadEnvFiles(app, PROD);
    expect(process.env[PROBE]).toBe('from-root');
  });

  it('loadEnvFiles never overrides a variable that is already set', () => {
    process.env[PROBE] = 'from-shell';
    writeFileSync(join(dir, '.env'), `${PROBE}=from-file\n`);
    loadEnvFiles(dir, PROD);
    expect(process.env[PROBE]).toBe('from-shell');
  });

  it('loadEnvFiles does not fail when there is no .env at all', () => {
    expect(() => loadEnvFiles(dir, PROD)).not.toThrow();
  });
});

describe('requireEnv', () => {
  it('returns the value', () => {
    process.env[PROBE] = 'value';
    expect(requireEnv(PROBE)).toBe('value');
  });

  it.each([['unset', undefined], ['empty', ''], ['whitespace only', '   ']])('throws when the variable is %s, naming it', (_label, value) => {
    if (value === undefined) delete process.env[PROBE]; else process.env[PROBE] = value;
    expect(() => requireEnv(PROBE)).toThrow(`Missing required env ${PROBE}`);
  });
});
