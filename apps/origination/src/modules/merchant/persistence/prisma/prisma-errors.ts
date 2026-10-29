import { Prisma } from './client';

// Prisma алдааг домэйн алдаа руу хөрвүүлэх туслахууд. Алдааны мессеж/meta-д хэрэглэгчийн утга (PII) оруулахгүй: зөвхөн модель, багана.

export interface UniqueViolation { model: string | null; columns: string[] }

/** P2002 (unique constraint) бол зөрчсөн модель, баганыг буцаана. PostgreSQL дээр meta.target = DB баганы нэрс. */
export function uniqueViolation(e: unknown): UniqueViolation | null {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return null;
  const meta = (e.meta ?? {}) as { modelName?: unknown; target?: unknown };
  const target = meta.target;
  const columns = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
  return { model: typeof meta.modelName === 'string' ? meta.modelName : null, columns };
}

/** Зөрчсөн unique нь `column`-ыг агуулж байгаа эсэх (баганы нэр эсвэл constraint-ийн нэр дотор). */
export function violates(v: UniqueViolation | null, model: string, column: string): boolean {
  if (!v || (v.model !== null && v.model !== model)) return false;
  return v.columns.some((c) => c === column || c.includes(column));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `@db.Uuid` баганад uuid биш утга өгвөл Prisma P2023 шиддэг; ийм ID байх боломжгүй тул finder-ууд null/хоосон буцаана (404, оршихыг задруулахгүй). */
export const isUuid = (s: string | undefined | null): s is string => typeof s === 'string' && UUID_RE.test(s);

/** LIKE/ILIKE-ийн wildcard (`%`, `_`) ба escape тэмдэгтийг шууд утгаар нь хайхаар escape хийнэ (Prisma `contains`/`endsWith` өөрөө escape хийдэггүй). */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

export const clampPage = ({ page, pageSize }: { page: number; pageSize: number }) => ({ skip: Math.max(0, (page - 1) * pageSize), take: Math.max(0, pageSize) });
