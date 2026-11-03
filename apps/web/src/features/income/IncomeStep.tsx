'use client';
import { useState } from 'react';
import { Alert, Button, Card, DatePicker, Empty, Flex, Form, Input, InputNumber, Select, Skeleton, Statistic, Table, Tag, Typography } from 'antd';
import type { IncomeBorrowerView } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useAddManual, useAddSalary, useCalculate, useFetchNdsh, useIncome, useRefreshIncome, useRemoveManual, useRemoveSalary, useSetExpenses } from './useIncome';

interface Props {
  applicationId: string;
  /** Орлого өөрчлөгдсөний дараа — wizard-н алхмуудын төлөвийг дахин татна. */
  onChanged?: () => void;
}

/** Wizard-н 3-р алхам "Орлого" (`/los/loan-application/:id/income`): цалин (НДШ/гар), сарын дундаж, гар орлого, зардал; бизнес = BSA placeholder. FR-4. */
export function IncomeStep({ applicationId, onChanged }: Props) {
  const q = useIncome(applicationId);
  const refresh = useRefreshIncome(applicationId, onChanged);
  if (q.isLoading) return <Skeleton active aria-label={t('income.loading')} />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const data = q.data;
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('income.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('income.subtitle')}</Typography.Text>
        </div>
        <Flex align="center" gap={8}>
          <Tag color={data.step.status === 'COMPLETED' ? 'success' : 'warning'}>{data.step.status === 'COMPLETED' ? t('income.step.complete') : t('income.step.incomplete')}</Tag>
          <Button onClick={() => refresh.mutate()} loading={refresh.isPending}>{t('income.action.refresh')}</Button>
        </Flex>
      </Flex>
      {data.blockers.length ? <Alert type="warning" showIcon message={data.blockers[0] ? t(`income.step.reason.${data.blockers[0].code}`) : undefined} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{data.blockers.map((b) => <li key={`${b.code}-${b.customerId}`}>{b.message}</li>)}</ul>} /> : null}
      {refresh.error ? <ApiErrorAlert error={refresh.error} /> : null}
      {!data.borrowers.length ? <Empty description={t('income.empty.noBorrower')} /> : data.borrowers.map((b) => <BorrowerIncome key={b.customerId} applicationId={applicationId} borrower={b} onChanged={onChanged} />)}
    </Flex>
  );
}

