import { resolveDataScope, type OrgDirectory, type SessionUser } from '@los/contracts';
import { EMPTY, type LookupKind, type Translate } from './reports.utils';

export { lookupKindOf, type LookupKind } from './reports.utils';

// F11-1: салбар / ЗЭЗ / бүтээгдэхүүний шүүлтийг нэрээр сонгодог (утга = id) болгох цэвэр логик. Vitest-ээр тестлэнэ.
// Сонголтын эх: салбар, ЗЭЗ — gateway `GET /api/directory` (бүх ажилтны дүр уншина); бүтээгдэхүүн — тайлангийн `definition.filters[].options` (каталог).

export interface LookupOption { value: string; label: string }
/** loading: лавлах ачаалж байна · ready: ачаалсан · failed: алдаа (нэр тайлж чадахгүй, "олдсонгүй" гэж дүгнэхгүй). */
export type LookupStatus = 'loading' | 'ready' | 'failed';
/** Сервер хүрээгээр аль хэдийн хязгаарласан id (NFR-3). null = хязгаарлаагүй. */
export interface LookupScope { branchId: string | null; officerId: string | null }
export interface Lookups { directory: OrgDirectory | undefined; status: LookupStatus; scope: LookupScope }
export interface SelectModel { options: LookupOption[]; notFound: boolean }
/** Толгойн "Хүрээ" мөрөнд id-г нэр болгоно. */
export interface ScopeNames { branch: (id: string) => string; officer: (id: string) => string }

export const NO_SCOPE: LookupScope = { branchId: null, officerId: null };

/**
 * Серверийн `resolveReportScope`-той ижил: ADMIN/APPROVER бүгд · BRANCH_MANAGER өөрийн салбар (сервер өөр салбарын шүүлтийг үл тооно) ·
 * OFFICER өөрийн хариуцсан (ЗЭЗ = өөрөө; салбар зөвхөн нарийсгана тул өөрийн салбар). Олон дүртэй бол хамгийн өргөн нь.
 */
export function lookupScopeOf(user: Pick<SessionUser, 'id' | 'branchId' | 'roles'> | undefined): LookupScope {
  if (!user) return NO_SCOPE;
  switch (resolveDataScope(user.roles)) {
    case 'BRANCH': return { branchId: user.branchId, officerId: null };
    case 'OWN': return { branchId: user.branchId, officerId: user.id };
    default: return NO_SCOPE;
  }
}

/** Own-property + хоосон биш нэр. `__proto__`, `constructor` зэрэг түлхүүр Object.prototype-ийн утга болж буцахаас сэргийлнэ. */
export function nameInMap(map: Readonly<Record<string, string>> | undefined, id: string): string | null {
  if (!map || !Object.prototype.hasOwnProperty.call(map, id)) return null;
  return map[id]?.trim() || null;
}

/** id → нэр лавлахаас Select-ийн сонголт (нэрээр эрэмбэлнэ). `onlyId` өгөгдвөл зөвхөн тэр id. Ижил нэртэй хоёр бичлэгийг id-ийн сүүлээр ялгана. */
export function directoryOptions(map: Readonly<Record<string, string>> | undefined, onlyId: string | null): LookupOption[] {
  const entries = Object.entries(map ?? {})
    .map(([value, name]) => ({ value, label: name.trim() }))
    .filter((o) => o.label !== '' && (onlyId === null || o.value === onlyId));
  const counts = new Map<string, number>();
  for (const o of entries) counts.set(o.label, (counts.get(o.label) ?? 0) + 1);
  return entries
    .map((o) => ((counts.get(o.label) ?? 0) > 1 ? { ...o, label: `${o.label} · ${o.value.slice(-4)}` } : o))
    .sort((a, b) => a.label.localeCompare(b.label, 'mn'));
}

/**
 * Одоогийн утгыг (жишээ нь URL-ээс) Select-д харуулах загвар. Сонголтод байвал хэвээр; хүрээнээс гадуур ч лавлахад байвал нэрээр нэмнэ;
 * огт танихгүй бол түүхий утгыг нэмж `notFound` тэмдэглэнэ (лавлах бэлэн үед л — ачаалж байх/алдаатай үед үл мэдэх тул тэмдэглэхгүй).
 */
