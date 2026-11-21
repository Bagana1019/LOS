'use client';
import { Alert, Collapse, Descriptions, Flex, Table, Tag } from 'antd';
import type { BsaAnalysisDetails } from '@los/contracts';
import { formatMnt, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { AnalysisWarning } from './bsa.api';
import { formatStepValue } from './bsa.helpers';

interface Props {
  details: BsaAnalysisDetails | null;
  warnings: readonly AnalysisWarning[];
  /** Хадгалагдсан хураангуй одоогийн гүйлгээ/параметрээс ялгаатай (дахин тооцоолох хэрэгтэй). */
  stale: boolean;
}

const warningKey = (w: AnalysisWarning): string => `${w.scope}:${w.severity}:${w.code}`;

/** BSA-FR-4.2–4.6: хураангуйн дор анхааруулгын жагсаалт, ӨОХ-ийн тойм, аргачлал ба орлого/зарлагын задаргаа (PDF тайлангийн агуулга). */
export function SummaryInsights({ details, warnings, stale }: Props) {
  return (
    <Flex vertical gap={12} data-testid="bsa-insights">
      {stale ? <Alert type="warning" showIcon message={t('bsa.insight.stale')} /> : null}
      {warnings.map((w) => <Alert key={warningKey(w)} type={w.severity === 'ERROR' ? 'error' : 'warning'} showIcon message={w.message} />)}
      {details ? <DtiOverview details={details} /> : null}
      {details ? (
        <Collapse
          items={[
            { key: 'methodology', label: t('bsa.insight.methodology'), children: <Methodology rows={details.methodology} /> },
            { key: 'breakdown', label: t('bsa.insight.breakdown'), children: <Breakdown rows={details.categories} /> },
          ]}
        />
      ) : null}
    </Flex>
  );
}

function DtiOverview({ details }: { details: BsaAnalysisDetails }) {
  const { dti, period, coverage } = details;
  return (
    <Descriptions
      size="small"
      bordered
      column={{ xs: 1, md: 2, xl: 3 }}
      items={[
        { key: 'ratio', label: t('bsa.insight.dtiRatio'), children: formatPercent(dti.dtiRatio, 1) },
        { key: 'max', label: t('bsa.insight.maxDti'), children: formatPercent(dti.maxDti, 1) },
        { key: 'meets', label: t('bsa.insight.limit'), children: <Tag color={dti.meetsLimit ? 'success' : 'error'}>{t(dti.meetsLimit ? 'bsa.insight.limit.ok' : 'bsa.insight.limit.exceeded')}</Tag> },
        { key: 'payment', label: t('bsa.insight.payment'), children: formatMnt(dti.proposedMonthlyPayment) },
        { key: 'period', label: t('bsa.insight.period'), children: `${period.from} — ${period.to} (${period.months} ${t('bsa.insight.monthUnit')})` },
        { key: 'coverage', label: t('bsa.insight.coverage'), children: `${coverage.coveredMonths}/${coverage.requiredMonths} ${t('bsa.insight.monthUnit')}` },
      ]}
    />
  );
}

function Methodology({ rows }: { rows: BsaAnalysisDetails['methodology'] }) {
  return (
    <Table
      size="small"
      rowKey="step"
      pagination={false}
      dataSource={[...rows]}
      columns={[
        { title: '#', dataIndex: 'step', width: 48 },
        { title: t('bsa.insight.col.step'), dataIndex: 'label' },
        { title: t('bsa.insight.col.formula'), dataIndex: 'formula' },
        { title: t('bsa.insight.col.value'), dataIndex: 'value', align: 'right', render: (v: number) => formatStepValue(v) },
      ]}
    />
  );
}

function Breakdown({ rows }: { rows: BsaAnalysisDetails['categories'] }) {
  const used = rows.filter((r) => r.txnCount > 0);
  return (
    <Table
      size="small"
      rowKey="code"
      pagination={false}
      dataSource={used}
      columns={[
        { title: t('bsa.insight.col.category'), dataIndex: 'name' },
        { title: t('bsa.susp.col.direction'), dataIndex: 'direction', render: (d: 'INCOME' | 'EXPENSE') => <Tag color={d === 'INCOME' ? 'green' : 'volcano'}>{t(`bsa.direction.${d}`)}</Tag> },
        { title: t('bsa.insight.col.total'), dataIndex: 'totalAmount', align: 'right', render: (v: number) => formatMnt(v) },
        { title: t('bsa.insight.col.monthly'), dataIndex: 'monthlyAvg', align: 'right', render: (v: number) => formatMnt(v) },
        { title: t('bsa.insight.col.weighted'), dataIndex: 'weightedMonthly', align: 'right', render: (v: number) => formatMnt(v) },
        { title: t('bsa.insight.col.share'), dataIndex: 'share', align: 'right', render: (v: number) => formatPercent(v, 1) },
        { title: t('bsa.insight.col.txns'), dataIndex: 'txnCount', align: 'right' },
      ]}
    />
  );
}
