'use client';
import { PosLeaseCancel } from '@los/contracts';
import { Alert, Form, Input, Modal } from 'antd';
import { useState } from 'react';
import { t } from '../../../lib/i18n';
import { errorMessage } from '../errors';

/** Цуцлах шалтгаан (заавал, 3–300 тэмдэгт — PosLeaseCancel). */
export function CancelModal({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (reason: string) => Promise<unknown> }) {
  const [form] = Form.useForm<{ reason: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (v: { reason: string }) => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(PosLeaseCancel.parse({ reason: v.reason }).reason);
      form.resetFields();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('cancel.title')}
      okText={t('cancel.confirm')}
      cancelText={t('merchant.back')}
      okButtonProps={{ danger: true, loading: busy }}
      cancelButtonProps={{ disabled: busy }}
      onOk={() => form.submit()}
      onCancel={() => { if (!busy) onClose(); }}
      destroyOnHidden
      afterOpenChange={(o) => { if (o) setError(null); }}
    >
      <p className="mp-muted">{t('cancel.text')}</p>
      {error ? <Alert className="mp-banner" type="error" showIcon role="alert" message={error} /> : null}
      <Form form={form} layout="vertical" requiredMark={false} onFinish={finish}>
        <Form.Item validateFirst name="reason" label={t('cancel.reason')} rules={[{ required: true, whitespace: true, message: t('validation.reason') }, { min: 3, max: 300, message: t('validation.reason') }]}>
          <Input.TextArea rows={3} maxLength={300} showCount autoFocus placeholder={t('cancel.reason.placeholder')} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
