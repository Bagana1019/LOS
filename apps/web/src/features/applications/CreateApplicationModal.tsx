'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Form, Input, Modal } from 'antd';
import type { ApplicationDetail } from '@los/contracts';
import { t } from '../../lib/i18n';
import { createIdempotencyKeyHolder, describeApplicationError, shouldRotateIdempotencyKey, singleFlight } from './applications.utils';
import { useCreateApplication } from './useApplications';

interface Props { open: boolean; onClose: () => void; onCreated: (app: ApplicationDetail) => void }

/** FR-1 "Нэмэх": хүсэлтийг ноорог (Шинэ) төлөвт үүсгээд wizard-ийн эхний алхам руу оруулна. Бүтээгдэхүүн, дүн, хугацаа 4-р алхамд. */
export function CreateApplicationModal({ open, onClose, onCreated }: Props) {
  const [purpose, setPurpose] = useState('');
  const create = useCreateApplication();
  // Idempotency-Key: нэг нээлт = нэг түлхүүр. Алдаа/retry-д ижил (сервер давхардуулахгүй), дараагийн нээлтэд шинэ.
  const keys = useMemo(() => createIdempotencyKeyHolder(), []);
  useEffect(() => { if (open) keys.reset(); }, [open, keys]);
  // Сүүлийн render-ийн утгаар ажиллана; guard нь нэг л удаа үүснэ (давхар дарах, Enter + onFinish → нэг POST).
  const latest = useRef<() => Promise<void>>(async () => {});
  latest.current = async () => {
    const trimmed = purpose.trim();
    try {
      const app = await create.mutateAsync({ body: trimmed ? { purpose: trimmed } : {}, idempotencyKey: keys.current() });
      keys.reset();
      setPurpose('');
      onCreated(app);
    } catch (e) {
      // Алдааг `create.error`-оор доорх Alert-д харуулна. Түлхүүр өөр биетэй ашиглагдсан бол солино; сүлжээний алдаанд ижил түлхүүрээр дахин оролдоно.
      if (shouldRotateIdempotencyKey(e)) keys.reset();
    }
  };
  const guarded = useMemo(() => singleFlight(() => latest.current()), []);
  const submit = () => { void guarded(); };
  return (
    <Modal open={open} title={t('application.create.title')} okText={t('application.create.submit')} cancelText={t('application.create.cancel')} confirmLoading={create.isPending} okButtonProps={{ disabled: create.isPending }} onOk={submit} onCancel={onClose} destroyOnClose>
      <Form layout="vertical" onFinish={submit}>
        <Form.Item label={t('application.create.purpose')} extra={t('application.create.purposeHint')}>
          <Input value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} onPressEnter={submit} autoFocus />
        </Form.Item>
        {create.isError ? <Alert type="error" showIcon message={describeApplicationError(create.error, 'application.create.failed')} /> : null}
      </Form>
    </Modal>
  );
}
