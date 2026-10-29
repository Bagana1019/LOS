'use client';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, Empty, Typography } from 'antd';
import type { DashboardSummary } from '@los/contracts';
import { t } from '../../lib/i18n';
import { BarList } from './BarList';
import { MonthlyDisbursementChart } from './MonthlyDisbursementChart';
import { agingRows, isMonthlyEmpty, productRows, statusRows } from './dashboard.utils';

function ChartCard({ title, caption, extra, children }: { title: string; caption?: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <Card size="small" title={title} extra={extra} style={{ height: '100%' }}>
      {caption ? <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>{caption}</Typography.Paragraph> : null}
      {children}
    </Card>
  );
}

const noData = () => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report.chart.empty')} />;

/** Багцын хугацаа хэтрэлтийн 5 хувин (CURRENT → 90+). Урт = үндсэн үлдэгдэл. */
export function AgingCard({ summary }: { summary: DashboardSummary }) {
  const { portfolio, currency } = summary;
  const empty = portfolio.aging.every((a) => a.loanCount === 0 && a.principal === 0);
  return (
    <ChartCard
      title={t('report.chart.aging.title')}
      caption={t('report.chart.aging.caption')}
      extra={<Link href="/los/report/overdue-loans">{t('report.dashboard.openReport')}</Link>}
    >
      {empty ? noData() : <BarList rows={agingRows(portfolio.aging, currency, t)} label={t('report.chart.aging.title')} />}
    </ChartCard>
  );
}

/** Хүсэлтийн төлөв бүрээр (DRAFT → MIGRATED). Урт = хүсэлтийн тоо. */
export function StatusFunnelCard({ summary }: { summary: DashboardSummary }) {
  const { applications, currency } = summary;
  const empty = applications.byStatus.every((s) => s.count === 0);
  return (
    <ChartCard
      title={t('report.chart.funnel.title')}
      caption={t('report.chart.funnel.caption')}
      extra={<Link href="/los/report/pipeline-progress">{t('report.dashboard.openReport')}</Link>}
    >
      {empty ? noData() : <BarList rows={statusRows(applications.byStatus, currency, t)} label={t('report.chart.funnel.title')} />}
    </ChartCard>
  );
}

export function TopProductsCard({ summary }: { summary: DashboardSummary }) {
  const { topProducts, currency } = summary;
  return (
    <ChartCard title={t('report.chart.products.title')} caption={t('report.chart.products.caption')}>
      {topProducts.length === 0 ? noData() : <BarList rows={productRows(topProducts, currency, t)} label={t('report.chart.products.title')} />}
    </ChartCard>
  );
}

export function MonthlyDisbursementCard({ summary }: { summary: DashboardSummary }) {
  const { monthly } = summary.disbursements;
  return (
    <ChartCard
      title={t('report.chart.monthly.title', { currency: summary.currency })}
      caption={isMonthlyEmpty(monthly) ? undefined : t('report.chart.monthly.caption')}
      extra={<Link href="/los/report/disbursed-loans">{t('report.dashboard.openReport')}</Link>}
    >
      <MonthlyDisbursementChart monthly={monthly} currency={summary.currency} />
    </ChartCard>
  );
}
