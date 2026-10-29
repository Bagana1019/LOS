'use client';
import { GoodsCategory, POS_POLICY_DEFAULTS, type PlanView, type PosPolicy } from '@los/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Collapse, Form, Input, Modal, Radio, Select, Switch, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import type { Rule } from 'antd/es/form';
import type { z } from 'zod';
import type { PlanCreate, PlanUpdate } from '@los/contracts';
import { dateInputToIso, formatMnt, formatPercent, isoToDateInput, percentToRate, rateToPercent } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { backOfficeKeys, createPlan, listPlans, updatePlan } from '../../../lib/merchant-api';
import { Ellipsis } from '../Ellipsis';
import { useIsMobile } from '../hooks';
import { IntInput, MntInput, mntMaxRule, PercentInput } from '../inputs';
import { ErrorState } from '../states';
import { ActiveTag, ToneTag } from '../StatusTag';
import { applyServerErrors } from './server-errors';

type PolicyKey = keyof PosPolicy;
interface PolicyForm { maxDti?: number; referDti?: number; minAge?: number; maxAgeAtMaturity?: number; declineDpd?: number; referDpd?: number; declineFico?: number; referFico?: number; maxActiveLoansAuto?: number; autoApproveMaxAmount?: number; autoDeclineEnabled?: 'true' | 'false'; offerTtlMinutes?: number }
export interface PlanFormValues {
  code?: string;
  name?: string;
  scope?: 'MERCHANT' | 'GLOBAL';
  productId?: string;
  goodsCategories?: GoodsCategory[];
  minAmount?: number;
  maxAmount?: number;
  termOptions?: number[];
  annualRate?: number;
  feeRate?: number;
  minDownPaymentRate?: number;
  commissionRate?: number | null;
  validFrom?: string;
  validTo?: string;
  isActive?: boolean;
  policy?: PolicyForm;
}

const PERCENT_POLICY: PolicyKey[] = ['maxDti', 'referDti'];

