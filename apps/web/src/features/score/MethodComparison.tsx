'use client';
import type { HTMLAttributes, ReactNode } from 'react';
import { CheckOutlined } from '@ant-design/icons';
import { Flex, Radio, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { CalcMethod, CalculationRecord, MethodVerdict, UnderwriteResult } from '@los/contracts';
import { t } from '../../lib/i18n';
import { EMPTY_VALUE } from '../../lib/format';
import { ReasonList } from './ReasonList';
import { ToneIcon, VerdictTag } from './VerdictTag';
import {
  autoBasisText, formatLimit, formatMoney, formatRatio, isBlockedByCollateral, methodHintKey, methodKey, ratioTone, verdictTone, type SelectionBlock,
} from './score.utils';

interface Props {
  applicationId: string;
  result: UnderwriteResult;
  /** Хадгалсан тооцооллын сонгосон арга (урьдчилсан харагдацад null) */
  selected: CalcMethod | null;
  selection: CalculationRecord['selection'];
  /** null = сонгож болно; бусад нь хаасан шалтгаан (харагдана) */
  block: SelectionBlock | null;
  /** Одоо хадгалагдаж буй арга (spinner-ийн оронд идэвхгүй болгоно) */
  savingMethod: CalcMethod | null;
  /** Урьдчилсан тооцоо шинэчлэгдэж байна */
  dim: boolean;
  onPick: (method: CalcMethod) => void;
}

interface Row {
  key: string;
  label: string;
  cell: (m: MethodVerdict) => ReactNode;
}

const money = (v: number): ReactNode => <span style={{ overflowWrap: 'anywhere' }}>{formatMoney(v)}</span>;

/** FR-8.1 харьцуулах хүснэгт: A/B/C баганууд; FR-8.2 «Автомат» тэмдэг + гараар сонгох; FR-8.4 хангасан/хангаагүй; FR-8.5 stress; FR-8.6 шалтгаан. */
export function MethodComparison({ applicationId, result, selected, selection, block, savingMethod, dim, onPick }: Props) {
  const blockId = 'score-selection-note';
  const disabledAll = block !== null || savingMethod !== null;
  const rows: Row[] = [
    {
      // Radio-г толгойд биш мөрөнд байрлуулна: antd Table `scroll.x` үед толгойг хэмжих далд мөрөнд хуулбарлаж, фокусжих давхар radio үүсгэдэг
      key: 'select',
      label: t('score.select.groupLabel'),
      cell: (m) => (
        <Radio
          value={m.method}
          disabled={disabledAll || !m.applicable}
          aria-label={t('score.select.aria', { method: t(methodKey(m.method)) })}
          aria-describedby={block ? blockId : undefined}
        >
          {t('score.select.label')}
        </Radio>
      ),
    },
    { key: 'baseIncome', label: t('score.compare.row.baseIncome'), cell: (m) => money(m.baseIncome) },
    { key: 'totalDebtService', label: t('score.compare.row.totalDebtService'), cell: (m) => money(m.totalDebtService) },
    {
      key: 'ratio',
      label: t('score.compare.row.ratio'),
      cell: (m) => {
        const lim = formatLimit(m);
        return (
          <Flex vertical gap={2} data-cell="ratio">
            <Flex align="center" gap={6}>
              <ToneIcon tone={ratioTone(m)} />
              <Typography.Text strong>{t(`score.ratio.${m.ratioKind}`)} {formatRatio(m)}</Typography.Text>
            </Flex>
            <Typography.Text type="secondary">{t('score.compare.limit', { sign: lim.sign, value: lim.value })}</Typography.Text>
          </Flex>
        );
      },
    },
    {
      key: 'verdict',
      label: t('score.compare.row.verdict'),
      cell: (m) => (
        <Flex vertical gap={4} align="flex-start">
          <VerdictTag tone={verdictTone(m)} />
          {isBlockedByCollateral(m) ? <Typography.Text type="warning">{t('score.compare.blockedByCollateral')}</Typography.Text> : null}
        </Flex>
      ),
    },
    { key: 'reasons', label: t('score.compare.row.reasons'), cell: (m) => <ReasonList applicationId={applicationId} reasons={m.reasons} /> },
    { key: 'maxAffordable', label: t('score.compare.row.maxAffordable'), cell: (m) => (m.applicable ? money(m.maxAffordable) : EMPTY_VALUE) },
    { key: 'maxLoanAmount', label: t('score.compare.row.maxLoanAmount'), cell: (m) => (m.applicable ? money(m.maxLoanAmount) : EMPTY_VALUE) },
    {
      key: 'stress',
      label: t('score.compare.row.stress'),
      cell: (m) => {
        if (!m.stress || !m.applicable) return EMPTY_VALUE;
        return (
          <Flex align="center" gap={6} data-cell="stress">
            <ToneIcon tone={m.stress.ratio === null ? 'na' : m.stress.pass ? 'pass' : 'fail'} />
            <Typography.Text>{t(`score.ratio.${m.ratioKind}`)} {formatRatio({ ratioKind: m.ratioKind, ratio: m.stress.ratio })}</Typography.Text>
          </Flex>
        );
      },
    },
  ];

  const columns: TableColumnsType<Row> = [
    {
      key: 'metric',
      title: t('score.compare.metric'),
      dataIndex: 'label',
      fixed: 'left',
      width: 150,
      render: (label: string) => <Typography.Text strong>{label}</Typography.Text>,
    },
    ...result.methods.map((m) => {
      const isAuto = result.autoSelected === m.method;
      const isSelected = selected === m.method;
      return {
        key: m.method,
        width: 210,
        title: (
          <Flex vertical gap={4} data-method={m.method}>
            <Flex align="center" gap={6} wrap>
              <Typography.Text strong>{t(methodKey(m.method))}</Typography.Text>
              {isAuto ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t('score.compare.auto')}</Tag> : null}
              {isSelected ? (
                <Tag color="geekblue" icon={<CheckOutlined aria-hidden />} style={{ marginInlineEnd: 0 }}>
                  {t('score.compare.selected')}{selection === 'MANUAL' ? ` (${t('score.selection.MANUAL')})` : ''}
                </Tag>
              ) : null}
            </Flex>
            <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>{t(methodHintKey(m.method))}</Typography.Text>
          </Flex>
        ),
        render: (_: unknown, row: Row) => row.cell(m),
      };
    }),
  ];

  return (
    <div aria-busy={dim} style={{ opacity: dim ? 0.55 : 1, transition: 'opacity .15s' }}>
      <div role="radiogroup" aria-label={t('score.select.groupLabel')}>
        <Radio.Group name="score-method" value={selected} onChange={(e) => onPick(e.target.value as CalcMethod)} style={{ display: 'block' }}>
          <Table<Row>
            size="small"
            bordered
            pagination={false}
            rowKey="key"
            columns={columns}
            dataSource={rows}
            onRow={(row) => ({ 'data-row': row.key }) as HTMLAttributes<HTMLElement>}
            scroll={{ x: 780 }}
            aria-label={t('score.compare.caption')}
          />
        </Radio.Group>
      </div>
      <Flex vertical gap={4} style={{ marginTop: 12 }}>
        {block ? <Typography.Text id={blockId} type="secondary" role="note">{t(`score.select.blocked.${block}`)}</Typography.Text> : null}
        <Typography.Text type="secondary" data-testid="score-auto-basis">{t('score.compare.autoBasis', { text: autoBasisText(result, t) })}</Typography.Text>
      </Flex>
    </div>
  );
}
