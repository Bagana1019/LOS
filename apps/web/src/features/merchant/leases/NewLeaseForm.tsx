'use client';
import { GoodsCategory, MnMobile, RegisterNo, type MerchantProfile, type PosLeaseCreate } from '@los/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, InputNumber, Radio, Select, Tag } from 'antd';
import type { Rule } from 'antd/es/form';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { formatMnt, formatPercent } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { createIdempotencyKeeper, createLease, createQuote, isApiError, merchantKeys } from '../../../lib/merchant-api';
import { errorMessage, fieldIssues, isNoAccess } from '../errors';
import { useDebouncedValue, useMe } from '../hooks';
import { Icon } from '../icons';
import { mntFormatter, mntMaxRule, mntParser } from '../inputs';
import { PageHeader } from '../PageHeader';
import { BlockSkeleton, ErrorState } from '../states';
import { canCreateLeases } from '../status';
import { normalizePhone, normalizeRegister, PHONE_INPUT_MAXLENGTH, REGISTER_INPUT_MAXLENGTH } from './buyer-input';
import { storeOtp } from './otp-store';
import { parsePrefill, type LeasePrefill } from './prefill';
import { QuoteCard } from './QuoteCard';
import { buildQuoteRequest, downPaymentShortcut, type QuoteFormValues } from './quote-request';
import { forgetBuyer, peekBuyer, rememberBuyer } from './retry-draft';

interface FormValues extends QuoteFormValues {
  storeId?: string;
  goodsName?: string;
  registerNo?: string;
  phone?: string;
}
type Plan = MerchantProfile['plans'][number];

const SHORTCUT_PERCENTS = [20, 30, 50] as const;

/** Zod схемээр (contracts) шалгаад монгол мессеж буцаах antd дүрэм. */
const zodRule = (schema: z.ZodTypeAny, messageKey: string): Rule => ({
  validator: (_rule, value: unknown) => (schema.safeParse(value ?? '').success ? Promise.resolve() : Promise.reject(new Error(t(messageKey)))),
});

/** Серверийн VALIDATION_FAILED `issues[].path` → формын талбар + монгол мессеж. */
const FIELD_OF_PATH: Record<string, { name: keyof FormValues; key: string }> = {
  'buyer.registerNo': { name: 'registerNo', key: 'validation.registerNo' },
  'buyer.phone': { name: 'phone', key: 'validation.phone' },
  'goods.name': { name: 'goodsName', key: 'validation.goodsName' },
  'goods.price': { name: 'price', key: 'validation.price' },
  downPayment: { name: 'downPayment', key: 'validation.downPayment' },
  termMonths: { name: 'termMonths', key: 'validation.term' },
  planCode: { name: 'planCode', key: 'validation.plan' },
  storeId: { name: 'storeId', key: 'validation.store' },
};

const isPlanCurrent = (p: Plan, now: number): boolean => (!p.validFrom || new Date(p.validFrom).getTime() <= now) && (!p.validTo || new Date(p.validTo).getTime() >= now);

function initialValuesOf(profile: MerchantProfile, plans: Plan[], prefill: LeasePrefill): FormValues {
  const plan = plans.find((p) => p.code === prefill.planCode) ?? (plans.length === 1 ? plans[0] : undefined);
  const category = plan ? (prefill.category && plan.goodsCategories.includes(prefill.category) ? prefill.category : plan.goodsCategories.length === 1 ? plan.goodsCategories[0] : undefined) : undefined;
  const buyer = peekBuyer(prefill.retryOf);
  return {
    planCode: plan?.code,
    category,
    goodsName: prefill.goodsName,
    price: prefill.price,
    downPayment: prefill.downPayment,
    termMonths: plan && prefill.termMonths && plan.termOptions.includes(prefill.termMonths) ? prefill.termMonths : undefined,
    storeId: profile.currentStoreId ?? (profile.stores.length === 1 ? profile.stores[0]?.id : undefined),
    registerNo: buyer?.registerNo,
    phone: buyer?.phone,
  };
}

