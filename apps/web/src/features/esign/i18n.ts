import { mn } from '@los/ui';

// FR-11.4 — UI текст зөвхөн mn толь бичгээс. Түлхүүр буруу бол tsc-ээр баригдана.
export type MnKey = keyof typeof mn;

/** `{name}` placeholder-ийг орлуулна; өгөөгүй placeholder хэвээр үлдэнэ (тест барина). */
export function t(key: MnKey, vars?: Readonly<Record<string, string | number>>): string {
  const text: string = mn[key];
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
}
