'use client';
import type { ReactElement } from 'react';
import { Col, Form, Input, Row, Select } from 'antd';
import type { Rule } from 'antd/es/form';
import type { AssetType } from '@los/contracts';
import { MAX_MONEY, MoneyInput, moneyRules } from '../../components/form';
import { t } from '../../lib/i18n';
import { PlainNumberInput } from '../admin/PlainNumberInput';
import { plainNumberRules } from '../admin/plain-number-rules';
import { FIELD_SPECS, fieldLabelKey, formNamePath, optionLabelKey, type FieldSpec } from './collateral.fields';

// Form.Item нь value/onChange/id-г шууд child элементэд шахдаг тул бүрэлдэхүүн биш, элемент буцаадаг функц.
// Тоон талбар: antd InputNumber-ийн оронд текст оролт — "5сая"→5, "-5"→0 гэж чимээгүй засахгүй (F2-8). Хүрээг (он, талбай…) submit дээр гэрээний zod схем шалгана.
function controlFor(spec: FieldSpec): ReactElement {
  const placeholder = spec.placeholderKey ? t(spec.placeholderKey) : undefined;
  switch (spec.kind) {
    case 'integer':
    case 'decimal':
      return <PlainNumberInput suffix={spec.unitKey ? t(spec.unitKey) : undefined} placeholder={placeholder} />;
    case 'money':
      return <MoneyInput placeholder={placeholder} />;
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

/** Тоон талбарын "тоо биш текст / бүхэл биш / хэт нарийн" шалгалт — submit-ийг барина, ингэснээр `cleanDescription` NaN-ийг чимээгүй хасахгүй. */
function numberRules(spec: FieldSpec): Rule[] | undefined {
  const label = t(fieldLabelKey(spec.name));
  switch (spec.kind) {
    case 'integer':
      return plainNumberRules({ label, integer: true });
    case 'decimal':
      return plainNumberRules({ label });
    case 'money':
      return moneyRules({ label, max: MAX_MONEY });
    default:
      return undefined;
  }
}

/** Хөрөнгийн төрлөөр динамик талбарууд (FIELD_SPECS). Шалгалтыг submit үед `@los/contracts`-ийн zod схем хийнэ (`buildCreateRequest`). */
export function CollateralFormFields({ assetType }: { assetType: AssetType | undefined }) {
  if (!assetType) return null;
  return (
    <Row gutter={16}>
      {FIELD_SPECS[assetType].map((spec) => (
        <Col key={spec.name} xs={24} sm={spec.wide ? 24 : 12}>
          <Form.Item name={formNamePath(spec.name)} label={t(fieldLabelKey(spec.name))} required={spec.required} extra={spec.extraKey ? t(spec.extraKey) : undefined} rules={numberRules(spec)}>
            {controlFor(spec)}
          </Form.Item>
        </Col>
      ))}
    </Row>
  );
}
