'use client';
import { Button, Card, Flex, Popconfirm, Tag, Tooltip, Typography } from 'antd';
import type { CollateralView, CollateralWarning } from '@los/contracts';
import { EMPTY_VALUE, formatMnt, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { describeCollateral } from './collateral.fields';
import { assetTypeKey, checklistProgress, encumbranceStatus, ownershipStatus, roleKey, valuationStatus } from './collateral.utils';
import { StatusTag } from './StatusTag';

interface Props {
  item: CollateralView;
  warnings: readonly CollateralWarning[];
  /** Устгах боломжтой эсэх (DRAFT/RETURNED ба бичих эрх). */
  canRemove: boolean;
  removeBlockedReason: string | null;
  removing: boolean;
  onOpen: () => void;
  onRemove: () => void;
}

/** Жагсаалтын нэг барьцаа: төрөл, нэг мөр тодорхойлолт, өмчлөгч, төлвийн шошго (өмчлөл / ачаалал / үнэлгээ / баримт), үнэ. */
export function CollateralCard({ item, warnings, canRemove, removeBlockedReason, removing, onOpen, onRemove }: Props) {
  const summary = describeCollateral(item.assetType, item.description);
  const own = ownershipStatus(item);
  const enc = encumbranceStatus(item);
  const val = valuationStatus(item);
  const progress = checklistProgress(item);
  const v = item.valuation;
  const mine = warnings.filter((w) => w.collateralId === item.id);
  const removeButton = (
    <Button danger size="small" disabled={!canRemove} loading={removing} aria-label={`${t('collateral.action.remove')}: ${summary}`}>
      {t('collateral.action.remove')}
    </Button>
  );
  return (
    <Card size="small" data-testid="collateral-card" data-collateral-id={item.id}>
      <Flex vertical gap={10}>
        <Flex justify="space-between" align="flex-start" gap={12} wrap>
          <Flex vertical gap={4} style={{ flex: '1 1 260px', minWidth: 0 }}>
            <Flex gap={8} align="center" wrap>
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t(assetTypeKey(item.assetType))}</Tag>
              <Typography.Text strong style={{ wordBreak: 'break-word' }}>{summary}</Typography.Text>
              {item.source === 'XYP' ? <Tag style={{ marginInlineEnd: 0 }}>{t('collateral.source.XYP')}</Tag> : null}
              {item.releasedAt ? <Tag color="default" style={{ marginInlineEnd: 0 }}>{t('collateral.status.released')}</Tag> : null}
            </Flex>
            <Typography.Text type="secondary">
              {t('collateral.card.owner')}: {item.owner.displayName ?? EMPTY_VALUE}
              {item.owner.role ? ` (${t(roleKey(item.owner.role))})` : ''}
            </Typography.Text>
          </Flex>
          <Flex gap={8} wrap>
            <Button size="small" type="primary" ghost onClick={onOpen} aria-label={`${t('collateral.action.details')}: ${summary}`}>{t('collateral.action.details')}</Button>
            {item.releasedAt ? null : canRemove ? (
              <Popconfirm
                title={t('collateral.confirm.removeTitle')}
                description={t('collateral.confirm.removeText', { name: summary })}
                okText={t('collateral.action.remove')}
                okButtonProps={{ danger: true }}
                cancelText={t('collateral.action.cancel')}
                onConfirm={onRemove}
              >
                {removeButton}
              </Popconfirm>
            ) : (
              <Tooltip title={removeBlockedReason}><span>{removeButton}</span></Tooltip>
            )}
          </Flex>
        </Flex>

        <Flex gap={6} wrap data-testid="collateral-tags">
          <StatusTag label={t('collateral.card.ownership')} tone={own.tone} textKey={own.textKey} />
          <StatusTag label={t('collateral.card.encumbrance')} tone={enc.tone} textKey={enc.textKey} />
          <StatusTag label={t('collateral.card.valuation')} tone={val.tone} textKey={val.textKey} />
          {progress.required > 0 ? (
            <Tag color={progress.complete ? 'success' : 'warning'} style={{ marginInlineEnd: 0 }}>
              {t('collateral.card.documents')}: {progress.satisfied} / {progress.required}
            </Tag>
          ) : null}
          {mine.map((w, index) => (
            <Tooltip key={`${w.code}:${index}`} title={w.message}>
              <Tag color={w.code === 'RELEASED' ? undefined : 'warning'} style={{ marginInlineEnd: 0 }}>{t(`collateral.warning.${w.code}`)}</Tag>
            </Tooltip>
          ))}
        </Flex>

        <Flex gap={24} wrap>
          <Value label={t('collateral.card.marketValue')} value={v ? formatMnt(v.marketValue) : EMPTY_VALUE} />
          <Value label={t('collateral.card.haircut')} value={v ? formatPercent(v.haircutRate) : EMPTY_VALUE} />
          <Value label={t('collateral.card.collateralValue')} value={v ? formatMnt(v.collateralValue) : EMPTY_VALUE} strong />
        </Flex>
      </Flex>
    </Card>
  );
}

function Value({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Flex vertical>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>
      <Typography.Text strong={strong}>{value}</Typography.Text>
    </Flex>
  );
}
