'use client';
import { App as AntApp, Alert, Button, Empty, Flex, Form, Input, InputNumber, Skeleton, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { InquiryBorrowerView, InquiryItemView, UnregisteredLoan } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatDateTime, formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { statusColor, summaryLines, warningColor } from './inquiry.utils';
import { useAddLoan, useFetchInquiries, useInquiries, useRecheckInquiries, useRemoveLoan } from './useInquiry';

interface Props {
  applicationId: string;
  /** Лавлагаа өөрчлөгдсөний дараа — wizard-н алхмуудын төлөвийг дахин татна. */
  onChanged?: () => void;
}

/**
 * Wizard-н 2-р алхам "Лавлагаа" (`/los/loan-application/:id/inquiry`): оролцогч бүрт 11 лавлагаа, хуучирсан бол шар тэмдэг, ЗМС-д бүртгэлгүй зээл.
 * FR-3.1–3.5; хар жагсаалт нь анхааруулга (BR-9).
 */
export function InquiryStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const q = useInquiries(applicationId);
  const fetchNow = useFetchInquiries(applicationId, onChanged);
  const recheck = useRecheckInquiries(applicationId, onChanged);
  const data = fetchNow.data ?? q.data;

  const run = (customerId?: string) =>
    fetchNow.mutate({ customerId }, { onSuccess: (res) => { if (!res.failures.length) void message.success(t('inquiry.toast.fetched')); } });

  if (q.isLoading) return <Skeleton active aria-label={t('inquiry.loading')} />;
  if (q.error && !data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  if (!data) return null;

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('inquiry.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('inquiry.subtitle')}</Typography.Text>
        </div>
        <Flex align="center" gap={8} wrap>
          <Tag color={data.step.status === 'COMPLETED' ? 'success' : 'warning'}>{data.step.status === 'COMPLETED' ? t('inquiry.step.complete') : t('inquiry.step.incomplete')}</Tag>
          <Button onClick={() => recheck.mutate()} loading={recheck.isPending}>{t('inquiry.action.recheck')}</Button>
          <Button type="primary" onClick={() => run()} loading={fetchNow.isPending} disabled={!data.borrowers.length}>{t('inquiry.action.fetchAll')}</Button>
        </Flex>
      </Flex>
      {data.step.reason && data.step.status !== 'COMPLETED' ? <Alert type="warning" showIcon message={t(`inquiry.step.reason.${data.step.reason}`)} description={t('inquiry.staleHint', { days: data.staleDays })} /> : null}
      {fetchNow.error ? <ApiErrorAlert error={fetchNow.error} /> : null}
      {data.failures.length ? (
        <Alert type="error" showIcon message={t('inquiry.fetch.failures')} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{data.failures.map((f) => <li key={`${f.customerId}-${f.source}-${f.code}`}>{f.source ? `${t(`inquiry.source.${f.source}`)}: ` : ''}{f.message}</li>)}</ul>} />
      ) : null}
      {!data.borrowers.length ? (
        <Empty description={t('inquiry.empty.noBorrower')} />
      ) : (
        <Tabs
          items={data.borrowers.map((b) => ({
            key: b.customerId,
            label: <span>{b.displayName} <Tag color={b.complete ? 'success' : b.hasStale ? 'warning' : 'default'}>{t(`inquiry.role.${b.role}`)}</Tag></span>,
            children: <BorrowerInquiries applicationId={applicationId} borrower={b} fetching={fetchNow.isPending} onFetch={() => run(b.customerId)} onChanged={onChanged} />,
          }))}
        />
      )}
    </Flex>
  );
}

