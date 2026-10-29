'use client';
import { useState } from 'react';
import { App as AntApp, Alert, Button, Empty, Flex, Skeleton, Tag, Tooltip, Typography } from 'antd';
import type { BorrowerView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { AddBorrowerModal } from './AddBorrowerModal';
import { ApiErrorAlert } from './ApiErrorAlert';
import { BorrowerSummaryBar } from './BorrowerSummaryBar';
import { BorrowerWarnings } from './BorrowerWarnings';
import { BorrowersTable } from './BorrowersTable';
import { ConsentModal } from './ConsentModal';
import { EditBorrowerModal } from './EditBorrowerModal';
import { useBorrowerList, useMakePrimary, useRemoveBorrower } from './useBorrowers';
import { describeError } from './borrowers.utils';

interface Props {
  applicationId: string;
  /** Оролцогч өөрчлөгдсөний дараа дуудагдана — wizard-н алхмуудын төлөвийг (client/inquiry/income/score) дахин татахад ашиглана. */
  onChanged?: () => void;
}

/**
 * Wizard-н 1-р алхам "Харилцагч" (`/los/loan-application/:id/client`): үндсэн / хамтран зээлдэгч, батлан даагч, барьцаалагч.
 * FR-2.1, FR-6.5, FR-10.4 (зөвхөн Шинэ/Буцаасан төлөвт засна), BR-9 (анхааруулга хориг биш).
 */
export function BorrowersStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const list = useBorrowerList(applicationId);
  const makePrimary = useMakePrimary(applicationId, onChanged);
  const remove = useRemoveBorrower(applicationId, onChanged);

  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [consentId, setConsentId] = useState<string | null>(null);

  const data = list.data;
  const items: readonly BorrowerView[] = data?.items ?? [];
  const editing = items.find((i) => i.id === editingId) ?? null;
  const consenting = items.find((i) => i.id === consentId) ?? null;

  const showError = (error: unknown) => void message.error({ content: describeError(error, t).message, duration: 6 });

  const handleMakePrimary = (item: BorrowerView) =>
    makePrimary.mutate(
      { borrowerId: item.id },
      { onSuccess: () => void message.success(t('borrower.toast.primaryChanged', { name: item.customer.displayName })), onError: showError },
    );
  const handleRemove = (item: BorrowerView) =>
    remove.mutate({ borrowerId: item.id }, { onSuccess: () => void message.success(t('borrower.toast.removed')), onError: showError });

  const busy = makePrimary.isPending && makePrimary.variables
    ? { id: makePrimary.variables.borrowerId, action: 'makePrimary' as const }
    : remove.isPending && remove.variables
      ? { id: remove.variables.borrowerId, action: 'remove' as const }
      : null;

  const addButton = (label: string) => {
    const editable = data?.summary.editable ?? false;
    const button = (
      <Button type="primary" disabled={!editable} onClick={() => setAddOpen(true)}>{label}</Button>
    );
    return editable ? button : <Tooltip title={t('borrower.gate.notEditable')}><span>{button}</span></Tooltip>;
  };

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('borrower.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('borrower.subtitle')}</Typography.Text>
        </div>
        {data ? (
          <Flex align="center" gap={12}>
            <Tag color={data.summary.clientStepComplete ? 'success' : 'warning'}>
              {data.summary.clientStepComplete ? t('borrower.state.stepComplete') : t('borrower.state.stepIncomplete')}
            </Tag>
            {addButton(t('borrower.action.add'))}
          </Flex>
        ) : null}
      </Flex>

      {list.isPending ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : !data ? (
        <ApiErrorAlert error={list.error} title={t('borrower.state.loadError')} onRetry={() => void list.refetch()} />
      ) : (
        <>
          {/* Дахин татахад алдаа гарвал хуучин өгөгдлийг хэвээр үзүүлж, анхааруулга нэмнэ. */}
          {list.isError ? <ApiErrorAlert error={list.error} title={t('borrower.state.loadError')} onRetry={() => void list.refetch()} /> : null}
          {!data.summary.editable ? <Alert type="info" showIcon message={t('borrower.state.notEditable')} /> : null}
          <BorrowerSummaryBar summary={data.summary} />
          <BorrowerWarnings warnings={data.warnings} items={data.items} />
          {data.items.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Flex vertical>
                  <Typography.Text>{t('borrower.state.empty')}</Typography.Text>
                  <Typography.Text type="secondary">{t('borrower.state.emptyHint')}</Typography.Text>
                </Flex>
              }
            >
              {addButton(t('borrower.action.addPrimary'))}
            </Empty>
          ) : (
            <BorrowersTable
              items={data.items}
              summary={data.summary}
              warnings={data.warnings}
              busy={busy}
              onEdit={(item) => setEditingId(item.id)}
              onConsent={(item) => setConsentId(item.id)}
              onMakePrimary={handleMakePrimary}
              onRemove={handleRemove}
            />
          )}
          <AddBorrowerModal open={addOpen} applicationId={applicationId} items={data.items} summary={data.summary} onClose={() => setAddOpen(false)} onChanged={onChanged} />
          <EditBorrowerModal borrower={editing} applicationId={applicationId} items={data.items} onClose={() => setEditingId(null)} onChanged={onChanged} />
          <ConsentModal borrower={consenting} applicationId={applicationId} onClose={() => setConsentId(null)} onChanged={onChanged} />
        </>
      )}
    </Flex>
  );
}
