'use client';
import { Alert, Button } from 'antd';
import { t } from '../../lib/i18n';
import { isForbiddenError } from './applications.utils';

interface ListLoadErrorProps {
  error: unknown;
  /** Ачаалж чадсангүй (сүлжээ, 5xx...) мессежийн түлхүүр. */
  errorKey: string;
  /** 403 ("эрх байхгүй") мессежийн түлхүүр. */
  forbiddenKey: string;
  onRetry: () => void;
}

/** F12-4: жагсаалтын ачаалалтын алдаа. 403 бол эрхгүй гэж хэлээд "Дахин оролдох" товчийг харуулахгүй (давтахад хэзээ ч ажиллахгүй); бусад алдаа хуучнаар. */
export function ListLoadError({ error, errorKey, forbiddenKey, onRetry }: ListLoadErrorProps) {
  if (isForbiddenError(error)) return <Alert type="error" showIcon message={t(forbiddenKey)} style={{ marginBottom: 12 }} />;
  return <Alert type="error" showIcon message={t(errorKey)} action={<Button size="small" onClick={onRetry}>{t('application.list.retry')}</Button>} style={{ marginBottom: 12 }} />;
}
