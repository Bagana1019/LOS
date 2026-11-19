// FATF тохиргоо: env → config. FATF_LIST_FILE = үйл ажиллагааны баг шинэчилдэг жагсаалтын файлын зам (нууц биш). Алдаа зөвхөн хувьсагчийн НЭРийг заана.
import { ExternalListError, IntegrationNotConfiguredError } from '../errors';
import { assertRealIntegrationEnv, isProduction, requireEnv } from '../integration-env';
import { resolveIntegrationMode } from '../integration-mode';
import { parseFatfList, readFatfListFile } from './fatf-list';

type Env = Record<string, string | undefined>;

/** Production + real үед заавал. */
export const FATF_REQUIRED_ENV = ['FATF_LIST_FILE'] as const;

export interface FatfConfig { listFile: string }

export function loadFatfConfig(env: Env = process.env): FatfConfig {
  const e = requireEnv('fatf', FATF_REQUIRED_ENV, env);
  return { listFile: e.FATF_LIST_FILE!.trim() };
}

/**
 * Phase 5: production + real → FATF_LIST_FILE заавал, файл уншигдаж, хатуу шалгалтаас гарна. Буруу файлтай deploy эхлэхгүй:
 * ажиллах үед 503 (AML "жагсаалт байхгүй") болж хэрэглэгчид нөлөөлөхөөс өмнө deploy дээр илэрнэ.
 * Production биш / mock үед файлыг ч уншихгүй.
 */
export function assertFatfProductionConfig(env: Env = process.env): void {
  assertRealIntegrationEnv('fatf', FATF_REQUIRED_ENV, env);
  if (!isProduction(env) || resolveIntegrationMode(env) !== 'real') return;
  let text: string;
  try {
    text = readFatfListFile(loadFatfConfig(env).listFile);
  } catch (e) {
    const unreadable = !(e instanceof ExternalListError) || e.reason.includes('unreadable');
    throw new IntegrationNotConfiguredError('fatf', [unreadable ? 'FATF_LIST_FILE (unreadable)' : 'FATF_LIST_FILE (invalid)']);
  }
  try {
    parseFatfList(text);
  } catch {
    throw new IntegrationNotConfiguredError('fatf', ['FATF_LIST_FILE (invalid)']);
  }
}
