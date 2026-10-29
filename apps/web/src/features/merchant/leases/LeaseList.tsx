'use client';
import { PosLeaseStatus } from '@los/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Card, Input, Select } from 'antd';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../../../lib/i18n';
import { listLeases, merchantKeys } from '../../../lib/merchant-api';
import { useMe, useSearchState } from '../hooks';
import { LinkButton } from '../LinkButton';
import { PageHeader } from '../PageHeader';
import { ErrorState } from '../states';
import { canCreateLeases, statusLabel } from '../status';
import { filtersToParams, filtersToSearch, hasActiveFilters, parseLeaseFilters, type LeaseFilters } from './filters';
import { LeaseResults } from './LeaseResults';

/** /merchant/leases — шүүлт нь URL-тай синк (status, store, from, to, page), хуудаслалт серверийн. Хайлт `q` нь URL-д орохгүй (PII — POS-BR-7), зөвхөн төлөвт. */
export function LeaseList() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const me = useMe();
  const urlFilters = useMemo(() => parseLeaseFilters(new URLSearchParams(sp.toString())), [sp]);

  // Хайлт (регистр/утасны цифр байж болно): зөвхөн төлөвт, 400мс-ийн дараа API-ийн query-д. URL-д бичихгүй.
  const { input: qInput, setInput: setQInput, value: q, clear: clearQ } = useSearchState();
  // Хайлт өөрчлөгдөхөд URL-ийн page хүчингүй: render дотор шууд 1 гэж үзнэ (хуучин хуудасны илүү хүсэлт, хоосон төлөв анивчихгүй), URL-ийг effect-ээр цэвэрлэнэ.
  const [prevQ, setPrevQ] = useState(q);
  const [ignoredPage, setIgnoredPage] = useState<number | null>(null);
  if (prevQ !== q) {
    setPrevQ(q);
    setIgnoredPage(urlFilters.page > 1 ? urlFilters.page : null);
  }
  const page = urlFilters.page === ignoredPage ? 1 : urlFilters.page;
  const filters = useMemo<LeaseFilters>(() => ({ ...urlFilters, page, ...(q ? { q } : {}) }), [urlFilters, page, q]);
  const params = useMemo(() => filtersToParams(filters), [filters]);

  const update = (patch: Partial<LeaseFilters>, resetPage = true) => {
    const next: LeaseFilters = { ...urlFilters, ...patch, ...(resetPage ? { page: 1 } : {}) };
    router.replace(`${pathname}${filtersToSearch(next)}`, { scroll: false });
  };

  useEffect(() => {
    if (ignoredPage === null) return;
    if (urlFilters.page !== ignoredPage) setIgnoredPage(null); // URL гүйцлээ
    else update({});
    // Зөвхөн хүчингүй болсон page эсвэл URL-ийн page өөрчлөгдөхөд ажиллана.
  }, [ignoredPage, urlFilters.page]);
  // Бүх шүүлтийг цэвэрлэнэ. `setPrevQ('')` нь хайлтын өөрчлөлтийг "хуудас хүчингүй" гэж танихгүй байлгаж, effect хуучин `urlFilters`-ээр URL-ийг буцааж дарахаас сэргийлнэ.
  const clearAll = () => {
    setPrevQ('');
    setIgnoredPage(null);
    clearQ();
    router.replace(pathname, { scroll: false });
  };

  const list = useQuery({ queryKey: merchantKeys.leases(params), queryFn: ({ signal }) => listLeases(params, { signal }), placeholderData: keepPreviousData });
  const profile = me.data;
  const showStores = profile?.role === 'MERCHANT_ADMIN' && profile.stores.length > 1;
  const canCreate = profile ? canCreateLeases(profile.merchant.status) : true;
  const active = hasActiveFilters(filters);

  return (
    <div>
      <PageHeader title={t('leases.title')} subtitle={t('leases.subtitle')} extra={<LinkButton href="/merchant/leases/new" type="primary" size="large" disabled={!canCreate}>{t('merchant.cta.newLease')}</LinkButton>} />
      <Card className="mp-card mp-filter-card">
        <form className="mp-filters" role="search" aria-label={t('leases.filters.label')} onSubmit={(e) => e.preventDefault()}>
          <label className="mp-field mp-field-grow">
            <span>{t('leases.filter.search')}</span>
            <Input allowClear value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={t('leases.filter.search.placeholder')} maxLength={100} inputMode="search" aria-label={t('leases.filter.search')} />
          </label>
          <div className="mp-field mp-field-grow">
            <span id="f-status">{t('leases.filter.status')}</span>
            <Select<PosLeaseStatus[]>
              mode="multiple"
              allowClear
              maxTagCount="responsive"
              aria-labelledby="f-status"
              value={urlFilters.status}
              placeholder={t('leases.filter.status.all')}
              onChange={(v) => update({ status: v })}
              options={PosLeaseStatus.map((s) => ({ value: s, label: statusLabel(s) }))}
            />
          </div>
          {showStores && profile ? (
            <div className="mp-field">
              <span id="f-store">{t('leases.filter.store')}</span>
              <Select<string>
                aria-labelledby="f-store"
                value={urlFilters.storeId ?? ''}
                onChange={(v) => update({ storeId: v || undefined })}
                options={[{ value: '', label: t('merchant.allStores') }, ...profile.stores.map((s) => ({ value: s.id, label: s.name }))]}
              />
            </div>
          ) : null}
          <label className="mp-field">
            <span>{t('leases.filter.from')}</span>
            <Input type="date" value={urlFilters.from ?? ''} max={urlFilters.to} onChange={(e) => update({ from: e.target.value || undefined })} />
          </label>
          <label className="mp-field">
            <span>{t('leases.filter.to')}</span>
            <Input type="date" value={urlFilters.to ?? ''} min={urlFilters.from} onChange={(e) => update({ to: e.target.value || undefined })} />
          </label>
          {active ? <Button className="mp-clear" onClick={clearAll}>{t('leases.filter.clear')}</Button> : null}
        </form>
      </Card>

      <Card className="mp-card mp-card-flush mp-results-card">
        {list.isError && !list.data ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <LeaseResults
            label={t('leases.title')}
            items={list.data?.items ?? []}
            loading={list.isPending || (list.isFetching && list.isPlaceholderData)}
            hrefFor={(id) => `/merchant/leases/${id}`}
            onOpen={(id) => router.push(`/merchant/leases/${id}`)}
            pagination={list.data ? { current: list.data.page, pageSize: list.data.pageSize, total: list.data.total, onChange: (page, pageSize) => update({ page, pageSize }, false) } : undefined}
            emptyTitle={active ? t('leases.empty.filtered.title') : t('leases.empty.title')}
            emptyDescription={active ? t('leases.empty.filtered.text') : t('leases.empty.text')}
            emptyActions={active ? <Button onClick={clearAll}>{t('leases.filter.clear')}</Button> : canCreate ? <LinkButton href="/merchant/leases/new" type="primary">{t('merchant.cta.newLease')}</LinkButton> : undefined}
          />
        )}
      </Card>
    </div>
  );
}
