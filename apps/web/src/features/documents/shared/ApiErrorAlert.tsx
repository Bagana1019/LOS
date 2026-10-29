'use client';
import { Alert, Button } from 'antd';
import { t } from '../../../lib/i18n';
import { describeApiError, type ErrorScope } from './api-error';

interface Props {
  error: unknown;
  scope: ErrorScope;
  /** Гарчиг өгвөл алдааны мессеж тайлбар болж доор гарна. */
  title?: string;
  onRetry?: () => void;
}

/** API алдааг монгол мессежээр (VALIDATION_FAILED үед талбарын жагсаалттай) харуулна. */
export function ApiErrorAlert({ error, scope, title, onRetry }: Props) {
  if (!error) return null;
  const d = describeApiError(error, scope);
  const hasBody = Boolean(title) || d.issues.length > 0;
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
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
      action={onRetry ? <Button size="small" onClick={onRetry}>{t(`${scope}.action.retry`)}</Button> : undefined}
    />
  );
}
