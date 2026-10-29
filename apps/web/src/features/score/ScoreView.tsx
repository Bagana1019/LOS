'use client';
import type { CSSProperties } from 'react';
import { CalculatorOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Empty, Flex, Row, Skeleton, Tag, Typography } from 'antd';
import type { CalcMethod, ScoreOverview, ScoreTerms } from '@los/contracts';
import { t } from '../../lib/i18n';
import { CollateralCard } from './CollateralCard';
import { MethodComparison } from './MethodComparison';
import { PolicyStrip } from './PolicyStrip';
import { ReasonList } from './ReasonList';
import { ScoreErrorAlert } from './ScoreErrorAlert';
import { SelectMethodModal } from './SelectMethodModal';
import { SoscoCard } from './SoscoCard';
import { StressCard } from './StressCard';
import { TermSliders } from './TermSliders';
import { calculateBlock, formatDateTime, formatTermsSummary, methodKey, selectionBlock, sourceResult, type ViewSource } from './score.utils';

const srOnly: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

export interface ScoreViewModel {
  applicationId: string;
  overview: ScoreOverview;
  source: ViewSource;
  /** Slider-ийн одоогийн утга */
  draft: ScoreTerms | null;
  dirty: boolean;
  previewPending: boolean;
  previewError: unknown;
  /** Overview дахин татахад алдаа (хуучин өгөгдөл харагдсаар) */
  refreshError: unknown;
  calculating: boolean;
  calculateError: unknown;
  /** Баталгаажуулалт хүлээж буй арга (modal) */
  selectTarget: CalcMethod | null;
  selecting: boolean;
  selectError: unknown;
  /** Дэлгэц уншигчид зарлах мессеж (хадгалсан, сонгосон) */
  announcement: string;
}

export interface ScoreViewActions {
  onTermsChange: (patch: Partial<ScoreTerms>) => void;
  onResetTerms: () => void;
  onCalculate: () => void;
  onRetryPreview: () => void;
  onRetryRefresh: () => void;
  onPick: (method: CalcMethod) => void;
  onConfirmSelect: (reason: string) => void;
  onCancelSelect: () => void;
}

export function ScoreSkeleton() {
  return (
    <Flex vertical gap={16} aria-busy="true" aria-label={t('score.loading')} role="status">
      <Skeleton active title={{ width: 240 }} paragraph={{ rows: 1 }} />
      <Card size="small"><Skeleton active paragraph={{ rows: 5 }} /></Card>
      <Card size="small"><Skeleton active paragraph={{ rows: 8 }} /></Card>
      <Card size="small"><Skeleton active paragraph={{ rows: 4 }} /></Card>
    </Flex>
  );
}

/** Серверийн `staleReason` нь машины код (BORROWERS_CHANGED …) байж болно — түүхий кодыг хэрэглэгчид харуулахгүй; танигдаагүй код → ерөнхий тайлбар. */
function staleDescription(reason: string | null | undefined): string {
  if (!reason) return t('score.alert.stale.default');
  if (reason === 'BORROWERS_CHANGED') return t('score.alert.stale.reason', { reason: t('score.alert.stale.reasons.BORROWERS_CHANGED') });
  if (/^[A-Z][A-Z0-9_]*$/.test(reason)) return t('score.alert.stale.default');
  return t('score.alert.stale.reason', { reason });
}

