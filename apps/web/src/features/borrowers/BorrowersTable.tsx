'use client';
import type { ReactNode } from 'react';
import { Button, Flex, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { BorrowerSummary, BorrowerView, BorrowerWarning } from '@los/contracts';
import { t } from '../../lib/i18n';
import {
  ROLE_COLOR, WARNING_SEVERITY, consentState, customerTypeKey, customerWarningCodes, describeLiability, formatDateTime, relationKey, roleKey, rowGates,
  warningBadgeKey, type Gate,
} from './borrowers.utils';

interface Props {
  items: readonly BorrowerView[];
  summary: BorrowerSummary;
  warnings: readonly BorrowerWarning[];
  /** Үйлдэл хийгдэж буй мөр (тухайн товчийг "loading" болгож, мөрийн бусад товчийг түр идэвхгүй болгоно). */
  busy: { id: string; action: 'makePrimary' | 'remove' } | null;
  onEdit: (item: BorrowerView) => void;
  onConsent: (item: BorrowerView) => void;
  onMakePrimary: (item: BorrowerView) => void;
  onRemove: (item: BorrowerView) => void;
}

const empty = () => t('borrower.common.empty');

/** Хориглосон үйлдлийн шалтгааныг tooltip-ээр харуулна. */
function Gated({ gate, children }: { gate: Gate; children: ReactNode }) {
  if (gate.allowed || !gate.reason) return <>{children}</>;
  return (
    <Tooltip title={t(gate.reason.key, gate.reason.params)}>
      <span>{children}</span>
    </Tooltip>
  );
}

export function BorrowersTable({ items, summary, warnings, busy, onEdit, onConsent, onMakePrimary, onRemove }: Props) {
  const badges = customerWarningCodes(warnings);
  const currentPrimary = items.find((i) => i.role === 'PRIMARY');

  const columns: TableColumnsType<BorrowerView> = [
    {
      title: t('borrower.column.name'),
      key: 'name',
      width: 150,
      render: (_, r) => (
        <Flex vertical gap={2} align="flex-start">
          <Typography.Text strong>{r.customer.displayName}</Typography.Text>
          {r.customer.customerType === 'LEGAL_ENTITY' ? <Tag>{t(customerTypeKey(r.customer.customerType))}</Tag> : null}
        </Flex>
      ),
    },
    {
      title: t('borrower.column.register'),
      key: 'register',
      width: 130,
      render: (_, r) => (
        <Flex vertical>
          <Typography.Text>{r.customer.registerNoMasked}</Typography.Text>
          {r.customer.phone ? <Typography.Text type="secondary">{r.customer.phone}</Typography.Text> : null}
        </Flex>
      ),
    },
    { title: t('borrower.column.role'), key: 'role', width: 150, render: (_, r) => <Tag color={ROLE_COLOR[r.role]}>{t(roleKey(r.role))}</Tag> },
    {
      title: t('borrower.column.relation'),
      key: 'relation',
      width: 120,
      render: (_, r) => (r.role !== 'PRIMARY' && r.relationToPrimary ? t(relationKey(r.relationToPrimary)) : empty()),
    },
    { title: t('borrower.column.liability'), key: 'liability', width: 170, render: (_, r) => describeLiability(r, summary, t) ?? empty() },
    {
      title: t('borrower.column.income'),
      key: 'income',
      width: 90,
      render: (_, r) => <Tag color={r.incomeIncluded ? 'green' : undefined}>{r.incomeIncluded ? t('borrower.common.yes') : t('borrower.common.no')}</Tag>,
    },
    {
      title: t('borrower.column.consent'),
      key: 'consent',
      width: 140,
      render: (_, r) => {
        const state = consentState(r);
        if (state === 'SIGNED' && r.consentSignedAt)
          return (
            <Tooltip title={r.consentFileId ? t('borrower.consent.fileId', { fileId: r.consentFileId }) : undefined}>
              <Tag color="success">{t('borrower.consent.signed', { date: formatDateTime(r.consentSignedAt) })}</Tag>
            </Tooltip>
          );
        if (state === 'MISSING') return <Tag color="warning">{t('borrower.consent.missing')}</Tag>;
        return <Typography.Text type="secondary">{t('borrower.consent.notRequired')}</Typography.Text>;
      },
    },
    {
      title: t('borrower.column.warnings'),
      key: 'warnings',
      width: 140,
      render: (_, r) => {
        const codes = badges.get(r.customerId) ?? [];
        if (codes.length === 0) return empty();
        return (
          <Flex gap={4} wrap>
            {codes.map((code) => (
              <Tag key={code} color={WARNING_SEVERITY[code] === 'error' ? 'error' : 'warning'}>{t(warningBadgeKey(code))}</Tag>
            ))}
          </Flex>
        );
      },
    },
    {
      title: t('borrower.column.actions'),
      key: 'actions',
      width: 210,
      fixed: 'right',
      render: (_, r) => {
        const gates = rowGates(r, items, summary);
        const rowBusy = busy?.id === r.id;
        return (
          <Space size={[8, 0]} wrap>
            <Gated gate={gates.edit}>
              <Button type="link" size="small" disabled={!gates.edit.allowed || rowBusy} onClick={() => onEdit(r)}>{t('borrower.action.edit')}</Button>
            </Gated>
            <Gated gate={gates.consent}>
              <Button type="link" size="small" disabled={!gates.consent.allowed || rowBusy} onClick={() => onConsent(r)}>{t('borrower.action.consent')}</Button>
            </Gated>
            {gates.makePrimary.visible ? (
              <Gated gate={gates.makePrimary}>
                <Popconfirm
                  title={t('borrower.confirm.makePrimaryTitle')}
                  description={
                    currentPrimary
                      ? t('borrower.confirm.makePrimaryText', { name: r.customer.displayName })
                      : t('borrower.confirm.makePrimaryNoCurrent', { name: r.customer.displayName })
                  }
                  okText={t('borrower.action.confirm')}
                  cancelText={t('borrower.action.cancel')}
                  disabled={!gates.makePrimary.allowed}
                  onConfirm={() => onMakePrimary(r)}
                >
                  <Button type="link" size="small" loading={rowBusy && busy?.action === 'makePrimary'} disabled={!gates.makePrimary.allowed || rowBusy}>{t('borrower.action.makePrimary')}</Button>
                </Popconfirm>
              </Gated>
            ) : null}
            <Gated gate={gates.remove}>
              <Popconfirm
                title={t('borrower.confirm.removeTitle')}
                description={t('borrower.confirm.removeText', { name: r.customer.displayName, role: t(roleKey(r.role)) })}
                okText={t('borrower.action.remove')}
                okButtonProps={{ danger: true }}
                cancelText={t('borrower.action.cancel')}
                disabled={!gates.remove.allowed}
                onConfirm={() => onRemove(r)}
              >
                <Button type="link" size="small" danger loading={rowBusy && busy?.action === 'remove'} disabled={!gates.remove.allowed || rowBusy}>{t('borrower.action.remove')}</Button>
              </Popconfirm>
            </Gated>
          </Space>
        );
      },
    },
  ];

  return <Table<BorrowerView> rowKey="id" size="middle" columns={columns} dataSource={[...items]} pagination={false} scroll={{ x: 1100 }} />;
}
