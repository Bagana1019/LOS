import { Alert, Card, Descriptions, Flex, Tag, Typography } from 'antd';
import type { DecisionRisk } from '@los/contracts';
import { EMPTY_VALUE, formatDateTime, formatMnt, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { formatRatioLimit, formatRatioValue, methodLabel } from './decision.risk';

interface Props { risk: DecisionRisk | null | undefined }

const verdictTag = (pass: boolean | null) => (pass == null ? null : <Tag color={pass ? 'success' : 'error'} style={{ marginLeft: 8 }}>{t(pass ? 'score.verdict.pass' : 'score.verdict.fail')}</Tag>);

/**
 * F3-1: батлагчид зориулсан «Эрсдэлийн хураангуй» карт. Зөвхөн сервер хадгалсан үр дүнг харуулна (ӨОХ/ӨТЧХ, LTV, Sosco, барьцаа, орлого, анхааруулга) —
 * UI-д тооцоолол хийхгүй. Тооцоолол хадгалагдаагүй бол хоосон карт биш, тодорхой мэдээлэл.
 */
export function RiskSummaryCard({ risk }: Props) {
  if (!risk) return <Alert type="info" showIcon data-testid="risk-missing" message={t('decide.risk.title')} description={t('decide.risk.missing')} />;
  const { ratio, ltv, sosco, collateral, income } = risk;
  return (
    <Card
      size="small" data-testid="risk-card" title={t('decide.risk.title')}
      extra={(
        <Flex gap={8} align="center">
          {risk.stale ? <Tag color="warning" data-testid="risk-stale">{t('decide.risk.stale')}</Tag> : null}
          <Typography.Text type="secondary">{t('decide.risk.computedAt', { date: formatDateTime(risk.computedAt) })}</Typography.Text>
        </Flex>
      )}
    >
      <Descriptions size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label={t('decide.risk.method')}>
          <span data-testid="risk-method">{methodLabel(risk.method)}</span>
          {risk.selection ? <Tag style={{ marginLeft: 8 }}>{t(`decide.risk.selection.${risk.selection}`)}</Tag> : null}
        </Descriptions.Item>
        <Descriptions.Item label={ratio ? t(`score.ratio.${ratio.kind}`) : `${t('score.ratio.DTI')} / ${t('score.ratio.DSCR')}`}>
          <span data-testid="risk-ratio">{ratio ? formatRatioValue(ratio.kind, ratio.value) : EMPTY_VALUE}</span>
          {ratio ? <Typography.Text type="secondary"> ({formatRatioLimit(ratio.kind, ratio.limit)})</Typography.Text> : null}
          {ratio ? verdictTag(ratio.pass) : null}
        </Descriptions.Item>
        <Descriptions.Item label={t('decide.risk.ltv')}>
          <span data-testid="risk-ltv">{formatPercent(ltv.value)}</span>
          <Typography.Text type="secondary"> ({t('decide.risk.limitMax', { value: formatPercent(ltv.limit) })})</Typography.Text>
          {verdictTag(ltv.pass)}
        </Descriptions.Item>
        <Descriptions.Item label={t('decide.risk.sosco')}>
          <span data-testid="risk-sosco">{sosco.score ?? EMPTY_VALUE}</span>
          {sosco.score != null ? <Typography.Text type="secondary"> {t('score.sosco.scale')}</Typography.Text> : null}
          {sosco.grade ? <Tag style={{ marginLeft: 8 }}>{t('score.sosco.grade')} {sosco.grade}</Tag> : null}
        </Descriptions.Item>
        <Descriptions.Item label={t('decide.risk.collateral')}>
          <span data-testid="risk-collateral">{!collateral.required && collateral.count === 0 ? t('decide.risk.collateral.none') : t('decide.risk.collateral.value', { count: collateral.count, total: formatMnt(collateral.totalValue) })}</span>
        </Descriptions.Item>
        <Descriptions.Item label={t('decide.risk.income.salary')}><span data-testid="risk-income-salary">{formatMnt(income.salaryMonthly)}</span></Descriptions.Item>
        <Descriptions.Item label={t('decide.risk.income.ncf')}><span data-testid="risk-income-ncf">{formatMnt(income.businessNcfMonthly)}</span></Descriptions.Item>
        <Descriptions.Item label={t('decide.risk.income.expense')}><span data-testid="risk-income-expense">{formatMnt(income.householdExpenseMonthly)}</span></Descriptions.Item>
      </Descriptions>
      <Flex vertical gap={4} style={{ marginTop: 8 }}>
        <Typography.Text strong>{t('decide.risk.flags')}</Typography.Text>
        {risk.flags.length
          ? risk.flags.map((f) => <Alert key={`${f.code}|${f.message}`} type={f.level === 'error' ? 'error' : 'warning'} showIcon message={f.message} data-testid="risk-flag" />)
          : <Typography.Text type="secondary" data-testid="risk-no-flags">{t('decide.risk.noFlags')}</Typography.Text>}
      </Flex>
    </Card>
  );
}