/** Wizard-ийн 7-р алхам "Тооцоолол" (`/los/loan-application/:id/score`)-ийн дүрслэл. Төлөв, мутацийг `ScoreStep` барина. FR-8.1…8.6. */
export function ScoreView({ model, actions }: { model: ScoreViewModel; actions: ScoreViewActions }) {
  const { applicationId, overview, source, draft, dirty, previewPending, previewError } = model;
  const result = sourceResult(source);
  const saved = source.kind === 'saved' ? source : null;
  const selectedMethod = saved ? saved.calculation.selectedMethod : null;
  const block = selectionBlock({ editable: overview.editable, source, busy: model.selecting });
  const calcBlock = calculateBlock(overview);
  const hasBlockers = overview.blockers.length > 0;
  const stale = saved?.calculation.isStale === true;

  const calcHint = calcBlock ? t(`score.calculate.disabled.${calcBlock}`) : dirty ? t('score.calculate.hintDirty') : t('score.calculate.hint');

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap>
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('score.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('score.subtitle')}</Typography.Text>
          <Flex gap={8} wrap style={{ marginTop: 8 }} data-testid="score-status">
            {source.kind === 'none' ? <Tag style={{ marginInlineEnd: 0 }}>{t('score.status.none')}</Tag> : null}
            {saved ? <Tag color="blue" style={{ marginInlineEnd: 0, whiteSpace: 'normal' }}>{t('score.status.saved', { at: formatDateTime(saved.calculation.computedAt) })}</Tag> : null}
            {source.kind === 'preview' ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>{t('score.status.preview')}</Tag> : null}
            {stale ? <Tag color="warning" style={{ marginInlineEnd: 0 }}>{t('score.status.stale')}</Tag> : null}
            {saved?.calculation.selectedMethod ? (
              <Tag color="geekblue" style={{ marginInlineEnd: 0, whiteSpace: 'normal' }}>
                {t('score.status.selected', { method: t(methodKey(saved.calculation.selectedMethod)) })}
                {saved.calculation.selection ? ` · ${t(`score.selection.${saved.calculation.selection}`)}` : ''}
              </Tag>
            ) : null}
          </Flex>
        </div>
        <Flex vertical gap={4} align="flex-end" style={{ flex: '0 1 340px', minWidth: 0 }}>
          <Button
            type="primary"
            icon={<CalculatorOutlined aria-hidden />}
            loading={model.calculating}
            disabled={calcBlock !== null}
            aria-describedby="score-calc-hint"
            onClick={actions.onCalculate}
          >
            {t('score.action.calculate')}
          </Button>
          <Typography.Text id="score-calc-hint" type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>{calcHint}</Typography.Text>
        </Flex>
      </Flex>

      <Flex vertical gap={12}>
        {hasBlockers ? (
          <Alert
            type="warning"
            showIcon
            message={t('score.alert.blockers.title')}
            description={
              <Flex vertical gap={8}>
                <span>{t('score.alert.blockers.hint')}</span>
                <ReasonList applicationId={applicationId} reasons={overview.blockers} />
              </Flex>
            }
          />
        ) : null}
        {!overview.editable ? <Alert type="info" showIcon message={t('score.alert.notEditable')} /> : null}
        {stale ? (
          <Alert
            type="warning"
            showIcon
            message={t('score.alert.stale.title')}
            description={staleDescription(saved?.calculation.staleReason)}
            action={calcBlock === null ? <Button size="small" type="primary" ghost loading={model.calculating} onClick={actions.onCalculate}>{t('score.action.recalculate')}</Button> : undefined}
          />
        ) : null}
        {source.kind === 'preview' ? (
          <Alert
            type="info"
            showIcon
            message={t(`score.alert.preview.${source.basis}.title`)}
            description={t(`score.alert.preview.${source.basis}.text`, { terms: formatTermsSummary(source.terms, t) })}
          />
        ) : null}
        {saved?.fallback ? <Alert type="info" showIcon message={t('score.alert.fallback')} /> : null}
        {model.refreshError ? <ScoreErrorAlert error={model.refreshError} title={t('score.alert.refreshError')} onRetry={actions.onRetryRefresh} alwaysRetry /> : null}
        {model.calculateError ? <ScoreErrorAlert error={model.calculateError} title={t('score.error.calculateTitle')} onRetry={actions.onCalculate} /> : null}
      </Flex>

      {result ? <PolicyStrip policy={result.policy} /> : null}

      <TermSliders
        applicationId={applicationId}
        terms={draft}
        limits={overview.limits}
        savedTerms={overview.terms}
        dirty={dirty}
        result={result}
        selected={selectedMethod}
        pending={previewPending}
        previewError={previewError}
        disabled={hasBlockers}
        onChange={actions.onTermsChange}
        onReset={actions.onResetTerms}
        onRetryPreview={actions.onRetryPreview}
      />

      {result ? (
        <>
          <Card title={t('score.compare.title')} size="small" role="region" aria-label={t('score.compare.title')}>
            <MethodComparison
              applicationId={applicationId}
              result={result}
              selected={selectedMethod}
              selection={saved?.calculation.selection ?? null}
              block={block}
              savingMethod={model.selecting ? model.selectTarget : null}
              dim={previewPending}
              onPick={actions.onPick}
            />
          </Card>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}><CollateralCard applicationId={applicationId} collateral={result.collateral} dim={previewPending} /></Col>
            <Col xs={24} lg={12}><StressCard stress={result.stress} dim={previewPending} /></Col>
          </Row>
        </>
      ) : (
        <Card size="small" role="region" aria-label={t('score.compare.title')}>
          {previewPending ? <Skeleton active paragraph={{ rows: 6 }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('score.empty.noSource')} />}
        </Card>
      )}

      <SoscoCard sosco={overview.sosco} previewing={source.kind === 'preview'} />

      <SelectMethodModal method={model.selectTarget} loading={model.selecting} error={model.selectError} onConfirm={actions.onConfirmSelect} onCancel={actions.onCancelSelect} />
      <div role="status" aria-live="polite" aria-atomic="true" style={srOnly} data-testid="score-announcer">{model.announcement}</div>
    </Flex>
  );
}