function BorrowerInquiries({ applicationId, borrower, fetching, onFetch, onChanged }: { applicationId: string; borrower: InquiryBorrowerView; fetching: boolean; onFetch: () => void; onChanged?: () => void }) {
  const columns = [
    { title: t('inquiry.col.source'), dataIndex: 'source', render: (s: InquiryItemView['source']) => t(`inquiry.source.${s}`) },
    { title: t('inquiry.col.status'), dataIndex: 'status', render: (s: InquiryItemView['status'], r: InquiryItemView) => (
      <Tooltip title={r.expiresAt ? formatDateTime(r.expiresAt) : undefined}><Tag color={statusColor(s)}>{t(`inquiry.status.${s}`)}</Tag></Tooltip>
    ) },
    { title: t('inquiry.col.fetchedAt'), dataIndex: 'fetchedAt', render: (v: string | null) => formatDateTime(v) },
    { title: t('inquiry.col.warning'), dataIndex: 'warningLevel', render: (w: InquiryItemView['warningLevel'], r: InquiryItemView) => (r.status === 'MISSING' ? null : <Tag color={warningColor(w)}>{t(`inquiry.warning.${w}`)}</Tag>) },
    { title: t('inquiry.col.summary'), key: 'summary', render: (_: unknown, r: InquiryItemView) => summaryLines(r).join(' · ') },
  ];
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" gap={12} wrap>
        <Typography.Text type="secondary">{borrower.registerNoMasked} · {t('inquiry.monthlyDebt', { amount: formatMnt(borrower.monthlyDebtPayment) })}</Typography.Text>
        <Button onClick={onFetch} loading={fetching}>{borrower.missing.length === borrower.items.length ? t('inquiry.action.fetchOne') : t('inquiry.action.refetch')}</Button>
      </Flex>
      <Table size="small" rowKey="source" pagination={false} columns={columns} dataSource={borrower.items} scroll={{ x: 'max-content' }} />
      <UnregisteredLoans applicationId={applicationId} customerId={borrower.customerId} loans={borrower.unregisteredLoans} onChanged={onChanged} />
    </Flex>
  );
}

function UnregisteredLoans({ applicationId, customerId, loans, onChanged }: { applicationId: string; customerId: string; loans: UnregisteredLoan[]; onChanged?: () => void }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<{ lenderName: string; amount: number; monthlyPayment: number; note?: string }>();
  const add = useAddLoan(applicationId, onChanged);
  const remove = useRemoveLoan(applicationId, onChanged);
  const required = [{ required: true, message: t('inquiry.loans.required') }];
  return (
    <Flex vertical gap={8}>
      <Typography.Title level={5} style={{ margin: 0 }}>{t('inquiry.loans.title')}</Typography.Title>
      {loans.length ? (
        <Table size="small" rowKey="id" pagination={false} dataSource={loans} columns={[
          { title: t('inquiry.loans.lender'), dataIndex: 'lenderName' },
          { title: t('inquiry.loans.amount'), dataIndex: 'amount', render: formatMnt },
          { title: t('inquiry.loans.monthly'), dataIndex: 'monthlyPayment', render: formatMnt },
          { title: t('inquiry.loans.note'), dataIndex: 'note' },
          { key: 'x', render: (_: unknown, r: UnregisteredLoan) => <Button size="small" danger loading={remove.isPending} onClick={() => remove.mutate(r.id, { onSuccess: () => void message.success(t('inquiry.toast.loanRemoved')) })}>{t('inquiry.action.remove')}</Button> },
        ]} />
      ) : <Typography.Text type="secondary">{t('inquiry.loans.empty')}</Typography.Text>}
      <Form form={form} layout="inline" onFinish={(v) => add.mutate({ ...v, customerId }, { onSuccess: () => { form.resetFields(); void message.success(t('inquiry.toast.loanAdded')); } })}>
        <Form.Item name="lenderName" rules={required}><Input placeholder={t('inquiry.loans.lender')} /></Form.Item>
        <Form.Item name="amount" rules={required}><InputNumber min={0} placeholder={t('inquiry.loans.amount')} style={{ width: 160 }} /></Form.Item>
        <Form.Item name="monthlyPayment" rules={required}><InputNumber min={0} placeholder={t('inquiry.loans.monthly')} style={{ width: 160 }} /></Form.Item>
        <Form.Item name="note"><Input placeholder={t('inquiry.loans.note')} /></Form.Item>
        <Form.Item><Space><Button htmlType="submit" loading={add.isPending}>{t('inquiry.action.addLoan')}</Button></Space></Form.Item>
      </Form>
      {add.error ? <ApiErrorAlert error={add.error} /> : null}
    </Flex>
  );
}
