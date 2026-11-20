// What the "Өмнө → Дараа" table of a change request shows. Raw before/payload shapes differ per request type and do NOT line up
// (blacklist payload is only { entryId }; a product snapshot is flat while its payload nests under `product`), so a naive diff
// marked every field "Устгагдсан"/"Нэмэгдсэн" (F8-3, F9-5). Here each known type is normalised to comparable sides; unknown types pass through.
import { t } from '../../lib/i18n';
import { listTypeLabel, maskRegister, reasonLabel } from '../blacklist/blacklist.utils';
import { diffSides, fieldLabelFor } from './customer-change';
import { formatValue, isPlainObject } from './diff';
import { fieldMeta, formatUnitValue } from './field-meta';

export interface RequestLike { targetType: string; action: string; before?: unknown; payload?: unknown }

export interface ChangeView {
  before: unknown;
  after: unknown;
  /** Customer requests whose values stayed encrypted: only the field names; otherwise null. */
  sealedFields: string[] | null;
  labelOf: (path: string) => string;
  valueOf: (path: string, value: unknown) => string;
  /** One-line explanation of what approving does (already Mongolian); null when nothing to add. */
  note: string | null;
}

const BLACKLIST = 'BLACKLIST_ENTRY';
const ACTIVATE_BLACK = 'ACTIVATE_BLACK';
const PRODUCT = 'PRODUCT';

const pick = (source: unknown, keys: readonly string[]): Record<string, unknown> | null =>
  isPlainObject(source) ? Object.fromEntries(keys.filter((k) => Object.hasOwn(source, k)).map((k) => [k, source[k]])) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

interface Sides { before: unknown; after: unknown; note?: string }

/** ACTIVATE_BLACK has no "after" in the payload ({ entryId } only): the effect of approving is the documented one (severity BLACK, active). */
function blacklistSides(dto: RequestLike): Sides {
  return { before: pick(dto.before, ['severity', 'isActive']), after: { severity: 'BLACK', isActive: true }, note: t('maker_checker.view.activate_black_note') };
}

/** Snapshot (flat, from auditShape) vs `payload.product`: compare only the fields the request proposes, so id/code/currency are no noise. */
function productSides(dto: RequestLike): Sides | null {
  const payload = isPlainObject(dto.payload) ? dto.payload : {};
  if (dto.action === 'SET_ACTIVE') return { before: pick(dto.before, ['isActive']), after: pick(payload, ['isActive']) };
  const proposed = isPlainObject(payload.product) ? payload.product : null;
  if (!proposed) return null;
  return { before: dto.action === 'CREATE' ? null : pick(dto.before, Object.keys(proposed)), after: proposed };
}

function knownSides(dto: RequestLike): Sides | null {
  if (dto.targetType === BLACKLIST && dto.action === ACTIVATE_BLACK) return blacklistSides(dto);
  if (dto.targetType === PRODUCT) return productSides(dto);
  return null;
}

export function buildChangeView(dto: RequestLike): ChangeView {
  const known = knownSides(dto);
  const { before, after, note, sealedFields } = known ? { ...known, sealedFields: null } : { ...diffSides(dto), note: undefined };
  const customerLabel = fieldLabelFor(dto.targetType);
  return {
    before,
    after,
    sealedFields,
    labelOf: (path) => fieldMeta(dto.targetType, path)?.label ?? customerLabel(path),
    valueOf: (path, value) => {
      const meta = fieldMeta(dto.targetType, path);
      return meta ? formatUnitValue(meta.unit, value) : formatValue(value);
    },
    note: note ?? null,
  };
}

export interface NameLookups { blacklistName?: string | null; productName?: string | null }

/** A readable name for the target (so a bare UUID is never the main label); null when it cannot be known. */
export function targetName(dto: RequestLike, lookups: NameLookups): string | null {
  if (dto.targetType === BLACKLIST) return lookups.blacklistName ?? null;
  if (dto.targetType !== PRODUCT) return null;
  const payload = isPlainObject(dto.payload) && isPlainObject(dto.payload.product) ? dto.payload.product : null;
  const before = isPlainObject(dto.before) ? dto.before : null;
  return str(before?.name) ?? str(payload?.name) ?? lookups.productName ?? null;
}

export interface ContextRow { key: string; label: string; value: string }
export interface BlacklistLookup { registerNo: string; reasonText: string | null }

/** Extra read-only rows under the target: who/why for a blacklist request (code labels from the snapshot, register masked from the looked-up entry). */
export function targetContext(dto: RequestLike, entry: BlacklistLookup | null | undefined): ContextRow[] {
  if (dto.targetType !== BLACKLIST) return [];
  const before = isPlainObject(dto.before) ? dto.before : {};
  const rows: ContextRow[] = [];
  if (entry) rows.push({ key: 'register', label: t('maker_checker.context.register'), value: maskRegister(entry.registerNo) });
  const listType = str(before.listType);
  if (listType) rows.push({ key: 'listType', label: t('maker_checker.blacklist_field.listType'), value: listTypeLabel(listType) });
  const reason = str(before.reasonCode);
  if (reason) rows.push({ key: 'reason', label: t('maker_checker.blacklist_field.reasonCode'), value: reasonLabel(reason) });
  if (entry?.reasonText) rows.push({ key: 'reasonText', label: t('maker_checker.context.reason_text'), value: entry.reasonText });
  return rows;
}
