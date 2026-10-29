'use client';
import type { ReactElement } from 'react';
import { Col, Form, Input, InputNumber, Row, Select } from 'antd';
import type { AssetType } from '@los/contracts';
import { t } from '../../lib/i18n';
import { FIELD_SPECS, fieldLabelKey, formNamePath, optionLabelKey, type FieldSpec } from './collateral.fields';
import { MONEY_INPUT_PROPS } from './money-input';

// Form.Item нь value/onChange/id-г шууд child элементэд шахдаг тул бүрэлдэхүүн биш, элемент буцаадаг функц.
function controlFor(spec: FieldSpec): ReactElement {
  const placeholder = spec.placeholderKey ? t(spec.placeholderKey) : undefined;
  switch (spec.kind) {
    case 'integer':
      return <InputNumber<number> precision={0} style={{ width: '100%' }} suffix={spec.unitKey ? t(spec.unitKey) : undefined} placeholder={placeholder} />;
    case 'decimal':
      return <InputNumber<number> min={0} style={{ width: '100%' }} suffix={spec.unitKey ? t(spec.unitKey) : undefined} placeholder={placeholder} />;
    case 'money':
      return <InputNumber<number> {...MONEY_INPUT_PROPS} placeholder={placeholder} />;
    case 'select':
      return (
        <Select
          allowClear={!spec.required}
          placeholder={t('collateral.form.choose')}
          options={(spec.options ?? []).map((value) => ({ value, label: t(optionLabelKey(spec, value)) }))}
        />
      );
    case 'date':
      return <Input type="date" />;
    case 'textarea':
      return <Input.TextArea rows={3} maxLength={spec.maxLength} showCount />;
    default:
      return <Input maxLength={spec.maxLength} placeholder={placeholder} autoComplete="off" />;
  }
}

/** Хөрөнгийн төрлөөр динамик талбарууд (FIELD_SPECS). Шалгалтыг submit үед `@los/contracts`-ийн zod схем хийнэ (`buildCreateRequest`). */
export function CollateralFormFields({ assetType }: { assetType: AssetType | undefined }) {
  if (!assetType) return null;
  return (
    <Row gutter={16}>
      {FIELD_SPECS[assetType].map((spec) => (
        <Col key={spec.name} xs={24} sm={spec.wide ? 24 : 12}>
          <Form.Item name={formNamePath(spec.name)} label={t(fieldLabelKey(spec.name))} required={spec.required} extra={spec.extraKey ? t(spec.extraKey) : undefined}>
            {controlFor(spec)}
          </Form.Item>
        </Col>
      ))}
    </Row>
  );
}
