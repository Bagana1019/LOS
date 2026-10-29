'use client';
import { App as AntApp, Alert, Button, Card, Collapse, Descriptions, Flex, Form, Input, InputNumber, Tag, Typography } from 'antd';
import { isManualValueAsset, type CollateralView, type SuggestValuationResponse } from '@los/contracts';
import { EMPTY_VALUE, formatDate, formatDateTime, formatMnt, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { canWriteBlocked } from './write-gates';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { buildSaveValuationRequest, isDemoSuggestion, overrideReasonRequired, suggestionWarningKey, toFieldErrors, unavailableReasonKey, valuationStatus } from './collateral.utils';
import { ExternalValuationForm } from './ExternalValuationForm';
import { applyFieldErrors } from './form-errors';
import { MONEY_INPUT_PROPS } from './money-input';
import { StatusTag } from './StatusTag';
import type { TabProps } from './TabProps';
import { ValuationHistory } from './ValuationHistory';
import { useSaveValuation, useSuggestValuation } from './useCollateral';

/** Үнэлгээ (FR-14): одоогийн үнэлгээ, системийн санал + haircut, ЗЭЗ-ийн эцсийн дүн (өөрчилбөл шалтгаан заавал), гадны лицензтэй үнэлгээ, түүх. */
export function ValuationTab({ applicationId, item, write, onChanged }: TabProps) {
  const external = item.valuation?.externalRequired && !item.valuation.externalSatisfied;
  return (
    <Flex vertical gap={16}>
      <CurrentValuation item={item} />
      <InternalValuationForm applicationId={applicationId} item={item} write={write} onChanged={onChanged} />
      <Collapse
        defaultActiveKey={external ? ['external'] : []}
        items={[
          {
            key: 'external',
            label: t('collateral.valuation.externalTitle'),
            children: <ExternalValuationForm applicationId={applicationId} item={item} write={write} onChanged={onChanged} />,
          },
          {
            key: 'history',
            label: t('collateral.valuation.historyTitle'),
            children: <ValuationHistory applicationId={applicationId} item={item} />,
          },
        ]}
      />
    </Flex>
  );
}

function CurrentValuation({ item }: { item: CollateralView }) {
  const v = item.valuation;
  const status = valuationStatus(item);
  return (
    <Card size="small" title={<Flex gap={8} align="center" wrap><Typography.Text strong>{t('collateral.valuation.current')}</Typography.Text><StatusTag tone={status.tone} textKey={status.textKey} /></Flex>} data-testid="current-valuation">
      {!v ? (
        <Typography.Text type="secondary">{t('collateral.valuation.none')}</Typography.Text>
      ) : (
        <Flex vertical gap={12}>
          {v.externalRequired && !v.externalSatisfied ? <Alert type="warning" showIcon message={t('collateral.valuation.externalRequiredAlert')} /> : null}
          {v.expired ? <Alert type="error" showIcon message={t('collateral.valuation.expiredAlert', { date: formatDate(v.validUntil) })} /> : null}
          <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
            <Descriptions.Item label={t('collateral.valuation.source')}>{t(`collateral.valuationSource.${v.source}`)}</Descriptions.Item>
            <Descriptions.Item label={t('collateral.valuation.valuedAt')}>{formatDateTime(v.valuedAt)}</Descriptions.Item>
            <Descriptions.Item label={t('collateral.valuation.marketValue')}>{formatMnt(v.marketValue)}</Descriptions.Item>
            <Descriptions.Item label={t('collateral.valuation.haircutRate')}>{formatPercent(v.haircutRate)}</Descriptions.Item>
            <Descriptions.Item label={t('collateral.valuation.collateralValue')}><Typography.Text strong>{formatMnt(v.collateralValue)}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label={t('collateral.valuation.validUntil')}>{v.validUntil ? formatDate(v.validUntil) : EMPTY_VALUE}</Descriptions.Item>
            {v.overrideReason ? <Descriptions.Item label={t('collateral.valuation.overrideReason')} span="filled">{v.overrideReason}</Descriptions.Item> : null}
          </Descriptions>
        </Flex>
      )}
    </Card>
  );
}

interface FormValues {
  marketValue?: number | null;
  overrideReason?: string;
  mileageKm?: number | null;
}

function InternalValuationForm({ applicationId, item, write, onChanged }: TabProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const suggest = useSuggestValuation(applicationId);
  const save = useSaveValuation(applicationId, onChanged);
  const marketValue = Form.useWatch('marketValue', form);
  const mileage = Form.useWatch('mileageKm', form);
  const gate = canWriteBlocked(write);

  const result: SuggestValuationResponse | undefined = suggest.data;
  const suggestion = result?.suggestion ?? null;
  const manual = result?.manualValueRequired ?? isManualValueAsset(item.assetType);
  const reasonRequired = overrideReasonRequired({ manualValueRequired: manual, suggestion, marketValue });
  const storedMileage = typeof item.description.mileageKm === 'number' ? item.description.mileageKm : undefined;

  const runSuggest = () =>
    suggest.mutate(
      { collateralId: item.id, ...(typeof mileage === 'number' ? { mileageKm: mileage } : {}) },
      {
        onSuccess: (res) => {
          // Саналыг эцсийн дүнгийн талбарт урьдчилан бөглөнө (ЗЭЗ засаж болно). Санал байхгүй бол оруулсан дүн хэвээр.
          if (res.suggestion.available && res.suggestion.marketValue !== null) form.setFieldsValue({ marketValue: res.suggestion.marketValue, overrideReason: undefined });
        },
      },
    );

  const onFinish = (values: FormValues) => {
    const built = buildSaveValuationRequest({
      assetType: item.assetType,
      marketValue: values.marketValue,
      overrideReason: values.overrideReason,
      mileageKm: values.mileageKm,
      suggestion,
      manualValueRequired: manual,
    });
    if (!built.ok) {
      applyFieldErrors(form, toFieldErrors(built.errors));
      return;
    }
    save.mutate({ collateralId: item.id, body: built.body }, { onSuccess: () => void message.success(t('collateral.toast.valuationSaved')) });
  };

  return (
    <Card size="small" title={t('collateral.valuation.internalTitle')} data-testid="internal-valuation">
      <Form<FormValues>
        name={`collateral-valuation-${item.id}`}
        form={form}
        layout="vertical"
        requiredMark="optional"
        initialValues={{ mileageKm: storedMileage }}
        onFinish={onFinish}
      >
        {item.assetType === 'VEHICLE' ? (
          <Form.Item name="mileageKm" label={t('collateral.valuation.mileage')} extra={t('collateral.valuation.mileageHint')}>
            <InputNumber<number> min={0} max={2_000_000} precision={0} style={{ width: '100%', maxWidth: 260 }} suffix={t('collateral.unit.km')} />
          </Form.Item>
        ) : null}

        <Flex vertical gap={12} style={{ marginBottom: 16 }}>
          <div>
            <Button onClick={runSuggest} loading={suggest.isPending} disabled={gate.disabled}>{t('collateral.valuation.suggest')}</Button>
          </div>
          <ApiErrorAlert error={suggest.error} scope="collateral" />
          {result ? <SuggestionPanel result={result} /> : isManualValueAsset(item.assetType) ? <Typography.Text type="secondary">{t('collateral.valuation.manualHint')}</Typography.Text> : null}
        </Flex>

        <Form.Item name="marketValue" label={t('collateral.valuation.finalValue')} required extra={t('collateral.valuation.finalValueHint')}>
          <InputNumber<number> {...MONEY_INPUT_PROPS} style={{ width: '100%', maxWidth: 320 }} />
        </Form.Item>
        {reasonRequired ? (
          <Form.Item name="overrideReason" label={t('collateral.valuation.overrideReason')} required extra={t('collateral.valuation.overrideReasonHint')}>
            <Input.TextArea rows={2} maxLength={500} showCount />
          </Form.Item>
        ) : null}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{t('collateral.valuation.formulaNote')}</Typography.Paragraph>

        <ApiErrorAlert error={save.error} scope="collateral" />
        <div style={{ marginTop: save.error ? 12 : 0 }}>
          <Button type="primary" htmlType="submit" loading={save.isPending} disabled={gate.disabled} title={gate.text}>{t('collateral.valuation.save')}</Button>
        </div>
      </Form>
    </Card>
  );
}

const CONFIDENCE_COLOR = { HIGH: 'success', MEDIUM: 'warning', LOW: 'error' } as const;

function SuggestionPanel({ result }: { result: SuggestValuationResponse }) {
  const { suggestion: s, haircut } = result;
  const demo = isDemoSuggestion(s, haircut.source);
  return (
    <Card size="small" type="inner" title={<Flex gap={8} align="center" wrap><Typography.Text strong>{t('collateral.valuation.suggestionTitle')}</Typography.Text>{demo ? <Tag color="purple" style={{ marginInlineEnd: 0 }}>{t('collateral.valuation.demoTag')}</Tag> : null}</Flex>} data-testid="suggestion-panel">
      <Flex vertical gap={10}>
        {!s.available ? (
          <Alert type="info" showIcon message={t(s.unavailableReason ? unavailableReasonKey(s.unavailableReason) : 'collateral.unavailableReason.UNKNOWN')} />
        ) : (
          <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
            <Descriptions.Item label={t('collateral.valuation.method')}>{s.method ? t(`collateral.valuationMethod.${s.method}`) : EMPTY_VALUE}</Descriptions.Item>
            <Descriptions.Item label={t('collateral.valuation.suggestedValue')}><Typography.Text strong data-testid="suggested-value">{formatMnt(s.marketValue)}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label={t('collateral.valuation.range')}>{s.lowValue !== null && s.highValue !== null ? `${formatMnt(s.lowValue)} – ${formatMnt(s.highValue)}` : EMPTY_VALUE}</Descriptions.Item>
            <Descriptions.Item label={t('collateral.valuation.confidence')}>
              {s.confidence ? <Tag color={CONFIDENCE_COLOR[s.confidence]} style={{ marginInlineEnd: 0 }}>{t(`collateral.confidence.${s.confidence}`)}</Tag> : EMPTY_VALUE}
            </Descriptions.Item>
          </Descriptions>
        )}
        <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label={t('collateral.valuation.haircutRate')}><Typography.Text strong data-testid="haircut-rate">{formatPercent(haircut.rate)}</Typography.Text></Descriptions.Item>
          <Descriptions.Item label={t('collateral.valuation.haircutSource')}>
            {t(`collateral.haircutSource.${haircut.source}`)}
            {haircut.source === 'DEMO_DEFAULT' ? <Tag color="purple" style={{ marginInlineStart: 8 }}>{t('collateral.valuation.demoTag')}</Tag> : null}
          </Descriptions.Item>
        </Descriptions>
        {s.warnings.length > 0 ? (
          <Flex vertical gap={6}>
            {s.warnings.map((w) => (
              <Alert key={w} type={w === 'DEMO_PARAMETERS' ? 'info' : 'warning'} showIcon message={t(suggestionWarningKey(w))} />
            ))}
          </Flex>
        ) : null}
      </Flex>
    </Card>
  );
}
