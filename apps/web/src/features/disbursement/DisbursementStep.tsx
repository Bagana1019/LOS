'use client';
import { useState } from 'react';
import { Alert, Button, Card, Descriptions, Flex, Form, Input, InputNumber, List, Modal, Radio, Skeleton, Tag, Typography, App as AntApp } from 'antd';
import type { UpdateDisbursementRequest } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { useAuth } from '../../lib/auth/auth-context';
import { formatDateTime, formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useApproveDisbursement, useDisbursement, useRejectDisbursement, useSubmitDisbursement, useUpdateDisbursement } from './disbursement.api';

interface Props { applicationId: string; onChanged?: () => void }
type FormValues = { disburseAmount?: number; disburseDate?: string; bankCode?: string; accountNo?: string; holderName?: string; accountOwnerType?: 'SELF' | 'THIRD_PARTY' };

/** Wizard-н "Зээл олгох хүсэлт" алхам (`/los/loan-application/:id/disburse`): данс, дүн, огноо → илгээх (G4) → Core-д олгох (G5, өөр хэрэглэгч). FR-12. */
export function DisbursementStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const { me } = useAuth();
  const perms = new Set<string>(me?.permissions ?? []);
  const q = useDisbursement(applicationId);
  const update = useUpdateDisbursement(applicationId, onChanged);
  const submit = useSubmitDisbursement(applicationId, onChanged);
  const approve = useApproveDisbursement(applicationId, onChanged);
  const reject = useRejectDisbursement(applicationId, onChanged);
  const [form] = Form.useForm<FormValues>();
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const draft = d.status === 'DRAFT';
  const canEdit = draft && perms.has('disbursement:request');
  const pending = d.status === 'SUBMITTED' || d.status === 'FAILED';
  const initial: FormValues = { disburseAmount: d.disburseAmount || d.approvedAmount, disburseDate: d.disburseDate ?? new Date().toISOString().slice(0, 10), bankCode: d.bankCode ?? undefined, holderName: d.holderName ?? undefined, accountOwnerType: d.accountOwnerType ?? 'SELF' };
  const body = (v: FormValues): UpdateDisbursementRequest => ({
    ...(v.disburseAmount ? { disburseAmount: v.disburseAmount } : {}), ...(v.disburseDate ? { disburseDate: v.disburseDate } : {}),
    ...(v.bankCode ? { bankCode: v.bankCode } : {}), ...(v.accountNo ? { accountNo: v.accountNo } : {}), ...(v.holderName ? { holderName: v.holderName } : {}), ...(v.accountOwnerType ? { accountOwnerType: v.accountOwnerType } : {}),
  });
  const done = (key: string) => () => void message.success(t(key));
  const error = update.error ?? submit.error ?? approve.error ?? reject.error;

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('disb.title')}</Typography.Title>
        <Tag data-testid="disb-status">{t(`disb.status.${d.status}`)}</Tag>
      </Flex>
      <Card size="small">
        <Descriptions size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label={t('disb.approved')}>{formatMnt(d.approvedAmount)}</Descriptions.Item>
          <Descriptions.Item label={t('disb.term')}>{d.termMonths}</Descriptions.Item>
          <Descriptions.Item label={t('disb.rate')}>{d.interestRate}</Descriptions.Item>
          <Descriptions.Item label={t('disb.type')}>{d.repaymentType}</Descriptions.Item>
          <Descriptions.Item label={t('disb.account')}>{d.accountNoMasked ?? '—'} {d.holderName ?? ''}</Descriptions.Item>
          {d.coreLoanId ? <Descriptions.Item label={t('disb.core')}>{d.coreLoanId}</Descriptions.Item> : null}
        </Descriptions>
        {d.nameCheck && !d.nameCheck.matched ? <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t('disb.nameMismatch', { name: d.nameCheck.registeredName ?? '—' })} /> : null}
        {d.reconciliation && !d.reconciliation.ok ? <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t('disb.diff', { fields: d.reconciliation.diffs.map((x) => x.field).join(', ') })} /> : null}
      </Card>
      {canEdit ? (
        <Card size="small" title={t('disb.form')}>
          <Form<FormValues> form={form} layout="vertical" initialValues={initial} onFinish={(v) => update.mutateAsync(body(v)).then(done('disb.saved')).catch(() => undefined)}>
            <Flex gap={16} wrap>
              <Form.Item name="disburseAmount" label={t('disb.field.amount')}><InputNumber min={0} style={{ width: 200 }} data-testid="disb-amount" /></Form.Item>
              <Form.Item name="disburseDate" label={t('disb.field.date')}><Input type="date" style={{ width: 160 }} data-testid="disb-date" /></Form.Item>
              <Form.Item name="bankCode" label={t('disb.field.bank')}><Input style={{ width: 140 }} maxLength={20} data-testid="disb-bank" /></Form.Item>
              <Form.Item name="accountNo" label={t('disb.field.accountNo')} extra={d.accountNoMasked ? t('disb.field.accountHint', { masked: d.accountNoMasked }) : undefined}><Input style={{ width: 220 }} maxLength={34} data-testid="disb-account" /></Form.Item>
              <Form.Item name="holderName" label={t('disb.field.holder')}><Input style={{ width: 220 }} maxLength={200} data-testid="disb-holder" /></Form.Item>
            </Flex>
            <Form.Item name="accountOwnerType" label={t('disb.field.owner')}><Radio.Group options={[{ value: 'SELF', label: t('disb.owner.SELF') }, { value: 'THIRD_PARTY', label: t('disb.owner.THIRD_PARTY') }]} /></Form.Item>
            <Button htmlType="submit" loading={update.isPending} data-testid="disb-save">{t('disb.save')}</Button>
          </Form>
        </Card>
      ) : null}
      {d.checks.length ? (
        <Card size="small" title={t('disb.checks')}>
          <List size="small" dataSource={d.checks} renderItem={(c) => <List.Item><Tag color={c.ok ? 'success' : 'error'}>{c.ok ? '✓' : '✗'}</Tag> {c.message}</List.Item>} />
        </Card>
      ) : null}
      <Flex gap={8} wrap>
        {canEdit ? <Button type="primary" disabled={!d.canSubmit} loading={submit.isPending} data-testid="disb-submit" onClick={() => Modal.confirm({ title: t('disb.confirmSubmit'), okText: t('disb.submit'), cancelText: t('disb.cancel'), onOk: () => submit.mutateAsync().then(done('disb.submitted')).catch(() => undefined) })}>{t('disb.submit')}</Button> : null}
        {pending && perms.has('disbursement:approve') ? (
          <>
            <Button type="primary" loading={approve.isPending} data-testid="disb-approve" onClick={() => Modal.confirm({ title: t('disb.confirmApprove'), okText: t('disb.approve'), cancelText: t('disb.cancel'), onOk: () => approve.mutateAsync(undefined).then(done('disb.approvedOk')).catch(() => undefined) })}>{t('disb.approve')}</Button>
            <Button danger data-testid="disb-reject" onClick={() => setRejecting(true)}>{t('disb.reject')}</Button>
          </>
        ) : null}
      </Flex>
      {error ? <ApiErrorAlert error={error} /> : null}
      {d.history.length ? (
        <Card size="small" title={t('disb.history')}>
          <List size="small" dataSource={d.history} renderItem={(h) => <List.Item>{formatDateTime(h.at)} · {h.action}{h.note ? ` — ${h.note}` : ''}</List.Item>} />
        </Card>
      ) : null}
      <Modal open={rejecting} title={t('disb.reject')} okText={t('disb.reject')} cancelText={t('disb.cancel')} okButtonProps={{ danger: true, loading: reject.isPending }} onOk={() => void reject.mutateAsync(comment.trim() || undefined).then(() => { setRejecting(false); setComment(''); done('disb.rejectedOk')(); }).catch(() => undefined)} onCancel={() => setRejecting(false)}>
        <Input.TextArea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('disb.rejectComment')} maxLength={1000} />
      </Modal>
    </Flex>
  );
}