export function selectModel(args: { options: readonly LookupOption[]; value: string; nameOf: (id: string) => string | null; ready: boolean }): SelectModel {
  const { options, value, nameOf, ready } = args;
  if (!value || options.some((o) => o.value === value)) return { options: [...options], notFound: false };
  const name = nameOf(value);
  if (name !== null) return { options: [...options, { value, label: name }], notFound: false };
  return { options: [...options, { value, label: value }], notFound: ready };
}

/** Салбар / ЗЭЗ-ийн Select: хүрээгээр хязгаарласан сонголт + одоогийн утга. */
export function directoryFieldModel(kind: Exclude<LookupKind, 'product'>, value: string, l: Lookups): SelectModel {
  const map = kind === 'branch' ? l.directory?.branches : l.directory?.users;
  const only = kind === 'branch' ? l.scope.branchId : l.scope.officerId;
  return selectModel({ options: directoryOptions(map, only), value, nameOf: (id) => nameInMap(map, id), ready: l.status === 'ready' });
}

/** Бүтээгдэхүүний Select: сонголт нь тайлангийн каталог (бүгд харагдана), каталогт байхгүй утга "олдсонгүй". */
export function catalogFieldModel(value: string, options: readonly LookupOption[]): SelectModel {
  return selectModel({ options, value, nameOf: () => null, ready: true });
}

// ── F11-4 c: JSON тайлангийн хүснэгтийн салбар / ЗЭЗ баганад нэр (Excel-ийн DIRECTORY_COLUMNS-тэй ижил түлхүүр) ────────────────────────
const DIRECTORY_COLUMN_KINDS: Readonly<Record<string, Exclude<LookupKind, 'product'>>> = { branchId: 'branch', officerId: 'officer' };

/** Тайлангийн баганын түлхүүр салбар / ЗЭЗ-ийн id багана мөн эсэх (өөр багана null). */
export function directoryColumnKind(columnKey: string): Exclude<LookupKind, 'product'> | null {
  return Object.prototype.hasOwnProperty.call(DIRECTORY_COLUMN_KINDS, columnKey) ? (DIRECTORY_COLUMN_KINDS[columnKey] ?? null) : null;
}

/** BR-12: ЗЭЗ-гүй (системээс үүссэн) хүсэлтийн `officerId` нь id биш шошго (apps/origination report-sql.ts `LOAN_TAIL_COLUMNS`) — нэр болгон хөрвүүлэхгүй. */
export const SYSTEM_OFFICER_LABEL = 'Систем';

/**
 * Хүснэгтийн нэг нүд: id → нэр. Хэзээ ч түүхий id биш: лавлахад байхгүй/нэр хоосон/лавлах алдаатай бол "Тодорхойгүй"; ачаалж байвал "—".
 * Салбарын багана зөвхөн салбарын, ЗЭЗ зөвхөн хэрэглэгчийн map-аар тайлагдана.
 */
export function directoryCellText(kind: Exclude<LookupKind, 'product'>, value: string, l: Pick<Lookups, 'directory' | 'status'>, tr: Translate): string {
  if (kind === 'officer' && value === SYSTEM_OFFICER_LABEL) return value;
  if (!l.directory) return l.status === 'loading' ? EMPTY : tr('report.table.unknownName');
  return nameInMap(kind === 'branch' ? l.directory.branches : l.directory.users, value) ?? tr('report.table.unknownName');
}

/**
 * Толгойн "Хүрээ: …" мөрөнд UUID биш нэр. Лавлах ачаалж байвал "—"; алдаатай бол нэр тайлах боломжгүй тул id; ачаалсан боловч байхгүй бол "олдсонгүй (id)".
 */
export function scopeNames(directory: OrgDirectory | undefined, status: LookupStatus, tr: Translate): ScopeNames {
  const resolve = (map: 'branches' | 'users') => (id: string): string => {
    if (!directory) return status === 'loading' ? EMPTY : id;
    return nameInMap(directory[map], id) ?? tr('report.lookup.unknownValue', { value: id });
  };
  return { branch: resolve('branches'), officer: resolve('users') };
}
