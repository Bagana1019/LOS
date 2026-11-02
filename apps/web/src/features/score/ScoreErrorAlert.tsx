'use client';
import { Alert, Button } from 'antd';
import { t } from '../../lib/i18n';
import { describeScoreError } from './score.utils';

interface Props {
  error: unknown;
  /** Гарчиг өгвөл алдааны мессеж тайлбар болж доор гарна. */
  title?: string;
  onRetry?: () => void;
  /** true бол алдааны төрлөөс үл хамааран "Дахин оролдох" харуулна (ачаалалтын алдаа). */
  alwaysRetry?: boolean;
}

/** `ApiError.code` (SCORING_ERROR_CODES)-оор монгол мессеж. SCORING_UNAVAILABLE / 5xx / сүлжээ → "Дахин оролдох". */
export function ScoreErrorAlert({ error, title, onRetry, alwaysRetry = false }: Props) {
  if (!error) return null;
  const d = describeScoreError(error, t);
  return (
    <Alert
      type="error"
      showIcon
      message={title ?? d.message}
      description={title ? d.message : undefined}
      action={onRetry && (d.retryable || alwaysRetry) ? <Button size="small" onClick={onRetry}>{t('score.action.retry')}</Button> : undefined}
      data-error-code={d.code ?? undefined}
    />
  );
}