function NewLeaseFormInner({ profile, prefill }: { profile: MerchantProfile; prefill: LeasePrefill }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const keeper = useRef(createIdempotencyKeeper()).current;
  // POS-BR-12: амжилттай үүссэний дараа дахин илгээхийг (давхар лизинг + 2 дахь SMS) хаана: form нь навигаци дуустал хаалттай, guard нь зөвхөн алдаанд цэвэрлэгдэнэ.
  const submitted = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const plans = useMemo(() => profile.plans.filter((p) => isPlanCurrent(p, Date.now())), [profile.plans]);
  const initialValues = useMemo(() => initialValuesOf(profile, plans, prefill), [profile, plans, prefill]);
  const isAdmin = profile.role === 'MERCHANT_ADMIN';
  const canCreate = canCreateLeases(profile.merchant.status);
  const retryMaskedHint = !!prefill.retryOf && !peekBuyer(prefill.retryOf);

  const values = Form.useWatch([], form) as FormValues | undefined;
  const plan = plans.find((p) => p.code === values?.planCode);
  const quoteRequest = useMemo(() => buildQuoteRequest(values ?? {}), [values]);
  const requestKey = JSON.stringify(quoteRequest);
  const debouncedKey = useDebouncedValue(requestKey, 450);
  const debouncedRequest = useMemo(() => (debouncedKey && debouncedKey !== 'null' ? (JSON.parse(debouncedKey) as NonNullable<typeof quoteRequest>) : null), [debouncedKey]);
  const quote = useQuery({
    queryKey: merchantKeys.quote(debouncedRequest ?? { planCode: '', goodsPrice: 0, downPayment: 0, termMonths: 0 }),
    queryFn: ({ signal }) => createQuote(debouncedRequest as NonNullable<typeof debouncedRequest>, { signal }),
    enabled: debouncedRequest !== null,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const quotePending = requestKey !== debouncedKey || (quote.isFetching && debouncedRequest !== null);
  const quoteBlocking = quote.isError && !quotePending && !!quoteRequest && isApiError(quote.error) && quote.error.status >= 400 && quote.error.status < 500 && !isNoAccess(quote.error);

  const create = useMutation({
    mutationFn: ({ payload, key }: { payload: PosLeaseCreate; key: string }) => createLease(payload, key),
    onSuccess: (res, vars) => {
      // Idempotency-Key-г ЦЭВЭРЛЭХГҮЙ: навигаци дуустал ямар нэг давхар илгээлт ижил key-ээр 200 replay болно (шинэ лизинг/SMS үүсэхгүй).
      qc.setQueryData(merchantKeys.lease(res.lease.id), res.lease);
      storeOtp(qc, res.lease.id, res.otp);
      rememberBuyer(res.lease.id, { registerNo: vars.payload.buyer.registerNo, phone: vars.payload.buyer.phone });
      if (prefill.retryOf) forgetBuyer(prefill.retryOf);
      void qc.invalidateQueries({ queryKey: merchantKeys.leasesAll() });
      void qc.invalidateQueries({ queryKey: merchantKeys.dashboardAll() });
      router.push(`/merchant/leases/${res.lease.id}?flow=1`);
    },
    onError: (e) => {
      submitted.current = false;
      const issues = fieldIssues(e);
      const mapped = issues.map((i) => FIELD_OF_PATH[i.path.join('.')]).filter((m): m is NonNullable<typeof m> => !!m);
      if (mapped.length > 0) form.setFields(mapped.map((m) => ({ name: m.name, errors: [t(m.key)] })));
      setSubmitError(mapped.length > 0 ? t('newLease.fixFields') : errorMessage(e));
    },
  });

  useEffect(() => {
    if (submitError) alertRef.current?.focus();
  }, [submitError]);

  const onPlanChange = (code: string) => {
    const next = plans.find((p) => p.code === code);
    if (!next) return;
    const cat = form.getFieldValue('category') as GoodsCategory | undefined;
    const term = form.getFieldValue('termMonths') as number | undefined;
    form.setFieldsValue({
      category: cat && next.goodsCategories.includes(cat) ? cat : next.goodsCategories.length === 1 ? next.goodsCategories[0] : undefined,
      termMonths: term && next.termOptions.includes(term) ? term : undefined,
    });
  };

  const applyShortcut = (percent: number) => {
    const price = form.getFieldValue('price') as number | undefined;
    if (!price) return;
    form.setFieldsValue({ downPayment: downPaymentShortcut(price, percent) });
    void form.validateFields(['downPayment']).catch(() => undefined);
  };

  const onFinish = (v: FormValues) => {
    if (submitted.current) return;
    if (!v.planCode || !v.category || !v.goodsName || typeof v.price !== 'number' || typeof v.downPayment !== 'number' || !v.termMonths || !v.registerNo || !v.phone) return;
    const payload: PosLeaseCreate = {
      planCode: v.planCode,
      ...(isAdmin && v.storeId ? { storeId: v.storeId } : {}),
      goods: { category: v.category, name: v.goodsName.trim(), price: v.price },
      downPayment: v.downPayment,
      termMonths: v.termMonths,
      buyer: { registerNo: normalizeRegister(v.registerNo), phone: normalizePhone(v.phone) },
    };
    setSubmitError(null);
    submitted.current = true;
    create.mutate({ payload, key: keeper.keyFor(payload) });
  };

  const priceValue = values?.price;
  return (
    <div>
      <PageHeader title={t('newLease.title')} subtitle={t('newLease.subtitle')} />
      {prefill.retryOf ? <Alert className="mp-banner" type="info" showIcon message={t('newLease.retry.title')} description={retryMaskedHint ? t('newLease.retry.buyerLost') : t('newLease.retry.text')} /> : null}
      <Form<FormValues> form={form} layout="vertical" requiredMark={false} autoComplete="off" initialValues={initialValues} onFinish={onFinish} className="mp-new-grid" disabled={create.isPending || create.isSuccess} scrollToFirstError={{ block: 'center' }}>
        {submitError ? (
          <div className="mp-area-alert" ref={alertRef} tabIndex={-1}>
            <Alert type="error" showIcon role="alert" message={submitError} closable onClose={() => setSubmitError(null)} />
          </div>
        ) : null}

        <section className="mp-panel mp-area-goods" aria-labelledby="s-goods">
          <h2 id="s-goods" className="mp-panel-title"><span className="mp-step-badge" aria-hidden="true">1</span>{t('newLease.goods')}</h2>
          <div className="mp-form-grid">
            {isAdmin && profile.stores.length > 0 ? (
              <Form.Item name="storeId" label={t('newLease.store')} rules={[{ required: true, message: t('validation.store') }]}>
                <Select placeholder={t('newLease.store.placeholder')} options={profile.stores.map((s) => ({ value: s.id, label: s.name }))} />
              </Form.Item>
            ) : null}
            <Form.Item name="planCode" label={t('newLease.plan')} rules={[{ required: true, message: t('validation.plan') }]} extra={plan ? t('newLease.plan.range', { min: formatMnt(plan.minAmount), max: formatMnt(plan.maxAmount) }) : undefined}>
              <Select<string> placeholder={t('newLease.plan.placeholder')} onChange={onPlanChange} options={plans.map((p) => ({ value: p.code, label: p.name }))} notFoundContent={t('newLease.plan.none')} />
            </Form.Item>
            <Form.Item name="category" label={t('newLease.category')} rules={[{ required: true, message: t('validation.category') }]}>
              <Select<GoodsCategory> placeholder={t('newLease.category.placeholder')} disabled={!plan} options={(plan?.goodsCategories ?? GoodsCategory).map((c) => ({ value: c, label: t(`goodsCategory.${c}`) }))} />
            </Form.Item>
            <Form.Item name="goodsName" label={t('newLease.goodsName')} validateFirst validateTrigger="onChange" validateDebounce={400} rules={[{ required: true, whitespace: true, message: t('validation.goodsName') }, { min: 2, max: 200, message: t('validation.goodsName') }]}>
              <Input autoFocus maxLength={200} placeholder={t('newLease.goodsName.placeholder')} />
            </Form.Item>
            <Form.Item name="price" label={t('newLease.price')} validateFirst rules={[{ required: true, type: 'number', min: 1, message: t('validation.price') }, mntMaxRule()]}>
              <InputNumber<string | number> className="mp-input-full" controls={false} inputMode="numeric" precision={0} formatter={mntFormatter} parser={mntParser} suffix="₮" placeholder="0" />
            </Form.Item>
          </div>
        </section>

        <section className="mp-panel mp-area-terms" aria-labelledby="s-terms">
          <h2 id="s-terms" className="mp-panel-title"><span className="mp-step-badge" aria-hidden="true">2</span>{t('newLease.terms')}</h2>
          <Form.Item
            name="downPayment"
            label={t('newLease.downPayment')}
            validateFirst
            dependencies={['price']}
            rules={[
              { required: true, type: 'number', min: 0, message: t('validation.downPayment') },
              mntMaxRule(),
              ({ getFieldValue }) => ({ validator: (_r, value: number | null) => (typeof value === 'number' && typeof getFieldValue('price') === 'number' && value >= (getFieldValue('price') as number) ? Promise.reject(new Error(t('validation.downPaymentTooHigh'))) : Promise.resolve()) }),
            ]}
          >
            <InputNumber<string | number> className="mp-input-full" controls={false} inputMode="numeric" precision={0} formatter={mntFormatter} parser={mntParser} suffix="₮" placeholder="0" />
          </Form.Item>
          <div className="mp-shortcuts" role="group" aria-label={t('newLease.shortcuts.label')}>
            {plan ? <Tag className="mp-min-down" bordered={false}>{t('newLease.minDown', { rate: formatPercent(plan.minDownPaymentRate, 1) })}</Tag> : null}
            {SHORTCUT_PERCENTS.map((p) => (
              <Button key={p} size="large" disabled={!priceValue} onClick={() => applyShortcut(p)}>{p}%</Button>
            ))}
          </div>
          <Form.Item name="termMonths" label={t('newLease.term')} rules={[{ required: true, message: t('validation.term') }]}>
            <Radio.Group optionType="button" buttonStyle="solid" size="large" className="mp-term-group" disabled={!plan}>
              {(plan?.termOptions ?? []).map((m) => <Radio.Button key={m} value={m}>{t('newLease.term.months', { n: m })}</Radio.Button>)}
            </Radio.Group>
          </Form.Item>
        </section>

        <aside className="mp-area-quote">
          <QuoteCard quote={quote.data} error={quote.error} pending={quotePending} idle={quoteRequest === null} />
        </aside>

        <section className="mp-panel mp-area-buyer" aria-labelledby="s-buyer">
          <h2 id="s-buyer" className="mp-panel-title"><span className="mp-step-badge" aria-hidden="true">3</span>{t('newLease.buyer')}</h2>
          <div className="mp-form-grid">
            <Form.Item
              name="registerNo" label={t('newLease.registerNo')} validateFirst validateTrigger={['onChange', 'onBlur']} validateDebounce={500}
              normalize={(v: string | undefined) => normalizeRegister(v)}
              rules={[{ required: true, message: t('validation.registerNo.required') }, zodRule(RegisterNo, 'validation.registerNo')]}
              extra={t('newLease.registerNo.hint')}
            >
              <Input maxLength={REGISTER_INPUT_MAXLENGTH} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="УБ12345678" />
            </Form.Item>
            <Form.Item
              name="phone" label={t('newLease.phone')} validateFirst validateTrigger={['onChange', 'onBlur']} validateDebounce={500}
              normalize={(v: string | undefined) => normalizePhone(v)}
              rules={[{ required: true, message: t('validation.phone.required') }, zodRule(MnMobile, 'validation.phone')]}
            >
              <Input maxLength={PHONE_INPUT_MAXLENGTH} inputMode="tel" autoComplete="off" prefix="+976" placeholder="99112233" />
            </Form.Item>
          </div>
          <div className="mp-consent">
            <Icon name="shield" size={22} />
            <div>
              <strong>{t('newLease.consent.title')}</strong>
              <p>{t('newLease.consent.text')}</p>
            </div>
          </div>
          <div className="mp-form-actions">
            <Button type="primary" size="large" htmlType="submit" loading={create.isPending || create.isSuccess} disabled={!canCreate || quoteBlocking} className="mp-submit">{t('newLease.submit')}</Button>
            {!canCreate ? <p className="mp-muted" role="status">{t('newLease.inactive')}</p> : quoteBlocking ? <p className="mp-muted" role="status">{t('newLease.fixQuote')}</p> : <p className="mp-muted">{t('newLease.submit.hint')}</p>}
          </div>
        </section>
      </Form>
    </div>
  );
}

export function NewLeaseForm() {
  const me = useMe();
  const sp = useSearchParams();
  const prefill = useMemo(() => parsePrefill(new URLSearchParams(sp.toString())), [sp]);
  if (me.isPending) return <BlockSkeleton rows={8} />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  return <NewLeaseFormInner profile={me.data} prefill={prefill} />;
}
