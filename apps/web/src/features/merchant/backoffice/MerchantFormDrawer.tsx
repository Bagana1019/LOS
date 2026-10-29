'use client';
import { GoodsCategory, MerchantCode, MnMobile, type MerchantCreate, type MerchantUpdate, type MerchantView } from '@los/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Drawer, Form, Input, Select } from 'antd';
import type { Rule } from 'antd/es/form';
import { useState } from 'react';
import type { z } from 'zod';
import { dateInputToIso, isoToDateInput, percentToRate, rateToPercent } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { backOfficeKeys, createMerchant, updateMerchant } from '../../../lib/merchant-api';
import { MntInput, mntMaxRule, PercentInput } from '../inputs';
import { normalizePhone, PHONE_INPUT_MAXLENGTH } from '../leases/buyer-input';
import { applyServerErrors } from './server-errors';

interface FormValues {
  code?: string;
  name?: string;
  legalName?: string;
  companyRegisterNo?: string;
  category?: GoodsCategory;
  contactName?: string;
  phone?: string;
  email?: string;
  branchId?: string;
  commissionRate?: number;
  maxTicketAmount?: number;
  dailyLimitAmount?: number | null;
  settlement?: { bankCode?: string; accountNo?: string; holderName?: string };
  contractNo?: string;
  contractSignedAt?: string;
}

const zodRule = (schema: z.ZodTypeAny, key: string): Rule => ({ validator: (_r, v: unknown) => (schema.safeParse(v ?? '').success ? Promise.resolve() : Promise.reject(new Error(t(key)))) });
const blank = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

function toInitial(m?: MerchantView): FormValues {
  if (!m) return { dailyLimitAmount: null };
  return {
    code: m.code, name: m.name, legalName: m.legalName ?? undefined, companyRegisterNo: m.companyRegisterNo ?? undefined, category: m.category ?? undefined, contactName: m.contactName, phone: m.phone,
    email: m.email ?? undefined, branchId: m.branchId, commissionRate: rateToPercent(m.commissionRate), maxTicketAmount: m.maxTicketAmount, dailyLimitAmount: m.dailyLimitAmount,
    settlement: { bankCode: m.settlement.bankCode, accountNo: undefined, holderName: m.settlement.holderName }, contractNo: m.contractNo ?? undefined, contractSignedAt: isoToDateInput(m.contractSignedAt) || undefined,
  };
}

/** Бүртгэх үед: MerchantCreate-ийн бүх талбар. Засах үед: зөвхөн өөрчлөгдсөн талбарыг PATCH-д илгээнэ (MerchantUpdate). */
export function buildCreatePayload(v: FormValues): z.input<typeof MerchantCreate> {
  return {
    code: (v.code ?? '').trim().toUpperCase(),
    name: (v.name ?? '').trim(),
    ...(blank(v.legalName) ? { legalName: blank(v.legalName) } : {}),
    ...(blank(v.companyRegisterNo) ? { companyRegisterNo: blank(v.companyRegisterNo) } : {}),
    ...(v.category ? { category: v.category } : {}),
    contactName: (v.contactName ?? '').trim(),
    phone: normalizePhone(v.phone),
    ...(blank(v.email) ? { email: blank(v.email) } : {}),
    branchId: (v.branchId ?? '').trim(),
    commissionRate: percentToRate(v.commissionRate ?? 0),
    maxTicketAmount: v.maxTicketAmount ?? 0,
    dailyLimitAmount: v.dailyLimitAmount ?? null,
    settlement: { bankCode: (v.settlement?.bankCode ?? '').trim().toUpperCase(), accountNo: (v.settlement?.accountNo ?? '').trim(), holderName: (v.settlement?.holderName ?? '').trim() },
    ...(blank(v.contractNo) ? { contractNo: blank(v.contractNo) } : {}),
    ...(v.contractSignedAt ? { contractSignedAt: dateInputToIso(v.contractSignedAt, 'start') } : {}),
  };
}

