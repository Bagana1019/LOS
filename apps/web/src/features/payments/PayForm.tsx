'use client';
import { Alert, Button, Flex, Input, InputNumber, Radio, Select, Skeleton, Tag, Typography } from 'antd';
import type { RepaymentStatusView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { PaymentErrorAlert } from './PaymentErrorAlert';
import {
  amountModeKey, buildInvoiceRequest, formatAmount, groupDigits, maxPayable, modeOptions, parseDigits, payableRows, previewAmount, providerHintKey, providerKey,
  reasonKey, validateCustomAmount, validatePayForm, type AmountMode, type PayFormValues, type ProviderOption,
} from './payment.utils';
import { useCreateInvoice } from './usePayments';

interface ProvidersState {
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

interface Props {
  applicationId: string;
  status: RepaymentStatusView;
  /** `provider` нь аль хэдийн идэвхтэй сонголт болсон (эхний идэвхтэй хэлбэр). */
  values: PayFormValues;
  options: readonly ProviderOption[];
  providers: ProvidersState;
  onChange: (patch: Partial<PayFormValues>) => void;
  onCreated: (invoiceId: string) => void;
  onCancel: () => void;
}

/** Төлбөрийн хэлбэр: идэвхтэйг сонгоно, идэвхгүйг шалтгаантай нь харуулна (NOT_CONFIGURED / NOT_IMPLEMENTED / ACCOUNT_MISSING / CURRENCY). */
function ProviderPicker({ options, value, onChange }: { options: readonly ProviderOption[]; value: PayFormValues['provider']; onChange: (p: ProviderOption['provider']) => void }) {
  return (
    <Radio.Group value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }}>
      <Flex vertical gap={10}>
        {options.map((o) => (
          <div key={o.provider}>
            <Radio value={o.provider} disabled={!o.enabled}>
              <Flex gap={8} align="center" wrap>
                <Typography.Text strong={o.enabled} type={o.enabled ? undefined : 'secondary'}>{t(providerKey(o.provider))}</Typography.Text>
                {o.enabled && o.mode === 'mock' ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('payment.mode.mock')}</Tag> : null}
                {!o.enabled && o.reason ? <Tag style={{ marginInlineEnd: 0 }}>{t(reasonKey(o.reason))}</Tag> : null}
              </Flex>
            </Radio>
            <div style={{ marginInlineStart: 24 }}>
              <Typography.Text type="secondary">{t(providerHintKey(o.provider))}</Typography.Text>
            </div>
          </div>
        ))}
      </Flex>
    </Radio.Group>
  );
}

