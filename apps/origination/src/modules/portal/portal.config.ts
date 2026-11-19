/** Эхлэх үеийн тохиргооны алдаа — модуль эхлэхгүй (fail fast, PRT-NFR-6). */
export class PortalConfigError extends Error {
  override readonly name = 'PortalConfigError';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * portal-bff нь X-Org-Id илгээдэггүй тул PortalInternalGuard байгууллагыг DEFAULT_ORG_ID-оос авна.
 * production эсвэл INTEGRATION_MODE=real үед хоосон/UUID биш бол эхлэхгүй; бусад орчинд анхааруулга л бичнэ.
 * @returns trim хийсэн DEFAULT_ORG_ID ('' байж болно — зөвхөн mock/dev)
 */
export function assertPortalOrgConfig(env: NodeJS.ProcessEnv, warn: (message: string) => void): string {
  const orgId = env.DEFAULT_ORG_ID?.trim() ?? '';
  if (UUID.test(orgId)) return orgId;
  const strict = env.NODE_ENV?.trim().toLowerCase() === 'production' || env.INTEGRATION_MODE?.trim().toLowerCase() === 'real';
  const problem = orgId ? 'DEFAULT_ORG_ID is not a UUID' : 'DEFAULT_ORG_ID is not set';
  if (strict) throw new PortalConfigError(`${problem}: the customer portal (portal-bff sends no X-Org-Id) cannot resolve the organisation — refusing to start`);
  warn(`${problem}: /api/internal/portal/* requests without X-Org-Id will be refused (MISSING_ORG) or bound to a non-UUID org`);
  return orgId;
}
