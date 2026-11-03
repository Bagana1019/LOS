'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Card, Flex, Input, Select, Skeleton, Statistic, Table, Tabs, Tag, Typography, Upload } from 'antd';
import { ReviewStatus, SuspicionFlag, type BsaSuspicionView } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { downloadIncomeSample, downloadReport } from './bsa.api';
import { useAnalysis, useJobs, useRecalculate, useResolve, useSuspicions, useUpload } from './useBsa';

interface Props { applicationId: string; analysisId: string }

/** M12c: нэг шинжилгээний хуудас — хуулга/хураангуй, 8 дохионы шалгалт (нэг/бөөнөөр шийдвэрлэх), тайлан татах. */
export function AnalysisPage({ applicationId, analysisId }: Props) {
  const q = useAnalysis(analysisId);
  if (q.isLoading) return <Skeleton active aria-label={t('bsa.loading')} />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const draft = q.data.status === 'DRAFT';
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('bsa.title')} · v{q.data.version}</Typography.Title>
        <Link href={`/los/bsa/${encodeURIComponent(applicationId)}`}><Button>{t('bsa.action.back')}</Button></Link>
      </Flex>
      <Tabs
        items={[
          { key: 'statements', label: t('bsa.tab.statements'), children: <Statements applicationId={applicationId} analysisId={analysisId} draft={draft} /> },
          { key: 'suspicions', label: t('bsa.tab.suspicions'), children: <Suspicions applicationId={applicationId} analysisId={analysisId} draft={draft} /> },
          { key: 'report', label: t('bsa.tab.report'), children: <Report analysisId={analysisId} analyzed={!draft} /> },
        ]}
      />
    </Flex>
  );
}

function Statements({ applicationId, analysisId, draft }: Props & { draft: boolean }) {
  const analysis = useAnalysis(analysisId);
  const jobs = useJobs(analysisId);
  const upload = useUpload(applicationId, analysisId);
  const recalc = useRecalculate(applicationId, analysisId);
  const s = analysis.data?.summary ?? null;
  return (
    <Flex vertical gap={16}>
      <Card title={t('bsa.upload.title')}>
        <Flex gap={12} align="center" wrap>
          <Upload multiple showUploadList={false} disabled={!draft} beforeUpload={() => false} onChange={(info) => { if (info.fileList.length && info.file === info.fileList[info.fileList.length - 1]) upload.mutate(info.fileList.map((f) => f.originFileObj as File).filter(Boolean)); }}>
            <Button type="primary" loading={upload.isPending} disabled={!draft}>{t('bsa.action.upload')}</Button>
          </Upload>
          <Button onClick={() => recalc.mutate(undefined)} loading={recalc.isPending} disabled={!draft}>{t('bsa.action.recalculate')}</Button>
          <Typography.Text type="secondary">{t('bsa.upload.hint')}</Typography.Text>
        </Flex>
        {upload.error ? <ApiErrorAlert error={upload.error} /> : null}
        {recalc.error ? <ApiErrorAlert error={recalc.error} /> : null}
      </Card>
      <Card title={t('bsa.summary.title')}>
        {s ? (
          <Flex gap={32} wrap>
            <Statistic title={t('bsa.summary.dtiIncome')} value={formatMnt(s.dtiIncome)} />
            <Statistic title={t('bsa.summary.debt')} value={formatMnt(s.existingDebtServiceMonthly)} />
            <Statistic title={t('bsa.summary.dtiPercent')} value={s.dtiPercent === null ? '—' : `${s.dtiPercent}%`} />
            <Statistic title={t('bsa.summary.ncf')} value={formatMnt(s.netCashFlowMonthly)} />
          </Flex>
        ) : <Typography.Text type="secondary">{t('bsa.summary.empty')}</Typography.Text>}
      </Card>
      <Card title={t('bsa.jobs.title')}>
        <Table rowKey="id" size="small" pagination={false} loading={jobs.isLoading} dataSource={jobs.data?.items ?? []}
          columns={[{ title: '#', render: (_: unknown, __, i) => i + 1, width: 48 }, { title: t('bsa.col.status'), dataIndex: 'status', render: (v: string) => <Tag>{v}</Tag> }]} />
      </Card>
    </Flex>
  );
}

