'use client';
import { Alert, Button, Flex, Tag, Typography } from 'antd';
import Link from 'next/link';
import type { CollateralGate, CollateralView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { describeCollateral } from './collateral.fields';
import { assetTypeKey, describeIssue, sortIssues, stepHref, type DetailTab } from './collateral.utils';

interface Props {
  applicationId: string;
  gate: CollateralGate;
  collaterals: readonly CollateralView[];
  /** Барьцааг дэлгэрэнгүй самбарт тухайн табаар нээнэ. */
  onOpen: (collateralId: string, tab: DetailTab) => void;
  onAdd?: () => void;
  canAdd: boolean;
}

/**
 * G0 хаалтыг хангаагүй шалтгаанууд (docs/05 §6). Код бүр i18n-ийн гарчиг ба «юу хийх» зөвлөмжтэй; API-ийн монгол мессеж (тоо, хүсэлтийн дугаар) тодруулга болж доор гарна.
 * Код нь i18n-д байхгүй (шинэ) бол API-ийн мессеж гарчиг болно.
 */
export function GateIssueList({ applicationId, gate, collaterals, onOpen, onAdd, canAdd }: Props) {
  if (gate.issues.length === 0) {
    return <Alert type="success" showIcon message={t(gate.skipped ? 'collateral.gate.skipped' : 'collateral.gate.complete')} />;
  }
  const labelOf = (id: string): string | null => {
    const c = collaterals.find((x) => x.id === id);
    return c ? `${t(assetTypeKey(c.assetType))}: ${describeCollateral(c.assetType, c.description)}` : null;
  };
  const issues = sortIssues(gate.issues, collaterals.map((c) => c.id)).map(describeIssue);
  return (
    <Alert
      type="warning"
      showIcon
      message={t('collateral.gate.incompleteTitle', { count: issues.length })}
      description={
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }} aria-label={t('collateral.gate.issuesLabel')} data-testid="gate-issues">
          {issues.map((issue, index) => {
            const target = issue.target;
            const label = issue.collateralId ? labelOf(issue.collateralId) : null;
            return (
              <li key={`${issue.code}:${issue.collateralId ?? ''}:${index}`} data-testid="gate-issue" data-code={issue.code} style={{ padding: '8px 0', borderTop: index === 0 ? undefined : '1px solid rgba(0,0,0,0.06)' }}>
                <Flex justify="space-between" align="flex-start" gap={12} wrap>
                  <Flex vertical gap={2} style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <Flex gap={8} align="center" wrap>
                      <Tag color={issue.severity === 'error' ? 'error' : 'warning'} style={{ marginInlineEnd: 0 }}>{t(`collateral.issue.severity.${issue.severity}`)}</Tag>
                      <Typography.Text strong>{issue.title}</Typography.Text>
                      {label ? <Typography.Text type="secondary">{label}</Typography.Text> : null}
                    </Flex>
                    {issue.message ? <Typography.Text type="secondary">{issue.message}</Typography.Text> : null}
                    {issue.hint ? <Typography.Text>{issue.hint}</Typography.Text> : null}
                  </Flex>
                  {target?.kind === 'tab' && issue.collateralId ? (
                    <Button size="small" onClick={() => onOpen(issue.collateralId as string, target.tab)} aria-label={`${t('collateral.gate.open')}: ${issue.title}`}>
                      {t('collateral.gate.open')}
                    </Button>
                  ) : null}
                  {target?.kind === 'step' ? (
                    <Link href={stepHref(applicationId, target.step)}>{t(`collateral.gate.goStep.${target.step}`)}</Link>
                  ) : null}
                  {target?.kind === 'add' && onAdd ? (
                    <Button size="small" onClick={onAdd} disabled={!canAdd}>{t('collateral.action.add')}</Button>
                  ) : null}
                </Flex>
              </li>
            );
          })}
        </ul>
      }
    />
  );
}
