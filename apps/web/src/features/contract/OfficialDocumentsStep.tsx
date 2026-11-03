'use client';
import { Alert, Button, Card, Empty, Flex, List, Skeleton, Tag, Typography, App as AntApp } from 'antd';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { downloadDmsFile } from '../documents/shared/files';
import { formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useContractDocs, useCreateLetter, usePrintLetter } from './contract.api';

interface Props { applicationId: string; onChanged?: () => void }

/** Wizard-н "Албан бичиг" алхам (`/los/loan-application/:id/official_documents`): албан бичиг үүсгэх, татах, хэвлэсэнд тэмдэглэх. FR-11.3. */
export function OfficialDocumentsStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const q = useContractDocs(applicationId);
  const create = useCreateLetter(applicationId, onChanged);
  const print = usePrintLetter(applicationId, onChanged);
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const letters = q.data.letters;
  const fail = (e: unknown) => void message.error(e instanceof Error ? e.message : t('cstep.failed'));
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('letters.title')}</Typography.Title>
        <Button type="primary" loading={create.isPending} data-testid="letter-create" onClick={() => create.mutateAsync({ extra: {} }).then(() => void message.success(t('letters.created'))).catch(() => undefined)}>{t('letters.create')}</Button>
      </Flex>
      {!q.data.contract ? <Alert type="info" showIcon message={t('letters.hint')} /> : null}
      {create.error || print.error ? <ApiErrorAlert error={create.error ?? print.error} /> : null}
      <Card size="small">
        {letters.length === 0 ? <Empty description={t('letters.empty')} /> : (
          <List dataSource={letters} renderItem={(l, i) => (
            <List.Item actions={[
              l.generatedFileId ? <Button key="d" size="small" onClick={() => void downloadDmsFile(l.generatedFileId as string, `letter-${i + 1}.pdf`).catch(fail)}>{t('cstep.download')}</Button> : null,
              l.printedAt ? null : <Button key="p" size="small" loading={print.isPending} onClick={() => print.mutate(l.id)}>{t('letters.markPrinted')}</Button>,
            ].filter(Boolean)}>
              <span>№{i + 1} · {formatDateTime(l.createdAt)} {l.printedAt ? <Tag color="success">{t('letters.printed')}</Tag> : <Tag>{t('letters.notPrinted')}</Tag>}</span>
            </List.Item>
          )} />
        )}
      </Card>
    </Flex>
  );
}
