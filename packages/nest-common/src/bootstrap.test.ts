import 'reflect-metadata';
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapService } from './bootstrap';

@Module({})
class EmptyModule {}

// Port 0 = the OS picks a free port; the env var name is private to this file.
const boot = () => bootstrapService({ service: 'h2-test', module: EmptyModule, portEnv: 'H2_TEST_PORT', defaultPort: 0 });
const PROD_SECRET = 'prod-internal-secret-0123456789';

let createSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { createSpy = vi.spyOn(NestFactory, 'create'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('bootstrapService (H2: fail fast on a missing INTERNAL_AUTH_SECRET in production)', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '                '],
    ['shorter than 16 characters', 'too-short-secret'.slice(0, 15)],
  ])('refuses to start in production when the secret is %s, before an app is created', async (_label, secret) => {
    vi.stubEnv('NODE_ENV', 'production');
    if (secret === undefined) delete process.env.INTERNAL_AUTH_SECRET; else vi.stubEnv('INTERNAL_AUTH_SECRET', secret);

    await expect(boot()).rejects.toThrow(/INTERNAL_AUTH_SECRET/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('starts in production with a sufficiently long secret', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTERNAL_AUTH_SECRET', PROD_SECRET);
    const app = await boot();
    try {
      expect(createSpy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it.each([['development'], ['test']])('still starts without a secret when NODE_ENV=%s', async (nodeEnv) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('INTERNAL_AUTH_SECRET', '');
    const app = await boot();
    try {
      expect(createSpy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

// M8: DB connect retry budget exhausted in onModuleInit → sanitized log + non-zero exit so the orchestrator restarts the pod.
@Injectable()
class DbDownService implements OnModuleInit {
  async onModuleInit() { throw Object.assign(new Error("Can't reach database server at postgresql://los:secret@db:5432"), { name: 'PrismaClientInitializationError', errorCode: 'P1001' }); }
}
@Module({ providers: [DbDownService] })
class DbDownModule {}

describe('bootstrapService (M8: startup failure exits non-zero)', () => {
  it('exits with code 1 and never logs the connection string', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    const writes: string[] = [];
    const capture = (chunk: unknown) => { writes.push(String(chunk)); return true; };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
    for (const m of ['log', 'error', 'warn'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { writes.push(a.map(String).join(' ')); });
    await expect(bootstrapService({ service: 'm8-test', module: DbDownModule, portEnv: 'M8_TEST_PORT', defaultPort: 0 })).rejects.toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
    const out = writes.join('\n');
    expect(out).toContain('P1001');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('postgresql://');
  });
});

describe('bootstrapService (audit seal: audit_log owners need a strong AUDIT_HMAC_KEY in production)', () => {
  const bootAudit = () => bootstrapService({ service: 'seal-test', module: EmptyModule, portEnv: 'H2_TEST_PORT', defaultPort: 0, auditSeal: true });
  const GOOD_KEY = 'prod-audit-hmac-key-0123456789abcdef-XYZ';
  beforeEach(() => { vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('INTERNAL_AUTH_SECRET', PROD_SECRET); });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['the .env.example placeholder', 'dev-audit-hmac-key-change-me-0123456789abcdef'],
    ['shorter than 32 characters', GOOD_KEY.slice(0, 31)],
  ])('refuses to start when the key is %s, before an app is created, without echoing the key', async (_label, key) => {
    if (key === undefined) delete process.env.AUDIT_HMAC_KEY; else vi.stubEnv('AUDIT_HMAC_KEY', key);
    const err = await bootAudit().then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/AUDIT_HMAC_KEY/);
    if (key?.trim()) expect(err?.message).not.toContain(key.trim());
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('starts with a strong key', async () => {
    vi.stubEnv('AUDIT_HMAC_KEY', GOOD_KEY);
    const app = await bootAudit();
    try { expect(createSpy).toHaveBeenCalledTimes(1); } finally { await app.close(); }
  });

  it('refuses AUDIT_SEAL_INTERVAL_MS=0 without the explicit AUDIT_SEAL_DISABLED=true opt-out', async () => {
    vi.stubEnv('AUDIT_HMAC_KEY', GOOD_KEY);
    vi.stubEnv('AUDIT_SEAL_INTERVAL_MS', '0');
    await expect(bootAudit()).rejects.toThrow(/AUDIT_SEAL_DISABLED=true/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('services that own no audit_log (auditSeal unset) do not need the key', async () => {
    delete process.env.AUDIT_HMAC_KEY;
    const app = await boot();
    try { expect(createSpy).toHaveBeenCalledTimes(1); } finally { await app.close(); }
  });
});
