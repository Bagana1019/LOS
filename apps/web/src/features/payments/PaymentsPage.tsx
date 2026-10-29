'use client';
import Link from 'next/link';
import { Breadcrumb, Flex } from 'antd';
import { t } from '../../lib/i18n';
import { PaymentHistory } from './PaymentHistory';
import { PaymentTools } from './PaymentTools';
import { RepaymentPanel } from './RepaymentPanel';

interface Props {
  /** LoanApplication.id (зээл = ACTIVE/MIGRATED төлөвтэй хүсэлт). */
  applicationId: string;
}

/** `/los/loan/:id/payments` — зээлийн эргэн төлөлт: ЭТХ-ийн төлөв + төлөх, төлбөрийн түүх, туслах хэрэгслүүд. */
export function PaymentsPage({ applicationId }: Props) {
  return (
    <Flex vertical gap={28} style={{ maxWidth: 1280 }}>
      <Breadcrumb items={[{ title: <Link href="/los/loan/list">{t('payment.page.breadcrumb.loans')}</Link> }, { title: t('payment.page.breadcrumb.payments') }]} />
      <RepaymentPanel applicationId={applicationId} />
      <PaymentHistory applicationId={applicationId} />
      <PaymentTools />
    </Flex>
  );
}
