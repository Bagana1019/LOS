import type { PosLeaseView } from '@los/contracts';
import { Card } from 'antd';
import { formatDateTime, formatMnt } from '../../../lib/format';
import { t } from '../../../lib/i18n';

/** Бараа, худалдан авагч (маскалсан; fullName байвал), огноонууд. PII үргэлж масклагдсан ирнэ (POS-BR-7). */
export function LeaseSummary({ lease }: { lease: PosLeaseView }) {
  const rows: Array<[string, string]> = [
    [t('detail.goods'), lease.goods.name],
    [t('detail.category'), t(`goodsCategory.${lease.goods.category}`)],
    ...(lease.goods.serialNo ? [[t('detail.serial'), lease.goods.serialNo] as [string, string]] : []),
    [t('detail.price'), formatMnt(lease.goods.price)],
  ];
  const buyer: Array<[string, string]> = [
    ...(lease.buyer.fullName ? [[t('detail.buyerName'), lease.buyer.fullName] as [string, string]] : []),
    [t('detail.register'), lease.buyer.registerMasked],
    [t('detail.phone'), lease.buyer.phoneMasked],
  ];
  const dates: Array<[string, string]> = [
    [t('detail.createdAt'), formatDateTime(lease.createdAt)],
    ...(lease.consentVerifiedAt ? [[t('detail.consentAt'), formatDateTime(lease.consentVerifiedAt)] as [string, string]] : []),
    ...(lease.decision.decidedAt ? [[t('detail.decidedAt'), formatDateTime(lease.decision.decidedAt)] as [string, string]] : []),
    ...(lease.acceptedAt ? [[t('detail.acceptedAt'), formatDateTime(lease.acceptedAt)] as [string, string]] : []),
    ...(lease.deliveredAt ? [[t('detail.deliveredAt'), formatDateTime(lease.deliveredAt)] as [string, string]] : []),
    ...(lease.settledAt ? [[t('detail.settledAt'), formatDateTime(lease.settledAt)] as [string, string]] : []),
    ...(lease.cancelledAt ? [[t('detail.cancelledAt'), formatDateTime(lease.cancelledAt)] as [string, string]] : []),
  ];
  const block = (title: string, list: Array<[string, string]>) => (
    <div className="mp-summary-block">
      <h3 className="mp-subtitle">{title}</h3>
      <dl className="mp-dl">{list.map(([k, v]) => <div key={k} className="mp-dl-row"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </div>
  );
  return (
    <Card className="mp-card" title={t('detail.summary')}>
      {block(t('detail.goodsBlock'), rows)}
      {block(t('detail.buyerBlock'), buyer)}
      {block(t('detail.datesBlock'), dates)}
    </Card>
  );
}
