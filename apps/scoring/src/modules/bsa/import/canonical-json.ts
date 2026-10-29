// Түлхүүрийн дарааллаас үл хамаарах JSON харьцуулалт. PostgreSQL `jsonb` нь объектын түлхүүрийн дарааллыг хадгалдаггүй (урт, дараа нь цагаан толгойгоор
// эрэмбэлнэ) тул хадгалсан ба шинээр тооцсон хураангуйг `JSON.stringify`-аар шууд харьцуулбал ҮРГЭЛЖ «зөрсөн» гэж гарна (бодит DB-тэй e2e-ээр илэрсэн).
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);

/** Объектын түлхүүрийг (дотор нь хүртэл) цагаан толгойгоор эрэмбэлсэн JSON мөр. `undefined` талбар хасагдана (JSON.stringify-тай адил) */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
      ? (Object.fromEntries(Object.entries(v as Record<string, Json>).sort(byKey)) as Json)
      : v,
  );
}

export const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
