'use client';
import { Alert, Card, Empty, Flex, Progress, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { SoscoComponentBreakdown, SoscoSummary } from '@los/contracts';
import { t } from '../../lib/i18n';
import { EMPTY_VALUE } from '../../lib/format';
import { GRADE_COLOR, formatDateTime, formatPoints, formatShare, formatSoscoInput, fractionBar, pointsBar, soscoComponentKey } from './score.utils';

interface Props {
  sosco: SoscoSummary | null;
  /** Урьдчилсан харагдац: Sosco хадгалсан тооцооллынх гэдгийг сануулна */
  previewing: boolean;
}

/** Sosco Score (дотоод, 0–1000, A–E) ба бүрэлдэхүүн. Мэдэгдэхгүй бүрэлдэхүүн оноонд ороогүй (жин бусдад хуваарилагдсан). docs/05 §3. */
export function SoscoCard({ sosco, previewing }: Props) {
  const columns: TableColumnsType<SoscoComponentBreakdown> = [
    { key: 'component', title: t('score.sosco.table.component'), width: 200, render: (_, c) => <Typography.Text strong>{t(soscoComponentKey(c.key))}</Typography.Text> },
    {
      key: 'input',
      title: t('score.sosco.table.input'),
      width: 100,
      align: 'right',
      render: (_, c) => (c.available ? formatSoscoInput(c.key, c.input) : EMPTY_VALUE),
    },
    {
      key: 'normalized',
      title: t('score.sosco.table.normalized'),
      width: 220,
      render: (_, c) =>
        c.available ? (
          <Flex align="center" gap={8}>
            <Progress percent={fractionBar(c.normalized)} showInfo={false} size="small" style={{ flex: 1, minWidth: 80, margin: 0 }} aria-label={t(soscoComponentKey(c.key))} />
            <span style={{ minWidth: 48, textAlign: 'right' }}>{formatShare(c.normalized)}</span>
          </Flex>
        ) : (
          <Tooltip title={t('score.sosco.unavailableHint')}>
            <Tag data-unavailable style={{ marginInlineEnd: 0 }}>{t('score.sosco.unavailable')}</Tag>
          </Tooltip>
        ),
    },
    { key: 'weight', title: t('score.sosco.table.weight'), width: 80, align: 'right', render: (_, c) => (c.available ? formatShare(c.effectiveWeight) : EMPTY_VALUE) },
    {
      key: 'points',
      title: t('score.sosco.table.points'),
      width: 180,
      render: (_, c) =>
        c.available ? (
          <Flex align="center" gap={8}>
            <Progress percent={pointsBar(c.points)} showInfo={false} size="small" strokeColor="#722ed1" style={{ flex: 1, minWidth: 60, margin: 0 }} aria-label={`${t(soscoComponentKey(c.key))}: ${t('score.sosco.table.points')}`} />
            <span style={{ minWidth: 44, textAlign: 'right' }}>{formatPoints(c.points)}</span>
          </Flex>
        ) : (
          EMPTY_VALUE
        ),
    },
  ];

  return (
    <Card title={t('score.sosco.title')} size="small" role="region" aria-label={t('score.sosco.title')} extra={sosco ? <Typography.Text type="secondary">{t('score.sosco.model', { version: sosco.modelVersion })}</Typography.Text> : undefined}>
      {!sosco ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('score.sosco.none')} />
      ) : (
        <Flex vertical gap={16}>
          <Flex wrap gap={32} align="center" data-testid="score-sosco-summary">
            <div>
              <Typography.Text type="secondary">{t('score.sosco.score')}</Typography.Text>
              <div style={{ fontSize: 40, lineHeight: 1.1, fontWeight: 600 }} data-testid="score-sosco-score">
                {sosco.score === null ? EMPTY_VALUE : String(sosco.score)}
                {sosco.score === null ? null : <span style={{ fontSize: 14, fontWeight: 400, marginInlineStart: 6 }}>{t('score.sosco.scale')}</span>}
              </div>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ display: 'block' }}>{t('score.sosco.grade')}</Typography.Text>
              {sosco.grade ? (
                <Tag color={GRADE_COLOR[sosco.grade]} data-grade={sosco.grade} style={{ fontSize: 22, lineHeight: '32px', paddingInline: 14, marginInlineEnd: 0 }}>{sosco.grade}</Tag>
              ) : (
                <span style={{ fontSize: 22 }}>{EMPTY_VALUE}</span>
              )}
            </div>
            <div style={{ minWidth: 160 }}>
              <Typography.Text type="secondary">{t('score.sosco.coverage')}</Typography.Text>
              <div style={{ fontSize: 20, fontWeight: 600 }} data-testid="score-sosco-coverage">{formatShare(sosco.coverage)}</div>
              <Progress percent={fractionBar(sosco.coverage)} showInfo={false} size="small" aria-label={t('score.sosco.coverage')} style={{ margin: 0 }} />
            </div>
            <Typography.Text type="secondary">{t('score.sosco.computedAt', { at: formatDateTime(sosco.computedAt) })}</Typography.Text>
          </Flex>

          {sosco.status === 'INSUFFICIENT_DATA' ? (
            <Alert type="warning" showIcon message={t('score.sosco.insufficient.title')} description={t('score.sosco.insufficient.text', { coverage: formatShare(sosco.coverage) })} />
          ) : null}
          {previewing ? <Typography.Text type="secondary">{t('score.sosco.previewNote')}</Typography.Text> : null}

          <Table<SoscoComponentBreakdown>
            size="small"
            pagination={false}
            rowKey="key"
            columns={columns}
            dataSource={sosco.components}
            scroll={{ x: 780 }}
            aria-label={t('score.sosco.table.caption')}
            rowClassName={(c) => (c.available ? '' : 'score-component-unavailable')}
          />
        </Flex>
      )}
    </Card>
  );
}
