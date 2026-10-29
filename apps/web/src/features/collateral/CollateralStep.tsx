'use client';
import { useState } from 'react';
import { App as AntApp, Alert, Button, Empty, Flex, Skeleton, Tag, Tooltip, Typography } from 'antd';
import { t } from '../../lib/i18n';
import { useAuth } from '../../lib/auth/auth-context';
import { useBorrowerList } from '../borrowers';
import { canWriteApplication, type WriteState } from '../documents/shared/access';
import { describeApiError } from '../documents/shared/api-error';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { CollateralCard } from './CollateralCard';
import { CollateralDetailDrawer } from './CollateralDetailDrawer';
import { CollateralFormModal } from './CollateralFormModal';
import { CollateralSummaryBar } from './CollateralSummaryBar';
import { GateIssueList } from './GateIssueList';
import { describeCollateral } from './collateral.fields';
import { ownerOptions, type DetailTab } from './collateral.utils';
import { useCollateralList, useRecheckCollaterals, useRemoveCollateral } from './useCollateral';
import { contentGate } from './write-gates';

interface Props {
  applicationId: string;
  /** Барьцаа өөрчлөгдсөний дараа дуудагдана — wizard-н алхмуудын төлөвийг (collateral/score) дахин татахад ашиглана. */
  onChanged?: () => void;
}

type FormState = { mode: 'create' } | { mode: 'edit'; id: string } | null;

/**
 * Wizard-н 5-р алхам "Барьцаа" (`/los/loan-application/:id/collateral`): барьцааны жагсаалт, LTV, G0 хаалт (FR-6, FR-14, G0).
 * Тооцоолол (LTV, haircut, G0) бүгд API-аас; хүсэлтийн төлөв (засах эсэх) оролцогчдын жагсаалтаас (`summary.editable`) — тодорхойгүй бол сервер 409-өөр шийднэ.
 */
export function CollateralStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const { me } = useAuth();
  const list = useCollateralList(applicationId);
  const borrowers = useBorrowerList(applicationId);
  const remove = useRemoveCollateral(applicationId, onChanged);
  const recheck = useRecheckCollaterals(applicationId, onChanged);

  const [formState, setFormState] = useState<FormState>(null);
  const [detail, setDetail] = useState<{ id: string; tab: DetailTab } | null>(null);

  const write: WriteState = { canWrite: canWriteApplication(me?.user.roles), editable: borrowers.data?.summary.editable };
  const gate = contentGate(write);
  const data = list.data;
  const items = data?.items ?? [];
  const owners = ownerOptions(borrowers.data?.items ?? []);
  const detailItem = detail ? items.find((i) => i.id === detail.id) ?? null : null;
  const editingItem = formState?.mode === 'edit' ? items.find((i) => i.id === formState.id) ?? null : null;

  const handleRemove = (id: string) => {
    const target = items.find((i) => i.id === id);
    remove.mutate(
      { collateralId: id },
      {
        onSuccess: () => {
          void message.success(t('collateral.toast.removed', { name: target ? describeCollateral(target.assetType, target.description) : '' }));
          setDetail((d) => (d?.id === id ? null : d));
        },
        onError: (error) => void message.error({ content: describeApiError(error, 'collateral').message, duration: 6 }),
      },
    );
  };

  const addButton = (label: string) => {
    const button = <Button type="primary" disabled={gate.disabled} onClick={() => setFormState({ mode: 'create' })}>{label}</Button>;
    return gate.disabled ? <Tooltip title={gate.text}><span>{button}</span></Tooltip> : button;
  };
  const removing = remove.isPending ? remove.variables?.collateralId ?? null : null;

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('collateral.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('collateral.subtitle')}</Typography.Text>
        </div>
        {data ? (
          <Flex align="center" gap={12} wrap>
            <Tag color={data.gate.skipped ? 'processing' : data.gate.complete ? 'success' : 'warning'} role="status">
              {data.gate.skipped ? t('collateral.state.stepSkipped') : data.gate.complete ? t('collateral.state.stepComplete') : t('collateral.state.stepIncomplete')}
            </Tag>
            <Tooltip title={write.canWrite ? t('collateral.action.recheckHint') : t('collateral.gate.readOnlyRole')}>
              <span>
                <Button onClick={() => recheck.mutate(undefined, { onError: (error) => void message.error({ content: describeApiError(error, 'collateral').message, duration: 6 }) })} loading={recheck.isPending} disabled={!write.canWrite}>
                  {t('collateral.action.recheck')}
                </Button>
              </span>
            </Tooltip>
            {addButton(t('collateral.action.add'))}
          </Flex>
        ) : null}
      </Flex>

      {list.isPending ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : !data ? (
        <ApiErrorAlert error={list.error} scope="collateral" title={t('collateral.state.loadError')} onRetry={() => void list.refetch()} />
      ) : (
        <>
          {/* Дахин татахад алдаа гарвал хуучин өгөгдлийг хэвээр үзүүлж, анхааруулга нэмнэ. */}
          {list.isError ? <ApiErrorAlert error={list.error} scope="collateral" title={t('collateral.state.loadError')} onRetry={() => void list.refetch()} /> : null}
          {borrowers.data?.summary.editable === false ? <Alert type="info" showIcon message={t('collateral.state.notEditable')} /> : null}
          <CollateralSummaryBar summary={data.summary} gate={data.gate} />
          <GateIssueList
            applicationId={applicationId}
            gate={data.gate}
            collaterals={data.items}
            canAdd={!gate.disabled}
            onAdd={() => setFormState({ mode: 'create' })}
            onOpen={(id, tab) => setDetail({ id, tab })}
          />
          {data.items.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Flex vertical>
                  <Typography.Text>{t('collateral.state.empty')}</Typography.Text>
                  <Typography.Text type="secondary">{t(data.summary.requiresCollateral ? 'collateral.state.emptyHint' : 'collateral.state.emptyOptionalHint')}</Typography.Text>
                </Flex>
              }
            >
              {addButton(t('collateral.action.add'))}
            </Empty>
          ) : (
            <Flex vertical gap={12} role="list" aria-label={t('collateral.listLabel')}>
              {data.items.map((item) => (
                <div role="listitem" key={item.id}>
                  <CollateralCard
                    item={item}
                    warnings={data.warnings}
                    canRemove={!gate.disabled}
                    removeBlockedReason={gate.text ?? null}
                    removing={removing === item.id}
                    onOpen={() => setDetail({ id: item.id, tab: 'overview' })}
                    onRemove={() => handleRemove(item.id)}
                  />
                </div>
              ))}
            </Flex>
          )}
          {remove.error ? <ApiErrorAlert error={remove.error} scope="collateral" /> : null}

          <CollateralFormModal
            open={formState !== null && (formState.mode === 'create' || editingItem !== null)}
            mode={formState?.mode ?? 'create'}
            applicationId={applicationId}
            collateral={editingItem}
            owners={owners}
            onClose={() => setFormState(null)}
            onChanged={onChanged}
          />
          <CollateralDetailDrawer
            applicationId={applicationId}
            item={detailItem}
            tab={detail?.tab ?? 'overview'}
            onTab={(tab) => setDetail((d) => (d ? { ...d, tab } : d))}
            onClose={() => setDetail(null)}
            write={write}
            onEdit={() => detail && setFormState({ mode: 'edit', id: detail.id })}
            onRemove={() => detail && handleRemove(detail.id)}
            removing={removing !== null && removing === detail?.id}
            onChanged={onChanged}
          />
        </>
      )}
    </Flex>
  );
}
