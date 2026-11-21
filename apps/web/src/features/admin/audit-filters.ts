import type { AuditActorOption } from '@los/contracts';

// F9-24 · /settings/audit шүүлтийн цэвэр дүрэм (React-гүй): сонголт нь API-ийн бодит утгаас, хайлт том/жижиг үсэг үл ялгах + хэсэгчилсэн.

export interface AuditFacets { entities: string[]; actions: string[] }
export interface TextOption { value: string }
export interface ActorSelectOption { value: string; label: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort((a, b) => a.localeCompare(b));

/** Сонгох боломжит объект/үйлдэл = API-ийн буцаасан мөрүүдийн бодит (давхардалгүй) утга. Утгыг хэвээр хадгална (өөрчилж зохиохгүй). */
export function distinctAuditValues(items: ReadonlyArray<{ entity: string; action: string }>): AuditFacets {
  return { entities: sortedUnique(items.map((i) => i.entity)), actions: sortedUnique(items.map((i) => i.action)) };
}

/** Хайлтын бичвэр утганд орсон эсэх: хэсэгчилсэн, том/жижиг үсэг үл ялгах, хоосон бол бүгд. */
export const matchesText = (input: string, value: string): boolean => value.toLowerCase().includes(input.trim().toLowerCase());

export const toTextOptions = (values: readonly string[]): TextOption[] => values.map((value) => ({ value }));

export const actorLabel = (a: AuditActorOption): string => `${a.fullName} (${a.username})`;

/** "Хэн" сонголтууд. Буулгасан UUID олдоогүй ч сонгогдоно (id-аар шүүдэг хуучин боломжийг хадгална). */
export function actorSelectOptions(found: readonly AuditActorOption[], search: string): ActorSelectOption[] {
  const options = found.map((a) => ({ value: a.id, label: actorLabel(a) }));
  const typed = search.trim();
  return UUID_RE.test(typed) && !options.some((o) => o.value === typed) ? [...options, { value: typed, label: typed }] : options;
}

/** Хүснэгтийн "Хэн" нүд: лавлахаас нэр, олдохгүй бол id; actorId байхгүй (системийн үйлдэл) бол null. */
export function actorDisplayName(users: Readonly<Record<string, string>> | undefined, actorId: string | null): string | null {
  return actorId === null ? null : users?.[actorId] ?? actorId;
}
