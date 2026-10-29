'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Result, Skeleton, Table, Typography, type TableColumnsType } from 'antd';
import { PAGE_SIZES, ChangeRequestStatus, type ChangeRequestDto, type ChangeRequestScope } from '@los/contracts';
import { mn } from '@los/ui';
import { useNow, useRequests } from '../hooks';
import { isForbidden, errorText } from '../errors';
import { describeChange, fmt, statusLabel } from '../labels';
import { formatDateTime, formatRemaining, isUrgent, msUntil } from '../time';
import { RequestActions } from './RequestActions';
import { StatusTag } from './StatusTag';
import type { DecisionHandlers } from './useDecisionFlow';

const { Text } = Typography;

interface Props {
  scope: ChangeRequestScope;
  handlers: DecisionHandlers;
  onOpen: (id: string) => void;
}

function TypeCell({ dto }: { dto: ChangeRequestDto }) {
  const { title, code } = describeChange(dto.targetType, dto.action);
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
}

function ExpiryCell({ dto, now }: { dto: ChangeRequestDto; now: number }) {
  const urgent = isUrgent(dto.status, dto.expiresAt, now);
  return (
    <div>
      <Text type={urgent ? 'danger' : undefined}>{formatDateTime(dto.expiresAt)}</Text>
      {dto.status === 'PENDING' && (
        <div>
          <Text type={urgent ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
            {formatRemaining(msUntil(dto.expiresAt, now))}
          </Text>
        </div>
      )}
    </div>
  );
}

export function RequestsTable({ scope, handlers, onOpen }: Props) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<ChangeRequestStatus | undefined>();
  const now = useNow();
  const { data, error, isPending, isFetching, refetch } = useRequests({ scope, status, page, pageSize });

  // After a decision the current page can run empty (the request left this scope): step back to the last page.
  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(data.total / pageSize)));
  }, [data, page, pageSize]);

  if (isPending) return <Skeleton active paragraph={{ rows: 8 }} />;

  if (!data) {
    if (isForbidden(error)) {
      return <Result status="403" title={mn['maker_checker.table.forbidden_title']} subTitle={mn['maker_checker.table.forbidden_desc']} />;
    }
    return (
      <Alert
        type="error"
        showIcon
        message={mn['maker_checker.table.error_title']}
        description={errorText(error)}
        action={<Button onClick={() => void refetch()}>{mn['maker_checker.table.retry']}</Button>}
      />
    );
  }

  const columns: TableColumnsType<ChangeRequestDto> = [
    { title: mn['maker_checker.col.created_at'], dataIndex: 'createdAt', width: 140, render: (v: string) => formatDateTime(v) },
    { title: mn['maker_checker.col.type'], key: 'type', width: 190, render: (_, r) => <TypeCell dto={r} /> },
    { title: mn['maker_checker.col.target'], dataIndex: 'targetId', width: 120, ellipsis: true },
    { title: mn['maker_checker.col.maker'], dataIndex: 'makerId', width: 110, ellipsis: true },
    { title: mn['maker_checker.col.reason'], dataIndex: 'reason', width: 180, ellipsis: true },
    { title: mn['maker_checker.col.expires_at'], key: 'expiresAt', width: 150, render: (_, r) => <ExpiryCell dto={r} now={now} /> },
    {
      title: mn['maker_checker.col.status'],
      key: 'status',
      width: 140,
      filters: ChangeRequestStatus.map((s) => ({ text: statusLabel(s), value: s })),
      filterMultiple: false,
      filteredValue: status ? [status] : null,
      render: (_, r) => <StatusTag status={r.status} mode={r.mode} />,
    },
    {
      title: mn['maker_checker.col.actions'],
      key: 'actions',
      width: 240,
      fixed: 'right',
      render: (_, r) => <RequestActions dto={r} handlers={handlers} onDetails={onOpen} variant="row" />,
    },
  ];

  return (
    <Table<ChangeRequestDto>
      rowKey="id"
      size="middle"
      columns={columns}
      dataSource={data.items}
      loading={isFetching}
      scroll={{ x: 1200 }}
      locale={{ emptyText: <Empty description={mn[`maker_checker.table.empty.${scope}`]} /> }}
      onRow={(r) => ({
        onClick: () => onOpen(r.id),
        style: { cursor: 'pointer' },
      })}
      pagination={{
        current: data.page,
        pageSize: data.pageSize,
        total: data.total,
        pageSizeOptions: PAGE_SIZES.map(String),
        showSizeChanger: true,
        showTotal: (total) => fmt(mn['maker_checker.table.total'], { total }),
      }}
      onChange={(p, filters) => {
        const next = filters.status?.[0] as ChangeRequestStatus | undefined;
        if (next !== status) {
          setStatus(next);
          setPage(1);
        } else if (p.pageSize !== undefined && p.pageSize !== pageSize) {
          setPageSize(p.pageSize);
          setPage(1);
        } else {
          setPage(p.current ?? 1);
        }
      }}
    />
  );
}
