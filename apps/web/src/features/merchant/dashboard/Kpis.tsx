'use client';
import type { MerchantDashboard } from '@los/contracts';
import Link from 'next/link';
import { formatDuration, formatMnt, formatNumber, formatPercent } from '../../../lib/format';
import { t } from '../../../lib/i18n';

/** POS-NFR-1: кассирын эхлэлээс шийдвэр хүртэл ≤ 60с. Зөвхөн харуулалтын зорилт (docs/05 §3). */
export const DECISION_TARGET_SECONDS = 60;

const TODO_ITEMS = [
  { key: 'awaitingOtp', status: 'DRAFT' },
  { key: 'awaitingAcceptance', status: 'APPROVED' },
  { key: 'awaitingDelivery', status: 'ACCEPTED' },
  { key: 'referred', status: 'REFERRED' },
] as const;

/** "Хийх ажил": карт бүр холбогдох төлвөөр шүүсэн жагсаалт руу. */
export function TodoCards({ todo }: { todo: MerchantDashboard['todo'] }) {
  return (
    <section aria-labelledby="todo-h" className="mp-section">
      <h2 id="todo-h" className="mp-section-title">{t('dashboard.todo.title')}</h2>
      <ul className="mp-todo-grid">
        {TODO_ITEMS.map(({ key, status }) => {
          const count = todo[key];
          return (
            <li key={key}>
              <Link href={`/merchant/leases?status=${status}`} className={`mp-todo mp-todo-${key}${count > 0 ? ' is-active' : ''}`}>
                <span className="mp-todo-count">{formatNumber(count)}</span>
                <span className="mp-todo-body">
                  <strong>{t(`dashboard.todo.${key}`)}</strong>
                  <small>{t(`dashboard.todo.${key}.hint`)}</small>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Kpi({ label, value, sub, testId }: { label: string; value: string; sub?: React.ReactNode; testId: string }) {
  return (
    <div className="mp-kpi" data-testid={testId}>
      <dt className="mp-kpi-label">{label}</dt>
      <dd className="mp-kpi-value">{value}</dd>
      {sub ? <dd className="mp-kpi-sub">{sub}</dd> : null}
    </div>
  );
}

export function KpiGrid({ totals }: { totals: MerchantDashboard['totals'] }) {
  const avg = totals.avgDecisionSeconds;
  const onTarget = avg !== null && avg <= DECISION_TARGET_SECONDS;
  return (
    <section aria-labelledby="kpi-h" className="mp-section">
      <h2 id="kpi-h" className="mp-section-title">{t('dashboard.kpi.title')}</h2>
      <dl className="mp-kpi-grid">
        <Kpi testId="kpi-requests" label={t('dashboard.kpi.requests')} value={formatNumber(totals.requests)} sub={t('dashboard.kpi.requests.sub', { approved: totals.approved, declined: totals.declined, referred: totals.referred })} />
        <Kpi testId="kpi-approved" label={t('dashboard.kpi.approved')} value={formatNumber(totals.approved)} sub={t('dashboard.kpi.approved.sub', { rate: formatPercent(totals.approvalRate, 1) })} />
        <Kpi testId="kpi-conversion" label={t('dashboard.kpi.conversion')} value={formatPercent(totals.conversionRate, 1)} sub={t('dashboard.kpi.conversion.sub', { accepted: totals.accepted, approved: totals.approved })} />
        <Kpi
          testId="kpi-decision"
          label={t('dashboard.kpi.decisionTime')}
          value={formatDuration(avg)}
          sub={
            avg === null ? t('dashboard.kpi.decisionTime.none') : (
              <span className="mp-pill-row">
                <span className={`mp-pill ${onTarget ? 'mp-pill-ok' : 'mp-pill-warn'}`}>{onTarget ? t('dashboard.kpi.decisionTime.ok') : t('dashboard.kpi.decisionTime.slow')}</span>
                <span className="mp-pill-note">{t('dashboard.kpi.decisionTime.target')}</span>
              </span>
            )
          }
        />
        <Kpi testId="kpi-financed" label={t('dashboard.kpi.financed')} value={formatMnt(totals.financedAmount)} sub={t('dashboard.kpi.financed.sub')} />
        <Kpi testId="kpi-sales" label={t('dashboard.kpi.sales')} value={formatMnt(totals.goodsSalesAmount)} sub={t('dashboard.kpi.sales.sub', { delivered: totals.delivered + totals.settled })} />
        <Kpi testId="kpi-commission" label={t('dashboard.kpi.commission')} value={formatMnt(totals.commissionAmount)} sub={t('dashboard.kpi.commission.sub')} />
        <Kpi testId="kpi-awaiting" label={t('dashboard.kpi.awaiting')} value={formatMnt(totals.awaitingSettlementNet)} sub={t('dashboard.kpi.awaiting.sub', { count: totals.delivered })} />
        <Kpi testId="kpi-settled" label={t('dashboard.kpi.settled')} value={formatMnt(totals.settledNet)} sub={t('dashboard.kpi.settled.sub', { count: totals.settled })} />
      </dl>
    </section>
  );
}
