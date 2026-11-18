import type { OrgDirectory } from '@los/contracts';

const PENDING = '—';

export interface DirectoryText { unknown: string; system: string }
export interface DirectoryLabels {
  /** Салбарын нэр. Ачаалж байвал / салбаргүй бол "—", лавлахад байхгүй бол "Тодорхойгүй". */
  branch: (id: string | null | undefined) => string;
  /** Хариуцсан ЗЭЗ-ийн нэр. ЗЭЗ-гүй (системээс үүссэн) бол "Систем". */
  officer: (id: string | null | undefined) => string;
}

/** Own-property + хоосон биш нэр. `__proto__`, `constructor` зэрэг түлхүүр Object.prototype-ийн утга болж буцахаас сэргийлнэ. */
function nameOf(map: Readonly<Record<string, string>>, id: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(map, id)) return null;
  const name = map[id]?.trim();
  return name ? name : null;
}

/**
 * FR-1.2 (M2): Салбар / ЗЭЗ баганад UUID-г ХЭЗЭЭ Ч харуулахгүй. Нэр байвал нэр; лавлах ачаалж байвал "—";
 * лавлахад байхгүй эсвэл лавлах ачаалж чадаагүй бол "Тодорхойгүй".
 */
export function directoryLabels(directory: OrgDirectory | undefined, loading: boolean, text: DirectoryText): DirectoryLabels {
  const resolve = (map: 'branches' | 'users', id: string): string => {
    if (!directory) return loading ? PENDING : text.unknown;
    return nameOf(directory[map], id) ?? text.unknown;
  };
  return {
    branch: (id) => (id ? resolve('branches', id) : PENDING),
    officer: (id) => (id ? resolve('users', id) : text.system),
  };
}
