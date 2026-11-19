'use client';
import { Button, Flex, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { MyApprovalItem } from '@los/contracts';
import { formatDateTime } from '../../lib/format';
import { formatMoney, t } from '../../lib/i18n';
import { applicationHref } from './applications.utils';

interface Props {
  items: readonly MyApprovalItem[];
  loading?: boolean;
  /** Санал өгч байх үед бүх мөрийн товч идэвхгүй — давхар санал өгөхгүй. */
  busy: boolean;
  onOpen: (applicationId: string) => void;
  onApprove: (item: MyApprovalItem) => void;
  onReturn: (item: MyApprovalItem) => void;
}

/** FR-1.1 / FR-1.5: одоогийн хэрэглэгчийн санал хүлээж буй хүсэлтүүд — мөр бүрт Батлах / Буцаах. Цэвэр (hook-гүй) тул react-dom/server-ээр тестлэгдэнэ. */
export function MyApprovalsTable({ items, loading, busy, onOpen, onApprove, onReturn }: Props) {
  const columns: ColumnsType<MyApprovalItem> = [
    { title: t('application.col.appNo'), dataIndex: 'appNo', key: 'appNo', render: (v: string, r) => <a href={applicationHref(r.applicationId)} onClick={(e) => { e.preventDefault(); onOpen(r.applicationId); }}>{v}</a> },
    { title: t('application.col.customer'), key: 'customer', render: (_, r) => r.borrowerName ?? '—' },
    { title: t('application.col.amount'), key: 'amount', align: 'right', render: (_, r) => (r.amount == null ? '—' : formatMoney(r.amount, r.currency)) },
    { title: t('application.mine.col.level'), key: 'level', render: (_, r) => t('application.mine.level', { no: r.levelNo, total: r.totalLevels, name: r.levelName }) },
    { title: t('application.mine.col.due'), key: 'due', render: (_, r) => (
      <Flex gap={4} wrap>
        <span>{r.dueAt ? formatDateTime(r.dueAt) : '—'}</span>
        {r.overdue ? <Tag color="error">{t('application.mine.overdue')}</Tag> : null}
      </Flex>
    ) },
    { title: t('application.col.action'), key: 'action', render: (_, r) => (
      <Flex gap={8} wrap>
        <Button size="small" type="primary" disabled={busy} data-testid={`mine-approve-${r.applicationId}`} onClick={() => onApprove(r)}>{t('decide.approve')}</Button>
        <Button size="small" danger disabled={busy} data-testid={`mine-return-${r.applicationId}`} onClick={() => onReturn(r)}>{t('decide.return')}</Button>
      </Flex>
    ) },
  ];

  return (
    <Table<MyApprovalItem>
      rowKey="applicationId"
      size="middle"
      loading={loading}
      dataSource={[...items]}
      columns={columns}
      scroll={{ x: 900 }}
      pagination={false}
      locale={{ emptyText: t('application.mine.empty') }}
    />
  );
}
