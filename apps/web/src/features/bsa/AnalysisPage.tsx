'use client';
import Link from 'next/link';
import { Alert, Button, Card, Flex, Skeleton, Tabs, Typography } from 'antd';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { t } from '../../lib/i18n';
import { downloadIncomeSample, downloadReport } from './bsa.api';
import { StatementsTab } from './StatementsTab';
import { SuspicionsTab } from './SuspicionsTab';
import { useAnalysis } from './useBsa';

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
      {!draft ? <Alert type="info" showIcon message={t('bsa.locked.title')} description={t('bsa.locked.body')} /> : null}
      <Tabs
        items={[
          { key: 'statements', label: t('bsa.tab.statements'), children: <StatementsTab applicationId={applicationId} analysisId={analysisId} draft={draft} /> },
          { key: 'suspicions', label: t('bsa.tab.suspicions'), children: <SuspicionsTab applicationId={applicationId} analysisId={analysisId} draft={draft} /> },
          { key: 'report', label: t('bsa.tab.report'), children: <Report analysisId={analysisId} analyzed={!draft} /> },
        ]}
      />
    </Flex>
  );
}

function Report({ analysisId, analyzed }: { analysisId: string; analyzed: boolean }) {
  return (
    <Card title={t('bsa.report.title')}>
      <Flex gap={8} wrap align="center">
        <Button onClick={() => void downloadReport(analysisId)}>{t('bsa.report.pdf')}</Button>
        <Button onClick={() => void downloadIncomeSample(analysisId)}>{t('bsa.report.xlsx')}</Button>
        {!analyzed ? <Typography.Text type="secondary">{t('bsa.report.draftHint')}</Typography.Text> : null}
      </Flex>
    </Card>
  );
}