export function buildUpdatePayload(v: FormValues, original: MerchantView): z.input<typeof MerchantUpdate> {
  const next = buildCreatePayload({ ...v, code: original.code });
  const out: Record<string, unknown> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const orig: Record<string, unknown> = {
    name: original.name, legalName: original.legalName, companyRegisterNo: original.companyRegisterNo, category: original.category, contactName: original.contactName, phone: original.phone, email: original.email,
    branchId: original.branchId, commissionRate: original.commissionRate, maxTicketAmount: original.maxTicketAmount, dailyLimitAmount: original.dailyLimitAmount, contractNo: original.contractNo,
    contractSignedAt: original.contractSignedAt ? isoToDateInput(original.contractSignedAt) : null,
  };
  for (const [k, value] of Object.entries(next)) {
    if (k === 'code' || k === 'settlement') continue;
    const cmp = k === 'contractSignedAt' ? isoToDateInput(value as string) : value;
    if (!same(cmp, orig[k])) out[k] = value;
  }
  // Данс: шинэ дугаар оруулсан үед л (бүтэн settlement шаардлагатай; маскалсан дугаарыг буцааж илгээж болохгүй).
  if (next.settlement.accountNo) out.settlement = next.settlement;
  return out as z.input<typeof MerchantUpdate>;
}

interface Props {
  open: boolean;
  merchant?: MerchantView;
  onClose: () => void;
  onSaved?: (m: MerchantView) => void;
}

/** Нээлттэй үед л mount хийгдэж, форм бүр цэвэр төлөвтэй эхэлнэ. */
export function MerchantFormDrawer({ open, ...rest }: Props) {
  return open ? <MerchantFormDrawerInner {...rest} /> : null;
}

