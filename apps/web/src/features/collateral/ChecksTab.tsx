'use client';
import { useState } from 'react';
import Link from 'next/link';
import { App as AntApp, Alert, Button, Card, Flex, Input, List, Radio, Tag, Tooltip, Typography } from 'antd';
import type { CollateralView } from '@los/contracts';
import { EMPTY_VALUE, formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { encumbranceMethods, encumbranceStatus, ownershipMethods, ownershipStatus, roleKey, stepHref, type CheckMethod, type StatusView } from './collateral.utils';
import { StatusTag } from './StatusTag';
import { contentGate } from './write-gates';
import type { TabProps } from './TabProps';
import { useCheckEncumbrance, useCheckOwnership } from './useCollateral';

/** Өмчлөлийн KYC (FR-6.5) ба ачаалал (FR-6.6) шалгалт. Бүртгэлтэй хөрөнгө → бүртгэлээс (REGISTRY), бүртгэлгүй → ЗЭЗ баталгаажуулна (DECLARED). */
export function ChecksTab({ applicationId, item, write, onChanged }: TabProps) {
  return (
    <Flex vertical gap={16}>
      <OwnershipSection applicationId={applicationId} item={item} write={write} onChanged={onChanged} />
      <EncumbranceSection applicationId={applicationId} item={item} write={write} onChanged={onChanged} />
    </Flex>
  );
}

interface RunFormProps {
  methods: CheckMethod[];
  testId: string;
  /** i18n түлхүүр: `collateral.checks.run.<kind>.<METHOD>`. */
  runKey: (method: CheckMethod) => string;
  running: boolean;
  disabled: boolean;
  disabledText?: string;
  onRun: (method: CheckMethod, note: string | undefined) => void;
}

function RunForm({ methods, testId, runKey, running, disabled, disabledText, onRun }: RunFormProps) {
  const [method, setMethod] = useState<CheckMethod>(methods[0] ?? 'REGISTRY');
  const [note, setNote] = useState('');
  const effective = methods.includes(method) ? method : (methods[0] as CheckMethod);
  const button = (
    <Button type="primary" loading={running} disabled={disabled} onClick={() => onRun(effective, effective === 'DECLARED' ? note.trim() || undefined : undefined)} data-testid={`${testId}-run`}>
      {t(runKey(effective))}
    </Button>
  );
  return (
    <Flex vertical gap={8}>
      {methods.length > 1 ? (
        <Radio.Group value={effective} onChange={(e) => setMethod(e.target.value as CheckMethod)} aria-label={t('collateral.checks.methodLabel')}>
          {methods.map((m) => (
            <Radio key={m} value={m}>{t(`collateral.checks.method.${m}`)}</Radio>
          ))}
        </Radio.Group>
      ) : (
        <Typography.Text type="secondary">{t(`collateral.checks.methodHint.${effective}`)}</Typography.Text>
      )}
      {effective === 'DECLARED' ? (
        <Input.TextArea rows={2} maxLength={500} showCount value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('collateral.checks.notePlaceholder')} aria-label={t('collateral.checks.note')} />
      ) : null}
      <div>{disabled && disabledText ? <Tooltip title={disabledText}><span>{button}</span></Tooltip> : button}</div>
    </Flex>
  );
}

function SectionHeader({ title, status, checkedAt }: { title: string; status: StatusView; checkedAt: string | null }) {
  return (
    <Flex gap={8} align="center" wrap>
      <Typography.Text strong>{title}</Typography.Text>
      <StatusTag tone={status.tone} textKey={status.textKey} />
      {checkedAt ? <Typography.Text type="secondary">{t('collateral.checks.checkedAt', { at: formatDateTime(checkedAt) })}</Typography.Text> : null}
    </Flex>
  );
}