function Suspicions({ applicationId, analysisId, draft }: Props & { draft: boolean }) {
  const [status, setStatus] = useState<ReviewStatus | undefined>('PENDING');
  const [flag, setFlag] = useState<SuspicionFlag | undefined>();
  const [selected, setSelected] = useState<string[]>([]);
  const [category, setCategory] = useState('');
  const [comment, setComment] = useState('');
  const q = useSuspicions(analysisId, { status, flag });
  const resolve = useResolve(applicationId, analysisId);
  const act = (action: 'APPROVE' | 'EXCLUDE' | 'RECLASSIFY') =>
    resolve.mutate({ ids: selected, action, ...(action === 'RECLASSIFY' ? { categoryCode: category.trim() } : {}), ...(comment.trim() ? { comment: comment.trim() } : {}) }, { onSuccess: () => setSelected([]) });
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const counts = q.data.counts;
  return (
    <Flex vertical gap={16}>
      <Typography.Title level={5} style={{ margin: 0 }}>{t('bsa.susp.title')}</Typography.Title>
      {counts.pending > 0 ? <Alert type="warning" showIcon message={t('bsa.susp.pendingBlock')} /> : null}
      <Flex gap={8} wrap>
        {SuspicionFlag.map((f) => (
          <Tag.CheckableTag key={f} checked={flag === f} onChange={(on) => setFlag(on ? f : undefined)}>
            {t(`bsa.flag.${f}`)}: {counts.byFlag[f]?.pending ?? 0}/{counts.byFlag[f]?.total ?? 0}
          </Tag.CheckableTag>
        ))}
      </Flex>
      <Flex gap={8} align="center" wrap>
        <Typography.Text>{t('bsa.susp.filter.status')}</Typography.Text>
        <Select allowClear value={status} onChange={(v) => setStatus(v)} style={{ width: 180 }} options={ReviewStatus.map((s) => ({ value: s, label: t(`bsa.susp.status.${s}`) }))} />
      </Flex>
      <Table<BsaSuspicionView>
        rowKey="id"
        size="small"
        locale={{ emptyText: t('bsa.susp.none') }}
        dataSource={q.data.items}
        pagination={false}
        rowSelection={draft ? { selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]), getCheckboxProps: (r) => ({ disabled: r.status === 'RESOLVED' }) } : undefined}
        columns={[
          { title: t('bsa.susp.col.flag'), dataIndex: 'flag', render: (f: string) => t(`bsa.flag.${f}`) },
          { title: t('bsa.susp.col.date'), dataIndex: 'firstDate' },
          { title: t('bsa.susp.col.amount'), dataIndex: 'totalAmount', render: (v: number) => formatMnt(v) },
          { title: t('bsa.susp.col.txns'), render: (_: unknown, r) => r.transactions.length },
          { title: t('bsa.susp.col.status'), render: (_: unknown, r) => (r.status === 'RESOLVED' ? <Tag color="success">{r.action ? t(`bsa.susp.action.${r.action}`) : t('bsa.susp.status.RESOLVED')}</Tag> : <Tag color="warning">{t('bsa.susp.status.PENDING')}</Tag>) },
        ]}
        expandable={{
          expandedRowRender: (r) => (
            <Table size="small" rowKey="id" pagination={false} dataSource={r.transactions}
              columns={[{ title: t('bsa.susp.col.date'), dataIndex: 'txnDate' }, { title: t('bsa.susp.col.amount'), dataIndex: 'amount', render: (v: number) => formatMnt(v) }, { title: '·', dataIndex: 'description' }]} />
          ),
        }}
      />
      {draft && selected.length ? (
        <Card size="small" title={t('bsa.susp.bulk', { count: selected.length })}>
          <Flex gap={8} wrap align="center">
            <Input placeholder={t('bsa.susp.comment')} value={comment} onChange={(e) => setComment(e.target.value)} style={{ width: 240 }} maxLength={1000} />
            <Button onClick={() => act('APPROVE')} loading={resolve.isPending}>{t('bsa.susp.approve')}</Button>
            <Button danger onClick={() => act('EXCLUDE')} loading={resolve.isPending}>{t('bsa.susp.exclude')}</Button>
            <Input placeholder={t('bsa.susp.category')} value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 200 }} maxLength={64} />
            <Button onClick={() => act('RECLASSIFY')} disabled={!category.trim()} loading={resolve.isPending}>{t('bsa.susp.reclassify')}</Button>
          </Flex>
        </Card>
      ) : null}
      {resolve.error ? <ApiErrorAlert error={resolve.error} /> : null}
    </Flex>
  );
}

function Report({ analysisId, analyzed }: { analysisId: string; analyzed: boolean }) {
  return (
    <Card title={t('bsa.report.title')}>
      <Flex gap={8} wrap align="center">
        <Button onClick={() => void downloadReport(analysisId)}>{t('bsa.report.pdf')}</Button>
        <Button onClick={() => void downloadIncomeSample(analysisId)}>{t('bsa.report.xlsx')}</Button>
        {!analyzed ? <Typography.Text type="secondary">{t('bsa.report.combined')}</Typography.Text> : null}
      </Flex>
    </Card>
  );
}
