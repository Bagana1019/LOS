import type { DecisionView } from '@los/contracts';
import { EMPTY_VALUE, formatPercent } from '../../lib/format';
import { hasMessage, t } from '../../lib/i18n';

// F3-1: шийдвэрийн хуудасны цэвэр туслахууд — зөвхөн ХАРУУЛАЛТ (формат, шошго, тоолуур). Томьёо `@los/calc`-д; энд тооцоолол хийхгүй.

export interface StageCounts { completed: number; total: number }

export interface ProgressCounts {
  /** Шугамын тоо — wizard-ийн зүүн самбарын «Бүрдсэн: done/total»-той ЯГ ижил (байвал). */
  done: number;
  total: number;
  percent: number;
  /** Шугам юуг тоолж буйг хэлэх тайлбар. */
  label: string;
  /** Заавал бүрдэх (BR-7) алхмын тоо — шугамаас өөр тоо бол тусад нь нэрлэнэ; шугам өөрөө заавал бүрдэхийг тоолж байвал null. */
  requiredLabel: string | null;
}

/**
 * F3-1: шугам «8/8» (заавал бүрдэх 8 алхам), самбар «Бүрдсэн 9/9» (1-р үе шатны 9 алхам, шийдвэр алхам өөрөө орно) гэж зөрдөг байсан.
 * Wizard-ийн тоолуур (`ApplicationDetail.stage1Completed/Total`) байвал шугам түүнийг харуулна; заавал бүрдэх тоог тусад нь нэрлэнэ (мэдээлэл нуухгүй).
 */
export function progressCounts(required: DecisionView['progress'], stage1: StageCounts | null | undefined): ProgressCounts {
  const bar = stage1 ?? { completed: required.completed, total: required.total };
  return {
    done: bar.completed, total: bar.total,
    percent: bar.total ? Math.round((bar.completed / bar.total) * 100) : 0,
    label: t(stage1 ? 'decide.progress.stage1' : 'decide.progress.required', { done: bar.completed, total: bar.total }),
    requiredLabel: stage1 ? t('decide.progress.required', { done: required.completed, total: required.total }) : null,
  };
}

/** Тооцооллын аргын монгол шошго (score feature-ийн `score.method.*`); мэдэгдэхгүй код хэвээр. */
export const methodLabel = (code: string | null | undefined): string => (code ? (hasMessage(`score.method.${code}`) ? t(`score.method.${code}`) : code) : EMPTY_VALUE);

/** ӨОХ бутархай → «43.21%», ӨТЧХ харьцаа → «1.80». */
export const formatRatioValue = (kind: 'DTI' | 'DSCR', value: number | null): string => (value == null ? EMPTY_VALUE : kind === 'DTI' ? formatPercent(value) : value.toFixed(2));

/** ӨОХ-д дээд, ӨТЧХ-д доод хязгаар. Хязгаар байхгүй бол хоосон. */
export function formatRatioLimit(kind: 'DTI' | 'DSCR', limit: number | null): string {
  if (limit == null) return '';
  return kind === 'DTI' ? t('decide.risk.limitMax', { value: formatPercent(limit) }) : t('decide.risk.limitMin', { value: limit.toFixed(2) });
}
