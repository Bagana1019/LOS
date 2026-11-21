'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Card, Flex, Skeleton, Statistic, Table, Tag, Typography, message } from 'antd';
import type { BsaLosBorrowerRow } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { isPaymentMissing, syncPaymentFeedback } from './bsa.feedback';
import { PushConfirmModal } from './PushConfirmModal';
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
  const [confirming, setConfirming] = useState<BsaLosBorrowerRow | null>(null);
  // F6-3: mutation-ий `isPending` асинхрон шинэчлэгддэг тул нэг task дотор ирсэн 2 дахь click-ийг товчны `loading` барьж чаддаггүй — синхрон хамгаалалт.
  const creating = useRef(false);
  if (q.isLoading) return <Skeleton active aria-label={t('bsa.loading')} />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const data = q.data;
  const editable = data.editable;
  // BSA-FR-5.3: татах нь шинжилгээг түгжих тул эхлээд баталгаажуулна.
  const onConfirmPush = () => {
    const analysisId = confirming?.analysisId;
    if (!analysisId) return;
    push.mutate(analysisId, {
      onSuccess: (r) => void api.success(r.reportAttached ? t('bsa.fb.push.ok') : `${t('bsa.fb.push.ok')} ${t('bsa.push.noReport')}`),
      onSettled: () => setConfirming(null),
    });
  };
  const onCreate = (customerId: string) => {
    if (creating.current) return;
    creating.current = true;
    create.mutate({ customerId }, { onSettled: () => { creating.current = false; } });
  };
  // F6-2: `sync-payment` зөвхөн `{ updated }` буцаадаг тул үр дүнг (шинэчлэгдсэн / өөрчлөх зүйлгүй / нөхцөл дутуу) тойм дахь төлбөр, шинжилгээнээс тайлбарлана.
  const paymentMissing = isPaymentMissing(data.proposedMonthlyPayment);
  const onSync = () => sync.mutate(undefined, {
    onSuccess: (r) => {
      const f = syncPaymentFeedback({ updated: r.updated, payment: data.proposedMonthlyPayment, hasAnalysis: data.borrowers.some((b) => b.analysisId !== null) });
      void api[f.type](f.message);
    },
  });

  return (
    <Flex vertical gap={16}>
      {holder}
      <div>
        {/* F6-1: BSA хуудаснаас хүсэлт рүү буцах зам (sidebar-д зөвхөн үндсэн цэс байдаг). */}
        <Link href={`/los/loan-application/${encodeURIComponent(applicationId)}`}>{t('bsa.action.backToApplication')}</Link>
        <Typography.Title level={4} style={{ margin: '4px 0 0' }}>{t('bsa.title')}</Typography.Title>
        <Typography.Text type="secondary">{t('bsa.subtitle')}</Typography.Text>
      </div>
      {!data.available ? <Alert type="warning" showIcon message={t('bsa.unavailable')} /> : null}
      {!editable ? <Alert type="info" showIcon message={t('bsa.notEditable')} /> : null}
      <Flex gap={24} wrap align="center">
        <Statistic title={t('bsa.payment')} value={data.proposedMonthlyPayment === null ? '—' : formatMnt(data.proposedMonthlyPayment)} />
        <Flex vertical gap={4} align="flex-start">
          <Button onClick={onSync} loading={sync.isPending} disabled={!editable || paymentMissing}>{t('bsa.action.syncPayment')}</Button>
          <Typography.Text type="secondary">{paymentMissing ? t('bsa.fb.sync.missingHint') : t('bsa.fb.sync.hint')}</Typography.Text>
        </Flex>
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
                    <Button type="primary" onClick={() => setConfirming(b)} loading={push.isPending} disabled={!editable || !data.available}>{t('bsa.action.push')}</Button>
                  </>
                ) : (
                  <Button type="primary" onClick={() => onCreate(b.customerId)} loading={create.isPending} disabled={!editable || !data.available}>{t('bsa.action.create')}</Button>
                )}
              </Flex>
            ),
          },
        ]}
      />
      <PushConfirmModal
        open={confirming !== null}
        borrowerName={confirming?.displayName ?? ''}
        pending={confirming?.pendingSuspiciousCount ?? null}
        proposedPayment={data.proposedMonthlyPayment}
        dtiPercent={confirming?.dtiPercent ?? null}
        loading={push.isPending}
        onConfirm={onConfirmPush}
        onCancel={() => setConfirming(null)}
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