function AmountPicker({ status, values, onChange }: { status: RepaymentStatusView; values: PayFormValues; onChange: (patch: Partial<PayFormValues>) => void }) {
  const { currency } = status;
  const modes = modeOptions(status);
  const rows = payableRows(status.installments);
  const max = maxPayable(status, 'CUSTOM', null);
  const customError = values.amount !== null ? validateCustomAmount(values.amount, max, currency) : null;

  const label = (mode: AmountMode): string =>
    mode === 'NOW' ? t('payment.pay.mode.NOW', { amount: formatAmount(status.payNowAmount, currency) }) : t(amountModeKey(mode));

  return (
    <Radio.Group value={values.mode} onChange={(e) => onChange({ mode: e.target.value })} style={{ width: '100%' }}>
      <Flex vertical gap={12}>
        {modes.map((m) => (
          <div key={m.mode}>
            <Radio value={m.mode} disabled={!m.enabled}><Typography.Text strong={m.enabled}>{label(m.mode)}</Typography.Text></Radio>
            {values.mode === m.mode ? (
              <div style={{ marginInlineStart: 24, marginTop: 6 }}>
                {m.mode === 'NOW' ? <Typography.Text type="secondary">{t('payment.pay.mode.NOW.hint')}</Typography.Text> : null}
                {m.mode === 'ROW' ? (
                  <Select
                    style={{ width: '100%', maxWidth: 420 }}
                    value={rows.some((r) => r.id === values.rowId) ? values.rowId : undefined}
                    onChange={(rowId: string) => onChange({ rowId })}
                    placeholder={t('payment.pay.row.placeholder')}
                    options={rows.map((r) => ({
                      value: r.id,
                      label: t('payment.pay.row.option', { seq: r.seq, date: r.dueDate, amount: formatAmount(r.outstanding, currency) }),
                    }))}
                  />
                ) : null}
                {m.mode === 'CUSTOM' ? (
                  <Flex vertical gap={4}>
                    <InputNumber<number>
                      style={{ width: '100%', maxWidth: 260 }}
                      value={values.amount}
                      min={0}
                      max={max}
                      precision={2}
                      controls={false}
                      status={customError ? 'error' : undefined}
                      placeholder={t('payment.pay.custom.placeholder')}
                      suffix={currency === 'MNT' ? '₮' : currency}
                      formatter={(v) => groupDigits(v)}
                      parser={(v) => parseDigits(v) as unknown as number}
                      onChange={(amount) => onChange({ amount: typeof amount === 'number' ? amount : null })}
                    />
                    {customError ? (
                      <Typography.Text type="danger">{t(customError.key, customError.params)}</Typography.Text>
                    ) : (
                      <Typography.Text type="secondary">{t('payment.pay.custom.hint', { max: formatAmount(max, currency) })}</Typography.Text>
                    )}
                  </Flex>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </Flex>
    </Radio.Group>
  );
}

/** Төлөх хэлбэр, дүн сонгох алхам. Сервер invoice-ийг амжилттай үүсгэвэл `onCreated(invoiceId)`. */
export function PayForm({ applicationId, status, values, options, providers, onChange, onCreated, onCancel }: Props) {
  const create = useCreateInvoice(applicationId);
  const invalid = validatePayForm(status, options, values);
  const amount = previewAmount(status, values);
  const noneEnabled = !providers.isLoading && !providers.error && options.every((o) => !o.enabled);

  const submit = () => {
    const req = buildInvoiceRequest(applicationId, values);
    if (!req || create.isPending) return;
    create.mutate(req, { onSuccess: (invoice) => onCreated(invoice.id) });
  };

  return (
    <Flex vertical gap={20}>
      <section>
        <Typography.Title level={5} style={{ marginTop: 0 }}>{t('payment.pay.provider.title')}</Typography.Title>
        {providers.isLoading ? <Skeleton active paragraph={{ rows: 3 }} title={false} /> : null}
        {providers.error ? <PaymentErrorAlert error={providers.error} title={t('payment.pay.provider.loadError')} onRetry={providers.refetch} /> : null}
        {!providers.isLoading && !providers.error ? <ProviderPicker options={options} value={values.provider} onChange={(provider) => onChange({ provider })} /> : null}
        {noneEnabled ? <Alert style={{ marginTop: 12 }} type="warning" showIcon message={t('payment.pay.provider.noneEnabled')} /> : null}
      </section>

      <section>
        <Typography.Title level={5} style={{ marginTop: 0 }}>{t('payment.pay.amount.title')}</Typography.Title>
        <AmountPicker status={status} values={values} onChange={onChange} />
        {values.mode !== 'NOW' ? <Alert style={{ marginTop: 12 }} type="info" showIcon message={t('payment.pay.fifoHint')} /> : null}
      </section>

      <section>
        <Typography.Title level={5} style={{ marginTop: 0 }}>{t('payment.pay.note.title')}</Typography.Title>
        <Input.TextArea value={values.note} onChange={(e) => onChange({ note: e.target.value })} rows={2} maxLength={200} showCount placeholder={t('payment.pay.note.placeholder')} />
      </section>

      <Flex justify="space-between" align="center" gap={12} wrap>
        <Flex vertical>
          <Typography.Text type="secondary">{t('payment.pay.total')}</Typography.Text>
          <Typography.Title level={3} style={{ margin: 0 }}>{amount !== null ? formatAmount(amount, status.currency) : t('payment.common.empty')}</Typography.Title>
        </Flex>
        <Flex gap={8}>
          <Button onClick={onCancel} disabled={create.isPending}>{t('payment.action.cancel')}</Button>
          <Button type="primary" size="large" disabled={invalid !== null} loading={create.isPending} onClick={submit}>{t('payment.pay.submit')}</Button>
        </Flex>
      </Flex>

      {create.error ? <PaymentErrorAlert error={create.error} /> : null}
    </Flex>
  );
}
