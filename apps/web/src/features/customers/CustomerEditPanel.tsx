'use client';
import { useMemo } from 'react';
import { App as AntApp, Alert, Button, Space, Typography } from 'antd';
import type { CustomerView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ApiError } from '../../lib/api';
import { CustomerForm } from './CustomerForm';
import { buildUpdateBody, customerToFormValues, xypLockedPrefill } from './customer-edit';
import { describeCustomerError } from './customer-error';
import { useUpdateCustomer } from './useCustomers';

interface Props { customer: CustomerView; onCancel: () => void; onSaved: () => void }

/**
 * F1-15: картын засах горим — `CustomerForm`-ыг (бүртгэхтэй ижил маягт, ижил шалгалт) картын утгаар бөглөж `PUT /customers/:id` дуудна.
 * Эрхийн шийдвэр (`canEditCustomer`) дуудагч талд; сервер (`CUSTOMER_BRANCH_FORBIDDEN`) эцсийн эх сурвалж, алдааг энд харуулна.
 */
export function CustomerEditPanel({ customer, onCancel, onSaved }: Props) {
  const { message } = AntApp.useApp();
  const update = useUpdateCustomer(customer.id);
  const initial = useMemo(() => customerToFormValues(customer), [customer]);
  const locked = useMemo(() => xypLockedPrefill(customer), [customer]);
  const serverIssues = useMemo(() => (update.error instanceof ApiError && update.error.code === 'VALIDATION_FAILED' ? update.error.issues ?? [] : []), [update.error]);
  const failure = update.error ? describeCustomerError(update.error) : null;

  const submit = (payload: Record<string, unknown>) => {
    const body = buildUpdateBody(payload, initial);
    if (Object.keys(body).length === 0) { void message.info(t('customer.edit.noChanges')); return; }
    update.mutate(body, { onSuccess: () => { void message.success(t('customer.edit.success')); onSaved(); } });
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%', marginTop: 16 }} data-testid="customer-edit-panel">
      <Typography.Title level={4} style={{ margin: 0 }}>{t('customer.edit.title')}</Typography.Title>
      <Alert type="info" showIcon message={t('customer.edit.note')} />
      {failure ? <Alert type="error" showIcon data-testid="customer-edit-error" message={t('customer.edit.failed')} description={failure.message} /> : null}
      <CustomerForm
        customerType={customer.customerType} registerNo={customer.registerNo} initial={initial} prefilled={locked} serverIssues={serverIssues}
        submitting={update.isPending} onSubmit={submit} submitLabel={t('customer.edit.submit')}
        extra={<Button data-testid="customer-edit-cancel" disabled={update.isPending} onClick={onCancel}>{t('customer.card.cancelEdit')}</Button>}
      />
    </Space>
  );
}
