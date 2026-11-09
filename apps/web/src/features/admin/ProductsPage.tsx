'use client';
import { useMemo, useState } from 'react';
import { App, Alert, Button, Checkbox, Drawer, Flex, Form, Input, InputNumber, Modal, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { PRODUCT_TARGET_TYPE, type ProductAdminDto } from '@los/contracts';
import { t, formatMoney } from '../../lib/i18n';
import { errorText } from './admin.utils';
import { useProductMutation, useProducts } from './admin.hooks';
import { BackLink } from './SettingsHome';
import { PendingChangeNotice, ReasonField, reasonOk, submittedText } from './FourEyes';
import { ASSET_TYPES, EMPTY_FORM, formToProduct, productToForm, type ProductFormValues } from './product-form';

type Editing = { mode: 'create' } | { mode: 'update'; product: ProductAdminDto };

/** Бүтээгдэхүүний админ (FR-13, BR-6). Үүсгэх/засах/идэвхгүй болгох бүр 4 нүдний санал (Q-124); устгахгүй. */
export function ProductsPage() {
  const { message } = App.useApp();
  const products = useProducts();
  const mutate = useProductMutation();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [toggle, setToggle] = useState<ProductAdminDto | null>(null);

  const done = (key: string) => (r: Parameters<typeof submittedText>[0]) => { void message.success(submittedText(r, key)); setEditing(null); setToggle(null); };

  const columns: TableColumnsType<ProductAdminDto> = useMemo(() => [
    { title: t('admin.products.col.code'), dataIndex: 'code', width: 130 },
    { title: t('admin.products.col.name'), dataIndex: 'name' },
    { title: t('admin.products.col.type'), dataIndex: 'productType', width: 110 },
    { title: t('admin.products.col.amount'), width: 220, render: (_, p) => `${formatMoney(p.minAmount, p.currency)} – ${formatMoney(p.maxAmount, p.currency)}` },
    { title: t('admin.products.col.term'), width: 110, render: (_, p) => `${p.minTerm}–${p.maxTerm}` },
    { title: t('admin.products.col.rate'), width: 110, render: (_, p) => `${p.minRate}–${p.maxRate}%` },
    { title: t('admin.products.col.collateral'), width: 90, render: (_, p) => (p.requiresCollateral ? t('admin.products.yes') : t('admin.products.no')) },
    { title: t('admin.products.col.apps'), dataIndex: 'applicationCount', width: 90 },
    { title: t('admin.products.col.status'), width: 110, render: (_, p) => <Tag color={p.isActive ? 'green' : 'default'}>{t(p.isActive ? 'admin.products.active' : 'admin.products.inactive')}</Tag> },
    {
      title: '', width: 220, fixed: 'right',
      render: (_, p) => (
        <Space>
          <Button size="small" onClick={() => setEditing({ mode: 'update', product: p })}>{t('admin.products.edit')}</Button>
          <Button size="small" danger={p.isActive} onClick={() => setToggle(p)}>{t(p.isActive ? 'admin.products.deactivate' : 'admin.products.activate')}</Button>
        </Space>
      ),
    },
  ], []);

  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.products.title')}</Typography.Title>
        <Button type="primary" onClick={() => setEditing({ mode: 'create' })}>{t('admin.products.add')}</Button>
      </Flex>
      <Alert type="info" showIcon message={t('admin.products.hint')} />
      <PendingChangeNotice targetType={PRODUCT_TARGET_TYPE} />
      {products.isError ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(products.error)} action={<Button onClick={() => void products.refetch()}>{t('admin.common.refresh')}</Button>} />
        : products.isLoading ? <Skeleton active />
        : <Table<ProductAdminDto> rowKey="id" size="small" pagination={false} columns={columns} dataSource={products.data ?? []} scroll={{ x: 1100 }} />}

      {editing ? (
        <ProductDrawer
          key={editing.mode === 'update' ? editing.product.id : 'new'} editing={editing} pending={mutate.isPending} onClose={() => setEditing(null)}
          onSubmit={(body, reason) => {
            const opts = { onSuccess: done('admin.products.applied_direct'), onError: (e: unknown) => void message.error(errorText(e)) };
            if (editing.mode === 'create') mutate.mutate({ kind: 'create', body: { reason, product: body as never } }, opts);
            else mutate.mutate({ kind: 'update', id: editing.product.id, body: { reason, product: body as never } }, opts);
          }}
        />
      ) : null}
      {toggle ? (
        <ToggleModal
          product={toggle} pending={mutate.isPending} onClose={() => setToggle(null)}
          onSubmit={(reason) => mutate.mutate({ kind: 'active', id: toggle.id, body: { reason, isActive: !toggle.isActive } }, { onSuccess: done('admin.products.applied_direct'), onError: (e) => void message.error(errorText(e)) })}
        />
      ) : null}
    </Flex>
  );
}

