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
