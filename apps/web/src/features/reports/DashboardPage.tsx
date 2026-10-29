'use client';
import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Alert, Breadcrumb, Col, Empty, Flex, Row, Skeleton, Typography } from 'antd';
import { t } from '../../lib/i18n';
import { AgingCard, MonthlyDisbursementCard, StatusFunnelCard, TopProductsCard } from './DashboardCharts';
import { DashboardFilters } from './DashboardFilters';
import { ApplicationKpis, CollectionKpis, DisbursementKpis, PortfolioKpis } from './DashboardKpis';
import { ReportErrorAlert } from './ReportErrorAlert';
import { buildDashboardQuery, isDashboardEmpty, parseDashboardFilters, scopeText, toDashboardSearchParams, type DashboardFilters as Filters } from './dashboard.utils';
import { formatDateTimeUb } from './reports.utils';
import { useDashboard } from './useReports';

/** `/los/dashboard` — KPI самбар (FR-13.3): багц, цуглуулалт, олголт, хүсэлтийн урсгал. Шүүлт URL-д. Хүрээг (NFR-3) сервер хэрэгжүүлнэ. */
export function DashboardPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => parseDashboardFilters(searchParams), [searchParams]);
  const query = useMemo(() => buildDashboardQuery(filters), [filters]);
  const q = useDashboard(query);
  const summary = q.data;
  const reloading = q.isFetching && q.isPlaceholderData;

  const apply = (next: Filters) => {
    const qs = toDashboardSearchParams(next).toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <Flex vertical gap={24} style={{ maxWidth: 1440 }}>
      <Flex vertical gap={8}>
        <Breadcrumb items={[{ title: <Link href="/los/report">{t('report.page.breadcrumb.index')}</Link> }, { title: t('report.dashboard.title') }]} />
        <Typography.Title level={3} style={{ margin: 0 }}>{t('report.dashboard.title')}</Typography.Title>
        <Typography.Text type="secondary">{t('report.dashboard.subtitle')}</Typography.Text>
      </Flex>

      <DashboardFilters value={filters} busy={reloading} onApply={apply} />

      {q.isError ? <ReportErrorAlert error={q.error} title={t('report.dashboard.loadError')} onRetry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton active paragraph={{ rows: 12 }} /> : null}

      {summary ? (
        <Flex vertical gap={24} style={{ opacity: reloading ? 0.6 : 1, transition: 'opacity .15s' }}>
          <Typography.Text type="secondary">
            {t('report.dashboard.meta', { asOf: summary.asOf, scope: scopeText(summary.scope, t), currency: summary.currency, generated: formatDateTimeUb(summary.generatedAt) })}
          </Typography.Text>

          {isDashboardEmpty(summary) ? <Alert type="info" showIcon message={t('report.dashboard.empty')} /> : null}

          <PortfolioKpis summary={summary} />
          <Row gutter={[16, 16]}>
            <Col xs={24} xl={12}><AgingCard summary={summary} /></Col>
            <Col xs={24} xl={12}><TopProductsCard summary={summary} /></Col>
          </Row>

          <CollectionKpis summary={summary} />

          <DisbursementKpis summary={summary} />
          <MonthlyDisbursementCard summary={summary} />

          <ApplicationKpis summary={summary} />
          <StatusFunnelCard summary={summary} />
        </Flex>
      ) : null}

      {!summary && !q.isLoading && !q.isError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report.dashboard.empty')} /> : null}
    </Flex>
  );
}