function ToggleModal({ product, pending, onClose, onSubmit }: { product: ProductAdminDto; pending: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal open title={t(product.isActive ? 'admin.products.deactivate.title' : 'admin.products.activate.title', { name: product.name })} onCancel={onClose}
      okText={t('admin.four_eyes.submit')} onOk={() => onSubmit(reason.trim())} okButtonProps={{ disabled: !reasonOk(reason), loading: pending }}>
      <Flex vertical gap={12}>
        {product.isActive ? <Alert type="warning" showIcon message={t('admin.products.deactivate.warning', { count: product.applicationCount })} /> : null}
        <Alert type="info" showIcon message={t('admin.four_eyes.notice')} />
        <ReasonField value={reason} onChange={setReason} />
      </Flex>
    </Modal>
  );
}

function ProductDrawer({ editing, pending, onClose, onSubmit }: { editing: Editing; pending: boolean; onClose: () => void; onSubmit: (body: unknown, reason: string) => void }) {
  const [form] = Form.useForm<ProductFormValues>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isNew = editing.mode === 'create';
  const initial = isNew ? EMPTY_FORM : productToForm(editing.product);
  const submit = () => {
    const r = isNew ? formToProduct(form.getFieldsValue(true), 'create') : formToProduct(form.getFieldsValue(true), 'update');
    if (!r.ok) { setError(r.error); return; }
    setError(null);
    onSubmit(r.value, reason.trim());
  };
  const num = (name: keyof ProductFormValues, label: string, props: { min?: number; max?: number; step?: number; addonAfter?: string } = {}) => (
    <Form.Item name={name} label={label}><InputNumber style={{ width: '100%' }} {...props} /></Form.Item>
  );
  return (
    <Drawer open width={640} onClose={onClose} title={isNew ? t('admin.products.add') : t('admin.products.edit_title', { code: editing.mode === 'update' ? editing.product.code : '' })}
      footer={(
        <Flex justify="end" gap={8}>
          <Button onClick={onClose}>{t('admin.common.cancel')}</Button>
          <Button type="primary" loading={pending} disabled={!reasonOk(reason)} onClick={submit}>{t('admin.four_eyes.submit')}</Button>
        </Flex>
      )}>
      <Form<ProductFormValues> form={form} layout="vertical" initialValues={initial}>
        <Flex gap={12} wrap>
          <Form.Item name="code" label={t('admin.products.col.code')} style={{ flex: 1, minWidth: 160 }}><Input disabled={!isNew} maxLength={32} placeholder="SME_PLUS" /></Form.Item>
          <Form.Item name="productType" label={t('admin.products.col.type')} style={{ flex: 1, minWidth: 160 }}><Input disabled={!isNew} maxLength={32} placeholder="BUSINESS" /></Form.Item>
          <Form.Item name="currency" label={t('admin.products.currency')} style={{ width: 110 }}><Select disabled={!isNew} options={[{ value: 'MNT' }, { value: 'USD' }]} /></Form.Item>
        </Flex>
        <Form.Item name="name" label={t('admin.products.col.name')}><Input maxLength={200} /></Form.Item>
        <Flex gap={12} wrap>
          <div style={{ flex: 1, minWidth: 200 }}>{num('minAmount', t('admin.products.min_amount'), { min: 0, step: 100_000 })}</div>
          <div style={{ flex: 1, minWidth: 200 }}>{num('maxAmount', t('admin.products.max_amount'), { min: 0, step: 100_000 })}</div>
          <div style={{ flex: 1, minWidth: 140 }}>{num('minTerm', t('admin.products.min_term'), { min: 1, max: 600 })}</div>
          <div style={{ flex: 1, minWidth: 140 }}>{num('maxTerm', t('admin.products.max_term'), { min: 1, max: 600 })}</div>
          <div style={{ flex: 1, minWidth: 140 }}>{num('minRate', t('admin.products.min_rate'), { min: 0, max: 100, step: 0.5 })}</div>
          <div style={{ flex: 1, minWidth: 140 }}>{num('maxRate', t('admin.products.max_rate'), { min: 0, max: 100, step: 0.5 })}</div>
          <div style={{ flex: 1, minWidth: 140 }}>{num('defaultFeeRate', t('admin.products.fee'), { min: 0, max: 1, step: 0.005 })}</div>
        </Flex>
        <Form.Item name="requiresCollateral" valuePropName="checked"><Checkbox>{t('admin.products.requires_collateral')}</Checkbox></Form.Item>
        <Flex gap={12} wrap>
          <div style={{ flex: 1, minWidth: 140 }}>{num('maxLtv', t('admin.products.max_ltv'), { min: 0, max: 1, step: 0.05 })}</div>
          <div style={{ flex: 1, minWidth: 140 }}>{num('maxDti', t('admin.products.max_dti'), { min: 0, max: 1, step: 0.05 })}</div>
          <div style={{ flex: 1, minWidth: 140 }}>{num('minDscr', t('admin.products.min_dscr'), { min: 0, max: 100, step: 0.05 })}</div>
          <div style={{ flex: 1, minWidth: 140 }}>{num('calcWeightThreshold', t('admin.products.calc_weight'), { min: 0, max: 1, step: 0.05 })}</div>
          <div style={{ flex: 1, minWidth: 200 }}>{num('externalValuationThreshold', t('admin.products.ext_valuation'), { min: 0, step: 1_000_000 })}</div>
          <div style={{ flex: 1, minWidth: 140 }}>{num('costOfGoodsRate', t('admin.products.cogs'), { min: 0, max: 1, step: 0.05 })}</div>
        </Flex>
        <Form.Item name="contractTemplateId" label={t('admin.products.contract_template')}><Input maxLength={64} /></Form.Item>

        <Typography.Title level={5}>{t('admin.products.doc_checklist')}</Typography.Title>
        <Form.List name="documentChecklist">
          {(fields, { add, remove }) => (
            <Flex vertical gap={8} style={{ marginBottom: 16 }}>
              {fields.map((f) => (
                <Flex key={f.key} gap={8} align="start">
                  <Form.Item name={[f.name, 'key']} style={{ margin: 0, width: 170 }}><Input placeholder="business_license" maxLength={60} /></Form.Item>
                  <Form.Item name={[f.name, 'name']} style={{ margin: 0, flex: 1 }}><Input placeholder={t('admin.products.doc_name')} maxLength={200} /></Form.Item>
                  <Form.Item name={[f.name, 'required']} valuePropName="checked" initialValue style={{ margin: 0 }}><Checkbox>{t('admin.products.doc_required')}</Checkbox></Form.Item>
                  <Button onClick={() => remove(f.name)}>×</Button>
                </Flex>
              ))}
              <Button onClick={() => add({ key: '', name: '', required: true })} style={{ alignSelf: 'start' }}>{t('admin.products.doc_add')}</Button>
            </Flex>
          )}
        </Form.List>

        <Typography.Title level={5}>{t('admin.products.haircut')}</Typography.Title>
        <Flex gap={12} wrap style={{ marginBottom: 16 }}>
          {ASSET_TYPES.map((a) => (
            <Form.Item key={a} name={['haircut', a]} label={t(`admin.products.asset.${a}`)} style={{ width: 150, margin: 0 }}><InputNumber style={{ width: '100%' }} min={0} max={1} step={0.05} /></Form.Item>
          ))}
        </Flex>
        <Form.Item name="collateralChecklistText" label={t('admin.products.collateral_checklist')} extra={t('admin.products.collateral_checklist.hint')}>
          <Input.TextArea rows={5} style={{ fontFamily: 'monospace' }} />
        </Form.Item>
      </Form>
      <Flex vertical gap={12}>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Alert type="info" showIcon message={t('admin.four_eyes.notice')} />
        <ReasonField value={reason} onChange={setReason} />
      </Flex>
    </Drawer>
  );
}
