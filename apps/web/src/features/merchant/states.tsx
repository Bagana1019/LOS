'use client';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button, Skeleton } from 'antd';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { errorMessage, isNoAccess, isNotFound } from './errors';
import { Icon, type IconName } from './icons';

/** Нэгдсэн "төлөвийн самбар": icon + гарчиг + тайлбар + үйлдэл. */
export function StatePanel({ icon, tone = 'neutral', title, description, actions, role = 'status' }: { icon: IconName; tone?: 'neutral' | 'danger' | 'success' | 'warning'; title: string; description?: ReactNode; actions?: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div className={`mp-state mp-state-${tone}`} role={role}>
      <span className="mp-state-icon"><Icon name={icon} size={26} /></span>
      <h2 className="mp-state-title">{title}</h2>
      {description ? <p className="mp-state-text">{description}</p> : null}
      {actions ? <div className="mp-state-actions">{actions}</div> : null}
    </div>
  );
}

/** 401/403 — нэвтрэх/эрх (gateway Module 0 хараахан байхгүй тул найрсаг мессеж). */
export function NoAccessState({ onRetry }: { onRetry?: () => void }) {
  return (
    <StatePanel icon="lock" tone="warning" role="alert" title={t('merchant.noAccess.title')} description={t('merchant.noAccess.text')} actions={onRetry ? <Button onClick={onRetry}>{t('merchant.retry')}</Button> : undefined} />
  );
}

export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  if (isNoAccess(error)) return <NoAccessState onRetry={onRetry} />;
  if (isNotFound(error)) return <StatePanel icon="alert" tone="neutral" role="alert" title={t('merchant.notFound.title')} description={t('merchant.notFound.text')} />;
  return (
    <StatePanel icon="alert" tone="danger" role="alert" title={title ?? t('merchant.error.title')} description={errorMessage(error)} actions={onRetry ? <Button type="primary" onClick={onRetry}>{t('merchant.retry')}</Button> : undefined} />
  );
}

export function EmptyState({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return <StatePanel icon="list" title={title} description={description} actions={actions} />;
}

export function BlockSkeleton({ rows = 4, title = true }: { rows?: number; title?: boolean }) {
  return (
    <div className="mp-skeleton" aria-busy="true" aria-label={t('merchant.loading')}>
      <Skeleton active title={title} paragraph={{ rows }} />
    </div>
  );
}

/** Нэг query-ийн loading / error / data-г нэг газар шийднэ. */
export function QueryBoundary<T>({ query, skeleton, children }: { query: UseQueryResult<T>; skeleton?: ReactNode; children: (data: T) => ReactNode }) {
  if (query.isPending) return <>{skeleton ?? <BlockSkeleton />}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}
