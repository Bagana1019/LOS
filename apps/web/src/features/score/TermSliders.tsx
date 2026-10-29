'use client';
import Link from 'next/link';
import { Button, Card, Flex, InputNumber, Slider, Space, Typography, theme } from 'antd';
import type { CalcMethod, ScoreLimits, ScoreTerms, UnderwriteResult } from '@los/contracts';
import { t } from '../../lib/i18n';
import { LiveNumbers } from './LiveNumbers';
import { ScoreErrorAlert } from './ScoreErrorAlert';
import { checkTerms, formatMoney, formatTermsSummary, groupDigits, parseGrouped, sliderSpecs, stepHref, type SliderSpec } from './score.utils';

interface FieldProps {
  id: string;
  label: string;
  spec: SliderSpec;
  /** Шууд оруулах алхам (slider-ийнхээс нарийн байж болно) */
  inputStep: number;
  value: number;
  ok: boolean;
  unit: string;
  precision?: number;
  money?: boolean;
  formatValue: (v: number) => string;
  minText: string;
  maxText: string;
  disabled: boolean;
  onChange: (v: number) => void;
}

function TermField({ id, label, spec, inputStep, value, ok, unit, precision, money, formatValue, minText, maxText, disabled, onChange }: FieldProps) {
  const { token } = theme.useToken();
  const hintId = `${id}-hint`;
  return (
    <div data-field={id} style={{ minWidth: 0 }}>
      <label htmlFor={id} style={{ display: 'block', fontWeight: 500, marginBottom: 4 }}>{label}</label>
      <Slider
        style={{ marginInline: 6 }}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={Math.min(Math.max(value, spec.min), spec.max)}
        disabled={spec.fixed || disabled}
        onChange={(v) => onChange(v)}
        ariaLabelForHandle={label}
        ariaValueTextFormatterForHandle={(v) => formatValue(v)}
        tooltip={{ formatter: (v) => (v === undefined ? '' : formatValue(v)) }}
      />
      <Space.Compact block>
        <InputNumber
          id={id}
          style={{ width: '100%' }}
          // min/max-ийг InputNumber-д ЗОРИУД өгөхгүй: rc-input-number хязгаараас гарсан бичсэн утгад onChange дуудахгүй тул "улаан + preview-гүй" төлөв үүсэхгүй.
          // Хязгаарыг `checkTerms`/`ok` шалгана; a11y-д aria-valuemin/max-аар мэдэгдэнэ.
          aria-valuemin={spec.min}
          aria-valuemax={spec.max}
          step={inputStep}
          precision={precision}
          value={value}
          status={ok ? undefined : 'error'}
          disabled={disabled}
          controls
          {...(money ? { formatter: (v: number | string | undefined) => groupDigits(v), parser: (v: string | undefined) => parseGrouped(v) as unknown as number } : {})}
          aria-describedby={hintId}
          aria-invalid={!ok}
          onChange={(v) => {
            if (typeof v === 'number' && Number.isFinite(v)) onChange(v);
          }}
        />
        <Space.Addon>{unit}</Space.Addon>
      </Space.Compact>
      <div id={hintId} style={{ fontSize: 12, marginTop: 4, color: ok ? token.colorTextSecondary : token.colorError }}>
        {t(ok ? 'score.terms.range' : 'score.terms.outOfRange', { min: minText, max: maxText })}
      </div>
    </div>
  );
}

interface Props {
  applicationId: string;
  terms: ScoreTerms | null;
  limits: ScoreLimits | null;
  /** Серверийн хадгалсан нөхцөл (slider өөрчлөгдсөн бол харьцуулахад) */
  savedTerms: ScoreTerms | null;
  dirty: boolean;
  /** Шууд тоонуудын эх: сонгогдсон үр дүн (preview эсвэл хадгалсан) */
  result: UnderwriteResult | null;
  selected: CalcMethod | null;
  pending: boolean;
  previewError: unknown;
  /** Хадгалсан тооцооллын нөхцөл байхгүй, саадтай үед slider идэвхгүй */
  disabled: boolean;
  onChange: (patch: Partial<ScoreTerms>) => void;
  onReset: () => void;
  onRetryPreview: () => void;
}

