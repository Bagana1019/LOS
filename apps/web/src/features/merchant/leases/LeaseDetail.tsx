'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, Skeleton } from 'antd';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { formatDateTime, formatMnt } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { getLease, merchantKeys } from '../../../lib/merchant-api';
import { Icon } from '../icons';
import { PageHeader } from '../PageHeader';
import { ErrorState } from '../states';
import { StatusTag } from '../StatusTag';
import { FlowSteps } from './FlowSteps';
import { LeasePanel } from './LeasePanel';
import { LeaseSummary } from './LeaseSummary';
import { LeaseTimeline } from './LeaseTimeline';
import { QuoteBreakdown } from './QuoteBreakdown';

const POLL_REFERRED_MS = 10_000;

function DetailSkeleton() {
  return (
    <div className="mp-detail-grid" aria-busy="true" aria-label={t('merchant.loading')}>
      <Card className="mp-card"><Skeleton active paragraph={{ rows: 6 }} /></Card>
      <Card className="mp-card"><Skeleton active paragraph={{ rows: 8 }} /></Card>
    </div>
  );
}

/** /merchant/leases/[id] — дэлгэрэнгүй + (flow=1 үед) алхамт урсгал. REFERRED үед шийдвэрийг автоматаар шалгана. */
export function LeaseDetail({ id }: { id: string }) {
  const flow = useSearchParams().get('flow') === '1';
  const [acceptStage, setAcceptStage] = useState(false);
  const q = useQuery({
    queryKey: merchantKeys.lease(id),
    queryFn: ({ signal }) => getLease(id, { signal }),
    refetchInterval: (query) => (query.state.data?.status === 'REFERRED' ? POLL_REFERRED_MS : false),
  });
  const lease = q.data;

  const back = (
    <Link href="/merchant/leases" className="mp-back-link"><Icon name="back" size={16} />{t('leases.title')}</Link>
  );

  if (q.isPending) return <><PageHeader title={t('detail.title')} back={back} /><DetailSkeleton /></>;
  if (q.isError && !lease) return <><PageHeader title={t('detail.title')} back={back} /><ErrorState error={q.error} onRetry={() => void q.refetch()} /></>;
  if (!lease) return null;

  return (
    <div>
      <PageHeader
        back={back}
        title={<span className="mp-title-row">{t('detail.titleWith', { no: lease.leaseNo })}<StatusTag status={lease.status} /></span>}
        subtitle={t('detail.subtitle', { store: lease.storeName, plan: lease.planName, date: formatDateTime(lease.createdAt) })}
      />
      <div className="mp-sr-only" role="status" aria-live="polite" data-testid="announce">{t(`pos.announce.${lease.status}`, { amount: formatMnt(lease.quote.monthlyPayment) })}</div>
      {flow ? <FlowSteps status={lease.status} acceptStage={acceptStage} /> : null}
      <div className="mp-detail-grid">
        <div className="mp-detail-main">
          <LeasePanel lease={lease} onAcceptStageChange={setAcceptStage} />
          <Card className="mp-card" title={t('detail.quote')}><QuoteBreakdown quote={lease.quote} heading={false} /></Card>
        </div>
        <div className="mp-detail-side">
          <LeaseSummary lease={lease} />
          <Card className="mp-card" title={t('detail.timeline')}><LeaseTimeline timeline={lease.timeline} /></Card>
        </div>
      </div>
    </div>
  );
}
