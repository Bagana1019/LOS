'use client';
import { useState } from 'react';
import { Alert, Form, Input, Modal } from 'antd';
import type { ApplicationDetail } from '@los/contracts';
import { t } from '../../lib/i18n';
import { describeApplicationError } from './applications.utils';
import { useCreateApplication } from './useApplications';

interface Props { open: boolean; onClose: () => void; onCreated: (app: ApplicationDetail) => void }

/** FR-1 "Нэмэх": хүсэлтийг ноорог (Шинэ) төлөвт үүсгээд wizard-ийн эхний алхам руу оруулна. Бүтээгдэхүүн, дүн, хугацаа 4-р алхамд. */
export function CreateApplicationModal({ open, onClose, onCreated }: Props) {
  const [purpose, setPurpose] = useState('');
  const create = useCreateApplication();
  const submit = () => {
    const trimmed = purpose.trim();
    create.mutate(trimmed ? { purpose: trimmed } : {}, { onSuccess: (app) => { setPurpose(''); onCreated(app); } });
  };
  return (
    <Modal open={open} title={t('application.create.title')} okText={t('application.create.submit')} cancelText={t('application.create.cancel')} confirmLoading={create.isPending} onOk={submit} onCancel={onClose} destroyOnClose>
      <Form layout="vertical" onFinish={submit}>
        <Form.Item label={t('application.create.purpose')} extra={t('application.create.purposeHint')}>
          <Input value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} onPressEnter={submit} autoFocus />
        </Form.Item>
        {create.isError ? <Alert type="error" showIcon message={describeApplicationError(create.error, 'application.create.failed')} /> : null}
      </Form>
    </Modal>
  );
}
