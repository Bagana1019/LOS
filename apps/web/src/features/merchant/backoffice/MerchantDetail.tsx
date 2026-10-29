'use client';
import type { MerchantView } from '@los/contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Descriptions, Skeleton, Tabs } from 'antd';
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useState } from 'react';
import { formatDate, formatDateTime, formatMnt, formatPercent } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { backOfficeKeys, getMerchant } from '../../../lib/merchant-api';
import { Icon } from '../icons';
import { PageHeader } from '../PageHeader';
import { ErrorState } from '../states';
import { MerchantStatusTag } from '../StatusTag';
import { AdminLeaseDrawer, } from './AdminLeaseDrawer';
import { AdminLeaseList } from './PosLeasesAdmin';
import { MerchantFormDrawer } from './MerchantFormDrawer';
import { MerchantStatusModal } from './MerchantStatusModal';
import { PlansTab } from './PlansTab';
import { StoresTab } from './StoresTab';

type TabKey = 'info' | 'stores' | 'plans' | 'leases';
const TABS: TabKey[] = ['info', 'stores', 'plans', 'leases'];

function InfoTab({ m }: { m: MerchantView }) {
  const [editing, setEditing] = useState(false);
  const [changing, setChanging] = useState(false);
  return (
    <div>
      <div className="mp-tab-toolbar">
        <Button onClick={() => setEditing(true)}>{t('merchant.edit')}</Button>
        <Button type="primary" onClick={() => setChanging(true)} disabled={m.status === 'TERMINATED'}>{t('merchants.status.change')}</Button>
      </div>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 1, md: 2 }} className="mp-descriptions" items={[
        { key: 'code', label: t('merchants.field.code'), children: m.code },
        { key: 'status', label: t('merchants.col.status'), children: <MerchantStatusTag status={m.status} /> },
        { key: 'name', label: t('merchants.field.name'), children: m.name },
        { key: 'legal', label: t('merchants.field.legalName'), children: m.legalName ?? '—' },
        { key: 'reg', label: t('merchants.field.companyRegisterNo'), children: m.companyRegisterNo ?? '—' },
        { key: 'cat', label: t('merchants.field.category'), children: m.category ? t(`goodsCategory.${m.category}`) : '—' },
        { key: 'contact', label: t('merchants.field.contactName'), children: m.contactName },
        { key: 'phone', label: t('merchants.field.phone'), children: m.phone },
        { key: 'email', label: t('merchants.field.email'), children: m.email ?? '—' },
        { key: 'branch', label: t('merchants.field.branchId'), children: m.branchId },
        { key: 'commission', label: t('merchants.field.commissionRate'), children: formatPercent(m.commissionRate, 2) },
        { key: 'ticket', label: t('merchants.field.maxTicket'), children: formatMnt(m.maxTicketAmount) },
        { key: 'daily', label: t('merchants.field.dailyLimit'), children: m.dailyLimitAmount === null ? t('dashboard.limits.noLimit') : formatMnt(m.dailyLimitAmount) },
        { key: 'bank', label: t('merchants.field.bankCode'), children: m.settlement.bankCode },
        { key: 'account', label: t('merchants.field.accountNo'), children: m.settlement.accountMasked },
        { key: 'holder', label: t('merchants.field.holderName'), children: m.settlement.holderName },
        { key: 'contractNo', label: t('merchants.field.contractNo'), children: m.contractNo ?? '—' },
        { key: 'signed', label: t('merchants.field.contractSignedAt'), children: m.contractSignedAt ? formatDate(m.contractSignedAt) : '—' },
        { key: 'created', label: t('merchants.col.createdAt'), children: formatDateTime(m.createdAt) },
        { key: 'updated', label: t('merchants.col.updatedAt'), children: formatDateTime(m.updatedAt) },
      ]} />
      <MerchantFormDrawer open={editing} merchant={m} onClose={() => setEditing(false)} />
      {changing ? <MerchantStatusModal merchant={m} onClose={() => setChanging(false)} /> : null}
    </div>
  );
}

/** /settings/merchants/[id] — Мэдээлэл · Дэлгүүр · Хөтөлбөр · Лизингүүд. */
export function MerchantDetail({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const raw = sp.get('tab');
  const tab: TabKey = TABS.includes(raw as TabKey) ? (raw as TabKey) : 'info';
  const [leaseId, setLeaseId] = useState<string | null>(null);
  const q = useQuery({ queryKey: backOfficeKeys.merchant(id), queryFn: ({ signal }) => getMerchant(id, { signal }) });
  const back = <Link href="/settings/merchants" className="mp-back-link"><Icon name="back" size={16} />{t('merchants.title')}</Link>;

  if (q.isPending) return <div className="mp-page"><PageHeader title={t('merchants.detail.title')} back={back} /><Card className="mp-card"><Skeleton active paragraph={{ rows: 8 }} /></Card></div>;
  if (q.isError) return <div className="mp-page"><PageHeader title={t('merchants.detail.title')} back={back} /><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const m = q.data;
  return (
    <div className="mp-page">
      <PageHeader back={back} title={<span className="mp-title-row">{m.name}<MerchantStatusTag status={m.status} /></span>} subtitle={`${m.code} · ${m.contactName} · ${m.phone}`} />
      <Card className="mp-card">
        <Tabs
          activeKey={tab}
          more={{ icon: <span role="img" aria-label={t('merchant.tabs.more')}>•••</span> }}
          onChange={(k) => router.replace(`${pathname}?tab=${k}`, { scroll: false })}
          items={[
            { key: 'info', label: t('merchants.tab.info'), children: <InfoTab m={m} /> },
            { key: 'stores', label: t('merchants.tab.stores'), children: <StoresTab merchantId={m.id} /> },
            { key: 'plans', label: t('merchants.tab.plans'), children: <PlansTab merchantId={m.id} /> },
            { key: 'leases', label: t('merchants.tab.leases'), children: <AdminLeaseList merchantId={m.id} tab="all" showStatusFilter onOpen={setLeaseId} label={t('merchants.tab.leases')} /> },
          ]}
        />
      </Card>
      <AdminLeaseDrawer leaseId={leaseId} onClose={() => setLeaseId(null)} />
    </div>
  );
}
