// НҮБ-ын нэгдсэн жагсаалтын тохиргоо: env → config. Эх сурвалж нь НИЙТИЙН файл тул заавал шаардах env байхгүй (нууц байхгүй).
// Алдаа зөвхөн хувьсагчийн НЭРийг заана.
import { IntegrationNotConfiguredError } from '../errors';
import { isProduction } from '../integration-env';
import { resolveIntegrationMode } from '../integration-mode';

type Env = Record<string, string | undefined>;

export const UN_SC_DEFAULT_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';
/** scsanctions.un.org нь файлыг өөрийн хостоос биш, UN-ийн Azure Blob-ийн богино настай SAS холбоос руу 302-оор шилжүүлдэг (2026-11-19-нд шалгасан). */
export const UN_SC_STORAGE_HOST = 'unsolprodfiles.blob.core.windows.net';
export const UN_SC_DEFAULT_TIMEOUT_MS = 15_000; // CLAUDE.md §3.1: гадаад дуудлага 15с
export const UN_SC_MAX_BYTES = 32 * 1024 * 1024; // бодит файл ~2.2 MB; хязгаар нь буруу / хортой хариуны санах ойг хамгаална
export const UN_SC_MAX_REDIRECTS = 3;

export interface UnScConfig {
  url: string;
  /** Redirect-ээр очихыг зөвшөөрсөн нэмэлт хостууд (жижиг үсгээр). Анхдагчаар: url-ийн хост + UN_SC_STORAGE_HOST. */
  extraRedirectHosts: string[];
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function readUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const ok = (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    return ok ? value : undefined;
  } catch {
    return undefined;
  }
}

export function loadUnScConfig(env: Env = process.env): UnScConfig {
  const invalid: string[] = [];
  const rawUrl = env.UN_SC_URL?.trim();
  const url = rawUrl ? readUrl(rawUrl) : UN_SC_DEFAULT_URL;
  if (!url) invalid.push('UN_SC_URL (invalid)');

  const hosts = (env.UN_SC_REDIRECT_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hosts.some((h) => !HOSTNAME.test(h))) invalid.push('UN_SC_REDIRECT_HOSTS (invalid)');

  if (invalid.length) throw new IntegrationNotConfiguredError('un-sc', invalid);
  return { url: url as string, extraRedirectHosts: hosts };
}

/**
 * Phase 5: production + real → тохиргоо зөв, UN_SC_URL нь https (жагсаалтыг http-ээр татвал дундаас сольж "цэвэр" жагсаалт өгч болно).
 * Production биш / mock үед юу ч хийхгүй — тэнд дуудлага бүр fail-closed хэвээр.
 */
export function assertUnScProductionConfig(env: Env = process.env): void {
  if (!isProduction(env) || resolveIntegrationMode(env) !== 'real') return;
  const cfg = loadUnScConfig(env);
  if (new URL(cfg.url).protocol !== 'https:') throw new Error('UN_SC_URL must use https in production. Refusing to start');
}
