'use client';
import { useState } from 'react';
import { Modal } from 'antd';
import type { RepaymentStatusView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { InvoicePanel } from './InvoicePanel';
import { PayForm } from './PayForm';
import { initialPayForm, providerOptions, resolveProvider, type PayFormValues } from './payment.utils';
import { useProviders } from './usePayments';

interface Props {
  open: boolean;
  applicationId: string;
  status: RepaymentStatusView;
  /** ЭТХ-ийн мөрөөс "Төлөх" дарсан бол тэр мөр урьдчилан сонгогдоно. */
  initialRowId: string | null;
  onClose: () => void;
}

/**
 * Төлбөр төлөх modal: (1) хэлбэр + дүн сонгох → (2) invoice (QR / банкны заавар, polling).
 * Хаахад дотоод төлөв арилна (destroyOnHidden); invoice PENDING хэвээр үлдэх тул дахин нээж ижил хүсэлт өгвөл сервер байгааг буцаана (idempotent).
 */
export function PayModal({ open, onClose, ...rest }: Props) {
  return (
    <Modal open={open} title={t('payment.pay.title')} onCancel={onClose} footer={null} width={780} destroyOnHidden maskClosable={false}>
      {open ? <PayFlow {...rest} onClose={onClose} /> : null}
    </Modal>
  );
}

function PayFlow({ applicationId, status, initialRowId, onClose }: Omit<Props, 'open'>) {
  const providersQuery = useProviders();
  const options = providerOptions(providersQuery.data, status.currency);
  const [draft, setDraft] = useState<PayFormValues>(() => initialPayForm(status, initialRowId));
  const [invoiceId, setInvoiceId] = useState<string | null>(null);

  const values: PayFormValues = { ...draft, provider: resolveProvider(draft.provider, options) };

  if (invoiceId) {
    return <InvoicePanel applicationId={applicationId} invoiceId={invoiceId} onRecreate={() => setInvoiceId(null)} onClose={onClose} />;
  }
  return (
    <PayForm
      applicationId={applicationId}
      status={status}
      values={values}
      options={options}
      providers={{ isLoading: providersQuery.isLoading, error: providersQuery.error, refetch: () => void providersQuery.refetch() }}
      onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      onCreated={setInvoiceId}
      onCancel={onClose}
    />
  );
}
