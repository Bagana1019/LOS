'use client';
import type { PosLeaseListItem } from '@los/contracts';
import { Pagination, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatDateTime, formatMnt } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { Ellipsis } from '../Ellipsis';
import { useIsMobile } from '../hooks';
import { paginationItemRender } from '../pagination';
import { EmptyState } from '../states';
import { StatusTag } from '../StatusTag';
import { publicReasonLabel } from '../status';

export interface LeaseResultsProps {
  items: readonly PosLeaseListItem[];
  loading?: boolean;
  /** Мөр дарахад (drawer нээх / шилжих). */
  onOpen?: (id: string) => void;
  /** Лизингийн № дээр жинхэнэ холбоос тавих бол (merchant портал). */
  hrefFor?: (id: string) => string;
  /** Хураангуй (dashboard): дэлгүүр, үнэ, сарын төлбөрийн багана нуух. */
  compact?: boolean;
  pagination?: { current: number; pageSize: number; total: number; onChange: (page: number, pageSize: number) => void };
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  emptyActions?: ReactNode;
  /** Хүснэгтийн aria-label. */
  label: string;
}

const buyerOf = (i: PosLeaseListItem) => i.buyerName ?? i.buyerRegisterMasked;

/** Лизингийн жагсаалт: desktop-д antd Table, утсанд (<768px) карт жагсаалт. Бүх хуудас (dashboard, жагсаалт, back-office) ижил. */
export function LeaseResults({ items, loading, onOpen, hrefFor, compact, pagination, emptyTitle, emptyDescription, emptyActions, label }: LeaseResultsProps) {
  const mobile = useIsMobile();

  if (!loading && items.length === 0) {
    return <EmptyState title={emptyTitle ?? t('leases.empty.title')} description={emptyDescription ?? t('leases.empty.text')} actions={emptyActions} />;
  }

  if (mobile) {
    return (
      <div aria-busy={loading ? 'true' : 'false'}>
        <ul className="mp-lease-cards" aria-label={label}>
          {items.map((i) => {
            const body = (
              <>
                <div className="mp-lease-card-top"><span className="mp-lease-no">{i.leaseNo}</span><StatusTag status={i.status} /></div>
                <div className="mp-lease-card-goods">{i.goodsName}</div>
                <div className="mp-lease-card-meta">{buyerOf(i)} · {formatDateTime(i.createdAt)}</div>
                <div className="mp-lease-card-amounts">
                  <span><small>{t('leases.col.financed')}</small>{formatMnt(i.financedAmount)}</span>
                  <span><small>{t('leases.col.monthly')}</small>{formatMnt(i.monthlyPayment)}<em> × {i.termMonths}</em></span>
                </div>
                {i.publicReason && i.status === 'DECLINED' ? <div className="mp-lease-card-reason">{publicReasonLabel(i.publicReason)}</div> : null}
              </>
            );
            return (
              <li key={i.id}>
                {hrefFor ? <Link className="mp-lease-card" href={hrefFor(i.id)}>{body}</Link> : <button type="button" className="mp-lease-card" onClick={() => onOpen?.(i.id)}>{body}</button>}
              </li>
            );
          })}
        </ul>
        {pagination ? <Pagination className="mp-pagination" simple itemRender={paginationItemRender} current={pagination.current} pageSize={pagination.pageSize} total={pagination.total} showSizeChanger={false} onChange={pagination.onChange} /> : null}
      </div>
    );
  }

  const columns: ColumnsType<PosLeaseListItem> = [
    {
      title: t('leases.col.leaseNo'), dataIndex: 'leaseNo', key: 'leaseNo', width: 170, className: 'mp-nowrap-cell',
      render: (v: string, r) => (hrefFor ? <Link href={hrefFor(r.id)} onClick={(e) => e.stopPropagation()} className="mp-lease-no">{v}</Link> : <button type="button" className="mp-link-btn mp-lease-no" onClick={(e) => { e.stopPropagation(); onOpen?.(r.id); }}>{v}</button>),
    },
    { title: t('leases.col.date'), dataIndex: 'createdAt', key: 'createdAt', width: 150, className: 'mp-nowrap-cell', render: (v: string) => formatDateTime(v) },
    { title: t('leases.col.goods'), key: 'goods', width: 200, render: (_: unknown, r) => <div><Ellipsis className="mp-cell-main" text={r.goodsName} /><Ellipsis className="mp-cell-sub" text={r.planCode} /></div> },
    { title: t('leases.col.buyer'), key: 'buyer', width: 170, render: (_: unknown, r) => <div><Ellipsis className="mp-cell-main" text={buyerOf(r)} /><Ellipsis className="mp-cell-sub" text={r.buyerPhoneMasked} /></div> },
    ...(compact ? [] : [
      { title: t('leases.col.store'), dataIndex: 'storeName', key: 'storeName', width: 150, render: (v: string) => <Ellipsis text={v} /> } as ColumnsType<PosLeaseListItem>[number],
      { title: t('leases.col.price'), dataIndex: 'goodsPrice', key: 'goodsPrice', width: 120, align: 'right' as const, render: (v: number) => <span className="mp-num">{formatMnt(v)}</span> },
    ]),
    { title: t('leases.col.financed'), dataIndex: 'financedAmount', key: 'financedAmount', width: 130, align: 'right', render: (v: number) => <span className="mp-num">{formatMnt(v)}</span> },
    ...(compact ? [] : [
      { title: t('leases.col.monthly'), key: 'monthly', width: 160, align: 'right' as const, render: (_: unknown, r: PosLeaseListItem) => <span className="mp-num">{formatMnt(r.monthlyPayment)} <span className="mp-cell-sub">× {r.termMonths}</span></span> },
    ]),
    {
      // Төлөв үргэлж харагдана: 1024–1280px-д хүснэгт хэвтээ гүйлгэгдэхэд баруун талд тогтоно.
      title: t('leases.col.status'), key: 'status', width: 150, fixed: 'right',
      render: (_: unknown, r) => <div><StatusTag status={r.status} />{r.publicReason && r.status === 'DECLINED' ? <div className="mp-cell-sub">{publicReasonLabel(r.publicReason)}</div> : null}</div>,
    },
  ];

  return (
    <Table<PosLeaseListItem>
      aria-label={label}
      rowKey="id"
      size={compact ? 'small' : 'middle'}
      loading={loading}
      columns={columns}
      dataSource={[...items]}
      scroll={{ x: columns.reduce((sum, c) => sum + Number(c.width ?? 0), 0) }}
      className="mp-table"
      rowClassName={() => 'mp-row-click'}
      onRow={(r) => ({ onClick: () => onOpen?.(r.id) })}
      pagination={pagination ? { current: pagination.current, pageSize: pagination.pageSize, total: pagination.total, showSizeChanger: true, pageSizeOptions: [10, 20, 50], itemRender: paginationItemRender, showTotal: (total) => t('leases.total', { total }), onChange: pagination.onChange } : false}
    />
  );
}
