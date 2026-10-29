'use client';
import { Alert, Button } from 'antd';
import { t } from '../../lib/i18n';
import { describeError } from './reports.utils';

interface Props {
  error: unknown;
  /** Гарчиг өгвөл алдааны мессеж тайлбар болж доор гарна. */
  title?: string;
  onRetry?: () => void;
  onClose?: () => void;
}

/** ApiError.code-оор монгол мессеж харуулна. Core интеграцийн тохиргоо/хэрэгжилтийн асуудлыг алдаа биш анхааруулга хэлбэрээр. Дотоод дэлгэрэнгүйг (stack) харуулахгүй. */
export function ReportErrorAlert({ error, title, onRetry, onClose }: Props) {
  if (!error) return null;
  const d = describeError(error, t);
  const hasBody = Boolean(title) || d.issues.length > 0;
  return (
    <Alert
      type={d.severity}
      showIcon
      closable={Boolean(onClose)}
      onClose={onClose}
      message={title ?? d.message}
      description={
        hasBody ? (
          <>
            {title ? <div>{d.message}</div> : null}
            {d.issues.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {d.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : undefined
      }
      action={onRetry && d.retryable ? <Button size="small" onClick={onRetry}>{t('report.common.retry')}</Button> : undefined}
    />
  );
}
