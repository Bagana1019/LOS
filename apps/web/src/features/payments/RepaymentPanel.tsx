'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Flex, Progress, Skeleton, Statistic, Table, Tag, Tooltip, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import type { InstallmentView, RepaymentStatusView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { PayModal } from './PayModal';
import { PaymentErrorAlert } from './PaymentErrorAlert';
import { formatAmount, formatDateTime, INSTALLMENT_COLOR, installmentStatusKey, paidPercent, payGate } from './payment.utils';
import { paymentsKey, useRepaymentStatus } from './usePayments';

interface Props {
  applicationId: string;
}

/** Нэг мөрийн нүд: тоо баганад баруун тийш. */
const money = (v: number, currency: string) => <span style={{ whiteSpace: 'nowrap' }}>{formatAmount(v, currency)}</span>;

function PayNowCard({ status, gateText, onPay }: { status: RepaymentStatusView; gateText: string | null; onPay: () => void }) {
  const { currency } = status;
  const disabled = !status.payable;
  const button = (
    <Button type="primary" size="large" disabled={disabled} onClick={onPay}>{t('payment.repayment.payNow.action')}</Button>
  );
  return (
    <Card style={{ flex: '1 1 340px' }}>
      <Flex vertical gap={12}>
        <Statistic title={t('payment.repayment.payNow.title')} value={status.payable ? formatAmount(status.payNowAmount, currency) : t('payment.common.empty')} />
        <Flex vertical gap={4}>
          {status.totals.overdue > 0 ? <Tag color="red" style={{ width: 'fit-content' }}>{t('payment.repayment.payNow.overdue', { amount: formatAmount(status.totals.overdue, currency) })}</Tag> : null}
          {status.nextDue ? (
            <Typography.Text type="secondary">
              {t('payment.repayment.payNow.nextDue', { date: status.nextDue.dueDate, amount: formatAmount(status.nextDue.outstanding, currency) })}
            </Typography.Text>
          ) : null}
        </Flex>
        {gateText ? <Tooltip title={gateText}><span style={{ width: 'fit-content' }}>{button}</span></Tooltip> : button}
      </Flex>
    </Card>
  );
}

function TotalsCard({ status }: { status: RepaymentStatusView }) {
  const { token } = theme.useToken();
  const { currency, totals } = status;
  return (
    <Card style={{ flex: '2 1 520px' }}>
      <Flex vertical gap={12}>
        <Flex gap={32} wrap>
          <Statistic title={t('payment.repayment.totals.scheduled')} value={formatAmount(totals.scheduled, currency)} />
          <Statistic title={t('payment.repayment.totals.paid')} value={formatAmount(totals.paid, currency)} />
          <Statistic title={t('payment.repayment.totals.outstanding')} value={formatAmount(totals.outstanding, currency)} />
          <Statistic title={t('payment.repayment.totals.overdue')} value={formatAmount(totals.overdue, currency)} valueStyle={totals.overdue > 0 ? { color: token.colorError } : undefined} />
        </Flex>
        <Progress percent={paidPercent(totals)} status={totals.outstanding === 0 && totals.scheduled > 0 ? 'success' : 'active'} />
      </Flex>
    </Card>
  );
}

