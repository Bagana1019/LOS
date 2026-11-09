'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Alert, Badge, Button, Flex, Input, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import type { SorterResult } from 'antd/es/table/interface';
import { APPLICATION_PAGE_SIZES, ApplicationSort, type ApplicationRow, type ApplicationStatus } from '@los/contracts';
import { formatMoney, t } from '../../lib/i18n';
import { applicationHref } from '../applications/applications.utils';
import { useApplicationList } from '../applications/useApplications';
import { isLoanTab, LOAN_TABS, loanPaymentsHref } from './loans.utils';

const { Title, Text } = Typography;
const isSort = (v: string | null): v is (typeof ApplicationSort)[number] => !!v && (ApplicationSort as readonly string[]).includes(v);

/** docs/01 §2: `/los/loan/list` — олгогдсон зээлүүд; хүсэлтийн жагсаалтын API-г (status=ACTIVE|MIGRATED|CLOSED) дахин ашиглана. Шүүлт URL-д. */
export function LoanListPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const status: ApplicationStatus = isLoanTab(params.get('status')) ? (params.get('status') as ApplicationStatus) : 'ACTIVE';
  const q = params.get('q') ?? '';
  const sort = isSort(params.get('sort')) ? (params.get('sort') as (typeof ApplicationSort)[number]) : 'decidedAt';
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
  const list = useApplicationList({ status, q: q || undefined, sort, dir, page, pageSize });
  const order = (key: string) => (sort === key ? (dir === 'asc' ? 'ascend' : 'descend') : null);

  const columns: ColumnsType<ApplicationRow> = [
    { title: t('loan.col.contractNo'), dataIndex: 'contractNo', key: 'contractNo', render: (v: string | null, r) => <a href={loanPaymentsHref(r.id)} onClick={(e) => { e.preventDefault(); router.push(loanPaymentsHref(r.id)); }}>{v ?? r.appNo}</a> },
    { title: t('application.col.customer'), key: 'customer', render: (_, r) => r.primaryBorrower?.displayName ?? '—' },
    { title: t('application.col.register'), key: 'register', render: (_, r) => r.primaryBorrower?.registerNoMasked ?? '—' },
    { title: t('application.col.product'), dataIndex: 'productName', key: 'product', render: (v: string | null) => v ?? '—' },
    { title: t('application.col.branch'), dataIndex: 'branchId', key: 'branch' },
    { title: t('application.col.amount'), dataIndex: 'amount', key: 'amount', align: 'right', sorter: true, sortOrder: order('amount'), render: (v: number | null, r) => (v == null ? '—' : formatMoney(v, r.currency)) },
    { title: t('application.col.rate'), dataIndex: 'interestRate', key: 'rate', align: 'right', render: (v: number | null) => (v == null ? '—' : `${v}%`) },
    { title: t('application.col.term'), dataIndex: 'termMonths', key: 'term', align: 'right', render: (v: number | null) => (v == null ? '—' : v) },
    { title: t('loan.col.decidedAt'), dataIndex: 'decidedAt', key: 'decidedAt', sorter: true, sortOrder: order('decidedAt'), render: (v: string | null) => (v ? v.slice(0, 10) : '—') },
    { title: t('application.col.status'), dataIndex: 'status', key: 'status', render: (v: ApplicationStatus) => <Tag>{t(`status.${v}`)}</Tag> },
    { title: t('application.col.action'), key: 'action', render: (_, r) => (
      <Flex gap={4}>
        <Button size="small" type="primary" href={loanPaymentsHref(r.id)} onClick={(e) => { e.preventDefault(); router.push(loanPaymentsHref(r.id)); }}>{t('loan.action.payments')}</Button>
        <Button size="small" href={applicationHref(r.id)} onClick={(e) => { e.preventDefault(); router.push(applicationHref(r.id)); }}>{t('loan.action.card')}</Button>
      </Flex>
    ) },
  ];

  const onTableChange = (p: TablePaginationConfig, _f: unknown, s: SorterResult<ApplicationRow> | SorterResult<ApplicationRow>[]) => {
    const sorter = Array.isArray(s) ? s[0] : s;
    const key = sorter?.columnKey;
    if (sorter?.order && typeof key === 'string' && isSort(key)) go({ sort: key, dir: sorter.order === 'ascend' ? 'asc' : 'desc', page: p.current, pageSize: p.pageSize });
    else go({ sort: undefined, dir: undefined, page: p.current, pageSize: p.pageSize });
  };

  return (
    <div style={{ maxWidth: 1600, margin: '0 auto' }}>
      <Flex justify="space-between" align="flex-start" wrap gap={12}>
        <div>
          <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>{t('loan.list.title')}</Title>
          <Text type="secondary">{t('loan.list.subtitle')}</Text>
        </div>
        <Button onClick={() => void list.refetch()}>{t('application.list.refresh')}</Button>
      </Flex>

      <Tabs
        activeKey={status}
        onChange={(key) => go({ status: key, page: 1 })}
        items={LOAN_TABS.map((s) => ({ key: s, label: <Badge count={list.data?.counts[s] ?? 0} showZero={false} overflowCount={999} offset={[10, -2]} color="blue">{t(`status.${s}`)}</Badge> }))}
      />
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear defaultValue={q} placeholder={t('application.list.search')} style={{ maxWidth: 360 }} onSearch={(v) => go({ q: v.trim() || undefined, page: 1 })} />
        {list.data ? <Text type="secondary" style={{ alignSelf: 'center' }}>{t('application.list.total', { total: list.data.total })}</Text> : null}
      </Flex>

      {list.isError ? <Alert type="error" showIcon message={t('loan.list.error')} action={<Button size="small" onClick={() => void list.refetch()}>{t('application.list.retry')}</Button>} style={{ marginBottom: 12 }} /> : null}
      <Table<ApplicationRow>
        rowKey="id"
        size="middle"
        loading={list.isFetching}
        dataSource={list.data?.items ?? []}
        columns={columns}
        scroll={{ x: 1300 }}
        locale={{ emptyText: t('loan.list.empty') }}
        pagination={{ current: page, pageSize, total: list.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [...APPLICATION_PAGE_SIZES].map(String) }}
        onChange={onTableChange}
      />
    </div>
  );
}
