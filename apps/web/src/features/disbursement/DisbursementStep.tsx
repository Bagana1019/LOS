'use client';
import { useState } from 'react';
import { Alert, Button, Card, Descriptions, Divider, Flex, Form, Input, List, Modal, Radio, Skeleton, Tag, Typography, App as AntApp } from 'antd';
import type { DisbursementView, UpdateDisbursementRequest } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { useAuth } from '../../lib/auth/auth-context';
import { formatDateTime, formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useApproveDisbursement, useDisbursement, useRejectDisbursement, useSubmitDisbursement, useUpdateDisbursement } from './disbursement.api';
import { ConfirmTerms, DisbursementTerms } from './DisbursementTerms';
import { collapseHistory, historyLabel, lastRejection } from './disbursement.utils';
import { describeDisbursementError, type DescribedDisbursementError } from './disbursement.errors';
import { accountNoProblem, amountProblem, holderNameProblem, parseAmount } from './disbursement.validation';

interface Props { applicationId: string; onChanged?: () => void }
/** `disburseAmount` нь хэрэглэгчийн бичсэн ТЕКСТ (F5-16): тоон input "5сая"/"-5"-г чимээгүй засдаг тул түүхий текстийг шалгана. */
type FormValues = { disburseAmount?: string; disburseDate?: string; bankCode?: string; accountNo?: string; holderName?: string; accountOwnerType?: 'SELF' | 'THIRD_PARTY' };

