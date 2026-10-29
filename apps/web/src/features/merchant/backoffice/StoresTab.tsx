'use client';
import { MnMobile, type StoreView } from '@los/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Switch, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { formatDate } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { backOfficeKeys, createStore, listStores, updateStore } from '../../../lib/merchant-api';
import { Ellipsis } from '../Ellipsis';
import { useIsMobile } from '../hooks';
import { normalizePhone, PHONE_INPUT_MAXLENGTH } from '../leases/buyer-input';
import { ErrorState } from '../states';
import { ActiveTag } from '../StatusTag';
import { applyServerErrors } from './server-errors';

interface StoreFormValues { code?: string; name?: string; city?: string; district?: string; khoroo?: string; detail?: string; phone?: string; isActive?: boolean }

const addressText = (s: StoreView): string => [s.address.city, s.address.district, s.address.khoroo, s.address.detail].filter(Boolean).join(', ');

/** Зөвхөн нээлттэй үед mount хийгдэнэ (родитель `open &&`) — форм бүр цэвэр төлөвтэй эхэлнэ. */
function StoreModal({ merchantId, store, onClose }: { merchantId: string; store?: StoreView; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<StoreFormValues>();
  const [error, setError] = useState<string | null>(null);
  const edit = !!store;

  const initial: StoreFormValues = store ? { code: store.code, name: store.name, city: store.address.city, district: store.address.district, khoroo: store.address.khoroo, detail: store.address.detail, phone: store.phone ?? undefined, isActive: store.isActive } : { isActive: true };

  const save = useMutation({
    mutationFn: (v: StoreFormValues) => {
      const address = { ...(v.city?.trim() ? { city: v.city.trim() } : {}), ...(v.district?.trim() ? { district: v.district.trim() } : {}), ...(v.khoroo?.trim() ? { khoroo: v.khoroo.trim() } : {}), detail: (v.detail ?? '').trim() };
      const base = { name: (v.name ?? '').trim(), address, ...(v.phone ? { phone: v.phone } : {}), isActive: v.isActive ?? true };
      return store ? updateStore(merchantId, store.id, base) : createStore(merchantId, { code: (v.code ?? '').trim().toUpperCase(), ...base });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: backOfficeKeys.stores(merchantId) });
      onClose();
    },
    onError: (e) => setError(applyServerErrors(form, e)),
  });

  return (
    <Modal open title={edit ? t('stores.editTitle') : t('stores.createTitle')} okText={edit ? t('merchant.save') : t('stores.create')} cancelText={t('merchant.cancel')} confirmLoading={save.isPending} onOk={() => form.submit()} onCancel={() => { if (!save.isPending) onClose(); }} destroyOnHidden width={600}>
      {error ? <Alert className="mp-banner" type="error" showIcon role="alert" message={error} /> : null}
      <Form<StoreFormValues> form={form} layout="vertical" requiredMark="optional" autoComplete="off" initialValues={initial} onFinish={(v) => { setError(null); save.mutate(v); }}>
        <div className="mp-form-grid">
          <Form.Item validateFirst name="code" label={t('stores.field.code')} normalize={(v: string | undefined) => (v ?? '').toUpperCase()} rules={[{ required: true, message: t('validation.code') }, { pattern: /^[A-Z0-9-]{2,32}$/, message: t('validation.code') }]}>
            <Input maxLength={32} disabled={edit} autoFocus={!edit} />
          </Form.Item>
          <Form.Item validateFirst name="name" label={t('stores.field.name')} rules={[{ required: true, whitespace: true, message: t('validation.name') }, { min: 2, max: 200, message: t('validation.name') }]}>
            <Input maxLength={200} autoFocus={edit} />
          </Form.Item>
          <Form.Item validateFirst name="city" label={t('stores.field.city')}><Input maxLength={100} /></Form.Item>
          <Form.Item validateFirst name="district" label={t('stores.field.district')}><Input maxLength={100} /></Form.Item>
          <Form.Item validateFirst name="khoroo" label={t('stores.field.khoroo')}><Input maxLength={100} /></Form.Item>
          <Form.Item validateFirst name="phone" label={t('stores.field.phone')} normalize={(v: string | undefined) => normalizePhone(v)} rules={[{ validator: (_r, v: string | undefined) => (!v || MnMobile.safeParse(v).success ? Promise.resolve() : Promise.reject(new Error(t('validation.phone')))) }]}>
            <Input maxLength={PHONE_INPUT_MAXLENGTH} inputMode="tel" prefix="+976" />
          </Form.Item>
        </div>
        <Form.Item validateFirst name="detail" label={t('stores.field.detail')} rules={[{ required: true, whitespace: true, message: t('validation.address') }, { min: 2, max: 300, message: t('validation.address') }]}>
          <Input.TextArea rows={2} maxLength={300} />
        </Form.Item>
        <Form.Item validateFirst name="isActive" label={t('stores.field.isActive')} valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  );
}