function OwnershipSection({ applicationId, item, write, onChanged }: TabProps) {
  const { message } = AntApp.useApp();
  const check = useCheckOwnership(applicationId, onChanged);
  const blocked = contentGate(write);
  const status = ownershipStatus(item);
  const o = item.ownership;
  return (
    <Card size="small" data-testid="ownership-section" title={<SectionHeader title={t('collateral.checks.ownership')} status={status} checkedAt={o?.checkedAt ?? null} />}>
      <Flex vertical gap={12}>
        {o ? (
          <>
            <Typography.Text type="secondary">
              {t('collateral.checks.via', { method: t(`collateral.checks.method.${o.method}`), source: t(`collateral.checks.source.${o.source}`) })}
            </Typography.Text>
            {o.owners.length > 0 ? (
              <List
                size="small"
                bordered
                header={t('collateral.checks.owners')}
                dataSource={o.owners}
                renderItem={(w) => (
                  <List.Item>
                    <Flex gap={8} align="center" wrap>
                      <Typography.Text strong>{w.name || EMPTY_VALUE}</Typography.Text>
                      <Typography.Text type="secondary">{w.registerMasked || EMPTY_VALUE}</Typography.Text>
                      {w.matchedCustomerId ? (
                        <Tag color="success" style={{ marginInlineEnd: 0 }}>{t('collateral.checks.matched', { role: w.role ? t(roleKey(w.role)) : '' })}</Tag>
                      ) : (
                        <Tag color="error" style={{ marginInlineEnd: 0 }}>{t('collateral.checks.notMatched')}</Tag>
                      )}
                    </Flex>
                  </List.Item>
                )}
              />
            ) : null}
            {o.status === 'OWNER_NOT_ON_APPLICATION' ? (
              <Alert
                type="warning"
                showIcon
                message={o.message ?? t('collateral.checks.registerPledgor')}
                description={<Link href={stepHref(applicationId, 'client')}>{t('collateral.gate.goStep.client')}</Link>}
              />
            ) : null}
            {o.status === 'OWNER_MISMATCH' ? <Alert type="error" showIcon message={o.message ?? t('collateral.checks.mismatch')} /> : null}
            {o.note ? <Typography.Text type="secondary">{t('collateral.checks.noteLabel', { note: o.note })}</Typography.Text> : null}
          </>
        ) : (
          <Typography.Text type="secondary">{t('collateral.checks.ownershipNone')}</Typography.Text>
        )}
        <RunForm
          methods={ownershipMethods(item.assetType)}
          testId="ownership"
          runKey={(m) => `collateral.checks.run.ownership.${m}`}
          running={check.isPending}
          disabled={blocked.disabled}
          disabledText={blocked.text}
          onRun={(method, note) =>
            check.mutate({ collateralId: item.id, body: { method, ...(note ? { note } : {}) } }, { onSuccess: () => void message.success(t('collateral.toast.ownershipChecked')) })
          }
        />
        <ApiErrorAlert error={check.error} scope="collateral" />
      </Flex>
    </Card>
  );
}

function EncumbranceSection({ applicationId, item, write, onChanged }: TabProps) {
  const { message } = AntApp.useApp();
  const check = useCheckEncumbrance(applicationId, onChanged);
  const blocked = contentGate(write);
  const status = encumbranceStatus(item);
  const e: CollateralView['encumbrance'] = item.encumbrance;
  return (
    <Card size="small" data-testid="encumbrance-section" title={<SectionHeader title={t('collateral.checks.encumbrance')} status={status} checkedAt={e?.checkedAt ?? null} />}>
      <Flex vertical gap={12}>
        {e ? (
          <>
            <Typography.Text type="secondary">{t('collateral.checks.viaMethod', { method: t(`collateral.checks.method.${e.method}`) })}</Typography.Text>
            {e.sources.length > 0 ? (
              <List
                size="small"
                bordered
                dataSource={e.sources}
                renderItem={(s) => (
                  <List.Item>
                    <Flex vertical gap={2}>
                      <Flex gap={8} align="center" wrap>
                        <Typography.Text strong>{t(`collateral.checks.encSource.${s.source}`)}</Typography.Text>
                        <Tag color={s.status === 'CLEAR' ? 'success' : s.status === 'NOT_APPLICABLE' ? undefined : 'error'} style={{ marginInlineEnd: 0 }}>
                          {t(`collateral.checks.encSourceStatus.${s.status}`)}
                        </Tag>
                      </Flex>
                      {s.pledgee ? <Typography.Text>{t('collateral.checks.pledgee', { name: s.pledgee })}</Typography.Text> : null}
                      {s.registeredAt ? <Typography.Text type="secondary">{t('collateral.checks.registeredAt', { at: s.registeredAt })}</Typography.Text> : null}
                      {s.note ? <Typography.Text type="secondary">{s.note}</Typography.Text> : null}
                    </Flex>
                  </List.Item>
                )}
              />
            ) : null}
            {e.status === 'ENCUMBERED' ? <Alert type="error" showIcon message={t('collateral.checks.encumberedAlert')} /> : null}
            {e.status === 'DISPUTED' ? <Alert type="error" showIcon message={t('collateral.checks.disputedAlert')} /> : null}
            {e.note ? <Typography.Text type="secondary">{t('collateral.checks.noteLabel', { note: e.note })}</Typography.Text> : null}
          </>
        ) : (
          <Typography.Text type="secondary">{t('collateral.checks.encumbranceNone')}</Typography.Text>
        )}
        <RunForm
          methods={encumbranceMethods(item.assetType)}
          testId="encumbrance"
          runKey={(m) => `collateral.checks.run.encumbrance.${m}`}
          running={check.isPending}
          disabled={blocked.disabled}
          disabledText={blocked.text}
          onRun={(method, note) =>
            check.mutate({ collateralId: item.id, body: { method, ...(note ? { note } : {}) } }, { onSuccess: () => void message.success(t('collateral.toast.encumbranceChecked')) })
          }
        />
        <ApiErrorAlert error={check.error} scope="collateral" />
      </Flex>
    </Card>
  );
}
