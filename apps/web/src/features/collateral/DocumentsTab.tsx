'use client';
import { useState } from 'react';
import { App as AntApp, Button, Card, Flex, List, Popconfirm, Tag, Typography } from 'antd';
import { COLLATERAL_OTHER_DOC_KEY, type CollateralDocumentView } from '@los/contracts';
import { EMPTY_VALUE, formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { describeApiError } from '../documents/shared/api-error';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { FileUploadButton } from '../documents/shared/FileUploadButton';
import { downloadDmsFile, formatBytes, uploadDmsFile } from '../documents/shared/files';
import type { TabProps } from './TabProps';
import { useAttachCollateralDocument, useDetachCollateralDocument } from './useCollateral';
import { contentGate } from './write-gates';

/**
 * FR-6.7: хөрөнгийн төрлөөр баримтын checklist (бүтээгдэхүүний `collateral_checklist_json`). Мөр бүр: нэр, заавал/хангагдсан, файлууд.
 * Файлыг эхлээд dms-д байршуулж (`POST /dms/files`), дараа нь барьцаанд checklist түлхүүрээр холбоно.
 */
export function DocumentsTab({ applicationId, item, write, onChanged }: TabProps) {
  const { message } = AntApp.useApp();
  const attach = useAttachCollateralDocument(applicationId, onChanged);
  const detach = useDetachCollateralDocument(applicationId, onChanged);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const gate = contentGate(write);

  const upload = async (key: string, file: File) => {
    setBusyKey(key);
    setError(null);
    try {
      const stored = await uploadDmsFile(file);
      await attach.mutateAsync({ collateralId: item.id, body: { checklistKey: key, fileId: stored.id } });
      void message.success(t('collateral.toast.documentAttached'));
    } catch (e) {
      setError(e);
    } finally {
      setBusyKey(null);
    }
  };
  const remove = async (doc: CollateralDocumentView) => {
    setBusyKey(`remove:${doc.id}`);
    setError(null);
    try {
      await detach.mutateAsync({ collateralId: item.id, documentId: doc.id });
      void message.success(t('collateral.toast.documentRemoved'));
    } catch (e) {
      setError(e);
    } finally {
      setBusyKey(null);
    }
  };
  const download = (doc: CollateralDocumentView) =>
    downloadDmsFile(doc.fileId, doc.fileName ?? t('collateral.documents.fileFallback')).catch((e: unknown) => void message.error(describeApiError(e, 'collateral').message));

  const renderDocs = (docs: readonly CollateralDocumentView[]) =>
    docs.length === 0 ? (
      <Typography.Text type="secondary">{t('collateral.documents.noFiles')}</Typography.Text>
    ) : (
      <List
        size="small"
        dataSource={[...docs]}
        renderItem={(doc) => (
          <List.Item
            key={doc.id}
            actions={[
              <Popconfirm key="rm" title={t('collateral.documents.removeConfirm')} okText={t('collateral.action.remove')} okButtonProps={{ danger: true }} cancelText={t('collateral.action.cancel')} onConfirm={() => void remove(doc)} disabled={gate.disabled}>
                <Button size="small" type="link" danger loading={busyKey === `remove:${doc.id}`} disabled={gate.disabled} aria-label={`${t('collateral.action.remove')}: ${doc.fileName ?? doc.fileId}`}>{t('collateral.action.remove')}</Button>
              </Popconfirm>,
            ]}
          >
            <Flex vertical gap={0} style={{ minWidth: 0 }}>
              <Button type="link" style={{ padding: 0, height: 'auto', textAlign: 'left', whiteSpace: 'normal' }} onClick={() => void download(doc)} aria-label={`${t('collateral.documents.download')}: ${doc.fileName ?? doc.fileId}`}>
                {doc.fileName ?? EMPTY_VALUE}
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatBytes(doc.size)} · {formatDateTime(doc.uploadedAt)}
                {doc.note ? ` · ${doc.note}` : ''}
              </Typography.Text>
            </Flex>
          </List.Item>
        )}
      />
    );

  return (
    <Flex vertical gap={12}>
      <Typography.Text type="secondary">{t('collateral.documents.intro')}</Typography.Text>
      {item.checklist.length === 0 ? <Typography.Text type="secondary">{t('collateral.documents.noChecklist')}</Typography.Text> : null}
      {item.checklist.map((row) => (
        <Card
          key={row.key}
          size="small"
          data-testid="collateral-checklist-row"
          data-key={row.key}
          title={
            <Flex gap={8} align="center" wrap>
              <Typography.Text strong>{row.label}</Typography.Text>
              <Tag color={row.required ? 'blue' : undefined} style={{ marginInlineEnd: 0 }}>{t(row.required ? 'collateral.documents.required' : 'collateral.documents.optional')}</Tag>
              <Tag color={row.satisfied ? 'success' : row.required ? 'warning' : undefined} style={{ marginInlineEnd: 0 }}>{t(row.satisfied ? 'collateral.documents.satisfied' : 'collateral.documents.missing')}</Tag>
            </Flex>
          }
          extra={<FileUploadButton size="small" label={t('collateral.documents.upload')} ariaLabel={`${t('collateral.documents.upload')}: ${row.label}`} loading={busyKey === row.key} disabled={gate.disabled || (busyKey !== null && busyKey !== row.key)} onFile={(f) => void upload(row.key, f)} />}
        >
          {renderDocs(row.documents)}
        </Card>
      ))}
      <Card
        size="small"
        data-testid="collateral-extra-docs"
        title={<Typography.Text strong>{t('collateral.documents.extraTitle')}</Typography.Text>}
        extra={<FileUploadButton size="small" label={t('collateral.documents.upload')} ariaLabel={`${t('collateral.documents.upload')}: ${t('collateral.documents.extraTitle')}`} loading={busyKey === COLLATERAL_OTHER_DOC_KEY} disabled={gate.disabled || (busyKey !== null && busyKey !== COLLATERAL_OTHER_DOC_KEY)} onFile={(f) => void upload(COLLATERAL_OTHER_DOC_KEY, f)} />}
      >
        {renderDocs(item.extraDocuments)}
      </Card>
      {gate.disabled && gate.text ? <Typography.Text type="secondary">{gate.text}</Typography.Text> : null}
      <ApiErrorAlert error={error} scope="collateral" />
    </Flex>
  );
}