function BorrowerIncome({ applicationId, borrower: b, onChanged }: { applicationId: string; borrower: IncomeBorrowerView; onChanged?: () => void }) {
  const ndsh = useFetchNdsh(applicationId, onChanged);
  const removeSalary = useRemoveSalary(applicationId, onChanged);
  const addSalary = useAddSalary(applicationId, onChanged);
  const calc = useCalculate(applicationId, onChanged);
  const addManual = useAddManual(applicationId, onChanged);
  const removeManual = useRemoveManual(applicationId, onChanged);
  const expenses = useSetExpenses(applicationId, onChanged);
  const [period, setPeriod] = useState<[string, string] | null>(b.summary.periodFrom && b.summary.periodTo ? [b.summary.periodFrom, b.summary.periodTo] : null);
  const required = [{ required: true, message: t('income.form.required') }];
  const errors = [ndsh, removeSalary, addSalary, calc, addManual, removeManual, expenses].map((m) => m.error).find(Boolean);
  const s = b.summary;

  return (
    <Card
      title={<span>{b.displayName} <Tag>{t(`income.role.${b.role}`)}</Tag>{b.included ? null : <Tag>{t('income.notIncluded')}</Tag>}</span>}
      extra={<Tag color={b.hasIncome ? 'success' : 'default'}>{b.hasIncome ? t('income.hasIncome') : t('income.noIncome')}</Tag>}
    >
      <Flex vertical gap={16}>
        {errors ? <ApiErrorAlert error={errors} /> : null}

        <Typography.Title level={5} style={{ margin: 0 }}>{t('income.salary.title')}</Typography.Title>
        <Flex gap={8} wrap>
          <Button onClick={() => ndsh.mutate(b.customerId)} loading={ndsh.isPending}>{t('income.salary.fetchNdsh')}</Button>
        </Flex>
        <Table size="small" rowKey="id" pagination={{ pageSize: 12, hideOnSinglePage: true }} dataSource={b.salaries} locale={{ emptyText: t('income.salary.empty') }} columns={[
          { title: t('income.salary.period'), key: 'p', render: (_: unknown, r) => `${r.year}-${String(r.month).padStart(2, '0')}` },
          { title: t('income.salary.employer'), dataIndex: 'employer' },
          { title: t('income.salary.amount'), dataIndex: 'salary', render: formatMnt },
          { title: t('income.salary.contribution'), dataIndex: 'contributionPaid', render: (v: number | null) => (v === null ? '—' : formatMnt(v)) },
          { title: t('income.salary.source'), dataIndex: 'source', render: (v: 'NDSH' | 'MANUAL') => t(`income.salary.source.${v}`) },
          { key: 'x', render: (_: unknown, r) => (r.source === 'MANUAL' ? <Button size="small" danger onClick={() => removeSalary.mutate(r.id)}>{t('income.salary.remove')}</Button> : null) },
        ]} />
        <Form layout="inline" onFinish={(v: { month: string; employer?: string; salary: number }) => addSalary.mutate({ customerId: b.customerId, employer: v.employer, year: Number(v.month.slice(0, 4)), month: Number(v.month.slice(5, 7)), salary: v.salary })}>
          <Form.Item name="month" rules={required} getValueFromEvent={(d: { format: (f: string) => string } | null) => d?.format('YYYY-MM')} getValueProps={() => ({})}><DatePicker picker="month" placeholder={t('income.salary.period')} /></Form.Item>
          <Form.Item name="employer"><Input placeholder={t('income.salary.employer')} /></Form.Item>
          <Form.Item name="salary" rules={required}><InputNumber min={1} placeholder={t('income.salary.amount')} style={{ width: 160 }} /></Form.Item>
          <Form.Item><Button htmlType="submit" loading={addSalary.isPending}>{t('income.salary.add')}</Button></Form.Item>
        </Form>

        <Typography.Title level={5} style={{ margin: 0 }}>{t('income.calc.title')}</Typography.Title>
        <Flex gap={12} align="center" wrap>
          <DatePicker.RangePicker picker="month" placeholder={[t('income.calc.from'), t('income.calc.to')]} onChange={(v) => setPeriod(v?.[0] && v[1] ? [v[0].format('YYYY-MM'), v[1].format('YYYY-MM')] : null)} />
          <Button type="primary" disabled={!period} loading={calc.isPending} onClick={() => period && calc.mutate({ customerId: b.customerId, periodFrom: period[0], periodTo: period[1] })}>{t('income.calc.button')}</Button>
        </Flex>
        <Typography.Text type="secondary">{t('income.calc.hint')}</Typography.Text>
        {s.avgSalaryMonthly !== null ? (
          <Flex gap={32} wrap>
            <Statistic title={t('income.calc.total')} value={formatMnt(s.salaryTotal)} />
            <Statistic title={t('income.calc.months')} value={s.months ?? '—'} />
            <Statistic title={t('income.calc.average')} value={formatMnt(s.avgSalaryMonthly)} />
          </Flex>
        ) : <Typography.Text type="secondary">{t('income.calc.none')}</Typography.Text>}

        <Typography.Title level={5} style={{ margin: 0 }}>{t('income.manual.title')}</Typography.Title>
        <Table size="small" rowKey="id" pagination={false} dataSource={b.manual} locale={{ emptyText: t('income.manual.empty') }} columns={[
          { title: t('income.manual.type'), dataIndex: 'type', render: (v: 'RENT' | 'PENSION' | 'OTHER') => t(`income.manual.type.${v}`) },
          { title: t('income.manual.monthly'), dataIndex: 'monthlyAmount', render: formatMnt },
          { title: t('income.manual.note'), dataIndex: 'note' },
          { key: 'x', render: (_: unknown, r) => <Button size="small" danger onClick={() => removeManual.mutate(r.id)}>{t('income.salary.remove')}</Button> },
        ]} />
        <Form layout="inline" initialValues={{ type: 'RENT' }} onFinish={(v: { type: 'RENT' | 'PENSION' | 'OTHER'; monthlyAmount: number; note?: string }) => addManual.mutate({ customerId: b.customerId, ...v })}>
          <Form.Item name="type"><Select style={{ width: 140 }} options={(['RENT', 'PENSION', 'OTHER'] as const).map((v) => ({ value: v, label: t(`income.manual.type.${v}`) }))} /></Form.Item>
          <Form.Item name="monthlyAmount" rules={required}><InputNumber min={1} placeholder={t('income.manual.monthly')} style={{ width: 160 }} /></Form.Item>
          <Form.Item name="note"><Input placeholder={t('income.manual.note')} /></Form.Item>
          <Form.Item><Button htmlType="submit" loading={addManual.isPending}>{t('income.manual.add')}</Button></Form.Item>
        </Form>
        {b.manualMonthlyTotal > 0 ? <Typography.Text type="secondary">{t('income.manual.total', { amount: formatMnt(b.manualMonthlyTotal) })}</Typography.Text> : null}

        <Typography.Title level={5} style={{ margin: 0 }}>{t('income.expense.title')}</Typography.Title>
        <Form layout="inline" key={`${s.householdExpenseMonthly}-${s.businessExpenseMonthly}`} initialValues={{ household: s.householdExpenseMonthly ?? undefined, business: s.businessExpenseMonthly ?? undefined }}
          onFinish={(v: { household?: number; business?: number }) => expenses.mutate({ customerId: b.customerId, body: { householdExpenseMonthly: v.household ?? undefined, businessExpenseMonthly: v.business ?? undefined } })}>
          <Form.Item name="household"><InputNumber min={0} placeholder={t('income.expense.household')} style={{ width: 200 }} /></Form.Item>
          <Form.Item name="business"><InputNumber min={0} placeholder={t('income.expense.business')} style={{ width: 200 }} /></Form.Item>
          <Form.Item><Button htmlType="submit" loading={expenses.isPending}>{t('income.expense.save')}</Button></Form.Item>
        </Form>

        <Alert type="info" showIcon message={t('income.business.title')} description={b.business.message} />
      </Flex>
    </Card>
  );
}
