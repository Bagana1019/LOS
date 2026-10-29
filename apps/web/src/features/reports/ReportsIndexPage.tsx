'use client';
import Link from 'next/link';
import { Card, Col, Empty, Flex, Row, Skeleton, Tag, Typography } from 'antd';
import type { ReportDefinitionView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ReportErrorAlert } from './ReportErrorAlert';
import { useReportDefinitions } from './useReports';

const CARD_LINK = { display: 'block', color: 'inherit', height: '100%' } as const;

/** Core-оос (туршилтын эсвэл бодит) ирдэг тайланг тэмдэглэнэ. LOS-ийн өөрийн өгөгдөл бол тэмдэглэгээ шаардлагагүй. */
export function DataSourceTag({ source }: { source: ReportDefinitionView['dataSource'] }) {
  if (source === 'origination') return null;
  return <Tag color={source === 'core-mock' ? 'gold' : 'blue'}>{t(source === 'core-mock' ? 'report.dataSource.core-mock' : 'report.dataSource.core')}</Tag>;
}

function ReportCard({ def }: { def: ReportDefinitionView }) {
  return (
    <Link href={`/los/report/${def.key}`} style={CARD_LINK}>
      <Card hoverable size="small" style={{ height: '100%' }}>
        <Flex vertical gap={8} style={{ minHeight: 112 }}>
          <Flex justify="space-between" align="start" gap={8}>
            <Typography.Title level={5} style={{ margin: 0 }}>{def.title}</Typography.Title>
            <DataSourceTag source={def.dataSource} />
          </Flex>
          <Typography.Paragraph type="secondary" style={{ margin: 0 }} ellipsis={{ rows: 3 }}>{def.description}</Typography.Paragraph>
          <Typography.Text type="secondary" style={{ marginTop: 'auto' }}>{t('report.index.meta', { columns: def.columns.length, filters: def.filters.length })}</Typography.Text>
        </Flex>
      </Card>
    </Link>
  );
}

/** `/los/report` — 9 тайлангийн картын жагсаалт + Dashboard холбоос (docs/01 §2.1). */
export function ReportsIndexPage() {
  const q = useReportDefinitions();
  const defs = q.data ?? [];

  return (
    <Flex vertical gap={24} style={{ maxWidth: 1280 }}>
      <Flex vertical gap={4}>
        <Typography.Title level={3} style={{ margin: 0 }}>{t('report.index.title')}</Typography.Title>
        <Typography.Text type="secondary">{t('report.index.subtitle')}</Typography.Text>
      </Flex>

      <Link href="/los/dashboard" style={CARD_LINK}>
        <Card hoverable size="small">
          <Flex justify="space-between" align="center" gap={16} wrap>
            <Flex vertical gap={4}>
              <Typography.Title level={5} style={{ margin: 0 }}>{t('report.index.dashboard.title')}</Typography.Title>
              <Typography.Text type="secondary">{t('report.index.dashboard.description')}</Typography.Text>
            </Flex>
            <Typography.Text strong>{t('report.index.dashboard.open')}</Typography.Text>
          </Flex>
        </Card>
      </Link>

      <Typography.Title level={5} style={{ margin: 0 }}>{t('report.index.section.reports')}</Typography.Title>

      {q.isError ? <ReportErrorAlert error={q.error} title={t('report.index.loadError')} onRetry={() => void q.refetch()} /> : null}

      {q.isLoading ? (
        <Row gutter={[16, 16]}>
          {Array.from({ length: 9 }, (_, i) => (
            <Col key={i} xs={24} md={12} xl={8}><Card size="small"><Skeleton active paragraph={{ rows: 2 }} /></Card></Col>
          ))}
        </Row>
      ) : null}

      {q.isSuccess && defs.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report.index.empty')} /> : null}

      {defs.length > 0 ? (
        <Row gutter={[16, 16]}>
          {defs.map((def) => (
            <Col key={def.key} xs={24} md={12} xl={8}><ReportCard def={def} /></Col>
          ))}
        </Row>
      ) : null}
    </Flex>
  );
}