function ScheduleTable({ status, onPayRow }: { status: RepaymentStatusView; onPayRow: (row: InstallmentView) => void }) {
  const { token } = theme.useToken();
  const { currency } = status;

  const columns: TableColumnsType<InstallmentView> = [
    { title: t('payment.schedule.column.seq'), dataIndex: 'seq', key: 'seq', width: 60, align: 'right' },
    { title: t('payment.schedule.column.dueDate'), dataIndex: 'dueDate', key: 'dueDate', width: 120 },
    { title: t('payment.schedule.column.principal'), key: 'principal', align: 'right', render: (_, r) => money(r.principal, currency) },
    { title: t('payment.schedule.column.interest'), key: 'interest', align: 'right', render: (_, r) => money(r.interest, currency) },
    { title: t('payment.schedule.column.total'), key: 'total', align: 'right', render: (_, r) => money(r.total, currency) },
    {
      title: t('payment.schedule.column.paid'),
      key: 'paid',
      align: 'right',
      render: (_, r) => (
        <Tooltip title={t('payment.schedule.paidBreakdown', { interest: formatAmount(r.paidInterest, currency), principal: formatAmount(r.paidPrincipal, currency) })}>
          {money(r.paidTotal, currency)}
        </Tooltip>
      ),
    },
    {
      title: t('payment.schedule.column.outstanding'),
      key: 'outstanding',
      align: 'right',
      render: (_, r) => <Typography.Text strong={r.outstanding > 0}>{money(r.outstanding, currency)}</Typography.Text>,
    },
    {
      title: t('payment.schedule.column.status'),
      key: 'status',
      width: 190,
      render: (_, r) => (
        <Flex gap={6} align="center" wrap>
          <Tag color={INSTALLMENT_COLOR[r.status]} style={{ marginInlineEnd: 0 }}>{t(installmentStatusKey(r.status))}</Tag>
          {r.status === 'OVERDUE' ? <Typography.Text type="danger">{t('payment.schedule.daysOverdue', { days: r.daysOverdue })}</Typography.Text> : null}
        </Flex>
      ),
    },
    {
      title: t('payment.schedule.column.action'),
      key: 'action',
      width: 100,
      align: 'center',
      render: (_, r) =>
        r.outstanding > 0 && status.payable ? <Button size="small" onClick={() => onPayRow(r)}>{t('payment.schedule.pay')}</Button> : null,
    },
  ];

  return (
    <Table<InstallmentView>
      size="small"
      rowKey="id"
      columns={columns}
      dataSource={status.installments}
      pagination={false}
      scroll={{ x: 960 }}
      onRow={(r) => ({ style: r.status === 'OVERDUE' ? { background: token.colorErrorBg } : undefined })}
      summary={() => (
        <Table.Summary fixed>
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={4}><Typography.Text strong>{t('payment.schedule.summary')}</Typography.Text></Table.Summary.Cell>
            <Table.Summary.Cell index={1} align="right"><Typography.Text strong>{money(status.totals.scheduled, currency)}</Typography.Text></Table.Summary.Cell>
            <Table.Summary.Cell index={2} align="right"><Typography.Text strong>{money(status.totals.paid, currency)}</Typography.Text></Table.Summary.Cell>
            <Table.Summary.Cell index={3} align="right"><Typography.Text strong>{money(status.totals.outstanding, currency)}</Typography.Text></Table.Summary.Cell>
            <Table.Summary.Cell index={4} colSpan={2} />
          </Table.Summary.Row>
        </Table.Summary>
      )}
    />
  );
}

/**
 * Зээлийн ЭТХ-ийн төлөв: "Одоо төлөх" карт, нийт дүн, мөр бүрийн төлөв (UPCOMING/DUE/OVERDUE/PARTIAL/PAID) ба "Төлөх" modal.
 * Дүн, төлөв, FIFO хуваарилалт бүгд серверийн тооцоо — UI зөвхөн харуулна.
 */
export function RepaymentPanel({ applicationId }: Props) {
  const queryClient = useQueryClient();
  const query = useRepaymentStatus(applicationId);
  const [payOpen, setPayOpen] = useState(false);
  const [rowId, setRowId] = useState<string | null>(null);
  const status = query.data;

  const openPay = (id: string | null) => {
    setRowId(id);
    setPayOpen(true);
  };

  // Modal хаагдахад ЭТХ ба түүхийг шинэчилнэ: хэрэглэгч банкны апп-аар төлөөд modal-аа хаасан байж болно.
  const closePay = () => {
    setPayOpen(false);
    void queryClient.invalidateQueries({ queryKey: paymentsKey(applicationId) });
  };

  const gate = status ? payGate(status, t) : null;

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('payment.repayment.title')}</Typography.Title>
          <Typography.Text type="secondary">
            {status
              ? t('payment.repayment.subtitle', { asOf: status.asOf, generated: status.scheduleGeneratedAt ? formatDateTime(status.scheduleGeneratedAt) : t('payment.common.empty') })
              : t('payment.repayment.subtitleLoading')}
          </Typography.Text>
        </div>
        <Button onClick={() => void query.refetch()} loading={query.isFetching && !query.isLoading}>{t('payment.action.refresh')}</Button>
      </Flex>

      {query.isLoading ? <Skeleton active paragraph={{ rows: 8 }} /> : null}
      {query.isError && !status ? <PaymentErrorAlert error={query.error} title={t('payment.repayment.loadError')} onRetry={() => void query.refetch()} /> : null}
      {query.isError && status ? <Alert type="warning" showIcon message={t('payment.repayment.refreshError')} /> : null}

      {status ? (
        <>
          {gate ? <Alert type={gate.key === 'payment.gate.fullyPaid' ? 'success' : 'info'} showIcon message={t(gate.key, gate.params)} /> : null}
          <Flex gap={16} wrap>
            <PayNowCard status={status} gateText={gate ? t(gate.key, gate.params) : null} onPay={() => openPay(null)} />
            <TotalsCard status={status} />
          </Flex>
          {status.installments.length === 0 ? (
            <Empty description={t('payment.schedule.empty')} />
          ) : (
            <ScheduleTable status={status} onPayRow={(row) => openPay(row.id)} />
          )}
          <PayModal open={payOpen} applicationId={applicationId} status={status} initialRowId={rowId} onClose={closePay} />
        </>
      ) : null}
    </Flex>
  );
}
