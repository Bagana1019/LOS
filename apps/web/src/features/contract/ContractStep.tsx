'use client';
import { Alert, Button, Card, Descriptions, Flex, Skeleton, Tag, Typography, App as AntApp } from 'antd';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { ContractSigningPanel } from '../contract-signing';
import { FileUploadButton } from '../documents/shared/FileUploadButton';
import { downloadDmsFile, uploadDmsFile } from '../documents/shared/files';
import { formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useAttachSigned, useContractDocs, useGenerateContract } from './contract.api';

interface Props { applicationId: string; onChanged?: () => void }

/** Wizard-н "Гэрээ" алхам (`/los/loan-application/:id/contract`): гэрээ үүсгэх (dms загвар → PDF), цахим эсвэл цаасан гарын үсэг (G4). FR-11.1, 11.3, 11.4. */
export function ContractStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const q = useContractDocs(applicationId);
  const generate = useGenerateContract(applicationId, onChanged);
  const attach = useAttachSigned(applicationId, onChanged);
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data.contract;
  const signed = Boolean(c?.signedFileId);
  const fail = (e: unknown) => void message.error(e instanceof Error ? e.message : t('cstep.failed'));
  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>{t('cstep.title')}</Typography.Title>
      <Card size="small">
        <Descriptions size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label={t('cstep.no')}>{c?.contractNo ?? '—'}</Descriptions.Item>
          <Descriptions.Item label={t('cstep.status')}>{signed ? <Tag color="success">{t('cstep.signed')}</Tag> : c?.generatedFileId ? <Tag color="processing">{t('cstep.generated')}</Tag> : <Tag>{t('cstep.notGenerated')}</Tag>}</Descriptions.Item>
          <Descriptions.Item label={t('cstep.channel')}>{c ? t(`cstep.channel.${c.signChannel}`) : '—'}</Descriptions.Item>
          <Descriptions.Item label={t('cstep.signedAt')}>{c?.signedAt ? formatDateTime(c.signedAt) : '—'}</Descriptions.Item>
        </Descriptions>
        <Flex gap={8} wrap style={{ marginTop: 12 }}>
          {signed ? null : <Button type="primary" loading={generate.isPending} data-testid="contract-generate" onClick={() => generate.mutateAsync().then(() => void message.success(t('cstep.generatedOk'))).catch(() => undefined)}>{c?.generatedFileId ? t('cstep.regenerate') : t('cstep.generate')}</Button>}
          {c?.generatedFileId ? <Button onClick={() => void downloadDmsFile(c.generatedFileId as string, `${c.contractNo}.pdf`).catch(fail)}>{t('cstep.download')}</Button> : null}
          {c?.signedFileId ? <Button onClick={() => void downloadDmsFile(c.signedFileId as string, `${c.contractNo}-signed.pdf`).catch(fail)}>{t('cstep.downloadSigned')}</Button> : null}
        </Flex>
        {generate.error ? <div style={{ marginTop: 12 }}><ApiErrorAlert error={generate.error} /></div> : null}
      </Card>
      {c?.generatedFileId && !signed ? (
        <>
          <Card size="small" title={t('cstep.paper')}>
            <Typography.Paragraph type="secondary">{t('cstep.paperHint')}</Typography.Paragraph>
            <FileUploadButton label={t('cstep.upload')} loading={attach.isPending} onFile={(f) => void uploadDmsFile(f).then((file) => attach.mutateAsync(file.id)).then(() => void message.success(t('cstep.attached'))).catch(fail)} />
            {attach.error ? <div style={{ marginTop: 12 }}><ApiErrorAlert error={attach.error} /></div> : null}
          </Card>
          <Card size="small" title={t('cstep.esign')}><ContractSigningPanel applicationId={applicationId} /></Card>
        </>
      ) : null}
      {!c?.generatedFileId ? <Alert type="info" showIcon message={t('cstep.hint')} /> : null}
    </Flex>
  );
}
