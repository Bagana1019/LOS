// CUSTOMER/UPDATE (эзэмшигч бус салбарын засварын хүсэлт) — inbox-ийн "Өмнө → Дараа"-д уншигдахуйц хэлбэр.
// Сервер payload-г `{ changes, cleared }` хэлбэрээр, дэлгэрэнгүйд шифр тайлж өгнө; тайлж чадаагүй бол зөвхөн талбарын нэрс (PII-гүй).
import { mn } from '@los/ui';
import { isPlainObject } from './diff';

const dict: Record<string, string> = mn;
export const CUSTOMER_TARGET_TYPE = 'CUSTOMER';

export interface DiffSides {
  before: unknown;
  after: unknown;
  /** Шифрлэгдсэн хэвээр ирсэн бол өөрчлөгдөх талбарын нэрс; бусад үед null */
  sealedFields: string[] | null;
}

interface RequestLike { targetType: string; before?: unknown; payload?: unknown }

const sealedSummary = (v: unknown): string[] | null => {
  if (!isPlainObject(v) || typeof v.sealed !== 'string') return null;
  const fields = isPlainObject(v.summary) ? v.summary.fields : undefined;
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string') : [];
};

export function diffSides(dto: RequestLike): DiffSides {
  if (dto.targetType !== CUSTOMER_TARGET_TYPE) return { before: dto.before, after: dto.payload, sealedFields: null };
  const sealed = sealedSummary(dto.payload);
  if (sealed) return { before: null, after: null, sealedFields: sealed };
  const p = isPlainObject(dto.payload) ? dto.payload : {};
  const changes = isPlainObject(p.changes) ? p.changes : {};
  const cleared = new Set(Array.isArray(p.cleared) ? p.cleared.filter((k): k is string => typeof k === 'string') : []);
  // Арилгасан талбар "Дараа" талд байхгүй → diff-д "Устгагдсан" гэж харагдана
  const after = Object.fromEntries(Object.entries(changes).filter(([k]) => !cleared.has(k)));
  return { before: dto.before, after, sealedFields: null };
}

/** Харилцагчийн хүсэлтэд талбарын замыг маягтын нэрээр (`customer.field.*`); бусад төрөлд түүхий зам */
export function fieldLabelFor(targetType: string): (path: string) => string {
  if (targetType !== CUSTOMER_TARGET_TYPE) return (path) => path;
  return (path) => {
    const [head, ...rest] = path.split('.');
    const key = `customer.field.${head}`;
    if (!Object.hasOwn(dict, key)) return path;
    return rest.length ? `${dict[key]} · ${rest.join('.')}` : dict[key];
  };
}
