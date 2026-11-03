'use client';
import Link from 'next/link';
import { Alert, Button, Card, Flex, Skeleton, Statistic, Table, Tag, Typography, message } from 'antd';
import type { BsaLosBorrowerRow } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useBsaOverview, useCombined, useCreateAnalysis, usePush, useSyncPayment } from './useBsa';

/** M12c: хүсэлтийн BSA тойм (`/los/bsa/:applicationId`) — зээлдэгч бүрийн шинжилгээ, «Системрүү татах» (INT-4), нэгтгэсэн ӨОХ (BSA-BR-9). */
export function BsaOverview({ applicationId }: { applicationId: string }) {
  const q = useBsaOverview(applicationId);
  const create = useCreateAnalysis(applicationId);
  const push = usePush(applicationId);
  const sync = useSyncPayment(applicationId);
  const multi = (q.data?.borrowers.filter((b) => b.analysisId).length ?? 0) > 1;
  const combined = useCombined(applicationId, multi && Boolean(q.data?.available));
  const [api, holder] = message.useMessage();
  if (q.isLoading) return <Skeleton active aria-label={t('bsa.loading')} />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const data = q.data;
  const editable = data.editable;
  const onPush = (analysisId: string) => push.mutate(analysisId, {
    onSuccess: (r) => void api.success(r.reportAttached ? t('bsa.push.ok') : `${t('bsa.push.ok')} ${t('bsa.push.noReport')}`),
  });

  return (
    <Flex vertical gap={16}>
      {holder}
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('bsa.title')}</Typography.Title>
        <Typography.Text type="secondary">{t('bsa.subtitle')}</Typography.Text>
      </div>
      {!data.available ? <Alert type="warning" showIcon message={t('bsa.unavailable')} /> : null}
      {!editable ? <Alert type="info" showIcon message={t('bsa.notEditable')} /> : null}
      <Flex gap={24} wrap align="center">
        <Statistic title={t('bsa.payment')} value={data.proposedMonthlyPayment === null ? '—' : formatMnt(data.proposedMonthlyPayment)} />
        <Button onClick={() => sync.mutate(undefined)} loading={sync.isPending} disabled={!editable}>{t('bsa.action.syncPayment')}</Button>
      </Flex>
      <Table<BsaLosBorrowerRow>
        rowKey="customerId"
        pagination={false}
        dataSource={data.borrowers}
        columns={[
          { title: t('bsa.col.borrower'), dataIndex: 'displayName' },
          { title: t('bsa.col.role'), dataIndex: 'role', render: (r: string) => t(`bsa.role.${r}`) },
          { title: t('bsa.col.status'), dataIndex: 'status', render: (s: string | null) => <Tag color={s === 'ANALYZED' ? 'success' : s ? 'processing' : 'default'}>{t(`bsa.status.${s ?? 'none'}`)}</Tag> },
          { title: t('bsa.col.version'), dataIndex: 'version', render: (v: number | null) => v ?? '—' },
          { title: t('bsa.col.dti'), dataIndex: 'dtiPercent', render: (v: number | null) => (v === null ? '—' : `${v}%`) },
          { title: t('bsa.col.pending'), dataIndex: 'pendingSuspiciousCount', render: (v: number | null) => (v === null ? '—' : v > 0 ? <Tag color="warning">{v}</Tag> : 0) },
          {
            title: t('bsa.col.actions'),
            render: (_: unknown, b) => (
              <Flex gap={8} wrap>
                {b.analysisId ? (
                  <>
                    <Link href={`/los/bsa/${encodeURIComponent(applicationId)}/${encodeURIComponent(b.analysisId)}`}><Button>{t('bsa.action.open')}</Button></Link>
                    <Button type="primary" onClick={() => onPush(b.analysisId as string)} loading={push.isPending} disabled={!editable || !data.available}>{t('bsa.action.push')}</Button>
                  </>
                ) : (
                  <Button type="primary" onClick={() => create.mutate({ customerId: b.customerId })} loading={create.isPending} disabled={!editable || !data.available}>{t('bsa.action.create')}</Button>
                )}
              </Flex>
            ),
          },
        ]}
      />
      {create.error ? <ApiErrorAlert error={create.error} /> : null}
      {push.error ? <ApiErrorAlert error={push.error} /> : null}
      {sync.error ? <ApiErrorAlert error={sync.error} /> : null}
      {combined.data ? (
        <Card title={t('bsa.combined.title')}>
          {!combined.data.allAnalyzed ? <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t('bsa.combined.partial')} /> : null}
          <Flex gap={32} wrap>
            <Statistic title={t('bsa.combined.dtiIncome')} value={formatMnt(combined.data.dtiIncome)} />
            <Statistic title={t('bsa.combined.debt')} value={formatMnt(combined.data.existingDebtServiceMonthly)} />
            <Statistic title={t('bsa.combined.dti')} value={`${combined.data.dtiPercent}%`} />
            <Statistic title={t('bsa.combined.ncf')} value={formatMnt(combined.data.netCashFlowMonthly)} />
          </Flex>
        </Card>
      ) : null}
    </Flex>
  );
}
