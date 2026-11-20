'use client';
import { useState } from 'react';
import { Alert, Button, Card, Flex, Input, Select, Skeleton, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import { ReviewStatus, SuspicionFlag, type BsaSuspicionView, type TxnDirection } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { categoryGroups, categoryName, directionSummary, directionsOf, formatConfidence, type BsaCategory } from './bsa.helpers';
import { useCategories, useResolve, useSuspicions } from './useBsa';

interface Props { applicationId: string; analysisId: string; draft: boolean }
type Txn = BsaSuspicionView['transactions'][number];

const DIRECTION_COLOR = { INCOME: 'green', EXPENSE: 'volcano', BOTH: 'gold' } as const;
const head = (label: string, hint: string) => <Tooltip title={hint}><span>{label}</span></Tooltip>;
const muted = (text: string) => <Typography.Text type="secondary">{text}</Typography.Text>;
const directionTag = (d: TxnDirection | 'BOTH' | null) => (d ? <Tag color={DIRECTION_COLOR[d]}>{t(`bsa.direction.${d}`)}</Tag> : muted(t('bsa.susp.unknown')));

/** Дохионы задлан харагдах гүйлгээний багана: чиглэл, харьцсан данс, утга, ангиллын нэр. Хоосон утгыг тайлбартай харуулна. */
const txnColumns = (cats: readonly BsaCategory[]): TableColumnsType<Txn> => [
  { title: t('bsa.susp.col.date'), key: 'when', render: (_: unknown, x: Txn) => (x.txnTime ? `${x.txnDate} ${x.txnTime.slice(0, 5)}` : x.txnDate) },
  { title: t('bsa.susp.col.direction'), dataIndex: 'direction', render: (d: TxnDirection) => directionTag(d) },
  { title: t('bsa.susp.col.txnAmount'), dataIndex: 'amount', align: 'right', render: (v: number) => formatMnt(v) },
  { title: head(t('bsa.susp.col.counterparty'), t('bsa.susp.hint.counterparty')), dataIndex: 'counterpartyAccount', render: (v: string | null) => v ?? muted(t('bsa.susp.noCounterparty')) },
  { title: t('bsa.susp.col.description'), dataIndex: 'description', render: (v: string) => v.trim() || muted(t('bsa.susp.noDescription')) },
  { title: head(t('bsa.susp.col.category'), t('bsa.susp.hint.category')), dataIndex: 'categoryCode', render: (c: string | null) => (c ? (categoryName(c, cats) ?? c) : muted(t('bsa.susp.noCategory'))) },
];

/** M12c: 8 дохионы шалгалт (BSA-FR-5.1/5.2) — нэг/бөөнөөр шийдвэрлэх; ангиллыг Монгол нэрээр сонгоно. */
export function SuspicionsTab({ applicationId, analysisId, draft }: Props) {
  const [status, setStatus] = useState<ReviewStatus | undefined>('PENDING');
  const [flag, setFlag] = useState<SuspicionFlag | undefined>();
  const [selected, setSelected] = useState<string[]>([]);
  const [category, setCategory] = useState<string | undefined>();
  const [comment, setComment] = useState('');
  const q = useSuspicions(analysisId, { status, flag });
  const categories = useCategories();
  const resolve = useResolve(applicationId, analysisId);
  const cats: readonly BsaCategory[] = categories.data ?? [];
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;

  const counts = q.data.counts;
  // Сонгосон дохионы чиглэлд таарах ангиллыг л санал болгоно; чиглэл солигдоход хуучин сонголт хүчингүй болно.
  const groups = categoryGroups(cats, directionsOf(q.data.items.filter((r) => selected.includes(r.id))));
  const chosen = groups.some((g) => g.options.some((o) => o.value === category)) ? category : undefined;
  const act = (action: 'APPROVE' | 'EXCLUDE' | 'RECLASSIFY') =>
    resolve.mutate(
      { ids: selected, action, ...(action === 'RECLASSIFY' && chosen ? { categoryCode: chosen } : {}), ...(comment.trim() ? { comment: comment.trim() } : {}) },
      { onSuccess: () => { setSelected([]); setCategory(undefined); } },
    );

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={5} style={{ margin: 0 }}>{t('bsa.susp.title')}</Typography.Title>
      {counts.pending > 0 ? <Alert type="warning" showIcon message={t('bsa.susp.pendingBlock')} /> : null}
      <Flex gap={8} wrap>
        {SuspicionFlag.map((f) => (
          <Tooltip key={f} title={t('bsa.susp.counter.hint')}>
            <span>
              <Tag.CheckableTag checked={flag === f} onChange={(on) => setFlag(on ? f : undefined)}>
                {t(`bsa.flag.${f}`)}: {counts.byFlag[f]?.pending ?? 0}/{counts.byFlag[f]?.total ?? 0}
              </Tag.CheckableTag>
            </span>
          </Tooltip>
        ))}
      </Flex>
      <Flex gap={8} align="center" wrap>
        <Typography.Text>{t('bsa.susp.filter.status')}</Typography.Text>
        <Select allowClear aria-label={t('bsa.susp.filter.status')} value={status} onChange={(v) => setStatus(v)} style={{ width: 180 }} options={ReviewStatus.map((s) => ({ value: s, label: t(`bsa.susp.status.${s}`) }))} />
      </Flex>
      <Table<BsaSuspicionView>
        rowKey="id"
        size="small"
        locale={{ emptyText: t('bsa.susp.none') }}
        dataSource={q.data.items}
        pagination={false}
        rowSelection={draft ? { selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]), getCheckboxProps: (r) => ({ disabled: r.status === 'RESOLVED' }) } : undefined}
        columns={[
          { title: t('bsa.susp.col.flag'), dataIndex: 'flag', render: (f: string) => t(`bsa.flag.${f}`) },
          { title: t('bsa.susp.col.date'), dataIndex: 'firstDate' },
          { title: head(t('bsa.susp.col.direction'), t('bsa.susp.hint.direction')), key: 'direction', render: (_: unknown, r: BsaSuspicionView) => directionTag(directionSummary(r.transactions)) },
          { title: t('bsa.susp.col.amount'), dataIndex: 'totalAmount', render: (v: number) => formatMnt(v) },
          { title: t('bsa.susp.col.txns'), render: (_: unknown, r: BsaSuspicionView) => r.transactions.length },
          { title: head(t('bsa.susp.col.confidence'), t('bsa.susp.hint.confidence')), key: 'confidence', render: (_: unknown, r: BsaSuspicionView) => formatConfidence(r.confidence) ?? muted(t('bsa.susp.unknown')) },
          { title: t('bsa.susp.col.status'), render: (_: unknown, r: BsaSuspicionView) => (r.status === 'RESOLVED' ? <Tag color="success">{r.action ? t(`bsa.susp.action.${r.action}`) : t('bsa.susp.status.RESOLVED')}</Tag> : <Tag color="warning">{t('bsa.susp.status.PENDING')}</Tag>) },
        ]}
        expandable={{
          expandedRowRender: (r) => <Table<Txn> size="small" rowKey="id" pagination={false} dataSource={r.transactions} columns={txnColumns(cats)} />,
        }}
      />
      {draft && selected.length ? (
        <Card size="small" title={t('bsa.susp.bulk', { count: selected.length })}>
          <Flex gap={8} wrap align="center">
            <Input aria-label={t('bsa.susp.comment')} placeholder={t('bsa.susp.comment')} value={comment} onChange={(e) => setComment(e.target.value)} style={{ width: 240 }} maxLength={1000} />
            <Tooltip title={t('bsa.susp.approve.hint')}>
              <Button onClick={() => act('APPROVE')} loading={resolve.isPending}>{t('bsa.susp.approve')}</Button>
            </Tooltip>
            <Tooltip title={t('bsa.susp.exclude.hint')}>
              <Button danger onClick={() => act('EXCLUDE')} loading={resolve.isPending}>{t('bsa.susp.exclude')}</Button>
            </Tooltip>
            <Select<string>
              id="bsa-reclassify-category"
              aria-label={t('bsa.susp.categoryLabel')}
              showSearch
              optionFilterProp="label"
              allowClear
              placeholder={t('bsa.susp.categoryPlaceholder')}
              notFoundContent={t('bsa.susp.categoryNone')}
              loading={categories.isLoading}
              options={groups}
              value={chosen}
              onChange={setCategory}
              style={{ width: 320 }}
            />
            <Tooltip title={t('bsa.susp.reclassify.hint')}>
              <span>
                <Button onClick={() => act('RECLASSIFY')} disabled={!chosen} loading={resolve.isPending}>{t('bsa.susp.reclassify')}</Button>
              </span>
            </Tooltip>
          </Flex>
          {categories.error ? <ApiErrorAlert error={categories.error} onRetry={() => void categories.refetch()} /> : null}
        </Card>
      ) : null}
      {resolve.error ? <ApiErrorAlert error={resolve.error} /> : null}
    </Flex>
  );
}
