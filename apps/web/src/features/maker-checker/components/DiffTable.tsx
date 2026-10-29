'use client';
import { useMemo } from 'react';
import { Empty, Table, Tag, Typography, theme, type TableColumnsType } from 'antd';
import { mn } from '@los/ui';
import { diffObjects, formatValue, type DiffEntry } from '../diff';

const KIND_COLOR = { added: 'green', removed: 'red', changed: 'gold' } as const;
const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const;

function Value({ present, value }: { present: boolean; value: unknown }) {
  if (!present) return <Typography.Text type="secondary">{mn['maker_checker.diff.absent']}</Typography.Text>;
  return <pre style={{ ...MONO, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{formatValue(value)}</pre>;
}

interface Props {
  before: unknown;
  payload: unknown;
}

/** "Өмнө → Дараа": one row per changed leaf field of the proposed payload. */
export function DiffTable({ before, payload }: Props) {
  const { token } = theme.useToken();
  const rows = useMemo(() => diffObjects(before, payload), [before, payload]);

  const columns: TableColumnsType<DiffEntry> = [
    {
      title: mn['maker_checker.diff.col_field'],
      dataIndex: 'path',
      width: '30%',
      render: (path: string, r) => (
        <div>
          <div style={{ ...MONO, wordBreak: 'break-all' }}>{path || mn['maker_checker.diff.root']}</div>
          <Tag color={KIND_COLOR[r.kind]} style={{ marginTop: 4 }}>
            {mn[`maker_checker.diff.kind.${r.kind}`]}
          </Tag>
        </div>
      ),
    },
    {
      title: mn['maker_checker.diff.col_before'],
      key: 'before',
      onCell: (r) => ({ style: r.kind === 'added' ? undefined : { background: token.colorErrorBg } }),
      render: (_, r) => <Value present={r.kind !== 'added'} value={r.before} />,
    },
    {
      title: mn['maker_checker.diff.col_after'],
      key: 'after',
      onCell: (r) => ({ style: r.kind === 'removed' ? undefined : { background: token.colorSuccessBg } }),
      render: (_, r) => <Value present={r.kind !== 'removed'} value={r.after} />,
    },
  ];

  return (
    <Table<DiffEntry>
      rowKey={(r) => r.path || '(root)'}
      size="small"
      bordered
      pagination={false}
      columns={columns}
      dataSource={rows}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={mn['maker_checker.diff.empty']} /> }}
    />
  );
}