/** Серверт хадгалагдсан утга → формын утга. Хадгалсны дараа формыг үүгээр дахин тохируулна: дэлгэц дээр харагдаж буй утга ЯГ серверийнх байх ёстой (F5-3). */
const formValuesOf = (d: DisbursementView): FormValues => ({
  disburseAmount: String(d.disburseAmount || d.approvedAmount), disburseDate: d.disburseDate ?? new Date().toISOString().slice(0, 10), bankCode: d.bankCode ?? undefined,
  holderName: d.holderName ?? undefined, accountOwnerType: d.accountOwnerType ?? 'SELF',
});
/** Алдааны текст багтах өргөн: нарийн (200px) талбарт урт мессеж 5-6 мөрөнд хугарч уншигдахгүй. */
const ITEM_WIDTH = 260;
/** Шалгалтыг давсан текстээс тоо: хоосон/тоо биш бол талбарыг илгээхгүй (validator өмнө нь үүнийг хаасан). */
const amountField = (text?: string): Pick<UpdateDisbursementRequest, 'disburseAmount'> => {
  const n = text ? parseAmount(text) : null;
  return n ? { disburseAmount: n } : {};
};
/** antd Form.Item-ийн `validator`: `problem` (монгол мессеж | null) → reject/resolve. Мессеж нь талбарын доор гарна. */
const ruleOf = (problem: (v: string | undefined) => string | null) => (_: unknown, v: unknown): Promise<void> => {
  const msg = problem(typeof v === 'string' ? v : undefined);
  return msg ? Promise.reject(new Error(msg)) : Promise.resolve();
};

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
  const [saveError, setSaveError] = useState<DescribedDisbursementError | null>(null);
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const draft = d.status === 'DRAFT';
  const canEdit = draft && perms.has('disbursement:request');
  const pending = d.status === 'SUBMITTED' || d.status === 'FAILED';
  const initial = formValuesOf(d);
  const body = (v: FormValues): UpdateDisbursementRequest => ({
    ...amountField(v.disburseAmount), ...(v.disburseDate ? { disburseDate: v.disburseDate } : {}),
    ...(v.bankCode ? { bankCode: v.bankCode } : {}), ...(v.accountNo ? { accountNo: v.accountNo } : {}), ...(v.holderName ? { holderName: v.holderName } : {}), ...(v.accountOwnerType ? { accountOwnerType: v.accountOwnerType } : {}),
  });
  const done = (key: string) => () => void message.success(t(key));
  const error = submit.error ?? approve.error; // reject-ийн алдаа татгалзах modal дотор (F5-11), хадгалахын алдаа маягтын товчны доор (`saveError`, F5-4)
  const showSaveError = (e: DescribedDisbursementError) => { form.setFields(e.fields.map((f) => ({ name: f.name, errors: [f.message] }))); setSaveError(e); };
  const save = (v: FormValues) => {
    setSaveError(null);
    return update.mutateAsync(body(v))
      .then((res) => { form.setFieldsValue({ ...formValuesOf(res), accountNo: undefined }); done('disb.saved')(); })
      .catch((e: unknown) => showSaveError(describeDisbursementError(e)));
  };
  const rejection = lastRejection(d.status, d.history);
  const canApprove = perms.has('disbursement:approve');
  const reasonMissing = comment.trim().length === 0;
  const closeReject = () => { setRejecting(false); reject.reset(); };
  const sendReject = () => { if (!reasonMissing) void reject.mutateAsync(comment.trim()).then(() => { setRejecting(false); setComment(''); done('disb.rejectedOk')(); }).catch(() => undefined); };

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('disb.title')}</Typography.Title>
        <Tag data-testid="disb-status">{t(`disb.status.${d.status}`)}</Tag>
      </Flex>
      {rejection ? <Alert data-testid="disb-rejected-banner" type="error" showIcon message={t('disb.rejectedBanner')} description={rejection.note ?? undefined} /> : null}
      {d.status === 'SUBMITTED' && !canApprove ? <Alert data-testid="disb-waiting" type="info" showIcon message={t('disb.waiting')} /> : null}
      <Card size="small" data-testid="disb-summary">
        <Descriptions size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label={t('disb.approved')}>{formatMnt(d.approvedAmount)}</Descriptions.Item>
          <Descriptions.Item label={t('disb.term')}>{d.termMonths}</Descriptions.Item>
          <Descriptions.Item label={t('disb.rate')}>{d.interestRate}</Descriptions.Item>
          <Descriptions.Item label={t('disb.type')}>{d.repaymentType}</Descriptions.Item>
          {d.coreLoanId ? <Descriptions.Item label={t('disb.core')}>{d.coreLoanId}</Descriptions.Item> : null}
        </Descriptions>
        <Divider orientation="left" plain style={{ margin: '8px 0' }}>{t('disb.sum.title')}</Divider>
        <DisbursementTerms d={d} />
        {d.nameCheck && !d.nameCheck.matched ? <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t('disb.nameMismatch', { name: d.nameCheck.registeredName ?? '—' })} /> : null}
        {d.reconciliation && !d.reconciliation.ok ? <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t('disb.diff', { fields: d.reconciliation.diffs.map((x) => x.field).join(', ') })} /> : null}
      </Card>
      {canEdit ? (
        <Card size="small" title={t('disb.form')}>
          <Form<FormValues> form={form} layout="vertical" initialValues={initial} onFinish={save} onValuesChange={() => setSaveError(null)}>
            <Flex gap={16} wrap>
              <Form.Item name="disburseAmount" label={t('disb.field.amount')} style={{ width: ITEM_WIDTH }} rules={[{ validator: ruleOf((v) => amountProblem(v, d.approvedAmount)) }]}><Input inputMode="decimal" autoComplete="off" data-testid="disb-amount" /></Form.Item>
              <Form.Item name="disburseDate" label={t('disb.field.date')} rules={[{ required: true, message: t('disb.err.date') }]}><Input type="date" style={{ width: 160 }} data-testid="disb-date" /></Form.Item>
              <Form.Item name="bankCode" label={t('disb.field.bank')}><Input style={{ width: 140 }} maxLength={20} data-testid="disb-bank" /></Form.Item>
              <Form.Item name="accountNo" label={t('disb.field.accountNo')} style={{ width: ITEM_WIDTH }} rules={[{ validator: ruleOf(accountNoProblem) }]} extra={d.accountNoMasked ? t('disb.field.accountHint', { masked: d.accountNoMasked }) : undefined}><Input inputMode="numeric" autoComplete="off" data-testid="disb-account" /></Form.Item>
              <Form.Item name="holderName" label={t('disb.field.holder')} style={{ width: ITEM_WIDTH }} rules={[{ validator: ruleOf(holderNameProblem) }]}><Input maxLength={200} data-testid="disb-holder" /></Form.Item>
            </Flex>
            <Form.Item name="accountOwnerType" label={t('disb.field.owner')}><Radio.Group options={[{ value: 'SELF', label: t('disb.owner.SELF') }, { value: 'THIRD_PARTY', label: t('disb.owner.THIRD_PARTY') }]} /></Form.Item>
            <Button htmlType="submit" loading={update.isPending} data-testid="disb-save">{t('disb.save')}</Button>
            {saveError ? <Alert data-testid="disb-save-error" type="error" showIcon style={{ marginTop: 12 }} message={saveError.message} /> : null}
          </Form>
        </Card>
      ) : null}
      {d.checks.length ? (
        <Card size="small" title={t('disb.checks')}>
          <List size="small" dataSource={d.checks} renderItem={(c) => <List.Item><Tag color={c.ok ? 'success' : 'error'}>{c.ok ? '✓' : '✗'}</Tag> {c.message}</List.Item>} />
        </Card>
      ) : null}
      <Flex gap={8} wrap>
        {canEdit ? <Button type="primary" disabled={!d.canSubmit} loading={submit.isPending} data-testid="disb-submit" onClick={() => Modal.confirm({ title: t('disb.confirmSubmit'), content: <ConfirmTerms hint={t('disb.confirmSubmitHint')} d={d} />, okText: t('disb.submit'), cancelText: t('disb.cancel'), onOk: () => submit.mutateAsync().then(done('disb.submitted')).catch(() => undefined) })}>{t('disb.submit')}</Button> : null}
        {pending && canApprove ? (
          <>
            <Button type="primary" loading={approve.isPending} data-testid="disb-approve" onClick={() => Modal.confirm({ title: t('disb.confirmApprove'), content: <ConfirmTerms hint={t('disb.confirmApproveHint')} d={d} />, okText: t('disb.approve'), cancelText: t('disb.cancel'), onOk: () => approve.mutateAsync(undefined).then(done('disb.approvedOk')).catch(() => undefined) })}>{t('disb.approve')}</Button>
            <Button danger data-testid="disb-reject" onClick={() => setRejecting(true)}>{t('disb.reject')}</Button>
          </>
        ) : null}
      </Flex>
      {error ? <ApiErrorAlert error={error} /> : null}
      {d.history.length ? (
        <Card size="small" title={t('disb.history')} data-testid="disb-history">
          <List size="small" dataSource={collapseHistory(d.history)} renderItem={(h) => <List.Item data-testid="disb-history-row">{formatDateTime(h.at)} · {historyLabel(h.action)}{h.count > 1 ? ` ×${h.count}` : ''}{h.note ? ` — ${h.note}` : ''}</List.Item>} />
        </Card>
      ) : null}
      <Modal open={rejecting} title={t('disb.reject')} okText={t('disb.reject')} cancelText={t('disb.cancel')} okButtonProps={{ danger: true, loading: reject.isPending, disabled: reasonMissing }} onOk={sendReject} onCancel={closeReject}>
        <Flex vertical gap={8}>
          <Typography.Text type="secondary">{t('disb.rejectHint')}</Typography.Text>
          <Input.TextArea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('disb.rejectReason')} maxLength={1000} aria-required />
          {reject.error ? <ApiErrorAlert error={reject.error} /> : null}
        </Flex>
      </Modal>
    </Flex>
  );
}
