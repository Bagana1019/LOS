'use client';
import { useCallback, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { App, Alert, Breadcrumb, Button, Flex, Result, Skeleton, Tooltip, Typography } from 'antd';
import { t } from '../../lib/i18n';
import { DataSourceTag } from './ReportsIndexPage';
import { ReportErrorAlert } from './ReportErrorAlert';
import { ReportFilters } from './ReportFilters';
import { ReportTable, type TableChange } from './ReportTable';
import {
  buildReportQuery, exportFileName, formatDateTimeUb, pageCorrection, parseViewState, sameFilters, toSearchParams,
  type FilterValues, type ReportViewState,
} from './reports.utils';
import { useExportReport, useReport, useReportDefinitions } from './useReports';

interface Props {
  /** URL-ийн `:key` (ReportKey байх ёстой; үгүй бол "олдсонгүй" харуулна). */
  reportKey: string;
}

/** `/los/report/[key]` — шүүлт (definition.filters), хүснэгт, Excel. Төлөв бүхэлдээ URL-д (холбоос хуваалцаж, шинэчилж болно). */
export function ReportPage({ reportKey }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { message } = App.useApp();

  const defs = useReportDefinitions();
  const definition = defs.data?.find((d) => d.key === reportKey);
  const state = useMemo(() => (definition ? parseViewState(searchParams, definition) : null), [definition, searchParams]);
  const query = useMemo(() => (definition && state ? buildReportQuery(state, definition, { paging: true }) : null), [definition, state]);

  const report = useReport(reportKey, query);
  const exporter = useExportReport(reportKey);
  const result = report.data;

  const navigate = useCallback(
    (next: ReportViewState) => {
      const qs = toSearchParams(next).toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  // Шүүлт өөрчлөгдсөний дараа хуудас хэмжээнээс хэтэрвэл сүүлийн хуудас руу. Зөвхөн одоогийн хуудасны хариуг үнэлнэ (өмнөх хүснэгтийн placeholder-аар давтахгүй).
  const correction = result && state && result.page === state.page ? pageCorrection(result) : null;
  useEffect(() => {
    if (correction !== null && state) navigate({ ...state, page: correction });
  }, [correction, state, navigate]);

  if (defs.isLoading) return <Skeleton active paragraph={{ rows: 10 }} />;
  if (defs.isError) return <ReportErrorAlert error={defs.error} title={t('report.page.definitionError')} onRetry={() => void defs.refetch()} />;
  if (!definition || !state) {
    return (
      <Result
        status="404"
        title={t('report.page.notFound.title')}
        subTitle={t('report.page.notFound.description')}
        extra={<Link href="/los/report"><Button type="primary">{t('report.page.back')}</Button></Link>}
      />
    );
  }

  const applyFilters = (filters: FilterValues) => {
    if (sameFilters(filters, state.filters)) void report.refetch();
    else navigate({ ...state, filters, page: 1 });
  };
  const onTableChange = (c: TableChange) => navigate({ ...state, ...c });
  const empty = !report.isLoading && (result?.total ?? 0) === 0;
  const fetching = report.isFetching;

  const exportExcel = () => {
    exporter.mutate(
      { query: buildReportQuery(state, definition, { paging: false }), fileName: exportFileName(definition.key, result?.asOf ?? state.filters.asOf) },
      { onSuccess: () => void message.success(t('report.export.success')) },
    );
  };

  return (
    <Flex vertical gap={16} style={{ maxWidth: 1600 }}>
      <Breadcrumb items={[{ title: <Link href="/los/report">{t('report.page.breadcrumb.index')}</Link> }, { title: definition.title }]} />

      <Flex justify="space-between" align="start" gap={16} wrap>
        <Flex vertical gap={4}>
          <Flex align="center" gap={8} wrap>
            <Typography.Title level={3} style={{ margin: 0 }}>{definition.title}</Typography.Title>
            <DataSourceTag source={definition.dataSource} />
          </Flex>
          <Typography.Text type="secondary">{definition.description}</Typography.Text>
        </Flex>
        <Link href="/los/dashboard"><Button>{t('report.page.dashboardLink')}</Button></Link>
      </Flex>

      {definition.dataSource === 'core-mock' ? <Alert type="info" showIcon message={t('report.dataSource.mockNotice')} /> : null}

      <ReportFilters filters={definition.filters} values={state.filters} busy={fetching && report.isPlaceholderData} onApply={applyFilters} onReset={() => navigate({ ...state, filters: {}, page: 1 })} />

      <Flex justify="space-between" align="center" gap={12} wrap>
        <Typography.Text type="secondary">
          {result ? t('report.page.meta', { total: result.total, asOf: result.asOf, generated: formatDateTimeUb(result.generatedAt) }) : t('report.page.metaLoading')}
        </Typography.Text>
        <Flex gap={8}>
          <Button onClick={() => void report.refetch()} loading={fetching && !report.isPlaceholderData}>{t('report.common.refresh')}</Button>
          <Tooltip title={empty ? t('report.export.disabledEmpty') : t('report.export.audit')}>
            <span>
              <Button type="primary" onClick={exportExcel} loading={exporter.isPending} disabled={!result || empty || report.isError}>{t('report.export.button')}</Button>
            </span>
          </Tooltip>
        </Flex>
      </Flex>

      {exporter.isError ? <ReportErrorAlert error={exporter.error} title={t('report.export.error')} onClose={() => exporter.reset()} /> : null}

      {report.isError ? <ReportErrorAlert error={report.error} title={t('report.page.loadError')} onRetry={() => void report.refetch()} /> : null}

      {report.isLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : report.isError && !result ? null : (
        <div style={{ opacity: fetching && report.isPlaceholderData ? 0.6 : 1, transition: 'opacity .15s' }}>
          <ReportTable definition={definition} result={result} loading={fetching && report.isPlaceholderData} state={state} onChange={onTableChange} />
        </div>
      )}
    </Flex>
  );
}
