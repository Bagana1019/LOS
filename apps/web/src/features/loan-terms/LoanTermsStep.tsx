'use client';
import { Alert, Button, Card, Flex, Form, Input, InputNumber, Select, Skeleton, Tag, Typography, App as AntApp } from 'antd';
import { useState } from 'react';
import { MONEY_MAX, MONEY_MAX_INTEGER_DIGITS, type PricingQuoteResponse } from '@los/contracts';
import type { Rule } from 'antd/es/form';
import { MoneyInput, PercentInput, moneyRules, percentRules } from '../../components/form';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatMnt, rateToPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useCibPurposes, useLoanTerms, useProducts, useRateQuote, useSaveTerms } from './loanTerms.api';
import { toFormValues, toSaveRequest, type TermsFormValues } from './loanTerms.form';
import { RateSuggestion } from './RateSuggestion';

interface Props { applicationId: string; onChanged?: () => void }
type FormValues = TermsFormValues;

// Оронгийн хязгаарлалт (DEMO, Q-101): мөнгө — бүхэл ≤ MONEY_MAX_INTEGER_DIGITS орон, бутархай ≤ 2 (`moneyRules`), бүтээгдэхүүний [min,max].
// Тоо биш/сөрөг/0/бутархайг `moneyRules` (shared MoneyInput) шалгана; энд зөвхөн энэ алхмын нэмэлт хязгаар. Form.Item-д `validateFirst` өгнө.
const digitCount = (n: number) => Math.floor(Math.abs(n)).toString().length;
const limitRules = (label: string, opts: { min?: number; max?: number } = {}): Rule[] => [{
  validator: (_r, v: number | null | undefined) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return Promise.resolve(); // хоосон/тоо биш нь moneyRules-д
    if (digitCount(v) > MONEY_MAX_INTEGER_DIGITS || v > MONEY_MAX) return Promise.reject(new Error(t('terms.form.maxDigits', { field: label, max: MONEY_MAX_INTEGER_DIGITS })));
    if (opts.min != null && opts.max != null && (v < opts.min || v > opts.max)) return Promise.reject(new Error(t('terms.form.range', { field: label, min: formatMnt(opts.min), max: formatMnt(opts.max) })));
    return Promise.resolve();
  },
}];
const amountRules = (label: string, o: { required?: boolean; positive?: boolean; min?: number; max?: number } = {}): Rule[] => [
  ...moneyRules({ label, positive: o.positive, ...(o.required ? { required: t('terms.form.required') } : {}) }),
  ...limitRules(label, o),
];
const intRange = (label: string, min: number, max: number): Rule[] => [{ type: 'number', min, max, message: t('terms.form.range', { field: label, min, max }) }];

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
  const rateQuote = useRateQuote();
  const [suggestion, setSuggestion] = useState<PricingQuoteResponse | null>(null);
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const readOnly = !d.editable;
  const selected = products.data?.items.find((p) => p.id === (productId ?? d.productId));
  const limits = selected?.limits ?? d.limits ?? null;
  const subs = cib.data?.items.find((x) => x.code === purposeCode)?.subs ?? [];
  const initial = toFormValues(d);
  const required = [{ required: true, message: t('terms.form.required') }];
  const effectiveProductId = productId ?? d.productId;
  // M11 · FR-5.5: серверийн санал (Sosco Score → шатлал → BR-6 хязгаар) хүү/шимтгэлийн талбарыг бөглөнө; ЗЭЗ хязгаарт багтаан өөрчилж болно.
  const suggestRate = () => {
    if (!effectiveProductId) { void message.warning(t('terms.suggest.needProduct')); return; }
    const amount = form.getFieldValue('amount') as unknown;
    rateQuote.mutateAsync({ productId: effectiveProductId, soscoScore: d.soscoScore ?? null, ...(typeof amount === 'number' && amount > 0 ? { amount } : {}) })
      .then((res) => {
        form.setFieldsValue({ interestRate: res.interestRate, feeRatePercent: rateToPercent(res.feeRate) }); // шимтгэл API-д бутархай, талбарт хувиар
        setSuggestion(res);
        void message.success(t('terms.suggest.applied'));
      })
      .catch(() => undefined);
  };

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
          onFinish={(v) => save.mutateAsync(toSaveRequest(v)).then(() => void message.success(t('terms.saved'))).catch(() => undefined)}
        >
          <Form.Item name="productId" label={t('terms.field.product')} rules={required}>
            <Select data-testid="terms-product" loading={products.isLoading} options={(products.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))} />
          </Form.Item>
          <Flex gap={16} wrap>
            <Form.Item name="amount" label={t('terms.field.amount')} validateFirst rules={amountRules(t('terms.field.amount'), { required: true, positive: true, min: limits?.minAmount, max: limits?.maxAmount })}><MoneyInput data-testid="terms-amount" style={{ width: 200 }} /></Form.Item>
            <Form.Item name="termMonths" label={t('terms.field.term')} rules={[...required, ...intRange(t('terms.field.term'), limits?.minTermMonths ?? 1, limits?.maxTermMonths ?? 600)]}><InputNumber data-testid="terms-term" min={1} max={600} precision={0} maxLength={3} inputMode="numeric" style={{ width: 140 }} /></Form.Item>
            <Form.Item name="interestRate" label={t('terms.field.rate')} extra={t('terms.field.rateHint')} validateFirst rules={[...percentRules({ label: t('terms.field.rate'), maxDecimals: 4 }), ...(limits ? [{ type: 'number' as const, min: limits.minRate, max: limits.maxRate, message: t('terms.form.range', { field: t('terms.field.rate'), min: limits.minRate, max: limits.maxRate }) }] : [])]}><PercentInput data-testid="terms-rate" style={{ width: 140 }} /></Form.Item>
            <Form.Item name="feeRatePercent" label={t('terms.field.fee')} extra={t('terms.field.feeHintPercent')} validateFirst rules={percentRules({ label: t('terms.field.fee'), maxDecimals: 2 })}><PercentInput data-testid="terms-fee" style={{ width: 140 }} /></Form.Item>
          </Flex>
          {readOnly ? null : (
            <Flex vertical gap={8} style={{ marginBottom: 16 }}>
              <Button onClick={suggestRate} loading={rateQuote.isPending} disabled={!effectiveProductId} data-testid="terms-suggest-rate" style={{ alignSelf: 'flex-start' }}>{t('pricing.suggest')}</Button>
              {suggestion ? <RateSuggestion quote={suggestion} /> : null}
              {rateQuote.error ? <ApiErrorAlert error={rateQuote.error} /> : null}
            </Flex>
          )}
          <Flex gap={16} wrap>
            <Form.Item name="downPayment" label={t('terms.field.downPayment')} validateFirst rules={amountRules(t('terms.field.downPayment'))}><MoneyInput style={{ width: 180 }} /></Form.Item>
            <Form.Item name="charges" label={t('terms.field.charges')} validateFirst rules={amountRules(t('terms.field.charges'))}><MoneyInput style={{ width: 180 }} /></Form.Item>
            <Form.Item name="insurance" label={t('terms.field.insurance')} validateFirst rules={amountRules(t('terms.field.insurance'))}><MoneyInput style={{ width: 180 }} /></Form.Item>
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
