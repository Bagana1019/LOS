import { decryptedField, maskRegisterNo } from '@los/database';
import type { ReportColumn, ReportRow } from '@los/contracts';

export type Raw = Record<string, unknown>;
type Cell = ReportRow[string];

export const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON * Math.sign(n)) * f) / f;
};

/** Prisma raw-ийн утга (bigint / Decimal / number / string) → number; хоосон / тоо биш бол null. */
export function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(String(v));
  return Number.isFinite(n) ? n : null;
}

/** SQL-ийн утгыг баганы төрлөөр API-ийн утга болгоно. money — 2 орон, percent (харьцаа) — 6 орон. */
export function convertValue(type: ReportColumn['type'], v: unknown): Cell {
  if (v == null) return null;
  switch (type) {
    case 'money': { const n = toNumber(v); return n === null ? null : round(n, 2); }
    case 'percent': { const n = toNumber(v); return n === null ? null : round(n, 6); }
    case 'number': { const n = toNumber(v); return n === null ? null : round(n, 2); }
    default:
      if (typeof v === 'boolean') return v;
      return String(v);
  }
}

/** Шифрлэгдсэн регистрийг тайлж нууцлана (NFR-5). Тайлах боломжгүй бол null — тайланг унагахгүй. */
export function maskedRegister(encrypted: unknown): string | null {
  if (typeof encrypted !== 'string' || !encrypted) return null;
  try { return maskRegisterNo(decryptedField(encrypted)); } catch { return null; }
}

export const fullName = (lastName: unknown, firstName: unknown): string | null => {
  const s = [lastName, firstName].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).join(' ');
  return s || null;
};
