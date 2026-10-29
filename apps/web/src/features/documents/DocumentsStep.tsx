'use client';
import { useState } from 'react';
import Link from 'next/link';
import { App as AntApp, Alert, Button, Empty, Flex, Skeleton, Tag, Tooltip, Typography } from 'antd';
import type { DocumentView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { useAuth } from '../../lib/auth/auth-context';
import { useBorrowerList } from '../borrowers';
import { AttachDocumentModal } from './AttachDocumentModal';
import { DocumentChecklistRow, ExtraDocumentsCard } from './DocumentRow';
import { borrowerOptions, summaryState, type AttachTarget } from './documents.utils';
import { canEditContent, canWriteApplication, editBlockedReason } from './shared/access';
import { describeApiError } from './shared/api-error';
import { ApiErrorAlert } from './shared/ApiErrorAlert';
import { useDocumentList, useRemoveDocument } from './useDocuments';

interface Props {
  applicationId: string;
  /** Баримт өөрчлөгдсөний дараа дуудагдана — wizard-н алхмын төлөв (document) дахин татахад. */
  onChanged?: () => void;
}

/**
 * Wizard-н 8-р алхам "Баримт бичиг" (`/los/loan-application/:id/document`): бүтээгдэхүүний checklist (FR-9.2) + нэмэлт баримт (FR-9.1).
 * Заавал баримт бүрт ≥ 1 файл байвал алхам бүрдэнэ. Хүсэлтийн төлөв жагсаалтын хариунд байхгүй тул засах эсэхийг оролцогчдын жагсаалтаас (`summary.editable`),
 * эцэст нь API-ийн 409 `APPLICATION_NOT_EDITABLE` мессежээс авна.
 */
export function DocumentsStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const { me } = useAuth();
  const list = useDocumentList(applicationId);
  const borrowerList = useBorrowerList(applicationId);
  const remove = useRemoveDocument(applicationId, onChanged);
  const [target, setTarget] = useState<AttachTarget | null>(null);

  const write = { canWrite: canWriteApplication(me?.user.roles), editable: borrowerList.data?.summary.editable };
  const canEdit = canEditContent(write);
  const blocked = editBlockedReason(write);
  const blockedText = blocked === 'role' ? t('document.gate.readOnlyRole') : blocked === 'status' ? t('document.gate.notEditable') : undefined;
  const borrowers = borrowerOptions(borrowerList.data?.items ?? []);
  const data = list.data;
  const removingId = remove.isPending ? remove.variables?.documentId ?? null : null;

  const handleRemove = (doc: DocumentView) =>
    remove.mutate(
      { documentId: doc.id },
      {
        onSuccess: () => void message.success(t('document.toast.removed')),
        onError: (error) => void message.error({ content: describeApiError(error, 'document').message, duration: 6 }),
      },
    );

  const rowProps = { applicationId, borrowers, canEdit, onRemove: handleRemove, removingId };
  const nameOf = (key: string): string => data?.checklist.find((r) => r.key === key)?.name ?? key;
  const state = data ? summaryState(data.summary) : null;
  const addExtra = (
    <Tooltip title={blockedText}>
      <span><Button disabled={!canEdit} onClick={() => setTarget({ kind: 'extra' })}>{t('document.action.addExtra')}</Button></span>
    </Tooltip>
  );

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('document.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('document.subtitle')}</Typography.Text>
        </div>
        {data ? (
          <Flex align="center" gap={12} wrap>
            <Tag color={data.summary.complete && !data.summary.productMissing ? 'success' : 'warning'} role="status" data-testid="document-step-state">
              {t(data.summary.complete && !data.summary.productMissing ? 'document.state.stepComplete' : 'document.state.stepIncomplete')}
            </Tag>
            {addExtra}
          </Flex>
        ) : null}
      </Flex>

      {list.isPending ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : !data ? (
        <ApiErrorAlert error={list.error} scope="document" title={t('document.state.loadError')} onRetry={() => void list.refetch()} />
      ) : (
        <>
          {list.isError ? <ApiErrorAlert error={list.error} scope="document" title={t('document.state.loadError')} onRetry={() => void list.refetch()} /> : null}
          {borrowerList.data?.summary.editable === false ? <Alert type="info" showIcon message={t('document.state.notEditable')} /> : null}

          {state === 'productMissing' ? (
            <Alert type="warning" showIcon message={t('document.summary.productMissing')} description={<Link href={`/los/loan-application/${encodeURIComponent(applicationId)}/loan`}>{t('document.summary.goLoan')}</Link>} />
          ) : (
            <Alert
              type={state === 'incomplete' ? 'warning' : 'success'}
              showIcon
              data-testid="document-summary"
              message={<span data-testid="document-progress">{t('document.summary.progress', { satisfied: data.summary.satisfied, required: data.summary.required })}</span>}
              description={
                state === 'incomplete' ? t('document.summary.missing', { names: data.summary.missing.map(nameOf).join(', ') }) : state === 'noRequired' ? t('document.summary.noRequired') : t('document.summary.complete')
              }
            />
          )}

          {data.checklist.length === 0 && state !== 'productMissing' ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('document.state.emptyChecklist')} />
          ) : (
            <Flex vertical gap={12} role="list" aria-label={t('document.checklistLabel')}>
              {data.checklist.map((row) => (
                <div role="listitem" key={row.key}>
                  <DocumentChecklistRow row={row} {...rowProps} onAttach={() => setTarget({ kind: 'checklist', key: row.key, name: row.name })} />
                </div>
              ))}
            </Flex>
          )}
          <ExtraDocumentsCard docs={data.extras} {...rowProps} onAttach={() => setTarget({ kind: 'extra' })} />
          {remove.error ? <ApiErrorAlert error={remove.error} scope="document" /> : null}
          {blockedText && !canEdit ? <Typography.Text type="secondary">{blockedText}</Typography.Text> : null}
          <AttachDocumentModal target={target} applicationId={applicationId} borrowers={borrowers} onClose={() => setTarget(null)} onChanged={onChanged} />
        </>
      )}
    </Flex>
  );
}

