'use client';
import { MerchantStatus, type MerchantView } from '@los/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Card, Input, Pagination, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { formatDate, formatMnt, formatPercent } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { backOfficeKeys, listMerchants, type MerchantListParams } from '../../../lib/merchant-api';
import { useIsMobile, useUrlSearchInput } from '../hooks';
import { paginationItemRender } from '../pagination';
import { PageHeader } from '../PageHeader';
import { EmptyState, ErrorState } from '../states';
import { MerchantStatusTag } from '../StatusTag';
import { merchantStatusLabel } from '../status';
import { MerchantFormDrawer } from './MerchantFormDrawer';

const PAGE_SIZES = [10, 20, 50];

/** /settings/merchants — мерчантын жагсаалт, шүүлт (төлөв, хайлт; URL-тай синк), бүртгэх drawer. */
export function MerchantList() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const mobile = useIsMobile();
  const statusParam = sp.get('status');
  const status = (MerchantStatus as readonly string[]).includes(statusParam ?? '') ? (statusParam as MerchantStatus) : undefined;
  const qParam = sp.get('q') ?? '';
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const pageSize = PAGE_SIZES.includes(Number(sp.get('pageSize'))) ? Number(sp.get('pageSize')) : 20;
  const [creating, setCreating] = useState(false);

  const push = (patch: { status?: MerchantStatus | null; q?: string | null; page?: number; pageSize?: number }) => {
    const next = new URLSearchParams(sp.toString());
    const set = (k: string, v: string | null | undefined) => { if (v) next.set(k, v); else next.delete(k); };
    if ('status' in patch) set('status', patch.status);
    if ('q' in patch) set('q', patch.q);
    set('page', patch.page && patch.page > 1 ? String(patch.page) : null);
    if (patch.pageSize !== undefined) set('pageSize', patch.pageSize === 20 ? null : String(patch.pageSize));
    const s = next.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  // Хайлт: бичих явцад локал, 400мс-ийн дараа URL-д (router-ийн хоцролтод тэсвэртэй).
  const { input: qInput, setInput: setQInput, clear: clearQ } = useUrlSearchInput(qParam, (q) => push({ q: q || null }));

  const params: MerchantListParams = { ...(status ? { status } : {}), ...(qParam ? { q: qParam } : {}), page, pageSize };
  const query = useQuery({ queryKey: backOfficeKeys.merchants(params), queryFn: ({ signal }) => listMerchants(params, { signal }), placeholderData: keepPreviousData });
  const open = (id: string) => router.push(`/settings/merchants/${id}`);

  const columns: ColumnsType<MerchantView> = [
    { title: t('merchants.col.code'), dataIndex: 'code', key: 'code', width: 130, render: (v: string, r) => <Link href={`/settings/merchants/${r.id}`} onClick={(e) => e.stopPropagation()} className="mp-lease-no">{v}</Link> },
    { title: t('merchants.col.name'), key: 'name', render: (_: unknown, r) => <div><div className="mp-cell-main">{r.name}</div>{r.legalName ? <div className="mp-cell-sub">{r.legalName}</div> : null}</div> },
    { title: t('merchants.col.contact'), key: 'contact', render: (_: unknown, r) => <div><div>{r.contactName}</div><div className="mp-cell-sub">{r.phone}</div></div> },
    { title: t('merchants.col.branch'), dataIndex: 'branchId', key: 'branchId' },
    { title: t('merchants.col.commission'), dataIndex: 'commissionRate', key: 'commissionRate', align: 'right', render: (v: number) => formatPercent(v, 2) },
    { title: t('merchants.col.maxTicket'), dataIndex: 'maxTicketAmount', key: 'maxTicketAmount', align: 'right', render: (v: number) => <span className="mp-num">{formatMnt(v)}</span> },
    { title: t('merchants.col.dailyLimit'), dataIndex: 'dailyLimitAmount', key: 'dailyLimitAmount', align: 'right', render: (v: number | null) => (v === null ? t('dashboard.limits.noLimit') : <span className="mp-num">{formatMnt(v)}</span>) },
    { title: t('merchants.col.status'), dataIndex: 'status', key: 'status', render: (v: MerchantView['status']) => <MerchantStatusTag status={v} /> },
    { title: t('merchants.col.createdAt'), dataIndex: 'createdAt', key: 'createdAt', render: (v: string) => formatDate(v) },
  ];

  const items = query.data?.items ?? [];
  const filtered = !!status || !!qParam;
  return (
    <div className="mp-page">
      <PageHeader title={t('merchants.title')} subtitle={t('merchants.subtitle')} extra={<Button type="primary" size="large" onClick={() => setCreating(true)}>{t('merchants.create')}</Button>} />
      <Card className="mp-card mp-filter-card">
        <div className="mp-filters" role="search" aria-label={t('merchants.filters.label')}>
          <label className="mp-field mp-field-grow">
            <span>{t('leases.filter.search')}</span>
            <Input allowClear value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={t('merchants.filter.search.placeholder')} maxLength={100} />
          </label>
          <div className="mp-field">
            <span id="m-status">{t('merchants.col.status')}</span>
            <Select<MerchantStatus | ''> aria-labelledby="m-status" value={status ?? ''} onChange={(v) => push({ status: v || null, page: 1 })} options={[{ value: '', label: t('merchants.filter.status.all') }, ...MerchantStatus.map((s) => ({ value: s, label: merchantStatusLabel(s) }))]} />
          </div>
          {filtered ? <Button className="mp-clear" onClick={() => { clearQ(); router.replace(pathname, { scroll: false }); }}>{t('leases.filter.clear')}</Button> : null}
        </div>
      </Card>
      <Card className="mp-card mp-card-flush mp-results-card">
        {query.isError && !query.data ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !query.isPending && items.length === 0 ? (
          <EmptyState title={filtered ? t('merchants.empty.filtered') : t('merchants.empty.title')} description={filtered ? t('leases.empty.filtered.text') : t('merchants.empty.text')} actions={filtered ? undefined : <Button type="primary" onClick={() => setCreating(true)}>{t('merchants.create')}</Button>} />
        ) : mobile ? (
          <div>
            <ul className="mp-lease-cards" aria-label={t('merchants.title')}>
              {items.map((m) => (
                <li key={m.id}>
                  <Link className="mp-lease-card" href={`/settings/merchants/${m.id}`}>
                    <div className="mp-lease-card-top"><span className="mp-lease-no">{m.name}</span><MerchantStatusTag status={m.status} /></div>
                    <div className="mp-lease-card-meta">{m.code} · {m.contactName} · {m.phone}</div>
                    <div className="mp-lease-card-meta">{t('merchants.col.commission')}: {formatPercent(m.commissionRate, 2)} · {formatMnt(m.maxTicketAmount)}</div>
                  </Link>
                </li>
              ))}
            </ul>
            {query.data ? <Pagination className="mp-pagination" simple itemRender={paginationItemRender} current={query.data.page} pageSize={query.data.pageSize} total={query.data.total} showSizeChanger={false} onChange={(p) => push({ page: p })} /> : null}
          </div>
        ) : (
          <Table<MerchantView>
            aria-label={t('merchants.title')} rowKey="id" size="middle" columns={columns} dataSource={items} loading={query.isPending || (query.isFetching && query.isPlaceholderData)} scroll={{ x: 'max-content' }} className="mp-table"
            rowClassName={() => 'mp-row-click'} onRow={(r) => ({ onClick: () => open(r.id) })}
            pagination={query.data ? { current: query.data.page, pageSize: query.data.pageSize, total: query.data.total, showSizeChanger: true, pageSizeOptions: PAGE_SIZES, itemRender: paginationItemRender, showTotal: (total) => t('leases.total', { total }), onChange: (p, s) => push({ page: p, pageSize: s }) } : false}
          />
        )}
      </Card>
      <MerchantFormDrawer open={creating} onClose={() => setCreating(false)} onSaved={(m) => open(m.id)} />
    </div>
  );
}
