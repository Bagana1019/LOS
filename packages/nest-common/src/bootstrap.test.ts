import 'reflect-metadata';
import { Module } from '@nestjs/common';
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
