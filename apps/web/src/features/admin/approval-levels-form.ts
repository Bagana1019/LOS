import type { ApprovalLevelInput } from '@los/contracts';
import { MAX_MONEY, moneyProblem } from '../../components/form';
import { t } from '../../lib/i18n';
import { plainNumberProblem } from './plain-number-rules';

/**
 * Батлах түвшний мөр (форм). antd InputNumber нь "5сая"→5, "-5"→1 гэж чимээгүй засдаг байсан тул утгыг текстээс шууд авна:
 * `amountTo` `null` = хоосон, `NaN` = тоо биш текст; `slaHours` `undefined` = хоосон, `NaN` = тоо биш текст (F2-8, F9-2).
 */
export interface LevelRow extends Omit<ApprovalLevelInput, 'slaHours'> {
  slaHours: number | undefined;
}
export type LevelField = 'amountTo' | 'slaHours';
export type LevelProblems = Partial<Record<LevelField, string>>;

/** = `ApprovalLevelInput.slaHours` дээд хязгаар (30 хоног); тест гэрээтэй тулгана. */
export const SLA_MAX_HOURS = 24 * 30;

const requiredText = (label: string) => t('admin.num.required', { field: label });

function amountProblem(value: number | null): string | undefined {
  const label = t('admin.levels.f.to');
  if (value === null) return requiredText(label);
  return moneyProblem(value, { label, positive: true, max: MAX_MONEY }) ?? undefined;
}

function slaProblem(value: number | undefined): string | undefined {
  const label = t('admin.levels.f.sla');
  if (value === undefined) return requiredText(label);
  return plainNumberProblem(value, { label, min: 1, max: SLA_MAX_HOURS, integer: true }) ?? undefined;
}

/** Талбар бүрийн алдаа. Сүүлийн түвшин дээд хязгааргүй (талбаргүй) тул `amountTo` шалгагдахгүй. Хоосон объект = мөр зөв. */
export function levelProblems(row: LevelRow, isLast: boolean): LevelProblems {
  const found: LevelProblems = { amountTo: isLast ? undefined : amountProblem(row.amountTo), slaHours: slaProblem(row.slaHours) };
  return Object.fromEntries(Object.entries(found).filter(([, message]) => message !== undefined)) as LevelProblems;
}

/** Эхний алдаатай түвшний мессеж ("Түвшин 2: Дээд дүн 0-ээс их байх ёстой") эсвэл null. */
export function firstLevelProblem(rows: readonly LevelRow[]): string | null {
  for (const [i, row] of rows.entries()) {
    const message = Object.values(levelProblems(row, i === rows.length - 1))[0];
    if (message) return t('admin.levels.problem', { no: row.levelNo, message });
  }
  return null;
}

function finite(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid approval level row: validate with firstLevelProblem before levelsFromRows');
  return value;
}

/** Зөвхөн `firstLevelProblem(rows) === null` үед: мөр → API-ийн түвшнүүд. */
export const levelsFromRows = (rows: readonly LevelRow[]): ApprovalLevelInput[] =>
  rows.map((r) => ({ ...r, amountTo: r.amountTo === null ? null : finite(r.amountTo), slaHours: finite(r.slaHours) }));

/** Мөр засах (оролтыг өөрчлөхгүй). Дээд дүн зөв тоо болвол дараагийн түвшний доод дүн дагана (завсар үүсгэхгүй); тоо биш/хоосон үед хөндөхгүй. */
export function patchLevel(rows: readonly LevelRow[], index: number, patch: Partial<LevelRow>): LevelRow[] {
  const follow = typeof patch.amountTo === 'number' && Number.isFinite(patch.amountTo) ? patch.amountTo : undefined;
  return rows.map((r, j) => {
    if (j === index) return { ...r, ...patch };
    return j === index + 1 && follow !== undefined ? { ...r, amountFrom: follow } : r;
  });
}