function MerchantFormDrawerInner({ merchant, onClose, onSaved }: Omit<Props, 'open'>) {
  const edit = !!merchant;
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (v: FormValues) => (merchant ? updateMerchant(merchant.id, buildUpdatePayload(v, merchant)) : createMerchant(buildCreatePayload(v))),
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: backOfficeKeys.merchantsAll() });
      qc.setQueryData(backOfficeKeys.merchant(m.id), m);
      onSaved?.(m);
      onClose();
    },
    onError: (e) => setError(applyServerErrors(form, e)),
  });

  const settlementChanged = (): boolean => {
    if (!merchant) return true;
    const s = form.getFieldValue('settlement') as FormValues['settlement'];
    return (s?.bankCode ?? '').trim().toUpperCase() !== merchant.settlement.bankCode.toUpperCase() || (s?.holderName ?? '').trim() !== merchant.settlement.holderName;
  };

  return (
    <Drawer
      open
      onClose={() => { if (!save.isPending) onClose(); }}
      width={680}
      destroyOnHidden
      title={edit ? t('merchants.form.editTitle') : t('merchants.form.createTitle')}
      footer={
        <div className="mp-drawer-footer">
          <Button onClick={onClose} disabled={save.isPending}>{t('merchant.cancel')}</Button>
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>{edit ? t('merchant.save') : t('merchants.form.create')}</Button>
        </div>
      }
    >
      {error ? <Alert className="mp-banner" type="error" showIcon role="alert" message={error} closable onClose={() => setError(null)} /> : null}
      <Form<FormValues> form={form} layout="vertical" requiredMark="optional" autoComplete="off" initialValues={toInitial(merchant)} disabled={save.isPending} onFinish={(v) => { setError(null); save.mutate(v); }} scrollToFirstError={{ block: 'center' }}>
        <h3 className="mp-subtitle">{t('merchants.form.basic')}</h3>
        <div className="mp-form-grid">
          <Form.Item validateFirst name="code" label={t('merchants.field.code')} normalize={(v: string | undefined) => (v ?? '').toUpperCase()} rules={[{ required: true, message: t('validation.code') }, zodRule(MerchantCode, 'validation.code')]} extra={edit ? t('merchants.field.code.locked') : t('merchants.field.code.hint')}>
            <Input maxLength={32} disabled={edit} autoFocus={!edit} />
          </Form.Item>
          <Form.Item validateFirst name="name" label={t('merchants.field.name')} rules={[{ required: true, whitespace: true, message: t('validation.name') }, { min: 2, max: 200, message: t('validation.name') }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item validateFirst name="legalName" label={t('merchants.field.legalName')} rules={[{ min: 2, max: 200, message: t('validation.name') }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item validateFirst name="companyRegisterNo" label={t('merchants.field.companyRegisterNo')} rules={[{ pattern: /^\d{7}$/, message: t('validation.companyRegisterNo') }]}>
            <Input maxLength={7} inputMode="numeric" />
          </Form.Item>
          <Form.Item validateFirst name="category" label={t('merchants.field.category')}>
            <Select<GoodsCategory> allowClear placeholder={t('merchants.field.category.placeholder')} options={GoodsCategory.map((c) => ({ value: c, label: t(`goodsCategory.${c}`) }))} />
          </Form.Item>
          <Form.Item validateFirst name="branchId" label={t('merchants.field.branchId')} rules={[{ required: true, whitespace: true, message: t('validation.branchId') }]} extra={t('merchants.field.branchId.hint')}>
            <Input maxLength={64} />
          </Form.Item>
        </div>

        <h3 className="mp-subtitle">{t('merchants.form.contact')}</h3>
        <div className="mp-form-grid">
          <Form.Item validateFirst name="contactName" label={t('merchants.field.contactName')} rules={[{ required: true, whitespace: true, message: t('validation.name') }, { min: 2, max: 200, message: t('validation.name') }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item validateFirst name="phone" label={t('merchants.field.phone')} normalize={(v: string | undefined) => normalizePhone(v)} rules={[{ required: true, message: t('validation.phone.required') }, zodRule(MnMobile, 'validation.phone')]}>
            <Input maxLength={PHONE_INPUT_MAXLENGTH} inputMode="tel" prefix="+976" />
          </Form.Item>
          <Form.Item validateFirst name="email" label={t('merchants.field.email')} rules={[{ type: 'email', max: 200, message: t('validation.email') }]}>
            <Input maxLength={200} inputMode="email" />
          </Form.Item>
        </div>

        <h3 className="mp-subtitle">{t('merchants.form.terms')}</h3>
        <div className="mp-form-grid">
          <Form.Item validateFirst name="commissionRate" label={t('merchants.field.commissionRate')} rules={[{ required: true, type: 'number', min: 0, max: 20, message: t('validation.commission') }]} extra={t('merchants.field.commissionRate.hint')}>
            <PercentInput />
          </Form.Item>
          <Form.Item validateFirst name="maxTicketAmount" label={t('merchants.field.maxTicket')} rules={[{ required: true, type: 'number', min: 1, message: t('validation.amount') }, mntMaxRule()]}>
            <MntInput />
          </Form.Item>
          <Form.Item validateFirst name="dailyLimitAmount" label={t('merchants.field.dailyLimit')} extra={t('merchants.field.dailyLimit.hint')} rules={[{ type: 'number', min: 1, message: t('validation.amount') }, mntMaxRule()]}>
            <MntInput placeholder={t('merchants.field.dailyLimit.placeholder')} />
          </Form.Item>
        </div>

        <h3 className="mp-subtitle">{t('merchants.form.settlement')}</h3>
        <div className="mp-form-grid">
          <Form.Item validateFirst name={['settlement', 'bankCode']} label={t('merchants.field.bankCode')} normalize={(v: string | undefined) => (v ?? '').toUpperCase()} rules={[{ required: true, whitespace: true, message: t('validation.bankCode') }, { min: 2, max: 16, message: t('validation.bankCode') }]}>
            <Input maxLength={16} placeholder="KHAN" />
          </Form.Item>
          <Form.Item
            name={['settlement', 'accountNo']}
            label={t('merchants.field.accountNo')}
            dependencies={[['settlement', 'bankCode'], ['settlement', 'holderName']]}
            normalize={(v: string | undefined) => (v ?? '').replace(/[^\d]/g, '')}
            rules={[
              { required: !edit, message: t('validation.accountNo') },
              () => ({ validator: (_r, v: string | undefined) => (v ? (/^\d{6,20}$/.test(v) ? Promise.resolve() : Promise.reject(new Error(t('validation.accountNo')))) : edit && settlementChanged() ? Promise.reject(new Error(t('validation.accountNo.requiredOnChange'))) : Promise.resolve()) }),
            ]}
            extra={edit && merchant ? t('merchants.field.accountNo.editHint', { masked: merchant.settlement.accountMasked }) : undefined}
          >
            <Input maxLength={20} inputMode="numeric" autoComplete="off" placeholder={edit && merchant ? merchant.settlement.accountMasked : undefined} />
          </Form.Item>
          <Form.Item validateFirst name={['settlement', 'holderName']} label={t('merchants.field.holderName')} rules={[{ required: true, whitespace: true, message: t('validation.name') }, { min: 2, max: 200, message: t('validation.name') }]}>
            <Input maxLength={200} />
          </Form.Item>
        </div>

        <h3 className="mp-subtitle">{t('merchants.form.contract')}</h3>
        <div className="mp-form-grid">
          <Form.Item validateFirst name="contractNo" label={t('merchants.field.contractNo')} rules={[{ max: 64, message: t('validation.invalid') }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item validateFirst name="contractSignedAt" label={t('merchants.field.contractSignedAt')}>
            <Input type="date" />
          </Form.Item>
        </div>
      </Form>
    </Drawer>
  );
}
