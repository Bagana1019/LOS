import common from './mn.json';
import auth from './mn.auth.json';
import shell from './mn.shell.json';

// Модуль бүр `mn.<module>.json` үүсгээд доор НЭГ import + `mnSources`-д НЭГ мөр нэмнэ (зэрэгцээ салбар зөрчилгүй мерж хийгдэнэ).
// Түлхүүр модулиар угтвартай (`auth.*`, `shell.*`, `customer.*`); давхардлыг web-ийн i18n тест барина.
export const mnSources = {
  common,
  auth,
  shell,
} as const;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
export const mn = Object.assign({}, ...Object.values(mnSources)) as UnionToIntersection<(typeof mnSources)[keyof typeof mnSources]>;
export type MnKey = keyof typeof mn;

/** Монгол текст авах. Түлхүүр олдохгүй бол түлхүүрийг буцаана (хоосон дэлгэц гаргахгүй). `{name}` талбарыг params-аар солино. */
export function t(key: MnKey | (string & {}), params?: Record<string, string | number>): string {
  const raw = (mn as Record<string, string>)[key] ?? key;
  return params ? raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : raw;
}
