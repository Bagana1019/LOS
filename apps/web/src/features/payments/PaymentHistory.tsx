'use client';
import { Alert, Empty, Flex, Skeleton, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { PaymentAllocationView, PaymentView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { PaymentErrorAlert } from './PaymentErrorAlert';
import { allocatedAmount, formatAmount, formatDateTime, PROVIDER_COLOR, providerKey, sortAllocations } from './payment.utils';
import { usePaymentList } from './usePayments';

interface Props {
  applicationId: string;
}

/** Төлбөр бүрийн ЭТХ-ийн мөрүүдэд хуваарилагдсан хэсэг (хүү → үндсэн). */
function AllocationTable({ payment }: { payment: PaymentView }) {
  const { currency } = payment;
  const columns: TableColumnsType<PaymentAllocationView> = [
    { title: t('payment.schedule.column.seq'), dataIndex: 'seq', key: 'seq', width: 70, align: 'right' },
    { title: t('payment.schedule.column.dueDate'), dataIndex: 'dueDate', key: 'dueDate', width: 130 },
    { title: t('payment.history.allocation.interest'), key: 'interest', align: 'right', render: (_, a) => formatAmount(a.interestPaid, currency) },
    { title: t('payment.history.allocation.principal'), key: 'principal', align: 'right', render: (_, a) => formatAmount(a.principalPaid, currency) },
    { title: t('payment.history.allocation.total'), key: 'total', align: 'right', render: (_, a) => <Typography.Text strong>{formatAmount(a.totalPaid, currency)}</Typography.Text> },
  ];
  return (
    <Flex vertical gap={8}>
      {payment.allocations.length === 0 ? (
        <Typography.Text type="secondary">{t('payment.history.allocation.none')}</Typography.Text>
      ) : (
        <Table<PaymentAllocationView> size="small" rowKey="scheduleRowId" columns={columns} dataSource={sortAllocations(payment.allocations)} pagination={false} />
      )}
      {payment.unallocatedAmount > 0 ? (
        <Alert type="warning" showIcon message={t('payment.history.unallocated.hint', { amount: formatAmount(payment.unallocatedAmount, currency) })} />
      ) : null}
    </Flex>
  );
}

/** Төлбөрийн түүх: шинэ нь эхэнд, мөр бүр дээр дарж ЭТХ-ийн хуваарилалтыг харна. */
export function PaymentHistory({ applicationId }: Props) {
  const query = usePaymentList(applicationId);
  const payments = query.data;

  const columns: TableColumnsType<PaymentView> = [
    { title: t('payment.history.column.paidAt'), key: 'paidAt', width: 150, render: (_, p) => formatDateTime(p.paidAt) },
    { title: t('payment.history.column.provider'), key: 'provider', width: 150, render: (_, p) => <Tag color={PROVIDER_COLOR[p.provider]}>{t(providerKey(p.provider))}</Tag> },
    { title: t('payment.history.column.amount'), key: 'amount', align: 'right', render: (_, p) => <Typography.Text strong>{formatAmount(p.amount, p.currency)}</Typography.Text> },
    { title: t('payment.history.column.allocated'), key: 'allocated', align: 'right', render: (_, p) => formatAmount(allocatedAmount(p), p.currency) },
    {
      title: t('payment.history.column.unallocated'),
      key: 'unallocated',
      align: 'right',
      render: (_, p) =>
        p.unallocatedAmount > 0 ? (
          <Tooltip title={t('payment.history.unallocated.tooltip')}>
            <Tag color="gold" style={{ marginInlineEnd: 0 }}>{formatAmount(p.unallocatedAmount, p.currency)}</Tag>
          </Tooltip>
        ) : (
          t('payment.common.empty')
        ),
    },
    { title: t('payment.history.column.payer'), key: 'payer', width: 140, render: (_, p) => p.payerAccountMasked ?? t('payment.common.empty') },
    {
      title: t('payment.history.column.reference'),
      key: 'reference',
      width: 190,
      render: (_, p) => <Typography.Text type="secondary" ellipsis={{ tooltip: p.providerPaymentId }} copyable={{ text: p.providerPaymentId }} style={{ maxWidth: 170 }}>{p.providerPaymentId}</Typography.Text>,
    },
  ];

  return (
    <Flex vertical gap={12}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('payment.history.title')}</Typography.Title>
      {query.isLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : null}
      {query.isError && !payments ? <PaymentErrorAlert error={query.error} title={t('payment.history.loadError')} onRetry={() => void query.refetch()} /> : null}
      {payments && payments.length === 0 ? <Empty description={t('payment.history.empty')} /> : null}
      {payments && payments.length > 0 ? (
        <Table<PaymentView>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={payments}
          pagination={payments.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
          scroll={{ x: 960 }}
          expandable={{ expandedRowRender: (p) => <AllocationTable payment={p} /> }}
        />
      ) : null}
    </Flex>
  );
}
