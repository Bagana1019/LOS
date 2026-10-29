'use client';
import { useEffect, useRef, useState } from 'react';
import { App as AntApp, Alert, Avatar, Badge, Button, Descriptions, Empty, Flex, Image, Popconfirm, Result, Skeleton, Tag, Tooltip, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { PaymentInvoiceView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { PaymentErrorAlert } from './PaymentErrorAlert';
import { canSimulate, formatAmount, formatCountdown, formatDateTime, isSafeDeeplink, PROVIDER_COLOR, providerKey, qrImageSrc, remainingSeconds } from './payment.utils';
import { paymentsKey, useCancelInvoice, useInvoice, useProviders, useSimulatePayment } from './usePayments';

interface Props {
  applicationId: string;
  invoiceId: string;
  /** EXPIRED / CANCELLED үед хэлбэр рүү буцаж дахин үүсгэнэ. */
  onRecreate: () => void;
  onClose: () => void;
}

const copyable = (text: string) => ({ text, tooltips: [t('payment.action.copy'), t('payment.action.copied')] as [string, string] });

/** Тик бүр шинэчлэгдэх секундийн тоолуур (зөвхөн идэвхтэй үед). */
function useRemainingSeconds(expiresAt: string | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return expiresAt ? remainingSeconds(expiresAt, now) : 0;
}

/** QPay / SocialPay: QR зураг + банкны апп-ын deeplink. */
function QrBlock({ invoice }: { invoice: PaymentInvoiceView }) {
  const src = qrImageSrc(invoice.qrImage);
  const links = invoice.deeplinks.filter((d) => isSafeDeeplink(d.link));
  return (
    <Flex vertical gap={12} style={{ minWidth: 240 }}>
      <Typography.Text strong>{t('payment.invoice.qr.title', { provider: t(providerKey(invoice.provider)) })}</Typography.Text>
      {src ? (
        <Image src={src} alt={t('payment.invoice.qr.alt')} width={240} height={240} preview={false} style={{ border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8 }} />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('payment.invoice.qr.missing')} />
      )}
      {invoice.qrText ? <Typography.Text type="secondary" copyable={copyable(invoice.qrText)}>{t('payment.invoice.qr.copyText')}</Typography.Text> : null}
      {links.length > 0 ? (
        <>
          <Typography.Text strong>{t('payment.invoice.deeplinks.title')}</Typography.Text>
          <Flex wrap gap={8} style={{ maxHeight: 180, overflowY: 'auto' }}>
            {links.map((d) => (
              <Tooltip key={`${d.name}|${d.link}`} title={d.description ?? undefined}>
                <Button size="small" href={d.link} rel="noreferrer" icon={<Avatar shape="square" size={18} src={d.logo ?? undefined}>{d.name.slice(0, 1)}</Avatar>}>
                  {d.name}
                </Button>
              </Tooltip>
            ))}
          </Flex>
        </>
      ) : null}
    </Flex>
  );
}

/** Банкны шилжүүлэг: данс, хүлээн авагч, дүн, гүйлгээний утга (хуулах товчтой). */
function BankInstructionBlock({ invoice }: { invoice: PaymentInvoiceView }) {
  const b = invoice.bankTransfer;
  if (!b) return <Alert type="warning" showIcon message={t('payment.invoice.bank.missing')} />;
  return (
    <Flex vertical gap={12} style={{ minWidth: 320, flex: 1 }}>
      <Typography.Text strong>{t('payment.invoice.bank.title')}</Typography.Text>
      <Descriptions
        column={1}
        bordered
        size="small"
        items={[
          { key: 'bank', label: t('payment.invoice.bank.bank'), children: b.bankCode },
          { key: 'account', label: t('payment.invoice.bank.account'), children: <Typography.Text strong copyable={copyable(b.accountNo)}>{b.accountNo}</Typography.Text> },
          {
            key: 'name',
            label: t('payment.invoice.bank.accountName'),
            children: b.accountName ? <Typography.Text copyable={copyable(b.accountName)}>{b.accountName}</Typography.Text> : t('payment.common.empty'),
          },
          {
            key: 'amount',
            label: t('payment.invoice.bank.amount'),
            children: <Typography.Text strong copyable={copyable(String(invoice.amount))}>{formatAmount(invoice.amount, invoice.currency)}</Typography.Text>,
          },
          { key: 'reference', label: t('payment.invoice.bank.reference'), children: <Typography.Text strong code copyable={copyable(b.reference)}>{b.reference}</Typography.Text> },
        ]}
      />
      <Alert type="warning" showIcon message={t('payment.invoice.bank.referenceWarning')} description={t('payment.invoice.bank.delayHint')} />
    </Flex>
  );
}

function PendingBody({ invoice, applicationId, onClose, pollFailed }: { invoice: PaymentInvoiceView; applicationId: string; onClose: () => void; pollFailed: boolean }) {
  const providers = useProviders();
  // "Туршилтын төлөлт": зөвхөн mock горим ба production биш (backend мөн ижил шалгана — үгүй бол 404).
  const simulate = canSimulate(providers.data?.find((p) => p.provider === invoice.provider), process.env.NODE_ENV);
  const cancel = useCancelInvoice(applicationId);
  const sim = useSimulatePayment(applicationId);
  const remaining = useRemainingSeconds(invoice.expiresAt, true);
  const busy = cancel.isPending || sim.isPending;

  return (
    <Flex vertical gap={16}>
      <Flex gap={24} wrap align="flex-start">
        {invoice.provider === 'BANK_TRANSFER' ? <BankInstructionBlock invoice={invoice} /> : <QrBlock invoice={invoice} />}
        <Flex vertical gap={12} style={{ flex: 1, minWidth: 260 }}>
          <Descriptions
            column={1}
            size="small"
            bordered
            items={[
              {
                key: 'provider',
                label: t('payment.invoice.field.provider'),
                children: (
                  <Flex gap={4} wrap>
                    <Tag color={PROVIDER_COLOR[invoice.provider]} style={{ marginInlineEnd: 0 }}>{t(providerKey(invoice.provider))}</Tag>
                    {simulate ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('payment.mode.mock')}</Tag> : null}
                  </Flex>
                ),
              },
              { key: 'amount', label: t('payment.invoice.field.amount'), children: <Typography.Text strong>{formatAmount(invoice.amount, invoice.currency)}</Typography.Text> },
              { key: 'no', label: t('payment.invoice.field.number'), children: <Typography.Text copyable={copyable(invoice.senderInvoiceNo)}>{invoice.senderInvoiceNo}</Typography.Text> },
              {
                key: 'expires',
                label: t('payment.invoice.field.expires'),
                children: remaining > 0
                  ? t('payment.invoice.expiresIn', { time: formatCountdown(remaining), at: formatDateTime(invoice.expiresAt) })
                  : t('payment.invoice.expiringNow'),
              },
            ]}
          />
          <Flex align="center" gap={8}>
            <Badge status="processing" />
            <Typography.Text type="secondary">{t('payment.invoice.waiting')}</Typography.Text>
          </Flex>
          {pollFailed ? <Alert type="warning" showIcon message={t('payment.invoice.pollError')} /> : null}
          <Typography.Text type="secondary">{t('payment.invoice.keepOpenHint')}</Typography.Text>
        </Flex>
      </Flex>

      {cancel.error ? <PaymentErrorAlert error={cancel.error} /> : null}
      {sim.error ? <PaymentErrorAlert error={sim.error} /> : null}

      <Flex justify="space-between" gap={8} wrap>
        <Popconfirm title={t('payment.invoice.cancelConfirm')} okText={t('payment.action.confirmYes')} cancelText={t('payment.action.no')} okButtonProps={{ danger: true }} onConfirm={() => cancel.mutate(invoice.id)}>
          <Button danger loading={cancel.isPending} disabled={sim.isPending}>{t('payment.invoice.cancel')}</Button>
        </Popconfirm>
        <Flex gap={8}>
          {simulate ? (
            <Tooltip title={t('payment.invoice.simulateHint')}>
              <Button loading={sim.isPending} disabled={cancel.isPending} onClick={() => sim.mutate({ invoiceId: invoice.id })}>{t('payment.invoice.simulate')}</Button>
            </Tooltip>
          ) : null}
          <Button disabled={busy} onClick={onClose}>{t('payment.action.close')}</Button>
        </Flex>
      </Flex>
    </Flex>
  );
}

