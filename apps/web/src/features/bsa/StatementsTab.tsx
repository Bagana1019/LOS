'use client';
import { useState } from 'react';
import { Button, Card, Flex, Select, Statistic, Table, Tag, Tooltip, Typography, Upload, type TableColumnsType } from 'antd';
import type { BankCode } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { BsaJobBrief } from './bsa.api';
import { bankOptions } from './bsa.helpers';
import { SummaryInsights } from './SummaryInsights';
import { useAnalysis, useJobs, useRecalculate, useRetryJob, useUpload } from './useBsa';

interface Props { applicationId: string; analysisId: string; draft: boolean }

const withHint = (label: string, hint: string) => <Tooltip title={hint}><span>{label}</span></Tooltip>;

/** «Хуулга ба хураангуй» таб: хуулга оруулах (банк сонгох боломжтой), импортын ажлууд (амжилтгүйг банк сонгож дахин оруулах), хураангуй ба анхааруулга/аргачлал. */
export function StatementsTab({ applicationId, analysisId, draft }: Props) {
  const analysis = useAnalysis(analysisId);
  const jobs = useJobs(analysisId);
  const upload = useUpload(applicationId, analysisId);
  const recalc = useRecalculate(applicationId, analysisId);
  const retry = useRetryJob(applicationId, analysisId);
  const [bank, setBank] = useState<BankCode | undefined>();
  const a = analysis.data;
  const s = a?.summary ?? null;

  const columns: TableColumnsType<BsaJobBrief> = [
    { title: '#', render: (_: unknown, __: BsaJobBrief, i: number) => i + 1, width: 48 },
    { title: t('bsa.col.file'), dataIndex: 'fileName' },
    { title: t('bsa.col.bank'), dataIndex: 'bankCode', render: (c: string | null | undefined) => (c ? t(`bsa.bank.${c}`) : <Typography.Text type="secondary">{t('bsa.jobs.noBank')}</Typography.Text>) },
    { title: t('bsa.col.status'), dataIndex: 'status', render: (v: string) => <Tag color={v === 'FAILED' ? 'error' : undefined}>{v}</Tag> },
    { title: t('bsa.col.error'), render: (_: unknown, j: BsaJobBrief) => j.errors?.[0]?.message ?? '' },
    ...(draft
      ? [{
          title: t('bsa.col.actions'),
          render: (_: unknown, j: BsaJobBrief) => (j.status === 'FAILED'
            ? <RetryJob job={j} loading={retry.isPending && retry.variables?.jobId === j.id} onRetry={(b) => retry.mutate({ jobId: j.id, ...(b ? { bankCode: b } : {}) })} />
            : null),
        }]
      : []),
  ];

  return (
    <Flex vertical gap={16}>
      <Card title={t('bsa.upload.title')}>
        <Flex gap={12} align="center" wrap>
          <Select<BankCode>
            id="bsa-upload-bank"
            aria-label={t('bsa.upload.bank')}
            allowClear
            placeholder={t('bsa.upload.bankPlaceholder')}
            value={bank}
            onChange={setBank}
            options={bankOptions()}
            disabled={!draft}
            style={{ width: 240 }}
          />
          <Upload multiple showUploadList={false} fileList={[]} disabled={!draft} beforeUpload={(file, batch) => { if (file === batch[0]) upload.mutate({ files: batch as File[], ...(bank ? { bank } : {}) }); return false; }}>
            <Button type="primary" loading={upload.isPending} disabled={!draft}>{t('bsa.action.upload')}</Button>
          </Upload>
          <Button onClick={() => recalc.mutate(undefined)} loading={recalc.isPending} disabled={!draft}>{t('bsa.action.recalculate')}</Button>
        </Flex>
        <Flex vertical gap={4} style={{ marginTop: 8 }}>
          <Typography.Text type="secondary">{t('bsa.upload.hint')}</Typography.Text>
          <Typography.Text type="secondary">{t('bsa.upload.bankHint')}</Typography.Text>
        </Flex>
        {upload.error ? <ApiErrorAlert error={upload.error} /> : null}
        {recalc.error ? <ApiErrorAlert error={recalc.error} /> : null}
      </Card>
      <Card title={t('bsa.summary.title')}>
        {s ? (
          <Flex vertical gap={16}>
            <Flex gap={32} wrap>
              <Statistic title={withHint(t('bsa.summary.dtiIncome'), t('bsa.hint.dtiIncome'))} value={formatMnt(s.dtiIncome)} />
              <Statistic title={withHint(t('bsa.summary.debt'), t('bsa.hint.debt'))} value={formatMnt(s.existingDebtServiceMonthly)} />
              <Statistic title={withHint(t('bsa.summary.dtiPercent'), t('bsa.hint.dtiPercent'))} value={s.dtiPercent === null ? '—' : `${s.dtiPercent}%`} />
              <Statistic title={withHint(t('bsa.summary.ncf'), t('bsa.hint.ncf'))} value={formatMnt(s.netCashFlowMonthly)} />
            </Flex>
            <SummaryInsights details={a?.details ?? null} warnings={a?.warnings ?? []} stale={a?.summaryStale ?? false} />
          </Flex>
        ) : <Typography.Text type="secondary">{t('bsa.summary.empty')}</Typography.Text>}
      </Card>
      <Card title={t('bsa.jobs.title')}>
        <Table<BsaJobBrief> rowKey="id" size="small" pagination={false} loading={jobs.isLoading} dataSource={jobs.data?.items ?? []} columns={columns} />
        {retry.error ? <ApiErrorAlert error={retry.error} /> : null}
      </Card>
    </Flex>
  );
}

/** Амжилтгүй ажил: банкийг гараар сонгоод (эсвэл сонгохгүй автоматаар) дахин оруулна — BSA-FR-2.6. */
function RetryJob({ job, loading, onRetry }: { job: BsaJobBrief; loading: boolean; onRetry: (bank?: BankCode) => void }) {
  const [bank, setBank] = useState<BankCode | undefined>();
  return (
    <Flex gap={8} wrap align="center">
      <Select<BankCode> id={`bsa-retry-bank-${job.id}`} aria-label={t('bsa.jobs.retryBank')} size="small" allowClear placeholder={t('bsa.jobs.retryBank')} value={bank} onChange={setBank} options={bankOptions()} style={{ width: 200 }} />
      <Tooltip title={t('bsa.jobs.retryHint')}>
        <Button size="small" onClick={() => onRetry(bank)} loading={loading}>{t('bsa.jobs.retry')}</Button>
      </Tooltip>
    </Flex>
  );
}
