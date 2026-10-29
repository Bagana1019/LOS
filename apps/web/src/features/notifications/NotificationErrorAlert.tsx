'use client';
import { Alert, Button } from 'antd';
import { t } from '../../lib/i18n';
import { describeError } from './notifications.utils';

interface Props {
  error: unknown;
  /** Гарчиг өгвөл алдааны мессеж тайлбар болж доор гарна. */
  title?: string;
  onRetry?: () => void;
  style?: React.CSSProperties;
}

/** ApiError.code-оор монгол мессеж (VALIDATION_FAILED үед талбарын жагсаалттай) харуулна. */
export function NotificationErrorAlert({ error, title, onRetry, style }: Props) {
  if (!error) return null;
  const d = describeError(error, t);
  const hasBody = Boolean(title) || d.issues.length > 0;
  return (
    <Alert
      style={style}
      type="error"
      showIcon
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
      action={onRetry ? <Button size="small" onClick={onRetry}>{t('notification.common.retry')}</Button> : undefined}
    />
  );
}
