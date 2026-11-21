import { BankCode, type TxnDirection } from '@los/contracts';
import { t } from '../../lib/i18n';

// BSA дэлгэцийн цэвэр туслахууд (I/O байхгүй): банкны сонголт, ангиллын Select, чиглэл, итгэл %.

export interface BankOption { value: BankCode; label: string }

/** Дэмжигдсэн 7 банк (`BankCode` — гэрээний цорын ганц эх), Монгол нэрээр. */
export const bankOptions = (): BankOption[] => BankCode.map((value) => ({ value, label: t(`bsa.bank.${value}`) }));

/**
 * `POST /bsa/analyses/:id/imports`-ийн `banks` multipart талбар: файл бүрийн банк (индекс = файлын дараалал), JSON мөр.
 * Банк сонгоогүй бол талбарыг илгээхгүй (null) — сервер автоматаар таниулна.
 */
export function banksField(fileCount: number, bank: BankCode | null | undefined): string | null {
  if (!bank || fileCount < 1) return null;
  return JSON.stringify(Array.from({ length: fileCount }, () => bank));
}

/** scoring `GET /bsa/categories`-ийн мөр (контрактад схем байхгүй; UI-д хэрэгтэй талбарууд). */
export interface BsaCategory { code: string; name: string; direction: TxnDirection; groupCode: string; isActive: boolean }
export interface CategoryGroup { label: string; options: { value: string; label: string }[] }

const DIRECTIONS: readonly TxnDirection[] = ['INCOME', 'EXPENSE'];

/** Сонгосон дохионуудын гүйлгээний чиглэлүүд (давхцалгүй, орлого түрүүлж). */
export function directionsOf(items: readonly { transactions: readonly { direction: TxnDirection }[] }[]): TxnDirection[] {
  const seen = new Set<TxnDirection>(items.flatMap((i) => i.transactions.map((x) => x.direction)));
  return DIRECTIONS.filter((d) => seen.has(d));
}

/** Нэг дохионы чиглэл: орлого / зарлага / хоёулаа (хос) / тодорхойгүй. */
export function directionSummary(txns: readonly { direction: TxnDirection }[]): TxnDirection | 'BOTH' | null {
  const d = directionsOf([{ transactions: txns }]);
  if (d.length === 0) return null;
  return d.length === 2 ? 'BOTH' : (d[0] as TxnDirection);
}

/**
 * «Ангилал солих» Select-ийн сонголт: идэвхтэй ангилал, сонгосон гүйлгээний чиглэлээр шүүсэн (чиглэл тодорхойгүй бол хоёулаа),
 * чиглэлээр бүлэглэсэн. Утга = код (дотоод), шошго = Монгол нэр.
 */
export function categoryGroups(categories: readonly BsaCategory[], directions: readonly TxnDirection[]): CategoryGroup[] {
  const wanted = directions.length > 0 ? directions : DIRECTIONS;
  return DIRECTIONS.filter((d) => wanted.includes(d))
    .map((d) => ({
      label: t(`bsa.direction.${d}.group`),
      options: categories.filter((c) => c.isActive && c.direction === d).map((c) => ({ value: c.code, label: c.name })),
    }))
    .filter((g) => g.options.length > 0);
}

export function categoryName(code: string | null, categories: readonly BsaCategory[]): string | null {
  if (!code) return null;
  return categories.find((c) => c.code === code)?.name ?? null;
}

/** Дохионы итгэл (0..100) → «85%»; байхгүй бол null (дуудагч тайлбар харуулна). */
export const formatConfidence = (v: number | null): string | null => (v === null ? null : `${Math.round(v)}%`);

const stepFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
/** Аргачлалын алхмын дүн: их дүнг таслалаар, харьцааг 4 орноор (харуулалт л). */
export const formatStepValue = (v: number): string => stepFormat.format(v);
