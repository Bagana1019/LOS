import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CommonModule } from '@los/nest-common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../../integrations/esign/provider.registry';
import { IntegrationsConfigError } from '../../integrations/esign/integrations.config';
import { PrismaModule, PrismaService } from '../../prisma.service';
import { DatabaseFieldCipher } from './adapters/database-field-cipher';
import { PrismaSigningFiles } from './adapters/prisma-signing-files';
import { ESIGN_CONFIG, type EsignConfig } from './esign.config';
import { EsignModule } from './esign.module';
import { PdfLibStamper } from './pdf/pdf-lib-stamper';
import { FIELD_CIPHER } from './ports/field-cipher.port';
import { PDF_STAMPER } from './ports/pdf-stamper.port';
import { SIGNING_FILES } from './ports/signing-files.port';
import { SIGNING_STORE } from './ports/signing.store';
import { SigningSweeperService } from './signing-sweeper.service';
import { SigningService } from './signing.service';
import { PrismaSigningStore } from './stores/prisma-signing.store';
import { applyE2eEnv, PUBLIC_BASE_URL } from './http/testing/e2e-app';

let restoreEnv: (() => void) | undefined;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreEnv?.();
  restoreEnv = undefined;
});

/** main-ийн AppModule-ийн хэлбэр (CommonModule + глобал PrismaModule); DB-д холбогдохгүйн тулд PrismaService stub */
async function compile() {
  return Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), CommonModule.forRoot(), PrismaModule, EsignModule.register()] })
    .overrideProvider(PrismaService).useValue({})
    .compile();
}

/** Амжилттай compile хийвэл assertion-ий алдаа TestingModule-ийг сериалчлахгүйн тулд string болгоно */
const compileFailure = (): Promise<string> => compile().then(() => 'compiled without error');

describe('EsignModule: wiring', () => {
  it('бодит гүйцэтгэлүүд холбогдож, SigningService үүснэ (PrismaSigningStore, PrismaSigningFiles, DatabaseFieldCipher)', async () => {
    restoreEnv = applyE2eEnv();
    const moduleRef = await compile();
    const get = <T>(token: unknown): T => moduleRef.get<T>(token as never, { strict: false });

    expect(get(SIGNING_STORE)).toBeInstanceOf(PrismaSigningStore);
    expect(get(SIGNING_FILES)).toBeInstanceOf(PrismaSigningFiles);
    expect(get(PDF_STAMPER)).toBeInstanceOf(PdfLibStamper);
    expect(get(FIELD_CIPHER)).toBeInstanceOf(DatabaseFieldCipher);
    expect(get(SigningService)).toBeInstanceOf(SigningService);
    expect(get(SigningSweeperService)).toBeInstanceOf(SigningSweeperService);
    expect(get<EsignConfig>(ESIGN_CONFIG)).toMatchObject({ publicBaseUrl: PUBLIC_BASE_URL, linkTtlHours: 72, sessionTtlSeconds: 300, maxAttempts: 3, sweepIntervalSec: 0, signedCopyTtlDays: 30 });
    expect(get<ProviderRegistry>(ProviderRegistry).list().map((provider) => [provider.code, provider.isMock])).toEqual([['TRIDUM', true], ['MONPASS', true]]);
    await moduleRef.close();
  });

  it('HTTP route-ууд бүртгэгдсэн: дотоод + public + (mock горимд) dev', async () => {
    restoreEnv = applyE2eEnv();
    const app = (await compile()).createNestApplication({ logger: false });
    await app.init();
    const router = app.getHttpAdapter().getInstance()._router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    const routes = router.flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route!.path}`) : []));
    expect(routes).toEqual(expect.arrayContaining([
      'POST /esign/requests', 'GET /esign/requests', 'GET /esign/requests/:id', 'POST /esign/requests/:id/resend', 'POST /esign/requests/:id/cancel',
      'GET /esign/requests/:id/signed-document', 'GET /esign/requests/:id/signature',
      'GET /public/esign/verify/:code', 'POST /public/esign/callback/:provider', 'GET /public/esign/:token', 'GET /public/esign/:token/document',
      'POST /public/esign/:token/start', 'GET /public/esign/:token/status', 'POST /public/esign/:token/decline', 'GET /public/esign/:token/signed-document',
      'POST /dev/esign/mock/:providerRef/approve',
    ]));
    // Route-ийн дараалал: `verify/:code`, `callback/:provider` нь `:token`-оос өмнө
    expect(routes.indexOf('GET /public/esign/verify/:code')).toBeLessThan(routes.indexOf('GET /public/esign/:token'));
    await app.close();
  });
});

describe('EsignModule: тохиргооны хамгаалалт (чимээгүй fallback байхгүй)', () => {
  it('NODE_ENV=production + mock provider → register() үед алдаа', () => {
    restoreEnv = applyE2eEnv({ NODE_ENV: 'production' });
    expect(() => EsignModule.register()).toThrow(IntegrationsConfigError);
  });

  it('production + real: ESIGN_PUBLIC_BASE_URL дутуу → compile алдаа (env-ийн нэр л хэлнэ)', async () => {
    restoreEnv = applyE2eEnv({ NODE_ENV: 'production', INTEGRATION_MODE: 'real', ESIGN_CALLBACK_BASE_URL: 'https://api.example.test/api' });
    delete process.env.ESIGN_PUBLIC_BASE_URL;
    await expect(compileFailure()).rejects.toThrow(/ESIGN_PUBLIC_BASE_URL/);
  });
});

describe('EsignModule: sweeper', () => {
  it('ESIGN_SWEEP_INTERVAL_SEC>0: интервалаар sweep дуудна, апп хаагдахад зогсоно', async () => {
    vi.useFakeTimers();
    restoreEnv = applyE2eEnv({ ESIGN_SWEEP_INTERVAL_SEC: '5' });
    const sweep = vi.spyOn(SigningService.prototype, 'sweep').mockResolvedValue({ scanned: 0, signed: 0, expired: 0, declined: 0, failed: 0, retried: 0, errors: 0 });
    const app = (await compile()).createNestApplication({ logger: false });
    await app.init();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    await app.close();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('ESIGN_SWEEP_INTERVAL_SEC=0: ажиллахгүй', async () => {
    vi.useFakeTimers();
    restoreEnv = applyE2eEnv({ ESIGN_SWEEP_INTERVAL_SEC: '0' });
    const sweep = vi.spyOn(SigningService.prototype, 'sweep');
    const app = (await compile()).createNestApplication({ logger: false });
    await app.init();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sweep).not.toHaveBeenCalled();
    await app.close();
  });
});
