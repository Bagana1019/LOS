'use client';
import type { MerchantDashboard } from '@los/contracts';
import { Card, Progress, Table } from 'antd';
import { formatMnt, formatNumber } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { useIsMobile } from '../hooks';
import { MP_COLORS } from '../theme';

/** Өдрийн лимитийн ашиглалт (POS-BR-9) ба нэг лизингийн дээд хэмжээ. Хувь нь зөвхөн прогресс харуулалт. */
export function LimitsCard({ limits }: { limits: MerchantDashboard['limits'] }) {
  const { dailyLimitAmount, dailyUsedAmount, maxTicketAmount } = limits;
  const percent = dailyLimitAmount && dailyLimitAmount > 0 ? Math.min(100, Math.round((dailyUsedAmount / dailyLimitAmount) * 100)) : 0;
  const color = percent >= 90 ? MP_COLORS.danger : percent >= 70 ? MP_COLORS.warning : MP_COLORS.primary;
  return (
    <Card className="mp-card" title={t('dashboard.limits.title')}>
      <div className="mp-limit-block">
        <div className="mp-limit-head">
          <span>{t('dashboard.limits.daily')}</span>
          <strong className="mp-num">{dailyLimitAmount === null ? t('dashboard.limits.noLimit') : `${percent}%`}</strong>
        </div>
        {dailyLimitAmount !== null ? <Progress percent={percent} showInfo={false} strokeColor={color} aria-label={t('dashboard.limits.daily')} /> : null}
        <p className="mp-muted mp-limit-text">
          {dailyLimitAmount === null
            ? t('dashboard.limits.usedOnly', { used: formatMnt(dailyUsedAmount) })
            : t('dashboard.limits.used', { used: formatMnt(dailyUsedAmount), limit: formatMnt(dailyLimitAmount) })}
        </p>
      </div>
      <div className="mp-limit-row">
        <span>{t('dashboard.limits.maxTicket')}</span>
        <strong className="mp-num">{formatMnt(maxTicketAmount)}</strong>
      </div>
    </Card>
  );
}

interface Row { key: string; name: string; requests: number; approved: number; financedAmount: number }
function BreakdownTable({ title, nameTitle, rows }: { title: string; nameTitle: string; rows: Row[] }) {
  const mobile = useIsMobile();
  if (mobile) {
    return (
      <Card className="mp-card" title={title}>
        {rows.length === 0 ? <p className="mp-muted">{t('dashboard.breakdown.empty')}</p> : (
          <ul className="mp-mini-list" aria-label={title}>
            {rows.map((r) => (
              <li key={r.key}>
                <strong>{r.name}</strong>
                <dl>
                  <div><dt>{t('dashboard.breakdown.requests')}</dt><dd>{formatNumber(r.requests)}</dd></div>
                  <div><dt>{t('dashboard.breakdown.approved')}</dt><dd>{formatNumber(r.approved)}</dd></div>
                  <div><dt>{t('dashboard.breakdown.financed')}</dt><dd>{formatMnt(r.financedAmount)}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }
  return (
    <Card className="mp-card" title={title}>
      <Table<Row>
        size="small"
        rowKey="key"
        pagination={false}
        dataSource={rows}
        locale={{ emptyText: t('dashboard.breakdown.empty') }}
        aria-label={title}
        columns={[
          { title: nameTitle, dataIndex: 'name', key: 'name', ellipsis: true },
          { title: t('dashboard.breakdown.requests'), dataIndex: 'requests', key: 'requests', align: 'right', render: (v: number) => formatNumber(v) },
          { title: t('dashboard.breakdown.approved'), dataIndex: 'approved', key: 'approved', align: 'right', render: (v: number) => formatNumber(v) },
          { title: t('dashboard.breakdown.financed'), dataIndex: 'financedAmount', key: 'financedAmount', align: 'right', render: (v: number) => <span className="mp-num">{formatMnt(v)}</span> },
        ]}
      />
    </Card>
  );
}

export function ByStoreTable({ rows }: { rows: MerchantDashboard['byStore'] }) {
  return <BreakdownTable title={t('dashboard.byStore.title')} nameTitle={t('dashboard.byStore.name')} rows={rows.map((r) => ({ key: r.storeId, name: r.storeName, requests: r.requests, approved: r.approved, financedAmount: r.financedAmount }))} />;
}
export function ByPlanTable({ rows }: { rows: MerchantDashboard['byPlan'] }) {
  return <BreakdownTable title={t('dashboard.byPlan.title')} nameTitle={t('dashboard.byPlan.name')} rows={rows.map((r) => ({ key: r.planCode, name: r.planCode, requests: r.requests, approved: r.approved, financedAmount: r.financedAmount }))} />;
}
