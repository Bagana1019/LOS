'use client';
import { App as AntApp, Button, Card, Flex, List, Popconfirm, Tag, Typography } from 'antd';
import type { DocumentChecklistStatus, DocumentView } from '@los/contracts';
import { formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { describeApiError } from './shared/api-error';
import { ApiErrorAlert } from './shared/ApiErrorAlert';
import { downloadDmsFile, formatBytes } from './shared/files';
import { OcrResult } from './OcrResult';
import { isIdCardRow, relatedLabel, type BorrowerOption } from './documents.utils';
import { useOcrCheck } from './useDocuments';

interface ItemProps {
  applicationId: string;
  doc: DocumentView;
  borrowers: readonly BorrowerOption[];
  canEdit: boolean;
  removing: boolean;
  onRemove: (doc: DocumentView) => void;
  /** OCR зөвхөн иргэний үнэмлэхийн (id_card) мөрөнд. */
  ocrEnabled: boolean;
}

/** Нэг файл: нэр (татах), хэмжээ, огноо, холбогдох зээлдэгч; OCR (id_card), хасах. */
function DocumentItem({ applicationId, doc, borrowers, canEdit, removing, onRemove, ocrEnabled }: ItemProps) {
  const { message } = AntApp.useApp();
  const ocr = useOcrCheck(applicationId);
  const related = relatedLabel(doc, borrowers);
  const download = () => downloadDmsFile(doc.fileId, doc.fileName).catch((e: unknown) => void message.error(describeApiError(e, 'document').message));
  return (
    <List.Item
      key={doc.id}
      data-testid="document-item"
      actions={[
        ocrEnabled ? (
          <Button key="ocr" size="small" type="link" loading={ocr.isPending} disabled={!canEdit} onClick={() => ocr.mutate({ documentId: doc.id })} aria-label={`${t('document.action.ocr')}: ${doc.fileName}`}>
            {t('document.action.ocr')}
          </Button>
        ) : null,
        <Popconfirm key="rm" title={t('document.confirm.removeTitle')} description={doc.fileName} okText={t('document.action.remove')} okButtonProps={{ danger: true }} cancelText={t('document.action.cancel')} disabled={!canEdit} onConfirm={() => onRemove(doc)}>
          <Button size="small" type="link" danger loading={removing} disabled={!canEdit} aria-label={`${t('document.action.remove')}: ${doc.fileName}`}>{t('document.action.remove')}</Button>
        </Popconfirm>,
      ].filter(Boolean)}
    >
      <Flex vertical gap={4} style={{ minWidth: 0, flex: 1 }}>
        <Flex gap={8} align="center" wrap>
          <Button type="link" style={{ padding: 0, height: 'auto', textAlign: 'left', whiteSpace: 'normal', wordBreak: 'break-word' }} onClick={() => void download()} aria-label={`${t('document.action.download')}: ${doc.fileName}`}>
            {doc.fileName}
          </Button>
          {related ? <Tag style={{ marginInlineEnd: 0 }}>{related}</Tag> : null}
        </Flex>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatBytes(doc.size)} · {formatDateTime(doc.uploadedAt)}
          {doc.note ? ` · ${doc.note}` : ''}
        </Typography.Text>
        {ocr.data ? <OcrResult check={ocr.data} /> : null}
        {ocr.error ? <ApiErrorAlert error={ocr.error} scope="document" /> : null}
      </Flex>
    </List.Item>
  );
}

interface RowProps extends Omit<ItemProps, 'doc' | 'ocrEnabled' | 'removing'> {
  row: DocumentChecklistStatus;
  onAttach: () => void;
  removingId: string | null;
}

/** Checklist-ийн нэг мөр: нэр, заавал/хангагдсан шошго, хавсаргасан файлууд, «Файл хавсаргах». */
export function DocumentChecklistRow({ row, onAttach, removingId, ...rest }: RowProps) {
  return (
    <Card
      size="small"
      data-testid="checklist-row"
      data-key={row.key}
      title={
        <Flex gap={8} align="center" wrap>
          <Typography.Text strong>{row.name}</Typography.Text>
          <Tag color={row.required ? 'blue' : undefined} style={{ marginInlineEnd: 0 }}>{t(row.required ? 'document.tag.required' : 'document.tag.optional')}</Tag>
          <Tag color={row.satisfied ? 'success' : row.required ? 'warning' : undefined} style={{ marginInlineEnd: 0 }}>{t(row.satisfied ? 'document.tag.satisfied' : 'document.tag.missing')}</Tag>
        </Flex>
      }
      extra={<Button size="small" onClick={onAttach} disabled={!rest.canEdit} aria-label={`${t('document.action.attach')}: ${row.name}`}>{t('document.action.attach')}</Button>}
    >
      {row.documents.length === 0 ? (
        <Typography.Text type="secondary">{t('document.row.noFiles')}</Typography.Text>
      ) : (
        <List size="small" dataSource={row.documents} renderItem={(doc) => <DocumentItem {...rest} doc={doc} removing={removingId === doc.id} ocrEnabled={isIdCardRow(row.key)} />} />
      )}
    </Card>
  );
}

/** Checklist-д ороогүй нэмэлт баримтууд. */
export function ExtraDocumentsCard({ docs, onAttach, removingId, ...rest }: { docs: readonly DocumentView[]; onAttach: () => void; removingId: string | null } & Omit<ItemProps, 'doc' | 'ocrEnabled' | 'removing'>) {
  return (
    <Card
      size="small"
      data-testid="extra-documents"
      title={<Typography.Text strong>{t('document.extra.title')}</Typography.Text>}
      extra={<Button size="small" onClick={onAttach} disabled={!rest.canEdit}>{t('document.action.addExtra')}</Button>}
    >
      {docs.length === 0 ? (
        <Typography.Text type="secondary">{t('document.extra.empty')}</Typography.Text>
      ) : (
        <List size="small" dataSource={[...docs]} renderItem={(doc) => <DocumentItem {...rest} doc={doc} removing={removingId === doc.id} ocrEnabled={false} />} />
      )}
    </Card>
  );
}
