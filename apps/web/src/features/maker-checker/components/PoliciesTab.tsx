'use client';
import { useState } from 'react';
import { Alert, Button, Empty, Result, Skeleton, Space, Switch, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import { mn } from '@los/ui';
import type { MakerCheckerPolicyDto } from '@los/contracts';
import { usePolicies } from '../hooks';
import { errorText, isForbidden } from '../errors';
import { describeChange, fmt, roleLabel } from '../labels';
import { formatDateTime } from '../time';
import { PolicyEditModal } from './PolicyEditModal';

const { Text } = Typography;

interface Editing {
  policy: MakerCheckerPolicyDto;
  presetEnabled?: boolean;
}

interface Props {
  /** Open the change request created by a policy edit. */
  onOpenRequest: (requestId: string) => void;
}

/** Policy list (ADMIN / APPROVER). Editing is a four-eyes change itself, so it goes through a modal with a reason. */
export function PoliciesTab({ onOpenRequest }: Props) {
  const { data, error, isPending, refetch } = usePolicies();
  const [editing, setEditing] = useState<Editing | null>(null);

  if (isPending) return <Skeleton active paragraph={{ rows: 6 }} />;

  if (!data) {
    if (isForbidden(error)) {
      return <Result status="403" title={mn['maker_checker.policies.forbidden_title']} subTitle={mn['maker_checker.policies.forbidden_desc']} />;
    }
    return (
      <Alert
        type="error"
        showIcon
        message={mn['maker_checker.policies.error_title']}
        description={errorText(error)}
        action={<Button onClick={() => void refetch()}>{mn['maker_checker.table.retry']}</Button>}
      />
    );
  }

  const columns: TableColumnsType<MakerCheckerPolicyDto> = [
    {
      title: mn['maker_checker.policies.col_target_type'],
      key: 'type',
      width: 240,
      render: (_, p) => {
        const { title, code } = describeChange(p.targetType, p.action);
        return (
          <div>
            <div>{title}</div>
            {code && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {code}
              </Text>
            )}
          </div>
        );
      },
    },
    {
      title: mn['maker_checker.policies.col_enabled'],
      key: 'enabled',
      width: 110,
      render: (_, p) => {
        // The switch only starts an edit: the change still needs a reason and another admin's approval.
        const sw = (
          <Switch
            checked={p.enabled}
            disabled={p.locked}
            onChange={(checked) => setEditing({ policy: p, presetEnabled: checked })}
          />
        );
        return p.locked ? (
          <Tooltip title={mn['maker_checker.policies.locked_tooltip']}>
            <span style={{ display: 'inline-block' }}>{sw}</span>
          </Tooltip>
        ) : (
          sw
        );
      },
    },
    {
      title: mn['maker_checker.policies.col_roles'],
      dataIndex: 'checkerRoles',
      width: 220,
      render: (roles: string[]) => (
        <>
          {roles.map((r) => (
            <Tag key={r}>{roleLabel(r)}</Tag>
          ))}
        </>
      ),
    },
    {
      title: mn['maker_checker.policies.col_expires'],
      dataIndex: 'expiresInHours',
      width: 120,
      render: (h: number) => fmt(mn['maker_checker.policies.hours'], { n: h }),
    },
    {
      title: mn['maker_checker.policies.col_flags'],
      key: 'flags',
      width: 180,
      render: (_, p) => (
        <Space size={4} wrap>
          <Tag color={p.configured ? 'blue' : 'default'} style={{ margin: 0 }}>
            {p.configured ? mn['maker_checker.policies.tag_configured'] : mn['maker_checker.policies.tag_default']}
          </Tag>
          {p.locked && (
            <Tooltip title={mn['maker_checker.policies.locked_tooltip']}>
              <Tag color="purple" style={{ margin: 0 }}>
                {mn['maker_checker.policies.tag_locked']}
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: mn['maker_checker.policies.col_updated'],
      key: 'updated',
      width: 170,
      render: (_, p) =>
        p.updatedAt ? (
          <div>
            <div>{formatDateTime(p.updatedAt)}</div>
            {p.updatedBy && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {p.updatedBy}
              </Text>
            )}
          </div>
        ) : (
          '—'
        ),
    },
    {
      title: mn['maker_checker.col.actions'],
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (_, p) => (
        <Button type="link" size="small" onClick={() => setEditing({ policy: p })}>
          {mn['maker_checker.btn.edit']}
        </Button>
      ),
    },
  ];

  return (
    <>
      <Alert type="info" showIcon message={mn['maker_checker.policies.notice']} style={{ marginBottom: 16 }} />
      <Table<MakerCheckerPolicyDto>
        rowKey={(p) => `${p.targetType}:${p.action}`}
        size="middle"
        columns={columns}
        dataSource={data}
        pagination={false}
        scroll={{ x: 1100 }}
        locale={{ emptyText: <Empty description={mn['maker_checker.policies.empty']} /> }}
      />
      {editing && (
        <PolicyEditModal
          key={`${editing.policy.targetType}:${editing.policy.action}`}
          policy={editing.policy}
          presetEnabled={editing.presetEnabled}
          onClose={() => setEditing(null)}
          onOpenRequest={onOpenRequest}
        />
      )}
    </>
  );
}
