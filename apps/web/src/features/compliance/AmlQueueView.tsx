'use client';
import { Alert, Flex, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { AmlHitQueueItem } from '@los/contracts';
import { formatDateTime, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { describeAmlError, screeningHref } from './aml.utils';

const { Title, Paragraph, Link } = Typography;

export interface AmlQueueViewProps {
  items: readonly AmlHitQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: unknown;
  onPageChange: (page: number, pageSize: number) => void;
}

const severityTag = (s: AmlHitQueueItem['hit']['severity']) => <Tag color={s === 'BLOCKING' ? 'red' : 'gold'}>{t(`aml.severity.${s}`)}</Tag>;

/** Compliance · AML шалгалтын дараалал (docs/05-compliance-aml.md §7 `GET /aml/hits?status=OPEN`). Регистр kyc-ээс масклагдсан ирнэ. */
export function AmlQueueView({ items, total, page, pageSize, loading, error, onPageChange }: AmlQueueViewProps) {
  const columns: ColumnsType<AmlHitQueueItem> = [
    { title: t('aml.col.subject'), key: 'subject', render: (_, r) => r.screening.subjectName },
    { title: t('aml.col.register'), key: 'register', render: (_, r) => <span data-testid="aml-queue-register">{r.screening.registerNoMasked}</span> },
    { title: t('aml.col.list'), key: 'list', render: (_, r) => t(`aml.list.${r.hit.list}`) },
    { title: t('aml.col.entry'), key: 'entry', render: (_, r) => r.hit.entryName },
    { title: t('aml.col.severity'), key: 'severity', width: 120, render: (_, r) => severityTag(r.hit.severity) },
    { title: t('aml.col.score'), key: 'score', width: 100, align: 'right', render: (_, r) => formatPercent(r.hit.score, 0) },
    { title: t('aml.col.screenedAt'), key: 'screenedAt', width: 170, render: (_, r) => formatDateTime(r.screening.screenedAt) },
    { title: t('aml.col.action'), key: 'action', width: 120, render: (_, r) => <Link href={screeningHref(r.screening.id)}>{t('aml.action.open')}</Link> },
  ];

  return (
    <Flex vertical gap={16}>
      <div>
        <Title level={3} style={{ marginBottom: 4 }}>{t('aml.queue.title')}</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>{t('aml.queue.subtitle')}</Paragraph>
      </div>
      {error ? <Alert type="error" showIcon message={describeAmlError(error, 'aml.error.LOAD')} /> : null}
      <Table<AmlHitQueueItem>
        rowKey={(r) => r.hit.id}
        columns={columns}
        dataSource={[...items]}
        loading={loading}
        locale={{ emptyText: t('aml.queue.empty') }}
        pagination={{ current: page, pageSize, total, showTotal: (n) => t('aml.queue.total', { count: n }), onChange: onPageChange }}
      />
    </Flex>
  );
}