/** Хэрэглэгчийн хувь (55) → API бутархай; зөвхөн бөглөсөн override-г оруулна (хоосон = анхдагч). */
export function buildPolicy(p: PolicyForm | undefined): Partial<PosPolicy> {
  const out: Record<string, number | boolean | string> = {};
  for (const [k, v] of Object.entries(p ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = PERCENT_POLICY.includes(k as PolicyKey) ? percentToRate(v as number) : k === 'autoDeclineEnabled' ? v === 'true' : (v as number);
  }
  return out as Partial<PosPolicy>;
}
export function policyToForm(p: PlanView['policy']): PolicyForm {
  const out: Record<string, number | boolean | string> = {};
  for (const [k, v] of Object.entries(p ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = PERCENT_POLICY.includes(k as PolicyKey) ? rateToPercent(v as number) : typeof v === 'boolean' ? String(v) : (v as number);
  }
  return out as PolicyForm;
}

function planFields(v: PlanFormValues) {
  return {
    name: (v.name ?? '').trim(),
    productId: v.productId?.trim() ? v.productId.trim() : null,
    goodsCategories: v.goodsCategories ?? [],
    minAmount: v.minAmount ?? 0,
    maxAmount: v.maxAmount ?? 0,
    termOptions: [...(v.termOptions ?? [])].sort((a, b) => a - b),
    annualRate: percentToRate(v.annualRate ?? 0),
    feeRate: percentToRate(v.feeRate ?? 0),
    minDownPaymentRate: percentToRate(v.minDownPaymentRate ?? 0),
    commissionRate: v.commissionRate === null || v.commissionRate === undefined ? null : percentToRate(v.commissionRate),
    policy: buildPolicy(v.policy),
    validFrom: v.validFrom ? dateInputToIso(v.validFrom, 'start') : null,
    validTo: v.validTo ? dateInputToIso(v.validTo, 'end') : null,
    isActive: v.isActive ?? true,
  };
}
export const buildPlanCreate = (v: PlanFormValues, merchantId: string): z.input<typeof PlanCreate> => ({ code: (v.code ?? '').trim().toUpperCase(), merchantId: v.scope === 'GLOBAL' ? null : merchantId, ...planFields(v) });
/** PATCH: код, хамрах хүрээ (merchantId) өөрчлөгдөхгүй. */
export const buildPlanUpdate = (v: PlanFormValues): z.input<typeof PlanUpdate> => planFields(v);

function toInitial(plan: PlanView | undefined, merchantId: string): PlanFormValues {
  if (!plan) return { scope: 'MERCHANT', isActive: true, goodsCategories: [], termOptions: [], feeRate: 0, minDownPaymentRate: 0, commissionRate: null, policy: {} };
  return {
    code: plan.code, name: plan.name, scope: plan.merchantId === null ? 'GLOBAL' : plan.merchantId === merchantId ? 'MERCHANT' : 'MERCHANT', productId: plan.productId ?? undefined,
    goodsCategories: plan.goodsCategories, minAmount: plan.minAmount, maxAmount: plan.maxAmount, termOptions: [...plan.termOptions], annualRate: rateToPercent(plan.annualRate), feeRate: rateToPercent(plan.feeRate),
    minDownPaymentRate: rateToPercent(plan.minDownPaymentRate), commissionRate: plan.commissionRate === null ? null : rateToPercent(plan.commissionRate), validFrom: isoToDateInput(plan.validFrom) || undefined,
    validTo: isoToDateInput(plan.validTo) || undefined, isActive: plan.isActive, policy: policyToForm(plan.policy),
  };
}

const POLICY_FIELDS: Array<{ key: PolicyKey; kind: 'percent' | 'int' | 'mnt' | 'bool' }> = [
  { key: 'maxDti', kind: 'percent' }, { key: 'referDti', kind: 'percent' }, { key: 'minAge', kind: 'int' }, { key: 'maxAgeAtMaturity', kind: 'int' }, { key: 'declineDpd', kind: 'int' }, { key: 'referDpd', kind: 'int' },
  { key: 'declineFico', kind: 'int' }, { key: 'referFico', kind: 'int' }, { key: 'maxActiveLoansAuto', kind: 'int' }, { key: 'autoApproveMaxAmount', kind: 'mnt' }, { key: 'autoDeclineEnabled', kind: 'bool' }, { key: 'offerTtlMinutes', kind: 'int' },
];

function defaultText(key: PolicyKey): string {
  const d = POS_POLICY_DEFAULTS[key];
  if (typeof d === 'boolean') return d ? t('plans.policy.yes') : t('plans.policy.no');
  if (key === 'maxDti' || key === 'referDti') return formatPercent(d, 1);
  if (key === 'autoApproveMaxAmount') return formatMnt(d);
  return String(d);
}

/** Нарийвчилсан бодлогын оролтын хязгаар: хязгаарыг InputNumber-д биш rule-д тавина (чимээгүй clamp хийхгүй). */
const POLICY_RULES: Record<'percent' | 'int' | 'mnt' | 'bool', Rule[]> = {
  percent: [{ type: 'number', min: 0, max: 100, message: t('validation.percent') }],
  mnt: [{ type: 'number', min: 0, message: t('validation.invalid') }, mntMaxRule()],
  int: [],
  bool: [],
};

function PolicyFields() {
  return (
    <div className="mp-form-grid">
      {POLICY_FIELDS.map(({ key, kind }) => {
        const label = t(`plans.policy.${key}`);
        const extra = t('plans.policy.default', { value: defaultText(key) });
        const placeholder = kind === 'percent' ? String(rateToPercent(POS_POLICY_DEFAULTS[key] as number)) : kind === 'bool' ? undefined : String(POS_POLICY_DEFAULTS[key]);
        return (
          <Form.Item key={key} name={['policy', key]} label={label} extra={extra} validateFirst rules={POLICY_RULES[kind]}>
            {kind === 'percent' ? <PercentInput placeholder={placeholder} />
              : kind === 'mnt' ? <MntInput placeholder={placeholder ? Number(placeholder).toLocaleString('en-US') : undefined} />
              : kind === 'bool' ? <Select<string> allowClear placeholder={t('plans.policy.inherit', { value: defaultText(key) })} options={[{ value: 'true', label: t('plans.policy.yes') }, { value: 'false', label: t('plans.policy.no') }]} />
              : <IntInput placeholder={placeholder} />}
          </Form.Item>
        );
      })}
    </div>
  );
}

/** Зөвхөн нээлттэй үед mount хийгдэнэ (родитель `open &&`). */
function PlanModal({ merchantId, plan, onClose }: { merchantId: string; plan?: PlanView; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<PlanFormValues>();
  const [error, setError] = useState<string | null>(null);
  const edit = !!plan;

  const save = useMutation({
    mutationFn: (v: PlanFormValues) => (plan ? updatePlan(plan.id, buildPlanUpdate(v)) : createPlan(buildPlanCreate(v, merchantId))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: backOfficeKeys.plansAll() });
      onClose();
    },
    onError: (e) => setError(applyServerErrors(form, e)),
  });

  return (
    <Modal open width={760} title={edit ? t('plans.editTitle') : t('plans.createTitle')} okText={edit ? t('merchant.save') : t('plans.create')} cancelText={t('merchant.cancel')} confirmLoading={save.isPending} onOk={() => form.submit()} onCancel={() => { if (!save.isPending) onClose(); }} destroyOnHidden>
      {error ? <Alert className="mp-banner" type="error" showIcon role="alert" message={error} /> : null}
      <Form<PlanFormValues> form={form} layout="vertical" requiredMark="optional" autoComplete="off" initialValues={toInitial(plan, merchantId)} disabled={save.isPending} onFinish={(v) => { setError(null); save.mutate(v); }} scrollToFirstError={{ block: 'center' }}>
        {plan && plan.merchantId === null ? <Alert className="mp-banner" type="warning" showIcon message={t('plans.global.warning')} /> : null}
        <div className="mp-form-grid">
          <Form.Item validateFirst name="code" label={t('plans.field.code')} normalize={(v: string | undefined) => (v ?? '').toUpperCase()} rules={[{ required: true, message: t('validation.code') }, { pattern: /^[A-Z0-9-]{2,32}$/, message: t('validation.code') }]}>
            <Input maxLength={32} disabled={edit} autoFocus={!edit} />
          </Form.Item>
          <Form.Item validateFirst name="name" label={t('plans.field.name')} rules={[{ required: true, whitespace: true, message: t('validation.name') }, { min: 2, max: 200, message: t('validation.name') }]}>
            <Input maxLength={200} autoFocus={edit} />
          </Form.Item>
          <Form.Item validateFirst name="scope" label={t('plans.field.scope')} extra={t('plans.field.scope.hint')}>
            <Radio.Group disabled={edit} options={[{ value: 'MERCHANT', label: t('plans.scope.MERCHANT') }, { value: 'GLOBAL', label: t('plans.scope.GLOBAL') }]} />
          </Form.Item>
          <Form.Item validateFirst name="productId" label={t('plans.field.productId')}><Input maxLength={64} /></Form.Item>
        </div>
        <Form.Item validateFirst name="goodsCategories" label={t('plans.field.categories')} rules={[{ required: true, type: 'array', min: 1, message: t('validation.categories') }]}>
          <Select<GoodsCategory[]> mode="multiple" placeholder={t('plans.field.categories.placeholder')} options={GoodsCategory.map((c) => ({ value: c, label: t(`goodsCategory.${c}`) }))} />
        </Form.Item>
        <div className="mp-form-grid">
          <Form.Item validateFirst name="minAmount" label={t('plans.field.minAmount')} rules={[{ required: true, type: 'number', min: 1, message: t('validation.amount') }, mntMaxRule()]}><MntInput /></Form.Item>
          <Form.Item
            name="maxAmount" label={t('plans.field.maxAmount')} dependencies={['minAmount']}
            rules={[{ required: true, type: 'number', min: 1, message: t('validation.amount') }, mntMaxRule(), ({ getFieldValue }) => ({ validator: (_r, v: number | undefined) => (typeof v === 'number' && typeof getFieldValue('minAmount') === 'number' && v < (getFieldValue('minAmount') as number) ? Promise.reject(new Error(t('validation.maxAmount'))) : Promise.resolve()) })]}
          >
            <MntInput />
          </Form.Item>
        </div>
        <Form.Item validateFirst name="termOptions" label={t('plans.field.terms')} rules={[{ required: true, type: 'array', min: 1, max: 12, message: t('validation.terms') }]}>
          <Select<number[]> mode="multiple" maxCount={12} placeholder={t('plans.field.terms.placeholder')} options={Array.from({ length: 60 }, (_, i) => ({ value: i + 1, label: t('newLease.term.months', { n: i + 1 }) }))} />
        </Form.Item>
        <div className="mp-form-grid">
          <Form.Item validateFirst name="annualRate" label={t('plans.field.annualRate')} rules={[{ required: true, type: 'number', min: 0, max: 100, message: t('validation.percent') }]}><PercentInput /></Form.Item>
          <Form.Item validateFirst name="feeRate" label={t('plans.field.feeRate')} extra={t('plans.field.feeRate.hint')} rules={[{ type: 'number', min: 0, max: 20, message: t('validation.percent20') }]}><PercentInput /></Form.Item>
          <Form.Item validateFirst name="minDownPaymentRate" label={t('plans.field.minDown')} rules={[{ type: 'number', min: 0, max: 90, message: t('validation.percent90') }]}><PercentInput /></Form.Item>
          <Form.Item validateFirst name="commissionRate" label={t('plans.field.commission')} extra={t('plans.field.commission.hint')} rules={[{ type: 'number', min: 0, max: 20, message: t('validation.percent20') }]}><PercentInput placeholder={t('plans.field.commission.placeholder')} /></Form.Item>
          <Form.Item validateFirst name="validFrom" label={t('plans.field.validFrom')}><Input type="date" /></Form.Item>
          <Form.Item validateFirst name="validTo" label={t('plans.field.validTo')} dependencies={['validFrom']} rules={[({ getFieldValue }) => ({ validator: (_r, v: string | undefined) => (v && getFieldValue('validFrom') && v < (getFieldValue('validFrom') as string) ? Promise.reject(new Error(t('validation.validTo'))) : Promise.resolve()) })]}><Input type="date" /></Form.Item>
        </div>
        <Form.Item validateFirst name="isActive" label={t('plans.field.isActive')} valuePropName="checked"><Switch /></Form.Item>
        <Collapse
          className="mp-policy-collapse"
          ghost={false}
          items={[{ key: 'policy', label: t('plans.policy.title'), forceRender: true, children: (<><p className="mp-muted">{t('plans.policy.text')}</p><PolicyFields /></>) }]}
        />
      </Form>
    </Modal>
  );
}

const scopeLabel = (p: PlanView, merchantId: string) => (p.merchantId === null ? t('plans.scope.GLOBAL.short') : p.merchantId === merchantId ? t('plans.scope.MERCHANT.short') : t('plans.scope.OTHER'));

/** Мерчантын болон глобал (merchantId = null) хөтөлбөрүүд. `GET /pos-plans` бүгдийг буцаадаг тул клиент талд шүүнэ. */
export function PlansTab({ merchantId }: { merchantId: string }) {
  const q = useQuery({ queryKey: backOfficeKeys.plans({}), queryFn: ({ signal }) => listPlans({}, { signal }), select: (all) => all.filter((p) => p.merchantId === null || p.merchantId === merchantId) });
  const [editing, setEditing] = useState<PlanView | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const openCreate = () => { setEditing(undefined); setOpen(true); };
  const openEdit = (p: PlanView) => { setEditing(p); setOpen(true); };

  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const validity = (p: PlanView) => (p.validFrom || p.validTo ? `${isoToDateInput(p.validFrom) || '…'} – ${isoToDateInput(p.validTo) || '…'}` : t('plans.noLimit'));
  // 1024–1280px-д хүснэгтийн агуулга контейнерээс өргөн: урт багануудыг "…"-ээр (tooltip-той) тасалж, төлөв + үйлдлийн баганыг баруун талд тогтооно (n=34).
  const columns: ColumnsType<PlanView> = [
    { title: t('plans.field.code'), dataIndex: 'code', key: 'code', width: 130, className: 'mp-nowrap-cell' },
    { title: t('plans.field.name'), dataIndex: 'name', key: 'name', width: 190, render: (v: string) => <Ellipsis text={v} /> },
    { title: t('plans.col.scope'), key: 'scope', width: 100, render: (_: unknown, p) => <ToneTag tone={p.merchantId === null ? 'blue' : 'default'}>{scopeLabel(p, merchantId)}</ToneTag> },
    { title: t('plans.col.categories'), key: 'cats', width: 190, render: (_: unknown, p) => <Ellipsis text={p.goodsCategories.map((c) => t(`goodsCategory.${c}`)).join(', ')} /> },
    { title: t('plans.col.amount'), key: 'amount', width: 210, align: 'right', render: (_: unknown, p) => <span className="mp-num">{formatMnt(p.minAmount)} – {formatMnt(p.maxAmount)}</span> },
    { title: t('plans.col.terms'), key: 'terms', width: 120, render: (_: unknown, p) => <Ellipsis text={p.termOptions.join(', ')} /> },
    { title: t('plans.col.rates'), key: 'rates', width: 200, render: (_: unknown, p) => <div><div>{t('plans.col.rates.annual', { v: formatPercent(p.annualRate, 2) })}</div><Ellipsis className="mp-cell-sub" text={`${t('plans.col.rates.fee', { v: formatPercent(p.feeRate, 2) })} · ${t('plans.col.rates.down', { v: formatPercent(p.minDownPaymentRate, 1) })}`} /></div> },
    { title: t('plans.col.validity'), key: 'validity', width: 190, className: 'mp-nowrap-cell', render: (_: unknown, p) => validity(p) },
    { title: t('merchants.col.status'), dataIndex: 'isActive', key: 'isActive', width: 110, fixed: 'right', render: (v: boolean) => <ActiveTag active={v} /> },
    { title: '', key: 'actions', width: 100, fixed: 'right', render: (_: unknown, p) => <Button size="small" onClick={() => openEdit(p)}>{t('merchant.edit')}</Button> },
  ];
  return (
    <div>
      <div className="mp-tab-toolbar"><Button type="primary" onClick={openCreate}>{t('plans.add')}</Button></div>
      {mobile ? (
        <ul className="mp-lease-cards" aria-label={t('plans.title')}>
          {(q.data ?? []).map((p) => (
            <li key={p.id}>
              <button type="button" className="mp-lease-card" onClick={() => openEdit(p)}>
                <div className="mp-lease-card-top"><span className="mp-lease-no">{p.name}</span><ActiveTag active={p.isActive} /></div>
                <div className="mp-lease-card-meta">{p.code} · {scopeLabel(p, merchantId)}</div>
                <div className="mp-lease-card-meta">{formatMnt(p.minAmount)} – {formatMnt(p.maxAmount)} · {p.termOptions.join(', ')} {t('format.month')} · {formatPercent(p.annualRate, 2)}</div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Table<PlanView>
          rowKey="id" size="middle" loading={q.isPending} dataSource={q.data ?? []} pagination={false} aria-label={t('plans.title')} locale={{ emptyText: t('plans.empty') }} className="mp-table"
          scroll={{ x: columns.reduce((sum, c) => sum + Number(c.width ?? 0), 0) }}
          columns={columns}
        />
      )}
      {open ? <PlanModal merchantId={merchantId} plan={editing} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
