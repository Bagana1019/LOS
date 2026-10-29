'use client';
import { PosLeaseStatus } from '@los/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Card, Input, Select, Tabs } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../../../lib/i18n';
import { backOfficeKeys, listAdminLeases, type AdminLeaseListParams } from '../../../lib/merchant-api';
import { useDebouncedValue } from '../hooks';
import { LeaseResults } from '../leases/LeaseResults';
import { PageHeader } from '../PageHeader';
import { ErrorState } from '../states';
import { statusLabel } from '../status';
import { AdminLeaseDrawer } from './AdminLeaseDrawer';

type TabKey = 'review' | 'settle' | 'all';
const TABS: TabKey[] = ['review', 'settle', 'all'];
const TAB_STATUS: Record<TabKey, PosLeaseStatus[]> = { review: ['REFERRED'], settle: ['DELIVERED'], all: [] };

export interface AdminLeaseListProps {
  /** Тухайн мерчантаар хязгаарлах (мерчантын дэлгэрэнгүйн "Лизингүүд" таб). */
  merchantId?: string;
  tab?: TabKey;
  showStatusFilter?: boolean;
  onOpen: (id: string) => void;
  label: string;
}

/** Back-office лизингийн жагсаалт (хайлт, төлөв, серверийн хуудаслалт). */
export function AdminLeaseList({ merchantId, tab = 'all', showStatusFilter, onOpen, label }: AdminLeaseListProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [qInput, setQInput] = useState('');
  const [statuses, setStatuses] = useState<PosLeaseStatus[]>([]);
  const q = useDebouncedValue(qInput.trim(), 400);
  const tabStatuses = TAB_STATUS[tab];
  const effective = tabStatuses.length ? tabStatuses : statuses;
  const params: AdminLeaseListParams = useMemo(() => ({ ...(merchantId ? { merchantId } : {}), ...(effective.length ? { status: effective } : {}), ...(q ? { q } : {}), page, pageSize }), [merchantId, effective, q, page, pageSize]);
  useEffect(() => { setPage(1); }, [q, tab, statuses, merchantId]);
  const query = useQuery({ queryKey: backOfficeKeys.leases(params), queryFn: ({ signal }) => listAdminLeases(params, { signal }), placeholderData: keepPreviousData });

  return (
    <div>
      <div className="mp-filters mp-filters-inline" role="search" aria-label={label}>
        <label className="mp-field mp-field-grow">
          <span>{t('leases.filter.search')}</span>
          <Input allowClear value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={t('leases.filter.search.placeholder')} maxLength={100} />
        </label>
        {showStatusFilter ? (
          <div className="mp-field mp-field-grow">
            <span id={`st-${tab}`}>{t('leases.filter.status')}</span>
            <Select<PosLeaseStatus[]> mode="multiple" allowClear maxTagCount="responsive" aria-labelledby={`st-${tab}`} value={statuses} placeholder={t('leases.filter.status.all')} onChange={setStatuses} options={PosLeaseStatus.map((s) => ({ value: s, label: statusLabel(s) }))} />
          </div>
        ) : null}
      </div>
      {query.isError && !query.data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <LeaseResults
          label={label}
          items={query.data?.items ?? []}
          loading={query.isPending || (query.isFetching && query.isPlaceholderData)}
          onOpen={onOpen}
          pagination={query.data ? { current: query.data.page, pageSize: query.data.pageSize, total: query.data.total, onChange: (p, s) => { setPage(p); setPageSize(s); } } : undefined}
          emptyTitle={tab === 'review' ? t('admin.empty.review') : tab === 'settle' ? t('admin.empty.settle') : t('leases.empty.title')}
          emptyDescription={tab === 'all' ? t('leases.empty.text') : t('admin.empty.hint')}
        />
      )}
    </div>
  );
}

/** /los/pos-leases — Хянах шаардлагатай [REFERRED] · Хүлээгдэж буй төлбөр [DELIVERED] · Бүгд. Мөр дарахад дэлгэрэнгүй drawer. */
export function PosLeasesAdmin() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const raw = sp.get('tab');
  const tab: TabKey = TABS.includes(raw as TabKey) ? (raw as TabKey) : 'review';
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="mp-page">
      <PageHeader title={t('admin.leases.title')} subtitle={t('admin.leases.subtitle')} />
      <Card className="mp-card">
        <Tabs
          activeKey={tab}
          more={{ icon: <span role="img" aria-label={t('merchant.tabs.more')}>•••</span> }}
          onChange={(k) => router.replace(`${pathname}?tab=${k}`, { scroll: false })}
          items={TABS.map((k) => ({ key: k, label: t(`admin.tab.${k}`), children: <AdminLeaseList tab={k} showStatusFilter={k === 'all'} onOpen={setOpenId} label={t(`admin.tab.${k}`)} /> }))}
        />
      </Card>
      <AdminLeaseDrawer leaseId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
