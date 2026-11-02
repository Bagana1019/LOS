'use client';
import { useState } from 'react';
import { App as AntApp } from 'antd';
import type { CalcMethod } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ScoreErrorAlert } from './ScoreErrorAlert';
import { ScoreSkeleton, ScoreView } from './ScoreView';
import { useCalculate, useScoreOverview, useScorePreview, useSelectMethod, useTermsDraft } from './useScore';
import { isTermsValid, methodKey, resolveSource } from './score.utils';

interface Props {
  applicationId: string;
  /** Тооцоолол/сонголт хадгалагдсаны дараа дуудагдана — wizard-н алхмуудын төлөвийг (score ✓) дахин татахад ашиглана. */
  onChanged?: () => void;
}

/**
 * Wizard-н 7-р алхам "Тооцоолол" (`/los/loan-application/:id/score`): A/B/C харьцуулалт, slider, LTV, stress, Sosco Score.
 * FR-8.1…8.6, BR-1…BR-5. UI-д тооцоолол хийхгүй — бүх тоо серверээс (`ScoreOverview`, `ScorePreviewResponse`).
 */
export function ScoreStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const overviewQuery = useScoreOverview(applicationId);
  const overview = overviewQuery.data;
  const calculation = overview?.calculation ?? null;

  const { draft, dirty, update, reset } = useTermsDraft(overview?.terms ?? null);
  const valid = Boolean(draft && isTermsValid(draft, overview?.limits ?? null));
  const blocked = (overview?.blockers.length ?? 0) > 0;
  // Тооцоолол байхгүй бол одоогийн нөхцөлийн preview; байвал зөвхөн slider өөрчлөгдсөн үед (хадгалсан тооцооллыг шууд үзүүлнэ)
  const previewEnabled = Boolean(overview) && !blocked && valid && (calculation === null || dirty);
  const preview = useScorePreview(applicationId, valid ? draft : null, previewEnabled);

  const [announcement, setAnnouncement] = useState('');
  const [target, setTarget] = useState<CalcMethod | null>(null);

  const calculate = useCalculate(applicationId, () => {
    reset(); // хадгалсан тооцоо хадгалсан нөхцөлөөр гарсан тул slider-ийн ноорогийг буцаана
    setAnnouncement(t('score.sr.calculated'));
    void message.success(t('score.toast.calculated'));
    onChanged?.();
  });
  const select = useSelectMethod(applicationId, (_overview, method) => {
    setTarget(null);
    setAnnouncement(t('score.sr.selected', { method: t(methodKey(method)) }));
    void message.success(t('score.toast.selected', { method: t(methodKey(method)) }));
    onChanged?.();
  });

  if (overviewQuery.isPending) return <ScoreSkeleton />;
  if (!overview) return <ScoreErrorAlert error={overviewQuery.error} title={t('score.error.loadTitle')} onRetry={() => void overviewQuery.refetch()} alwaysRetry />;

  const source = resolveSource({ calculation, dirty, preview: preview.data });
  const pick = (method: CalcMethod) => {
    if (calculation?.selectedMethod === method) return;
    select.reset();
    setTarget(method);
  };

  return (
    <ScoreView
      model={{
        applicationId,
        overview,
        source,
        draft,
        dirty,
        previewPending: preview.pending,
        previewError: preview.error,
        refreshError: overviewQuery.isError ? overviewQuery.error : null,
        calculating: calculate.isPending,
        calculateError: calculate.error,
        selectTarget: target,
        selecting: select.isPending,
        selectError: select.error,
        announcement,
      }}
      actions={{
        onTermsChange: update,
        onResetTerms: reset,
        onCalculate: () => calculate.mutate(),
        onRetryPreview: preview.refetch,
        onRetryRefresh: () => void overviewQuery.refetch(),
        onPick: pick,
        onConfirmSelect: (reason) => target && select.mutate({ method: target, ...(reason ? { reason } : {}) }),
        onCancelSelect: () => {
          setTarget(null);
          select.reset();
        },
      }}
    />
  );
}
