'use client';
import { useState } from 'react';
import { Alert, Button, Card, Flex, Form, Input, InputNumber, Select, Skeleton, Statistic, Table, Tag, Typography, App as AntApp } from 'antd';
import { ScheduleTypeEnum, type ScheduleParamsRequest, type ScheduleRowView, type ScheduleView } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { exportSchedule, useGenerateSchedule, usePreviewSchedule, useSchedule } from './schedule.api';

interface Props { applicationId: string; onChanged?: () => void }
type FormValues = { startDate: string; firstPaymentDate: string; type: ScheduleParamsRequest['type']; graceMonths: number };
const today = () => new Date().toISOString().slice(0, 10);
const nextMonth = () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString().slice(0, 10); };

/** Wizard-н 6-р алхам "Эргэн төлөлтийн хуваарь" (`/los/loan-application/:id/installment`): параметр, урьдчилан харах, хадгалах, Excel. FR-7. */
export function ScheduleStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const q = useSchedule(applicationId);
  const preview = usePreviewSchedule(applicationId);
  const generate = useGenerateSchedule(applicationId, onChanged);
  const [form] = Form.useForm<FormValues>();
  const [shown, setShown] = useState<ScheduleView | null>(null);
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const { editable, schedule } = q.data;
  const view = shown ?? schedule;
  const p = schedule?.params;
  const initial: FormValues = { startDate: p?.startDate ?? today(), firstPaymentDate: p?.firstPaymentDate ?? nextMonth(), type: p?.type ?? 'ANNUITY', graceMonths: p?.graceMonths ?? 0 };
  const params = (v: FormValues): ScheduleParamsRequest => ({ startDate: v.startDate, firstPaymentDate: v.firstPaymentDate, type: v.type, graceMonths: v.graceMonths ?? 0 });
  const columns = [
    { title: '№', dataIndex: 'seq', width: 56 },
    { title: t('sched.col.date'), dataIndex: 'dueDate' },
    { title: t('sched.col.days'), dataIndex: 'days', width: 70 },
    { title: t('sched.col.principal'), dataIndex: 'principal', align: 'right' as const, render: formatMnt },
    { title: t('sched.col.interest'), dataIndex: 'interest', align: 'right' as const, render: formatMnt },
    { title: t('sched.col.total'), dataIndex: 'total', align: 'right' as const, render: formatMnt },
    { title: t('sched.col.balance'), dataIndex: 'balance', align: 'right' as const, render: formatMnt },
  ];
  return (
    <Flex vertical gap={16}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('sched.title')}</Typography.Title>
        <Typography.Text type="secondary">{t('sched.subtitle')}</Typography.Text>
      </div>
      {schedule?.isStale ? <Alert type="warning" showIcon message={t('sched.stale')} /> : null}
      {!editable ? <Alert type="info" showIcon message={t('sched.readOnly')} /> : null}
      <Card>
        <Form<FormValues> form={form} layout="inline" disabled={!editable} initialValues={initial} onValuesChange={() => setShown(null)} onFinish={(v) => generate.mutateAsync(params(v)).then(() => { setShown(null); void message.success(t('sched.saved')); }).catch(() => undefined)} style={{ rowGap: 12 }}>
          <Form.Item name="startDate" label={t('sched.field.start')} rules={[{ required: true }]}><Input type="date" style={{ width: 160 }} data-testid="sched-start" /></Form.Item>
          <Form.Item name="firstPaymentDate" label={t('sched.field.first')} rules={[{ required: true }]}><Input type="date" style={{ width: 160 }} data-testid="sched-first" /></Form.Item>
          <Form.Item name="type" label={t('sched.field.type')}><Select style={{ width: 200 }} options={ScheduleTypeEnum.options.map((v) => ({ value: v, label: t(`sched.type.${v}`) }))} /></Form.Item>
          <Form.Item name="graceMonths" label={t('sched.field.grace')}><InputNumber min={0} max={599} precision={0} /></Form.Item>
          <Button onClick={() => void form.validateFields().then((v) => preview.mutateAsync(params(v)).then(setShown)).catch(() => undefined)} loading={preview.isPending} data-testid="sched-preview">{t('sched.preview')}</Button>
          {editable ? <Button type="primary" htmlType="submit" loading={generate.isPending} data-testid="sched-save" style={{ marginLeft: 8 }}>{t('sched.save')}</Button> : null}
        </Form>
        {preview.error || generate.error ? <div style={{ marginTop: 12 }}><ApiErrorAlert error={preview.error ?? generate.error} /></div> : null}
      </Card>
      {view ? (
        <>
          <Flex gap={32} wrap>
            <Statistic title={t('sched.sum.count')} value={view.summary.installments} />
            <Statistic title={t('sched.sum.principal')} value={formatMnt(view.summary.totalPrincipal)} />
            <Statistic title={t('sched.sum.interest')} value={formatMnt(view.summary.totalInterest)} />
            <Statistic title={t('sched.sum.total')} value={formatMnt(view.summary.totalPayment)} />
            {shown ? <Tag color="processing">{t('sched.previewTag')}</Tag> : schedule ? <Tag color="success">{t('sched.savedTag')}</Tag> : null}
          </Flex>
          <Table<ScheduleRowView> size="small" rowKey="seq" columns={columns} dataSource={view.rows} pagination={{ pageSize: 12, hideOnSinglePage: true }} data-testid="sched-table" />
          {schedule && !shown ? <div><Button onClick={() => void exportSchedule(applicationId).catch(() => void message.error(t('sched.exportFailed')))}>{t('sched.export')}</Button></div> : null}
        </>
      ) : <Alert type="info" showIcon message={t('sched.empty')} />}
    </Flex>
  );
}
