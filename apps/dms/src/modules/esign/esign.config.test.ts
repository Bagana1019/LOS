import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CALLBACK_BASE_URL, DEFAULT_PUBLIC_BASE_URL, envFromConfigService, ESIGN_CONFIG, ESIGN_ENV_NAMES, esignConfigProvider, EsignConfigError, loadEsignConfig,
  type EsignConfig,
} from './esign.config';

const PRODUCTION = {
  NODE_ENV: 'production',
  ESIGN_PUBLIC_BASE_URL: 'https://los.example.mn',
  ESIGN_CALLBACK_BASE_URL: 'https://api.los.example.mn/api',
};

const failure = (env: Record<string, string>): EsignConfigError => {
  try {
    loadEsignConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(EsignConfigError);
    return error as EsignConfigError;
  }
  throw new Error('expected loadEsignConfig to throw');
};

describe('loadEsignConfig', () => {
  it('env хоосон бол brief-ийн default утгууд', () => {
    expect(loadEsignConfig({})).toEqual<EsignConfig>({
      publicBaseUrl: 'http://localhost:3000', callbackBaseUrl: 'http://localhost:4000/api', linkTtlHours: 72, sessionTtlSeconds: 300, maxAttempts: 3, sweepIntervalSec: 60,
      finalizingStaleSec: 300, signedCopyTtlDays: 30,
    });
    expect(DEFAULT_PUBLIC_BASE_URL).toBe('http://localhost:3000');
    expect(DEFAULT_CALLBACK_BASE_URL).toBe('http://localhost:4000/api');
  });

  it('process.env-ээс анхдагчаар уншина', () => {
    const previous = process.env.ESIGN_MAX_ATTEMPTS;
    process.env.ESIGN_MAX_ATTEMPTS = '5';
    try {
      expect(loadEsignConfig().maxAttempts).toBe(5);
    } finally {
      if (previous === undefined) delete process.env.ESIGN_MAX_ATTEMPTS;
      else process.env.ESIGN_MAX_ATTEMPTS = previous;
    }
  });

  it('env-ээр бүх утгыг дарж болно; URL-ийн төгсгөлийн "/"-г хасна', () => {
    expect(
      loadEsignConfig({
        ESIGN_PUBLIC_BASE_URL: 'https://los.example.mn///', ESIGN_CALLBACK_BASE_URL: 'https://api.example.mn/api/', ESIGN_LINK_TTL_HOURS: '24', ESIGN_SESSION_TTL_SECONDS: '120',
        ESIGN_MAX_ATTEMPTS: '5', ESIGN_SWEEP_INTERVAL_SEC: '15', ESIGN_FINALIZING_STALE_SEC: '600', ESIGN_SIGNED_COPY_TTL_DAYS: '7',
      }),
    ).toEqual({
      publicBaseUrl: 'https://los.example.mn', callbackBaseUrl: 'https://api.example.mn/api', linkTtlHours: 24, sessionTtlSeconds: 120, maxAttempts: 5, sweepIntervalSec: 15,
      finalizingStaleSec: 600, signedCopyTtlDays: 7,
    });
  });

  it('хоосон / зөвхөн зайтай утгыг "тохируулаагүй" гэж үзнэ (docker-compose `VAR=`)', () => {
    expect(loadEsignConfig({ ESIGN_LINK_TTL_HOURS: '', ESIGN_PUBLIC_BASE_URL: '   ', ESIGN_MAX_ATTEMPTS: ' 4 ' })).toMatchObject({ linkTtlHours: 72, publicBaseUrl: DEFAULT_PUBLIC_BASE_URL, maxAttempts: 4 });
  });

  it('ESIGN_SWEEP_INTERVAL_SEC=0 нь sweeper-ийг унтраана (хүчинтэй утга)', () => {
    expect(loadEsignConfig({ ESIGN_SWEEP_INTERVAL_SEC: '0' }).sweepIntervalSec).toBe(0);
  });

  it.each([
    ['ESIGN_LINK_TTL_HOURS', ['0', '169', '1.5', 'abc', '-1']],
    ['ESIGN_SESSION_TTL_SECONDS', ['29', '3601', 'x']],
    ['ESIGN_MAX_ATTEMPTS', ['0', '11', '2.5', 'many']],
    ['ESIGN_SWEEP_INTERVAL_SEC', ['-1', '3601', 'fast']],
    ['ESIGN_FINALIZING_STALE_SEC', ['29', '86401', 'soon']],
  ])('%s: хүрээнээс гарсан/тоо биш утга → алдаа; мессежид ЗӨВХӨН нэр', (name, values) => {
    for (const value of values) {
      const error = failure({ [name]: value });
      expect(error.message).toBe(`Invalid ${name}`);
      expect(error.message).not.toContain(value);
    }
  });

  it.each(['not a url', 'ftp://los.example.mn', 'https://user:secret-pass@los.example.mn', 'https://los.example.mn/?token=abc', 'https://los.example.mn/#frag', 'javascript:alert(1)'])(
    'ESIGN_PUBLIC_BASE_URL=%s → алдаа, утга (нууц) мессежид орохгүй',
    (value) => {
      const error = failure({ ESIGN_PUBLIC_BASE_URL: value });
      expect(error.message).toBe('Invalid ESIGN_PUBLIC_BASE_URL');
    },
  );

  it('хэд хэдэн буруу хувьсагчийг нэг мессежид, давхардалгүй жагсаана', () => {
    const error = failure({ ESIGN_LINK_TTL_HOURS: '0', ESIGN_MAX_ATTEMPTS: '0', ESIGN_CALLBACK_BASE_URL: 'nope' });
    expect(error.message).toBe('Invalid ESIGN_CALLBACK_BASE_URL, ESIGN_LINK_TTL_HOURS, ESIGN_MAX_ATTEMPTS');
  });

  describe('NODE_ENV=production', () => {
    it('бүх шаардлагатай нь байвал амжилттай', () => {
      expect(loadEsignConfig(PRODUCTION)).toMatchObject({ publicBaseUrl: 'https://los.example.mn', callbackBaseUrl: 'https://api.los.example.mn/api' });
    });

    it.each(['ESIGN_PUBLIC_BASE_URL', 'ESIGN_CALLBACK_BASE_URL'])('%s байхгүй бол эхлэхэд алдаа', (name) => {
      const env: Record<string, string> = { ...PRODUCTION };
      delete env[name];
      expect(failure(env).message).toBe(`Missing ${name}: required when NODE_ENV=production`);
    });

    it('хоосон утга "байхгүй"-тэй адил; бүгдийг нэг дор жагсаана', () => {
      expect(failure({ NODE_ENV: 'production', ESIGN_PUBLIC_BASE_URL: '  ' }).message).toBe(
        'Missing ESIGN_PUBLIC_BASE_URL, ESIGN_CALLBACK_BASE_URL: required when NODE_ENV=production',
      );
    });

    it('http:// URL-ийг татгалзана (линк, webhook https байх ёстой)', () => {
      const error = failure({ ...PRODUCTION, ESIGN_PUBLIC_BASE_URL: 'http://los.example.mn', ESIGN_CALLBACK_BASE_URL: 'http://api.example.mn/api' });
      expect(error.message).toBe('ESIGN_PUBLIC_BASE_URL, ESIGN_CALLBACK_BASE_URL must use https when NODE_ENV=production');
    });

    it('production биш үед URL http байж болно', () => {
      expect(loadEsignConfig({ NODE_ENV: 'development' }).publicBaseUrl).toBe('http://localhost:3000');
    });
  });
});

