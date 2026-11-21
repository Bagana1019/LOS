'use client';
import { Alert, Descriptions, Flex, Typography } from 'antd';
import type { DisbursementView } from '@los/contracts';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { termsFlags } from './disbursement.utils';

export type Terms = Pick<DisbursementView, 'approvedAmount' | 'disburseAmount' | 'disburseDate' | 'bankCode' | 'accountNoMasked' | 'holderName' | 'accountOwnerType'>;
const EMPTY = '—';

/** F5-10 / F5-8: ямар дүнг, хэзээ, аль банк/данс (маскласан), хэний дансанд олгохыг НЭГ газар харуулна — дээд карт болон илгээх/зөвшөөрөх баталгаажуулалтад ижил. Зөрүүтэй бол анхааруулна. */
export function DisbursementTerms({ d, column = { xs: 1, md: 2 } }: { d: Terms; column?: number | Record<string, number> }) {
  const flags = termsFlags(d);
  return (
    <>
      <Descriptions size="small" column={column}>
        <Descriptions.Item label={t('disb.field.amount')}><span data-testid="disb-sum-amount">{d.disburseAmount > 0 ? formatMnt(d.disburseAmount) : EMPTY}</span></Descriptions.Item>
        <Descriptions.Item label={t('disb.field.date')}><span data-testid="disb-sum-date">{d.disburseDate ?? EMPTY}</span></Descriptions.Item>
        <Descriptions.Item label={t('disb.field.bank')}><span data-testid="disb-sum-bank">{d.bankCode ?? EMPTY}</span></Descriptions.Item>
        <Descriptions.Item label={t('disb.account')}><span data-testid="disb-sum-account">{d.accountNoMasked ?? EMPTY} {d.holderName ?? ''}</span></Descriptions.Item>
        <Descriptions.Item label={t('disb.field.owner')}><span data-testid="disb-sum-owner">{d.accountOwnerType ? t(`disb.owner.${d.accountOwnerType}`) : EMPTY}</span></Descriptions.Item>
      </Descriptions>
      {flags.amountDiffers ? <Alert data-testid="disb-warn-amount" type="warning" showIcon style={{ marginTop: 8 }} message={t('disb.warn.amount', { disbursed: formatMnt(d.disburseAmount), approved: formatMnt(d.approvedAmount) })} /> : null}
      {flags.thirdParty ? <Alert data-testid="disb-warn-third-party" type="warning" showIcon style={{ marginTop: 8 }} message={t('disb.warn.thirdParty')} /> : null}
    </>
  );
}

/** `Modal.confirm`-ийн content: тайлбар + олгох нөхцөл. Static modal тул context hook ашиглахгүй цэвэр JSX. */
export function ConfirmTerms({ hint, d }: { hint: string; d: Terms }) {
  return (
    <Flex vertical gap={8}>
      <Typography.Text type="secondary">{hint}</Typography.Text>
      <DisbursementTerms d={d} column={1} />
    </Flex>
  );
}
