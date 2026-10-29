'use client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Card, Segmented, Select, Skeleton } from 'antd';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { mnStartOfDayIso } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { getDashboard, merchantKeys } from '../../../lib/merchant-api';
import { useMe, useMnDateKey } from '../hooks';
import { LeaseResults } from '../leases/LeaseResults';
import { LinkButton } from '../LinkButton';
import { PageHeader } from '../PageHeader';
import { ErrorState } from '../states';
import { canCreateLeases } from '../status';
import { ByPlanTable, ByStoreTable, LimitsCard } from './Breakdown';
import { DailyCharts } from './DailyCharts';
import { KpiGrid, TodoCards } from './Kpis';

type RangeKey = 'today' | '7d' | '30d';
/** Хугацааны сонголт → өнөөдрөөс хэдэн хоногийн өмнөөс (Улаанбаатарын өдрийн эхлэлээс). */
const RANGE_DAYS_BACK: Record<RangeKey, number> = { today: 0, '7d': 6, '30d': 29 };
const RANGE_KEYS: RangeKey[] = ['today', '7d', '30d'];

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label={t('merchant.loading')} data-testid="dashboard-skeleton">
      <div className="mp-todo-grid mp-section">{[0, 1, 2, 3].map((i) => <Card key={i} className="mp-card"><Skeleton active title={{ width: '40%' }} paragraph={{ rows: 1 }} /></Card>)}</div>
      <div className="mp-kpi-grid mp-section">{Array.from({ length: 9 }, (_, i) => <Card key={i} className="mp-card"><Skeleton active title={false} paragraph={{ rows: 2 }} /></Card>)}</div>
      <Card className="mp-card"><Skeleton active paragraph={{ rows: 5 }} /></Card>
    </div>
  );
}

export function Dashboard() {
  const router = useRouter();
  const me = useMe();
  const [range, setRange] = useState<RangeKey>('7d');
  const [storeId, setStoreId] = useState<string | undefined>(undefined);
  // Нээлттэй үлдсэн дэлгэц Улаанбаатарын шөнө дундыг давахад "өнөөдөр/7/30 хоног"-ийн эхлэл урагшилж, шинэ түлхүүрээр дахин татна (n=21).
  const today = useMnDateKey();
  const from = useMemo(() => mnStartOfDayIso(new Date(), RANGE_DAYS_BACK[range]), [range, today]);
  const params = { from, ...(storeId ? { storeId } : {}) };
  const q = useQuery({
    queryKey: merchantKeys.dashboard(params),
    queryFn: ({ signal }) => getDashboard(params, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const profile = me.data;
  const showStoreFilter = profile?.role === 'MERCHANT_ADMIN' && profile.stores.length > 1;
  const canCreate = profile ? canCreateLeases(profile.merchant.status) : true;
  const dash = q.data;

  const actions = (
    <div className="mp-toolbar">
      <Segmented<RangeKey>
        aria-label={t('dashboard.range.label')}
        value={range}
        onChange={setRange}
        options={RANGE_KEYS.map((k) => ({ value: k, label: t(`dashboard.range.${k}`) }))}
      />
      {showStoreFilter && profile ? (
        <Select<string>
          aria-label={t('dashboard.store.label')}
          className="mp-store-select"
          value={storeId ?? ''}
          onChange={(v) => setStoreId(v || undefined)}
          options={[{ value: '', label: t('merchant.allStores') }, ...profile.stores.map((s) => ({ value: s.id, label: s.name }))]}
        />
      ) : null}
      <LinkButton href="/merchant/leases/new" type="primary" size="large" disabled={!canCreate}>{t('merchant.cta.newLease')}</LinkButton>
    </div>
  );

  return (
    <div>
      <PageHeader
        title={profile ? t('dashboard.greeting', { name: profile.merchant.name }) : t('dashboard.greeting.plain')}
        subtitle={t('dashboard.today', { date: today })}
        extra={actions}
      />
      {q.isPending ? <DashboardSkeleton /> : q.isError && !dash ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : dash ? (
        <div className={q.isFetching ? 'mp-fetching' : undefined}>
          <TodoCards todo={dash.todo} />
          <KpiGrid totals={dash.totals} />
          <section className="mp-section" aria-labelledby="charts-h">
            <h2 id="charts-h" className="mp-sr-only">{t('dashboard.daily.title')}</h2>
            <DailyCharts daily={dash.daily} />
          </section>
          <section className="mp-section mp-two-col" aria-label={t('dashboard.limits.title')}>
            <LimitsCard limits={dash.limits} />
            <div className="mp-stack">
              <ByStoreTable rows={dash.byStore} />
              <ByPlanTable rows={dash.byPlan} />
            </div>
          </section>
          <section className="mp-section" aria-labelledby="recent-h">
            <div className="mp-section-head">
              <h2 id="recent-h" className="mp-section-title">{t('dashboard.recent.title')}</h2>
              <Link href="/merchant/leases">{t('dashboard.recent.all')}</Link>
            </div>
            <Card className="mp-card mp-card-flush">
              <LeaseResults
                compact
                label={t('dashboard.recent.title')}
                items={dash.recent}
                hrefFor={(id) => `/merchant/leases/${id}`}
                onOpen={(id) => router.push(`/merchant/leases/${id}`)}
                emptyTitle={t('dashboard.recent.empty.title')}
                emptyDescription={t('dashboard.recent.empty.text')}
                emptyActions={canCreate ? <LinkButton href="/merchant/leases/new" type="primary">{t('merchant.cta.newLease')}</LinkButton> : undefined}
              />
            </Card>
          </section>
        </div>
      ) : null}
    </div>
  );
}