describe('ConfigService / DI', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    for (const name of ESIGN_ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it('envFromConfigService: ESIGN_* ба NODE_ENV-ийг ConfigService-ээс авна', async () => {
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ ESIGN_MAX_ATTEMPTS: '9', ESIGN_PUBLIC_BASE_URL: 'https://x.example' })] })] }).compile();
    const env = envFromConfigService(module.get(ConfigService));
    expect(env.ESIGN_MAX_ATTEMPTS).toBe('9');
    expect(env.ESIGN_PUBLIC_BASE_URL).toBe('https://x.example');
    expect(Object.keys(env).sort()).toEqual([...ESIGN_ENV_NAMES].sort());
  });

  it('ESIGN_CONFIG token: ConfigService байвал түүнээс (.env-ийн утгыг ч агуулна)', async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ ESIGN_LINK_TTL_HOURS: '48', ESIGN_SWEEP_INTERVAL_SEC: '0' })] })],
      providers: [esignConfigProvider],
    }).compile();
    expect(module.get<EsignConfig>(ESIGN_CONFIG)).toMatchObject({ linkTtlHours: 48, sweepIntervalSec: 0, maxAttempts: 3 });
  });

  it('ESIGN_CONFIG token: ConfigService байхгүй бол process.env-ээс', async () => {
    process.env.ESIGN_MAX_ATTEMPTS = '6';
    const module = await Test.createTestingModule({ providers: [esignConfigProvider] }).compile();
    expect(module.get<EsignConfig>(ESIGN_CONFIG).maxAttempts).toBe(6);
  });

  it('буруу тохиргоо DI үүсгэх үед (апп эхлэхэд) алдаа өгнө', async () => {
    process.env.ESIGN_MAX_ATTEMPTS = 'zero';
    await expect(Test.createTestingModule({ providers: [esignConfigProvider] }).compile()).rejects.toThrow('Invalid ESIGN_MAX_ATTEMPTS');
  });
});