/**
 * Үүссэн invoice: QR/deeplink эсвэл банкны заавар, 3 секунд тутам polling.
 * PAID → амжилт + ЭТХ/түүх шинэчлэх; EXPIRED → дахин үүсгэх; CANCELLED → шинээр үүсгэх.
 */
export function InvoicePanel({ applicationId, invoiceId, onRecreate, onClose }: Props) {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const q = useInvoice(applicationId, invoiceId);
  const invoice = q.data;
  const status = invoice?.status;

  const paidNotified = useRef(false);
  useEffect(() => {
    if (status === 'PAID' && !paidNotified.current) {
      paidNotified.current = true;
      void message.success(t('payment.toast.paid'));
      void queryClient.invalidateQueries({ queryKey: paymentsKey(applicationId) });
    }
  }, [status, message, queryClient, applicationId]);

  if (!invoice) {
    if (q.isError) return <PaymentErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
    return <Skeleton active paragraph={{ rows: 6 }} />;
  }

  const close = <Button key="close" onClick={onClose}>{t('payment.action.close')}</Button>;
  switch (invoice.status) {
    case 'PAID':
      return (
        <Result
          status="success"
          title={t('payment.invoice.paid.title')}
          subTitle={invoice.paidAt
            ? t('payment.invoice.paid.subtitle', { amount: formatAmount(invoice.amount, invoice.currency), time: formatDateTime(invoice.paidAt) })
            : t('payment.invoice.paid.subtitleNoTime', { amount: formatAmount(invoice.amount, invoice.currency) })}
          extra={<Button type="primary" onClick={onClose}>{t('payment.action.close')}</Button>}
        />
      );
    case 'EXPIRED':
      return (
        <Result
          status="warning"
          title={t('payment.invoice.expired.title')}
          subTitle={t('payment.invoice.expired.subtitle')}
          extra={[<Button key="again" type="primary" onClick={onRecreate}>{t('payment.invoice.recreate')}</Button>, close]}
        />
      );
    case 'CANCELLED':
      return (
        <Result
          status="info"
          title={t('payment.invoice.cancelled.title')}
          subTitle={t('payment.invoice.cancelled.subtitle')}
          extra={[<Button key="again" type="primary" onClick={onRecreate}>{t('payment.invoice.createNew')}</Button>, close]}
        />
      );
    case 'PENDING':
      return <PendingBody invoice={invoice} applicationId={applicationId} onClose={onClose} pollFailed={q.isError} />;
  }
}