/** FR-8.3: дүн / хугацаа / хүү slider + тоон оролт (бүтээгдэхүүний хязгаарт, BR-6); шууд сарын төлбөр, нийт өрийн үйлчилгээ, хүүгийн орлого. */
export function TermSliders({ applicationId, terms, limits, savedTerms, dirty, result, selected, pending, previewError, disabled, onChange, onReset, onRetryPreview }: Props) {
  const { token } = theme.useToken();
  const specs = limits ? sliderSpecs(limits) : null;
  const check = terms ? checkTerms(terms, limits) : null;
  const usable = Boolean(terms && specs && !disabled);

  return (
    <Card title={t('score.terms.title')} size="small" role="region" aria-label={t('score.terms.title')}>
      <Flex vertical gap={16}>
        <Typography.Text type="secondary">{t('score.terms.hint')}</Typography.Text>

        {!terms ? (
          <Typography.Text type="secondary">{t('score.terms.missing')}</Typography.Text>
        ) : !specs ? (
          <Typography.Text type="secondary">{t('score.terms.noLimits')}</Typography.Text>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 }}>
            <TermField
              id="score-amount"
              label={t('score.terms.amount')}
              spec={specs.amount}
              inputStep={specs.amount.step}
              value={terms.amount}
              ok={check!.amount}
              unit="₮"
              money
              formatValue={formatMoney}
              minText={formatMoney(specs.amount.min)}
              maxText={formatMoney(specs.amount.max)}
              disabled={!usable}
              onChange={(v) => onChange({ amount: v })}
            />
            <TermField
              id="score-term"
              label={t('score.terms.termMonths')}
              spec={specs.termMonths}
              inputStep={1}
              precision={0}
              value={terms.termMonths}
              ok={check!.termMonths}
              unit={t('score.terms.unit.month')}
              formatValue={(v) => `${v} ${t('score.terms.unit.month')}`}
              minText={String(specs.termMonths.min)}
              maxText={String(specs.termMonths.max)}
              disabled={!usable}
              onChange={(v) => onChange({ termMonths: Math.round(v) })}
            />
            <TermField
              id="score-rate"
              label={t('score.terms.interestRate')}
              spec={specs.interestRate}
              inputStep={specs.interestRate.inputStep}
              precision={2}
              value={terms.interestRate}
              ok={check!.interestRate}
              unit="%"
              formatValue={(v) => `${v}%`}
              minText={`${specs.interestRate.min}%`}
              maxText={`${specs.interestRate.max}%`}
              disabled={!usable}
              onChange={(v) => onChange({ interestRate: v })}
            />
          </div>
        )}

        {dirty && savedTerms ? (
          <Flex align="center" gap={8} wrap data-testid="score-dirty">
            <Typography.Text type="secondary">{t('score.terms.saved', { terms: formatTermsSummary(savedTerms, t) })}</Typography.Text>
            <Button size="small" onClick={onReset}>{t('score.action.reset')}</Button>
          </Flex>
        ) : null}
        {terms && check && !(check.amount && check.termMonths && check.interestRate) ? (
          <Typography.Text type="warning">{t('score.terms.invalid')}</Typography.Text>
        ) : null}
        <Link href={stepHref(applicationId, 'loan')} style={{ color: token.colorLink }}>{t('score.action.openLoan')}</Link>

        <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 12 }}>
          <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>{t('score.live.title')}</Typography.Text>
          <LiveNumbers result={result} selected={selected} pending={pending} />
        </div>
        {previewError ? <ScoreErrorAlert error={previewError} title={t('score.error.previewTitle')} onRetry={onRetryPreview} /> : null}
      </Flex>
    </Card>
  );
}
