'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Flex, Input, Select, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CustomerType, type CustomerSummary } from '@los/contracts';
import { t } from '../../lib/i18n';
import { useAuth } from '../../lib/auth/auth-context';
import { useCustomerList } from './useCustomers';

const { Title, Text } = Typography;

/** FR-2.2: харилцагчийн жагсаалт + хайлт (регистр / овог нэр / утас). */
export function CustomerListPage() {
  const router = useRouter();
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [type, setType] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const list = useCustomerList({ q: q || undefined, customerType: type, page, pageSize });
  const canWrite = !!me && me.permissions.includes('customer:write');

  const open = (id: string) => router.push(`/customer/${id}`);
  const columns: ColumnsType<CustomerSummary> = [
    { title: t('customer.col.register'), dataIndex: 'registerNoMasked', key: 'register', render: (v: string, r) => <a href={`/customer/${r.id}`} onClick={(e) => { e.preventDefault(); open(r.id); }}>{v}</a> },
    { title: t('customer.col.type'), dataIndex: 'customerType', key: 'type', render: (v: CustomerType) => <Tag>{t(`customer.type.${v}`)}</Tag> },
    { title: t('customer.col.name'), key: 'name', render: (_, r) => [r.lastName, r.firstName].filter(Boolean).join(' ') },
    { title: t('customer.col.phone'), dataIndex: 'phone', key: 'phone', render: (v: string | null) => v ?? '—' },
    { title: t('customer.col.flags'), key: 'flags', render: (_, r) => (
      <Flex gap={4} wrap>
        {r.blacklisted ? <Tag color="red">{t('customer.flag.blacklisted')}</Tag> : null}
        {r.isPep ? <Tag color="orange">{t('customer.flag.pep')}</Tag> : null}
        {r.isRelatedParty ? <Tag color="gold">{t('customer.flag.related')}</Tag> : null}
      </Flex>
    ) },
    { title: t('customer.col.createdAt'), dataIndex: 'createdAt', key: 'createdAt', render: (v: string) => v.slice(0, 10) },
  ];

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <Flex justify="space-between" align="flex-start" wrap gap={12}>
        <div>
          <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>{t('customer.title')}</Title>
          <Text type="secondary">{t('customer.list.subtitle')}</Text>
        </div>
        {canWrite ? <Button type="primary" data-testid="create-customer" onClick={() => router.push('/customer/new')}>{t('customer.action.add')}</Button> : null}
      </Flex>
      {!canWrite && me ? <Alert style={{ marginTop: 12 }} type="info" showIcon message={t('customer.list.noWriteHint')} /> : null}

      <Flex gap={8} wrap style={{ margin: '16px 0 12px' }}>
        <Input.Search allowClear placeholder={t('customer.search.placeholder')} style={{ maxWidth: 360 }} onSearch={(v) => { setQ(v.trim()); setPage(1); }} />
        <Select allowClear placeholder={t('customer.list.allTypes')} style={{ width: 180 }} value={type} onChange={(v) => { setType(v); setPage(1); }}
          options={CustomerType.map((v) => ({ value: v, label: t(`customer.type.${v}`) }))} />
        {list.data ? <Text type="secondary" style={{ alignSelf: 'center' }}>{t('customer.list.total', { total: list.data.total })}</Text> : null}
      </Flex>

      {list.isError ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={t('customer.list.error')} action={<Button size="small" onClick={() => void list.refetch()}>{t('customer.list.retry')}</Button>} /> : null}
      <Table<CustomerSummary>
        rowKey="id"
        loading={list.isFetching}
        dataSource={list.data?.items ?? []}
        columns={columns}
        locale={{ emptyText: t('customer.list.empty') }}
        pagination={{ current: page, pageSize, total: list.data?.total ?? 0, showSizeChanger: true, onChange: (p, s) => { setPage(p); setPageSize(s); } }}
      />
    </div>
  );
}
