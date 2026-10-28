import type { ReactNode } from 'react';
import type { SigningFailureReason } from '@los/contracts';
import { Button, Result, Spin } from 'antd';
import type { EsignErrorKind } from '../api';
import { t } from '../i18n';
import { errorMessage, failureMessage } from '../messages';
import { card, muted, tap } from '../styles';

type ResultKind = { kind: 'declined' } | { kind: 'expired' } | { kind: 'cancelled' } | { kind: 'notFound' } | { kind: 'failed'; reason: SigningFailureReason | null };

/** Төгсгөлийн (дахин оролдох боломжгүй) төлвүүд: татгалзсан, хугацаа дууссан, цуцалсан, олдсонгүй, амжилтгүй. */
export function TerminalResult(props: ResultKind) {
  switch (props.kind) {
    case 'declined':
      return <Panel status="info" title={t('esign.declined.title')} subTitle={t('esign.declined.body')} />;
    case 'expired':
      return <Panel status="warning" title={t('esign.expired.title')} subTitle={t('esign.expired.body')} />;
    case 'cancelled':
      return <Panel status="info" title={t('esign.cancelled.title')} subTitle={t('esign.cancelled.body')} />;
    case 'notFound':
      return <Panel status="warning" title={t('esign.error.notFoundTitle')} subTitle={t('esign.error.notFoundBody')} />;
    case 'failed':
      return <Panel status="error" title={t('esign.failed.title')} subTitle={failureMessage(props.reason)} />;
  }
}

/** Түр алдаа (сүлжээ, сервер, 429): дахин оролдох товчтой. */
export function ErrorPanel({ kind, onRetry }: { kind: EsignErrorKind; onRetry: () => void }) {
  return (
    <Panel
      status="error"
      title={t('esign.error.title')}
      subTitle={errorMessage(kind)}
      extra={
        <Button type="primary" size="large" block style={tap} onClick={onRetry}>
          {t('esign.retry')}
        </Button>
      }
    />
  );
}

export function LoadingPanel({ label = t('esign.loading') }: { label?: string }) {
  return (
    <section style={{ ...card, alignItems: 'center' }} role="status" aria-busy="true">
      <Spin size="large" />
      <p style={muted}>{label}</p>
    </section>
  );
}

export function Panel({ status, title, subTitle, extra }: { status: 'info' | 'warning' | 'error'; title: string; subTitle: string; extra?: ReactNode }) {
  return (
    <section style={card} role={status === 'error' ? 'alert' : undefined}>
      <Result status={status} title={title} subTitle={subTitle} extra={extra} style={{ padding: '8px 0' }} />
    </section>
  );
}
