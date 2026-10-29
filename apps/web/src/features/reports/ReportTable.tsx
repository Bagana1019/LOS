'use client';
import { useMemo } from 'react';
import { Empty, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ReportDefinitionView, ReportResult, ReportRow } from '@los/contracts';
import { t } from '../../lib/i18n';
import {
  PAGE_SIZES, columnAlign, columnPixelWidth, effectiveSort, formatCell, formatTotal, nextSort, statusColor, statusLabel, tableScrollWidth, toAntdOrder, totalKeysOf, totalsCurrency,
  type ReportViewState, type SortDir,
} from './reports.utils';

const ROW_KEY = '__rowKey';

export interface TableChange {
  page: number;
  pageSize: number;
  sortBy: string | null;
  sortDir: SortDir;
}

interface Props {
  definition: ReportDefinitionView;
  result: ReportResult | undefined;
  /** Шинэ өгөгдөл татаж байгаа (өмнөх хүснэгт харагдсаар байна). */
  loading: boolean;
  state: ReportViewState;
  onChange: (next: TableChange) => void;
}

/** Сервер талын хуудаслалт (10/20/50/100) ба эрэмбэтэй хүснэгт. Багана төрлөөр форматлагдана, нийлбэр мөр нь бүх шүүлттэй мөрийн нийлбэр (хуудсынх биш). */
export function ReportTable({ definition, result, loading, state, onChange }: Props) {
  const active = effectiveSort(state, definition);
  const rows = result?.rows ?? [];
  // Мөрт тогтвортой ID байхгүй (тайлан = нэгтгэл) тул хуудас+дугаараар түлхүүр үүсгэнэ (antd rowKey-ийн index параметр deprecated).
  const dataSource = useMemo(() => rows.map((row, i) => ({ ...row, [ROW_KEY]: `${result?.page ?? 1}:${i}` })), [rows, result?.page]);

  const columns: TableColumnsType<ReportRow> = definition.columns.map((c, index) => ({
    key: c.key,
    dataIndex: c.key,
    title: c.label,
    align: columnAlign(c.type),
    width: columnPixelWidth(c.width),
    fixed: index === 0 ? 'left' : undefined,
    ellipsis: c.type === 'string',
    sorter: c.sortable ? true : undefined,
    sortOrder: c.sortable ? toAntdOrder(active, c.key) : undefined,
    sortDirections: ['ascend', 'descend'],
    showSorterTooltip: false,
    render: (_: unknown, row: ReportRow) => {
      const value = row[c.key];
      if (c.type === 'status' && value !== null && value !== undefined && value !== '') {
        const code = String(value);
        return <Tag bordered={false} color={statusColor(code)} style={{ marginInlineEnd: 0 }}>{statusLabel(c, code)}</Tag>;
      }
      return formatCell(c, value, row, t);
    },
  }));

  const totalKeys = result ? totalKeysOf(definition.columns, result.totals) : [];
  const currency = result ? totalsCurrency(rows, state.filters.currency) : 'MNT';
  const summary = () => {
    if (!result) return null;
    if (result.mixedCurrency) {
      return (
        <Table.Summary fixed>
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={definition.columns.length}>
              <Typography.Text type="secondary">{t('report.table.mixedCurrency')}</Typography.Text>
            </Table.Summary.Cell>
          </Table.Summary.Row>
        </Table.Summary>
      );
    }
    if (totalKeys.length === 0) return null;
    return (
      <Table.Summary fixed>
        <Table.Summary.Row>
          {definition.columns.map((c, i) => (
            <Table.Summary.Cell key={c.key} index={i} align={columnAlign(c.type)}>
              {i === 0 ? <Typography.Text strong>{t('report.table.totalRow')}</Typography.Text> : null}
              {i > 0 && totalKeys.includes(c.key) ? <Typography.Text strong>{formatTotal(c, result.totals?.[c.key] ?? 0, currency)}</Typography.Text> : null}
            </Table.Summary.Cell>
          ))}
        </Table.Summary.Row>
      </Table.Summary>
    );
  };

  return (
    <Table<ReportRow>
      rowKey={ROW_KEY}
      size="middle"
      columns={columns}
      dataSource={dataSource}
      loading={loading}
      sticky
      scroll={{ x: tableScrollWidth(definition.columns) }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report.table.empty')} /> }}
      summary={rows.length > 0 ? summary : undefined}
      pagination={{
        current: state.page,
        pageSize: state.pageSize,
        total: result?.total ?? 0,
        showSizeChanger: true,
        pageSizeOptions: PAGE_SIZES.map(String),
        showTotal: (total) => t('report.table.total', { total }),
      }}
      onChange={(pagination, _filters, sorter, extra) => {
        if (extra.action === 'sort') {
          const s = Array.isArray(sorter) ? sorter[0] : sorter;
          const next = nextSort(state, definition, s?.columnKey === undefined ? undefined : String(s.columnKey), s?.order);
          onChange({ page: 1, pageSize: state.pageSize, ...next });
        } else if (extra.action === 'paginate') {
          const pageSize = pagination.pageSize ?? state.pageSize;
          onChange({ page: pageSize !== state.pageSize ? 1 : pagination.current ?? 1, pageSize, sortBy: state.sortBy, sortDir: state.sortDir });
        }
      }}
    />
  );
}