export function StoresTab({ merchantId }: { merchantId: string }) {
  const q = useQuery({ queryKey: backOfficeKeys.stores(merchantId), queryFn: ({ signal }) => listStores(merchantId, { signal }) });
  const [editing, setEditing] = useState<StoreView | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const mobile = useIsMobile();
  const openCreate = () => { setEditing(undefined); setOpen(true); };
  const openEdit = (s: StoreView) => { setEditing(s); setOpen(true); };

  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  // Хаяг "…"-ээр тасарч (tooltip-той), төлөв + үйлдэл баруун талд тогтоно (n=34).
  const columns: ColumnsType<StoreView> = [
    { title: t('stores.field.code'), dataIndex: 'code', key: 'code', width: 140, className: 'mp-nowrap-cell' },
    { title: t('stores.field.name'), dataIndex: 'name', key: 'name', width: 200, render: (v: string) => <Ellipsis text={v} /> },
    { title: t('stores.field.address'), key: 'address', width: 260, render: (_: unknown, s) => <Ellipsis text={addressText(s)} /> },
    { title: t('stores.field.phone'), dataIndex: 'phone', key: 'phone', width: 130, className: 'mp-nowrap-cell', render: (v: string | null) => v ?? '—' },
    { title: t('merchants.col.createdAt'), dataIndex: 'createdAt', key: 'createdAt', width: 130, className: 'mp-nowrap-cell', render: (v: string) => formatDate(v) },
    { title: t('merchants.col.status'), dataIndex: 'isActive', key: 'isActive', width: 110, fixed: 'right', render: (v: boolean) => <ActiveTag active={v} /> },
    { title: '', key: 'actions', width: 100, fixed: 'right', render: (_: unknown, s) => <Button size="small" onClick={() => openEdit(s)}>{t('merchant.edit')}</Button> },
  ];
  return (
    <div>
      <div className="mp-tab-toolbar"><Button type="primary" onClick={openCreate}>{t('stores.add')}</Button></div>
      {mobile ? (
        <ul className="mp-lease-cards" aria-label={t('stores.title')}>
          {(q.data ?? []).map((s) => (
            <li key={s.id}>
              <button type="button" className="mp-lease-card" onClick={() => openEdit(s)}>
                <div className="mp-lease-card-top"><span className="mp-lease-no">{s.name}</span><ActiveTag active={s.isActive} /></div>
                <div className="mp-lease-card-meta">{s.code} · {addressText(s)}</div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Table<StoreView>
          rowKey="id" size="middle" loading={q.isPending} dataSource={q.data ?? []} pagination={false} aria-label={t('stores.title')} locale={{ emptyText: t('stores.empty') }} className="mp-table"
          scroll={{ x: columns.reduce((sum, c) => sum + Number(c.width ?? 0), 0) }}
          columns={columns}
        />
      )}
      {open ? <StoreModal merchantId={merchantId} store={editing} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
