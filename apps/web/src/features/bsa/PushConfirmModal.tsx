'use client';
import { Alert, Descriptions, Flex, Modal, Typography } from 'antd';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';

interface Props {
  open: boolean;
  borrowerName: string;
  /** Шийдвэрлэгдээгүй сэжигтэй дохионы тоо (мэдэгдэхгүй бол null). */
  pending: number | null;
  /** ЭТХ-ээс санал болгосон сарын төлбөр (бүртгэгдээгүй бол null). */
  proposedPayment: number | null;
  dtiPercent: number | null;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** BSA-FR-5.3: «Системрүү татах»-ын өмнөх анхааруулга — хүлээгдэж буй дохио, санал болгосон дүн, татсаны дараах түгжилт (INT-4). */
export function PushConfirmModal({ open, borrowerName, pending, proposedPayment, dtiPercent, loading, onConfirm, onCancel }: Props) {
  const paymentMissing = proposedPayment === null || proposedPayment <= 0;
  return (
    <Modal
      open={open}
      title={t('bsa.push.confirm.title')}
      okText={t('bsa.push.confirm.ok')}
      cancelText={t('bsa.push.confirm.cancel')}
      okButtonProps={{ danger: true }}
      confirmLoading={loading}
      maskClosable={false}
      onOk={onConfirm}
      onCancel={onCancel}
    >
      <Flex vertical gap={12}>
        <Typography.Text strong>{borrowerName}</Typography.Text>
        {pending !== null && pending > 0
          ? <Alert type="warning" showIcon message={t('bsa.push.confirm.unresolved', { count: pending })} description={t('bsa.push.confirm.unresolvedHint')} />
          : <Alert type="success" showIcon message={t('bsa.push.confirm.allResolved')} />}
        <Descriptions
          size="small"
          column={1}
          bordered
          items={[
            { key: 'payment', label: t('bsa.push.confirm.payment'), children: proposedPayment === null ? '—' : formatMnt(proposedPayment) },
            { key: 'dti', label: t('bsa.push.confirm.dti'), children: dtiPercent === null ? '—' : `${dtiPercent}%` },
          ]}
        />
        {paymentMissing ? <Alert type="warning" showIcon message={t('bsa.push.confirm.paymentMissing')} /> : null}
        <Alert type="error" showIcon message={t('bsa.push.confirm.lockTitle')} description={t('bsa.push.confirm.lock')} />
      </Flex>
    </Modal>
  );
}
