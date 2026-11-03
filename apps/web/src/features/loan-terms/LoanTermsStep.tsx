'use client';
import { Alert, Button, Card, Flex, Form, Input, InputNumber, Select, Skeleton, Tag, Typography, App as AntApp } from 'antd';
import type { SaveLoanTermsRequest } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useCibPurposes, useLoanTerms, useProducts, useSaveTerms } from './loanTerms.api';

interface Props { applicationId: string; onChanged?: () => void }
type FormValues = { productId: string; amount: number; termMonths: number; interestRate?: number; feeRate?: number; downPayment?: number; charges?: number; insurance?: number; purpose: string; purposeDetail?: string; cibPurposeCode?: string; cibSubCode?: string; officerNote?: string };

const clean = (v: FormValues): SaveLoanTermsRequest => {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (val !== undefined && val !== null && val !== '') out[k] = val;
  return out as SaveLoanTermsRequest;
};

/** Wizard-н 4-р алхам "Зээлийн мэдээлэл" (`/los/loan-application/:id/loan`): бүтээгдэхүүн, дүн, хугацаа, хүү, зориулалт. FR-5.1…5.4. */
export function LoanTermsStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const q = useLoanTerms(applicationId);
  const products = useProducts();
  const cib = useCibPurposes();
  const save = useSaveTerms(applicationId, onChanged);
  const [form] = Form.useForm<FormValues>();
  const purposeCode = Form.useWatch('cibPurposeCode', form);
  const productId = Form.useWatch('productId', form);
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const readOnly = !d.editable;
  const selected = products.data?.items.find((p) => p.id === (productId ?? d.productId));
  const limits = selected?.limits ?? d.limits ?? null;
  const subs = cib.data?.items.find((x) => x.code === purposeCode)?.subs ?? [];
  const initial: Partial<FormValues> = { productId: d.productId ?? undefined, amount: d.amount ?? undefined, termMonths: d.termMonths ?? undefined, interestRate: d.interestRate ?? undefined, feeRate: d.feeRate ?? undefined, downPayment: d.downPayment ?? undefined, charges: d.charges ?? undefined, insurance: d.insurance ?? undefined, purpose: d.purpose ?? undefined, purposeDetail: d.purposeDetail ?? undefined, cibPurposeCode: d.cibPurposeCode ?? undefined, cibSubCode: d.cibSubCode ?? undefined, officerNote: d.officerNote ?? undefined };
  const required = [{ required: true, message: t('terms.form.required') }];

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="flex-start" wrap gap={8}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('terms.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('terms.subtitle')}</Typography.Text>
        </div>
        {d.step ? <Tag color={d.step.status === 'COMPLETED' ? 'success' : 'warning'}>{t(`application.stepStatus.${d.step.status}`)}</Tag> : null}
      </Flex>
      {readOnly ? <Alert type="info" showIcon message={t('terms.readOnly')} /> : null}
      {d.installmentStep?.status === 'STALE' ? <Alert type="warning" showIcon message={t('terms.scheduleStale')} /> : null}
      {limits ? <Alert type="info" showIcon message={t('terms.limits', { min: formatMnt(limits.minAmount), max: formatMnt(limits.maxAmount), minTerm: limits.minTermMonths, maxTerm: limits.maxTermMonths, minRate: limits.minRate, maxRate: limits.maxRate })} /> : null}
      <Card>
        <Form<FormValues>
          key={`${d.productId}-${d.amount}-${d.termMonths}-${d.interestRate}`}
          form={form} layout="vertical" disabled={readOnly} initialValues={initial}
          onFinish={(v) => save.mutateAsync(clean(v)).then(() => void message.success(t('terms.saved'))).catch(() => undefined)}
        >
          <Form.Item name="productId" label={t('terms.field.product')} rules={required}>
            <Select data-testid="terms-product" loading={products.isLoading} options={(products.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))} />
          </Form.Item>
          <Flex gap={16} wrap>
            <Form.Item name="amount" label={t('terms.field.amount')} rules={required}><InputNumber data-testid="terms-amount" min={0} style={{ width: 200 }} /></Form.Item>
            <Form.Item name="termMonths" label={t('terms.field.term')} rules={required}><InputNumber data-testid="terms-term" min={1} max={600} precision={0} style={{ width: 140 }} /></Form.Item>
            <Form.Item name="interestRate" label={t('terms.field.rate')} extra={t('terms.field.rateHint')}><InputNumber min={0} max={100} step={0.01} style={{ width: 140 }} /></Form.Item>
            <Form.Item name="feeRate" label={t('terms.field.fee')} extra={t('terms.field.feeHint')}><InputNumber min={0} max={1} step={0.001} style={{ width: 140 }} /></Form.Item>
          </Flex>
          <Flex gap={16} wrap>
            <Form.Item name="downPayment" label={t('terms.field.downPayment')}><InputNumber min={0} style={{ width: 180 }} /></Form.Item>
            <Form.Item name="charges" label={t('terms.field.charges')}><InputNumber min={0} style={{ width: 180 }} /></Form.Item>
            <Form.Item name="insurance" label={t('terms.field.insurance')}><InputNumber min={0} style={{ width: 180 }} /></Form.Item>
          </Flex>
          <Form.Item name="purpose" label={t('terms.field.purpose')} rules={required}><Input data-testid="terms-purpose" maxLength={200} /></Form.Item>
          <Form.Item name="purposeDetail" label={t('terms.field.purposeDetail')}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          <Flex gap={16} wrap>
            <Form.Item name="cibPurposeCode" label={t('terms.field.cib')} style={{ minWidth: 260 }}>
              <Select allowClear onChange={() => form.setFieldValue('cibSubCode', undefined)} options={(cib.data?.items ?? []).map((p) => ({ value: p.code, label: p.name }))} />
            </Form.Item>
            <Form.Item name="cibSubCode" label={t('terms.field.cibSub')} style={{ minWidth: 260 }}>
              <Select allowClear disabled={!purposeCode} options={subs.map((s) => ({ value: s.code, label: s.name }))} />
            </Form.Item>
          </Flex>
          <Form.Item name="officerNote" label={t('terms.field.note')}><Input.TextArea rows={3} maxLength={2000} /></Form.Item>
          {d.feeAmount != null ? <Typography.Paragraph>{t('terms.feeAmount', { amount: formatMnt(d.feeAmount) })}</Typography.Paragraph> : null}
          {save.error ? <ApiErrorAlert error={save.error} /> : null}
          {readOnly ? null : <Button type="primary" htmlType="submit" loading={save.isPending} data-testid="terms-save">{t('terms.save')}</Button>}
        </Form>
      </Card>
    </Flex>
  );
}
