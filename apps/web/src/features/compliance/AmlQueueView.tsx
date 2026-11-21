'use client';
import { Alert, Flex, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { AmlHitQueueItem } from '@los/contracts';
import { formatDateTime, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { AML_QUEUE_TABS, describeAmlError, screeningHref, type AmlQueueTab } from './aml.utils';
import { SeverityTag } from './SeverityTag';

const { Title, Paragraph, Link } = Typography;

export interface AmlQueueViewProps {
  items: readonly AmlHitQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  tab: AmlQueueTab;
  loading: boolean;
  error: unknown;
  onPageChange: (page: number, pageSize: number) => void;
  onTabChange: (tab: AmlQueueTab) => void;
}

const isTab = (key: string): key is AmlQueueTab => (AML_QUEUE_TABS as readonly string[]).includes(key);
const TAB_ITEMS = AML_QUEUE_TABS.map((key) => ({ key, label: t(`aml.queue.tab.${key}`) }));

/** F7-6: шийдвэрлэсэн hit-д төлөв ба шийдвэрлэсэн огноо нэмж харуулна (хүлээгдэж буй tab-д бүгд "шийдвэрлээгүй" тул нуугдана). */
const resolvedColumns = (): ColumnsType<AmlHitQueueItem> => [
  { title: t('aml.col.status'), key: 'status', width: 150, render: (_, r) => <Tag>{t(`aml.hitStatus.${r.hit.status}`)}</Tag> },
  { title: t('aml.col.reviewedAt'), key: 'reviewedAt', width: 170, render: (_, r) => formatDateTime(r.hit.reviewedAt) },
];

/** Compliance · AML шалгалтын дараалал (docs/05-compliance-aml.md §7 `GET /aml/hits?status=…`). Регистр kyc-ээс масклагдсан ирнэ. */
export function AmlQueueView({ items, total, page, pageSize, tab, loading, error, onPageChange, onTabChange }: AmlQueueViewProps) {
  const columns: ColumnsType<AmlHitQueueItem> = [
    { title: t('aml.col.subject'), key: 'subject', render: (_, r) => r.screening.subjectName },
    { title: t('aml.col.register'), key: 'register', render: (_, r) => <span data-testid="aml-queue-register">{r.screening.registerNoMasked}</span> },
    { title: t('aml.col.list'), key: 'list', render: (_, r) => t(`aml.list.${r.hit.list}`) },
    { title: t('aml.col.entry'), key: 'entry', render: (_, r) => r.hit.entryName },
    { title: t('aml.col.severity'), key: 'severity', width: 120, render: (_, r) => <SeverityTag severity={r.hit.severity} /> },
    { title: t('aml.col.score'), key: 'score', width: 100, align: 'right', render: (_, r) => formatPercent(r.hit.score, 0) },
    { title: t('aml.col.screenedAt'), key: 'screenedAt', width: 170, render: (_, r) => formatDateTime(r.screening.screenedAt) },
    ...(tab === 'OPEN' ? [] : resolvedColumns()),
    { title: t('aml.col.action'), key: 'action', width: 120, render: (_, r) => <Link href={screeningHref(r.screening.id)}>{t(r.hit.status === 'OPEN' ? 'aml.action.open' : 'aml.action.view')}</Link> },
  ];

  return (
    <Flex vertical gap={16}>
      <div>
        <Title level={3} style={{ marginBottom: 4 }}>{t('aml.queue.title')}</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>{t('aml.queue.subtitle')}</Paragraph>
      </div>
      <Tabs activeKey={tab} items={TAB_ITEMS} onChange={(key) => { if (isTab(key)) onTabChange(key); }} aria-label={t('aml.queue.tabs')} />
      {error ? <Alert type="error" showIcon message={describeAmlError(error, 'aml.error.LOAD')} /> : null}
      <Table<AmlHitQueueItem>
        rowKey={(r) => r.hit.id}
        columns={columns}
        dataSource={[...items]}
        loading={loading}
        locale={{ emptyText: t(tab === 'OPEN' ? 'aml.queue.empty' : 'aml.queue.emptyFiltered') }}
        pagination={{ current: page, pageSize, total, showTotal: (n) => t('aml.queue.total', { count: n }), onChange: onPageChange }}
      />
    </Flex>
  );
}
