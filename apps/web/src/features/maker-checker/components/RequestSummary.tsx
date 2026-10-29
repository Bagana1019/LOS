'use client';
import { Descriptions, Tag, Typography, type DescriptionsProps } from 'antd';
import { mn } from '@los/ui';
import type { ChangeRequestDto } from '@los/contracts';
import { describeChange, modeLabel, roleLabel } from '../labels';
import { formatDateTime, isUrgent } from '../time';
import { StatusTag } from './StatusTag';

const { Text } = Typography;

const Roles = ({ roles }: { roles: string[] }) => (
  <>
    {roles.map((r) => (
      <Tag key={r}>{roleLabel(r)}</Tag>
    ))}
  </>
);

/** Header summary of a request: who proposed what, when, and who decided. */
export function RequestSummary({ dto, now }: { dto: ChangeRequestDto; now: number }) {
  const { title, code } = describeChange(dto.targetType, dto.action);
  const urgent = isUrgent(dto.status, dto.expiresAt, now);

  const items: DescriptionsProps['items'] = [
    { key: 'id', span: 2, label: mn['maker_checker.field.id'], children: <Text copyable code>{dto.id}</Text> },
    {
      key: 'type',
      span: 2,
      label: mn['maker_checker.field.type'],
      children: (
        <>
          {title}
          {code && <Text type="secondary"> ({code})</Text>}
        </>
      ),
    },
    { key: 'target', label: mn['maker_checker.field.target'], children: <Text copyable>{dto.targetId}</Text> },
    { key: 'status', label: mn['maker_checker.col.status'], children: <StatusTag status={dto.status} mode={dto.mode} /> },
    { key: 'mode', label: mn['maker_checker.field.mode'], children: modeLabel(dto.mode) },
    {
      key: 'maker',
      label: mn['maker_checker.field.maker'],
      children: (
        <>
          <Text>{dto.makerId}</Text> <Roles roles={dto.makerRoles} />
        </>
      ),
    },
    { key: 'created', label: mn['maker_checker.field.created_at'], children: formatDateTime(dto.createdAt) },
  ];

  if (dto.applicationId) items.push({ key: 'application', label: mn['maker_checker.field.application'], children: dto.applicationId });
  if (dto.branchId) items.push({ key: 'branch', label: mn['maker_checker.field.branch'], children: dto.branchId });
  if (dto.requiredCheckerRoles.length > 0) {
    items.push({ key: 'required', label: mn['maker_checker.field.required_roles'], children: <Roles roles={dto.requiredCheckerRoles} /> });
  }
  items.push({
    key: 'expires',
    label: mn['maker_checker.field.expires_at'],
    children: <Text type={urgent ? 'danger' : undefined}>{formatDateTime(dto.expiresAt)}</Text>,
  });
  if (dto.checkerId) {
    items.push({
      key: 'checker',
      label: mn['maker_checker.field.checker'],
      children: (
        <>
          <Text>{dto.checkerId}</Text> <Roles roles={dto.checkerRoles} />
        </>
      ),
    });
  }
  if (dto.decidedAt) items.push({ key: 'decided', label: mn['maker_checker.field.decided_at'], children: formatDateTime(dto.decidedAt) });

  return <Descriptions bordered size="small" column={2} items={items} />;
}
