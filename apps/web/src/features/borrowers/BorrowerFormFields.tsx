'use client';
import { Form, Input, InputNumber, Radio, Select, Switch } from 'antd';
import { MAX_GUARANTEE_AMOUNT, type BorrowerRole, type GuaranteeType } from '@los/contracts';
import { t } from '../../lib/i18n';
import { GUARANTEE_TYPES, RELATIONS, groupDigits, guaranteeTypeKey, relationKey, visibleFields } from './borrowers.utils';

interface Props {
  role: BorrowerRole | undefined;
  guaranteeType: GuaranteeType | null | undefined;
  /** Хамтран зээлдэгчдийн хувийн нийлбэрээс үлдсэн хувь (%) — энэ хүнийг оруулахгүй тооцсон. */
  remainingPercent: number;
}

const MIN_PERCENT = 0.01;
const MIN_AMOUNT = 0.01;

/**
 * Дүрээс хамаарсан талбарууд (add/edit-д нийтлэг). Талбарын харагдац нь backend-ийн checkRoleFields-тэй уялдана:
 * холбоо — PRIMARY-д үгүй; хувь — CO_BORROWER; төрөл/дүн — GUARANTOR; орлого нэгтгэх — PRIMARY/CO_BORROWER.
 */
export function BorrowerFormFields({ role, guaranteeType, remainingPercent }: Props) {
  const show = visibleFields(role, guaranteeType);
  const shareMessage =
    remainingPercent < MIN_PERCENT ? t('borrower.form.liabilityShareNone') : t('borrower.form.liabilityShareRange', { max: `${remainingPercent}%` });

  return (
    <>
      {show.relationToPrimary ? (
        <Form.Item name="relationToPrimary" label={t('borrower.form.relation')}>
          <Select allowClear placeholder={t('borrower.form.relationPlaceholder')} options={RELATIONS.map((r) => ({ value: r, label: t(relationKey(r)) }))} />
        </Form.Item>
      ) : null}

      {show.liabilityShare ? (
        <Form.Item
          name="liabilityPercent"
          label={t('borrower.form.liabilityShare')}
          extra={t('borrower.form.liabilityShareExtra', { remaining: remainingPercent })}
          rules={[{ type: 'number', min: MIN_PERCENT, max: remainingPercent, message: shareMessage }]}
        >
          <InputNumber min={0} max={100} precision={2} step={5} suffix="%" style={{ width: 200 }} />
        </Form.Item>
      ) : null}

      {show.guaranteeType ? (
        <Form.Item name="guaranteeType" label={t('borrower.form.guaranteeType')}>
          <Radio.Group optionType="button" buttonStyle="solid" options={GUARANTEE_TYPES.map((g) => ({ value: g, label: t(guaranteeTypeKey(g)) }))} />
        </Form.Item>
      ) : null}

      {show.guaranteeAmount ? (
        <Form.Item
          name="guaranteeAmount"
          label={t('borrower.form.guaranteeAmount')}
          rules={[
            { required: true, message: t('borrower.form.guaranteeAmountRequired') },
            { type: 'number', min: MIN_AMOUNT, message: t('borrower.form.guaranteeAmountMin') },
            { type: 'number', max: MAX_GUARANTEE_AMOUNT, message: t('borrower.form.guaranteeAmountMax', { max: groupDigits(MAX_GUARANTEE_AMOUNT) }) },
          ]}
        >
          <InputNumber<number>
            min={0}
            max={MAX_GUARANTEE_AMOUNT}
            precision={2}
            controls={false}
            suffix="₮"
            style={{ width: 260 }}
            formatter={(value) => groupDigits(value)}
            parser={(display) => (display ?? '').replace(/,/g, '') as unknown as number} // antd: parser нь тоон мөр буцааж болно
          />
        </Form.Item>
      ) : null}

      {show.incomeIncluded ? (
        <Form.Item name="incomeIncluded" label={t('borrower.form.incomeIncluded')} valuePropName="checked" extra={t('borrower.form.incomeIncludedExtra')}>
          <Switch checkedChildren={t('borrower.common.yes')} unCheckedChildren={t('borrower.common.no')} />
        </Form.Item>
      ) : null}

      {show.note ? (
        <Form.Item name="note" label={t('borrower.form.note')}>
          <Input.TextArea rows={2} maxLength={1000} showCount placeholder={t('borrower.form.notePlaceholder')} />
        </Form.Item>
      ) : null}
    </>
  );
}
