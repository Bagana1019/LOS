'use client';
import { Alert, Button, Descriptions, Flex, Popconfirm, Tag, Tooltip, Typography } from 'antd';
import Link from 'next/link';
import { EMPTY_VALUE, formatDate, formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { descriptionRows } from './collateral.fields';
import { describeIssue, roleKey, stepHref } from './collateral.utils';
import type { TabProps } from './TabProps';
import { contentGate } from './write-gates';

interface Props extends TabProps {
  onEdit: () => void;
  onRemove: () => void;
  removing: boolean;
}

/** Тойм: хөрөнгийн талбарууд, өмчлөгч, ЭБ/даатгал/дахин үнэлгээний огноо, энэ барьцааны G0 дутагдал; засах / устгах. */
export function OverviewTab({ applicationId, item, write, onEdit, onRemove, removing }: Props) {
  const rows = descriptionRows(item.assetType, item.description);
  const issues = item.issues.map(describeIssue);
  const gate = contentGate(write);
  const editable = !gate.disabled;
  const blockedText = gate.text;

  const editButton = <Button onClick={onEdit} disabled={!editable}>{t('collateral.action.edit')}</Button>;
  const removeButton = <Button danger loading={removing} disabled={!editable || item.releasedAt !== null}>{t('collateral.action.remove')}</Button>;
  return (
    <Flex vertical gap={16}>
      <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }} title={t('collateral.overview.fields')}>
        {rows.map((r) => (
          <Descriptions.Item key={r.name} label={r.label}>{r.value}</Descriptions.Item>
        ))}
      </Descriptions>

      <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }} title={t('collateral.overview.meta')}>
        <Descriptions.Item label={t('collateral.card.owner')}>
          {item.owner.displayName ?? EMPTY_VALUE}
          {item.owner.role ? <Tag style={{ marginInlineStart: 8 }}>{t(roleKey(item.owner.role))}</Tag> : null}
        </Descriptions.Item>
        <Descriptions.Item label={t('collateral.overview.source')}>{t(`collateral.source.${item.source}`)}</Descriptions.Item>
        <Descriptions.Item label={t('collateral.overview.registryNo')}>{item.registryNo ?? EMPTY_VALUE}</Descriptions.Item>
        <Descriptions.Item label={t('collateral.overview.registryDate')}>{item.registryDate ?? EMPTY_VALUE}</Descriptions.Item>
        <Descriptions.Item label={t('collateral.overview.insuranceExpiresAt')}>{item.insuranceExpiresAt ?? EMPTY_VALUE}</Descriptions.Item>
        <Descriptions.Item label={t('collateral.overview.nextRevaluationAt')}>{item.nextRevaluationAt ?? EMPTY_VALUE}</Descriptions.Item>
        <Descriptions.Item label={t('collateral.overview.createdAt')}>{formatDateTime(item.createdAt)}</Descriptions.Item>
        {item.releasedAt ? <Descriptions.Item label={t('collateral.overview.releasedAt')}>{formatDate(item.releasedAt)}</Descriptions.Item> : null}
        {item.note ? <Descriptions.Item label={t('collateral.overview.note')} span="filled">{item.note}</Descriptions.Item> : null}
      </Descriptions>

      <div>
        <Typography.Title level={5}>{t('collateral.overview.issues')}</Typography.Title>
        {issues.length === 0 ? (
          <Alert type="success" showIcon message={t('collateral.overview.noIssues')} />
        ) : (
          <Flex vertical gap={8}>
            {issues.map((i, index) => (
              <Alert
                key={`${i.code}:${index}`}
                type={i.severity}
                showIcon
                message={i.title}
                description={
                  <Flex vertical>
                    {i.message ? <span>{i.message}</span> : null}
                    {i.hint ? <span>{i.hint}</span> : null}
                    {i.target?.kind === 'step' ? <Link href={stepHref(applicationId, i.target.step)}>{t(`collateral.gate.goStep.${i.target.step}`)}</Link> : null}
                  </Flex>
                }
              />
            ))}
          </Flex>
        )}
      </div>

      <Flex gap={8} wrap>
        {editable ? editButton : <Tooltip title={blockedText}><span>{editButton}</span></Tooltip>}
        {editable && item.releasedAt === null ? (
          <Popconfirm
            title={t('collateral.confirm.removeTitle')}
            description={t('collateral.confirm.removeText', { name: t(`collateral.assetType.${item.assetType}`) })}
            okText={t('collateral.action.remove')}
            okButtonProps={{ danger: true }}
            cancelText={t('collateral.action.cancel')}
            onConfirm={onRemove}
          >
            {removeButton}
          </Popconfirm>
        ) : (
          <Tooltip title={blockedText}><span>{removeButton}</span></Tooltip>
        )}
      </Flex>
    </Flex>
  );
}
