'use client';
import { MerchantStatusChange, type MerchantStatus, type MerchantView } from '@los/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Form, Input, Modal, Select } from 'antd';
import { useState } from 'react';
import { t } from '../../../lib/i18n';
import { backOfficeKeys, changeMerchantStatus } from '../../../lib/merchant-api';
import { errorMessage } from '../errors';
import { merchantStatusLabel } from '../status';

/** Мерчантын төлөвийн шилжилт (POS-FR-1; origination `MERCHANT_TRANSITIONS`-тэй нийцсэн). Эцсийн шийдвэрийг сервер гаргана. */
export const MERCHANT_TARGETS: Readonly<Record<MerchantStatus, readonly Exclude<MerchantStatus, 'PENDING'>[]>> = {
  PENDING: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: [],
};

/** Зөвхөн нээлттэй үед mount хийгдэнэ (родитель `open &&`). */
export function MerchantStatusModal({ merchant, onClose }: { merchant: MerchantView; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ status: Exclude<MerchantStatus, 'PENDING'>; reason: string }>();
  const [error, setError] = useState<string | null>(null);
  const targets = MERCHANT_TARGETS[merchant.status];

  const change = useMutation({
    mutationFn: (v: { status: Exclude<MerchantStatus, 'PENDING'>; reason: string }) => changeMerchantStatus(merchant.id, MerchantStatusChange.parse(v)),
    onSuccess: (m) => {
      qc.setQueryData(backOfficeKeys.merchant(m.id), m);
      void qc.invalidateQueries({ queryKey: backOfficeKeys.merchantsAll() });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <Modal
      open
      title={t('merchants.status.title')}
      okText={t('merchants.status.confirm')}
      cancelText={t('merchant.cancel')}
      confirmLoading={change.isPending}
      okButtonProps={{ disabled: targets.length === 0 }}
      onOk={() => form.submit()}
      onCancel={() => { if (!change.isPending) onClose(); }}
      destroyOnHidden
    >
      <p className="mp-muted">{t('merchants.status.current', { status: merchantStatusLabel(merchant.status) })}</p>
      {targets.length === 0 ? <Alert type="info" showIcon message={t('merchants.status.terminal')} /> : null}
      {error ? <Alert className="mp-banner" type="error" showIcon role="alert" message={error} /> : null}
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => { setError(null); change.mutate({ status: v.status, reason: v.reason }); }} disabled={targets.length === 0}>
        <Form.Item validateFirst name="status" label={t('merchants.status.new')} rules={[{ required: true, message: t('validation.status') }]}>
          <Select<Exclude<MerchantStatus, 'PENDING'>> placeholder={t('merchants.status.new.placeholder')} options={targets.map((s) => ({ value: s, label: merchantStatusLabel(s) }))} />
        </Form.Item>
        <Form.Item validateFirst name="reason" label={t('merchants.status.reason')} rules={[{ required: true, whitespace: true, message: t('validation.reason') }, { min: 3, max: 500, message: t('validation.reason') }]}>
          <Input.TextArea rows={3} maxLength={500} showCount placeholder={t('merchants.status.reason.placeholder')} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
