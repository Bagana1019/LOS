import common from './mn.json';
import auth from './mn.auth.json';
import shell from './mn.shell.json';
import makerChecker from './mn.maker-checker.json';
import merchant from './mn.merchant.json'; // Мерчант POS портал (docs/05 §12): merchant.*, pos.*, error.* — бусад файлтай түлхүүр давхцахгүй
import borrower from './mn.borrower.json';
import payment from './mn.payment.json';
import notification from './mn.notification.json';
import report from './mn.report.json';
import customer from './mn.customer.json';
import esign from './esign.mn.json'; // FR-11.4 цахим гарын үсэг: esign.*, verify.*, contractSigning.*

// Модуль бүр `mn.<module>.json` үүсгээд доор НЭГ import + `mnSources`-д НЭГ мөр нэмнэ (зэрэгцээ салбар зөрчилгүй мерж хийгдэнэ).
// Түлхүүр модулиар угтвартай (`auth.*`, `shell.*`, `customer.*`); давхардлыг web-ийн i18n тест барина.
export const mnSources = {
  common,
  auth,
  shell,
  makerChecker,
  merchant,
  borrower,
  payment,
  notification,
  report,
  customer,
  esign,
} as const;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
const merged = Object.assign({}, ...Object.values(mnSources)) as UnionToIntersection<(typeof mnSources)[keyof typeof mnSources]>;
export type MnKey = keyof typeof merged;
/** Бүх модулийн нэгдсэн каталог. Хавтгай `Record` — модулиуд түлхүүрийг string-ээр индексэлдэг. */
export const mn: Record<string, string> = merged;

/** Монгол текст авах. Түлхүүр олдохгүй бол түлхүүрийг буцаана (хоосон дэлгэц гаргахгүй). `{name}` талбарыг params-аар солино. */
export function t(key: MnKey | (string & {}), params?: Record<string, string | number>): string {
  const raw = Object.prototype.hasOwnProperty.call(mn, key) ? mn[key] : key; // 'constructor', 'toString' зэрэг prototype нэр функц буцаахгүй
  return params ? raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : raw;
}
