'use client';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Col, Flex, Row, Typography } from 'antd';
import type { DashboardSummary } from '@los/contracts';
import { t } from '../../lib/i18n';
import { KpiCard } from './KpiCard';
import { changeRatio, deltaTone, formatDelta, formatHours, formatRatio } from './dashboard.utils';
import { formatMoneyValue, formatNumberValue } from './reports.utils';

const COLS = { xs: 24, sm: 12, xl: 6 } as const;
/** 5 карт нэг мөрөнд (≥1366px), нарийн дэлгэц дээр доош эвхэгдэнэ. */
const COLS_5 = { flex: '1 1 210px' } as const;

export function Section({ title, href, children }: { title: string; href?: string; children: ReactNode }) {
  return (
    <Flex vertical gap={12}>
      <Flex justify="space-between" align="baseline" gap={12}>
        <Typography.Title level={5} style={{ margin: 0 }}>{title}</Typography.Title>
        {href ? <Link href={href}>{t('report.dashboard.openReport')}</Link> : null}
      </Flex>
      {children}
    </Flex>
  );
}

const money = (n: number, currency: string) => formatMoneyValue(n, currency);
const count = (n: number) => formatNumberValue(n, 0);

/** Идэвхтэй зээлийн багц (ACTIVE/MIGRATED): тоо, үндсэн үлдэгдэл, хугацаа хэтэрсэн дүн, PAR. */
export function PortfolioKpis({ summary }: { summary: DashboardSummary }) {
  const { portfolio: p, currency } = summary;
  return (
    <Section title={t('report.dashboard.section.portfolio')} href="/los/report/outstanding-balance">
      <Row gutter={[16, 16]}>
        <Col {...COLS}><KpiCard label={t('report.kpi.activeLoans')} value={count(p.activeLoanCount)} /></Col>
        <Col {...COLS}><KpiCard label={t('report.kpi.outstandingPrincipal')} value={money(p.outstandingPrincipal, currency)} /></Col>
        <Col {...COLS}><KpiCard label={t('report.kpi.overdueAmount')} value={money(p.overdueAmount, currency)} hint={t('report.dashboard.loans', { count: p.overdueLoanCount })} /></Col>
        <Col {...COLS}><KpiCard label={t('report.kpi.par')} value={formatRatio(p.parRatio)} hint={t('report.kpi.parHint')} /></Col>
      </Row>
    </Section>
  );
}

/** Энэ сарын эргэн төлөлтийн цуглуулалт ба ойрын 7 хоногийн төлөх дүн. */
export function CollectionKpis({ summary }: { summary: DashboardSummary }) {
  const { collections: c, currency } = summary;
  return (
    <Section title={t('report.dashboard.section.collections')} href="/los/report/upcoming-repayments">
      <Row gutter={[16, 16]}>
        <Col {...COLS}><KpiCard label={t('report.kpi.dueThisMonth')} value={money(c.dueThisMonth, currency)} /></Col>
        <Col {...COLS}><KpiCard label={t('report.kpi.collectedThisMonth')} value={money(c.collectedThisMonth, currency)} /></Col>
        <Col {...COLS}><KpiCard label={t('report.kpi.collectionRate')} value={formatRatio(c.collectionRate)} meter={c.collectionRate} hint={t('report.kpi.collectionRateHint')} /></Col>
        <Col {...COLS}><KpiCard label={t('report.kpi.dueNext7Days')} value={money(c.dueNext7Days, currency)} /></Col>
      </Row>
    </Section>
  );
}

/** Олголт: энэ сар (өмнөх сартай харьцуулсан), өмнөх сар, он эхлснээс. */
export function DisbursementKpis({ summary }: { summary: DashboardSummary }) {
  const { disbursements: d, currency } = summary;
  const ratio = changeRatio(d.thisMonthAmount, d.lastMonthAmount);
  const tone = deltaTone(ratio);
  return (
    <Section title={t('report.dashboard.section.disbursements')} href="/los/report/disbursed-loans">
      <Row gutter={[16, 16]}>
        <Col {...COLS}>
          <KpiCard
            label={t('report.kpi.disbursedThisMonth')}
            value={money(d.thisMonthAmount, currency)}
            hint={t('report.dashboard.disbursementCount', { count: d.thisMonthCount })}
            delta={tone ? { text: formatDelta(ratio), tone, caption: t('report.kpi.vsLastMonth') } : undefined}
          />
        </Col>
        <Col {...COLS}><KpiCard label={t('report.kpi.disbursedLastMonth')} value={money(d.lastMonthAmount, currency)} /></Col>
        <Col {...COLS}><KpiCard label={t('report.kpi.disbursedYtd')} value={money(d.yearToDateAmount, currency)} /></Col>
      </Row>
    </Section>
  );
}

/** Хүсэлтийн урсгал (энэ сар): илгээсэн/батлагдсан/буцаасан, батлах хувь, шийдвэрийн дундаж хугацаа. */
export function ApplicationKpis({ summary }: { summary: DashboardSummary }) {
  const a = summary.applications;
  return (
    <Section title={t('report.dashboard.section.applications')} href="/los/report/pipeline-progress">
      <Row gutter={[16, 16]}>
        <Col {...COLS_5}><KpiCard label={t('report.kpi.submitted')} value={count(a.submittedThisMonth)} /></Col>
        <Col {...COLS_5}><KpiCard label={t('report.kpi.approved')} value={count(a.approvedThisMonth)} /></Col>
        <Col {...COLS_5}><KpiCard label={t('report.kpi.returned')} value={count(a.returnedThisMonth)} /></Col>
        <Col {...COLS_5}><KpiCard label={t('report.kpi.approvalRate')} value={formatRatio(a.approvalRate)} meter={a.approvalRate} hint={t('report.kpi.approvalRateHint')} /></Col>
        <Col {...COLS_5}><KpiCard label={t('report.kpi.avgDecisionHours')} value={formatHours(a.avgDecisionHours, t)} hint={t('report.kpi.avgDecisionHoursHint')} /></Col>
      </Row>
    </Section>
  );
}
