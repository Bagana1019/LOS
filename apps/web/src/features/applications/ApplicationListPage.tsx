'use client';
import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { App as AntApp, Alert, Badge, Button, Flex, Input, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import type { SorterResult } from 'antd/es/table/interface';
import { APPLICATION_PAGE_SIZES, ApplicationSort, ApplicationStatus, type ApplicationRow } from '@los/contracts';
import { formatMoney, t } from '../../lib/i18n';
import { useAuth } from '../../lib/auth/auth-context';
import { downloadApplications } from './applications.api';
import { applicationHref, resumeHref, STATUS_TABS } from './applications.utils';
import { CreateApplicationModal } from './CreateApplicationModal';
import { useApplicationList } from './useApplications';

const { Title, Text } = Typography;

const isStatus = (v: string | null): v is ApplicationStatus => !!v && (ApplicationStatus as readonly string[]).includes(v);
const isSort = (v: string | null): v is (typeof ApplicationSort)[number] => !!v && (ApplicationSort as readonly string[]).includes(v);

/** FR-1.1…1.4: төлвөөр табаар ангилсан хүсэлтийн жагсаалт — шүүлт URL-д (`?status=&q=&sort=&dir=&page=&pageSize=`). */
export function ApplicationListPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { message } = AntApp.useApp();
  const { me } = useAuth();
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);

  const status = isStatus(params.get('status')) ? (params.get('status') as ApplicationStatus) : 'DRAFT';
  const q = params.get('q') ?? '';
  const sort = isSort(params.get('sort')) ? (params.get('sort') as (typeof ApplicationSort)[number]) : 'createdAt';
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const sizeParam = Number(params.get('pageSize'));
  const pageSize = (APPLICATION_PAGE_SIZES as readonly number[]).includes(sizeParam) ? sizeParam : 20;

  const go = (patch: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const query = { status, q: q || undefined, sort, dir, page, pageSize };
  const list = useApplicationList(query);
  const canCreate = !!me && (me.permissions.includes('application:write') || me.user.roles.includes('ADMIN'));

  const columns: ColumnsType<ApplicationRow> = [
    { title: t('application.col.appNo'), dataIndex: 'appNo', key: 'appNo', sorter: true, sortOrder: sort === 'appNo' ? (dir === 'asc' ? 'ascend' : 'descend') : null, render: (v: string, r) => <a href={applicationHref(r.id)} onClick={(e) => { e.preventDefault(); router.push(applicationHref(r.id)); }}>{v}</a> },
    { title: t('application.col.branch'), dataIndex: 'branchId', key: 'branch' },
    { title: t('application.col.officer'), dataIndex: 'officerId', key: 'officer', render: (v: string | null) => v ?? t('application.list.system') },
    { title: t('application.col.contractNo'), dataIndex: 'contractNo', key: 'contractNo', render: (v: string | null) => v ?? '—' },
    { title: t('application.col.customer'), key: 'customer', render: (_, r) => r.primaryBorrower?.displayName ?? '—' },
    { title: t('application.col.register'), key: 'register', render: (_, r) => r.primaryBorrower?.registerNoMasked ?? '—' },
    { title: t('application.col.product'), dataIndex: 'productName', key: 'product', render: (v: string | null) => v ?? '—' },
    { title: t('application.col.currency'), dataIndex: 'currency', key: 'currency' },
    { title: t('application.col.amount'), dataIndex: 'amount', key: 'amount', align: 'right', sorter: true, sortOrder: sort === 'amount' ? (dir === 'asc' ? 'ascend' : 'descend') : null, render: (v: number | null, r) => (v == null ? '—' : formatMoney(v, r.currency)) },
    { title: t('application.col.rate'), dataIndex: 'interestRate', key: 'rate', align: 'right', render: (v: number | null) => (v == null ? '—' : `${v}%`) },
    { title: t('application.col.term'), dataIndex: 'termMonths', key: 'term', align: 'right', render: (v: number | null) => (v == null ? '—' : v) },
    { title: t('application.col.decidedAt'), dataIndex: 'decidedAt', key: 'decidedAt', sorter: true, sortOrder: sort === 'decidedAt' ? (dir === 'asc' ? 'ascend' : 'descend') : null, render: (v: string | null) => (v ? v.slice(0, 10) : '—') },
    { title: t('application.col.status'), dataIndex: 'status', key: 'status', render: (v: ApplicationStatus, r) => (
      <Flex gap={4} wrap>
        <Tag>{t(`status.${v}`)}</Tag>
        {v === 'DRAFT' || v === 'RETURNED' ? <Text type="secondary">{t('application.list.steps', { done: r.stepsDone, required: r.stepsRequired })}</Text> : null}
      </Flex>
    ) },
    { title: t('application.col.action'), key: 'action', render: (_, r) => (
      <Button size="small" type={r.status === 'DRAFT' || r.status === 'RETURNED' ? 'primary' : 'default'} href={r.status === 'DRAFT' || r.status === 'RETURNED' ? resumeHref(r.id) : applicationHref(r.id)}
        onClick={(e) => { e.preventDefault(); router.push(r.status === 'DRAFT' || r.status === 'RETURNED' ? resumeHref(r.id) : applicationHref(r.id)); }}>
        {r.status === 'DRAFT' || r.status === 'RETURNED' ? t('application.action.fill') : t('application.action.open')}
      </Button>
    ) },
  ];

  const onTableChange = (p: TablePaginationConfig, _f: unknown, s: SorterResult<ApplicationRow> | SorterResult<ApplicationRow>[]) => {
    const sorter = Array.isArray(s) ? s[0] : s;
    const key = sorter?.columnKey;
    if (sorter?.order && typeof key === 'string' && isSort(key)) go({ sort: key, dir: sorter.order === 'ascend' ? 'asc' : 'desc', page: p.current, pageSize: p.pageSize });
    else go({ sort: undefined, dir: undefined, page: p.current, pageSize: p.pageSize });
  };

  const doExport = async () => {
    setExporting(true);
    try { await downloadApplications({ status, q: q || undefined, sort, dir }); } catch { void message.error(t('application.list.error')); } finally { setExporting(false); }
  };

  return (
    <div style={{ maxWidth: 1600, margin: '0 auto' }}>
      <Flex justify="space-between" align="flex-start" wrap gap={12}>
        <div>
          <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>{t('application.list.title')}</Title>
          <Text type="secondary">{t('application.list.subtitle')}</Text>
        </div>
        <Flex gap={8} wrap>
          <Button onClick={() => void list.refetch()}>{t('application.list.refresh')}</Button>
          <Button loading={exporting} onClick={() => void doExport()}>{t('application.list.export')}</Button>
          {canCreate ? <Button type="primary" data-testid="create-application" onClick={() => setCreating(true)}>{t('application.list.add')}</Button> : null}
        </Flex>
      </Flex>

      <Tabs
        activeKey={status}
        onChange={(key) => go({ status: key, page: 1 })}
        items={STATUS_TABS.map((s) => ({ key: s, label: <Badge count={list.data?.counts[s] ?? 0} showZero={false} overflowCount={999} offset={[10, -2]} color="blue">{t(`status.${s}`)}</Badge> }))}
      />
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear defaultValue={q} placeholder={t('application.list.search')} style={{ maxWidth: 360 }} onSearch={(v) => go({ q: v.trim() || undefined, page: 1 })} />
        {list.data ? <Text type="secondary" style={{ alignSelf: 'center' }}>{t('application.list.total', { total: list.data.total })}</Text> : null}
      </Flex>

      {list.isError ? <Alert type="error" showIcon message={t('application.list.error')} action={<Button size="small" onClick={() => void list.refetch()}>{t('application.list.retry')}</Button>} style={{ marginBottom: 12 }} /> : null}
      <Table<ApplicationRow>
        rowKey="id"
        size="middle"
        loading={list.isFetching}
        dataSource={list.data?.items ?? []}
        columns={columns}
        scroll={{ x: 1400 }}
        locale={{ emptyText: t('application.list.empty') }}
        pagination={{ current: page, pageSize, total: list.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [...APPLICATION_PAGE_SIZES].map(String) }}
        onChange={onTableChange}
      />

      <CreateApplicationModal open={creating} onClose={() => setCreating(false)} onCreated={(app) => { setCreating(false); void message.success(t('application.create.success', { appNo: app.appNo })); router.push(resumeHref(app.id)); }} />
    </div>
  );
}
