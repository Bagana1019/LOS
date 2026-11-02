'use client';
import { useState } from 'react';
import { App as AntApp, Button, Flex, Form, Input, Modal, Select, Typography } from 'antd';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from './shared/ApiErrorAlert';
import { FileUploadButton } from './shared/FileUploadButton';
import { formatBytes, uploadDmsFile, type DmsFile } from './shared/files';
import { attachNoteError, borrowerOptionLabel, buildAttachRequest, type AttachTarget, type BorrowerOption } from './documents.utils';
import { useAttachDocument } from './useDocuments';

interface Props {
  target: AttachTarget | null;
  applicationId: string;
  borrowers: readonly BorrowerOption[];
  onClose: () => void;
  onChanged?: () => void;
}

/** Баримт хавсаргах (FR-9.1): файл → dms-д байршуулна → хүсэлтэд checklist түлхүүрээр (эсвэл нэмэлт `other` + тайлбар) холбоно. Зээлдэгчид холбож болно. */
export function AttachDocumentModal({ target, ...rest }: Props) {
  return (
    <Modal
      open={target !== null}
      title={target ? (target.kind === 'checklist' ? t('document.attach.titleChecklist', { name: target.name }) : t('document.attach.titleExtra')) : ''}
      onCancel={rest.onClose}
      footer={null}
      destroyOnHidden
      maskClosable={false}
      width={560}
    >
      {target ? <AttachBody target={target} {...rest} /> : null}
    </Modal>
  );
}

interface FormValues {
  borrowerId?: string;
  note?: string;
}

function AttachBody({ target, applicationId, borrowers, onClose, onChanged }: Omit<Props, 'target'> & { target: AttachTarget }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const attach = useAttachDocument(applicationId, onChanged);
  const [file, setFile] = useState<File | null>(null);
  const [stored, setStored] = useState<{ file: File; dms: DmsFile } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'attaching'>('idle');
  const [error, setError] = useState<unknown>(null);

  const submit = async (values: FormValues) => {
    setError(null);
    if (!file) {
      setFileError(t('document.validation.fileRequired'));
      return;
    }
    setFileError(null);
    const noteError = attachNoteError(target, values.note);
    if (noteError) {
      form.setFields([{ name: 'note', errors: [noteError] }]);
      return;
    }
    try {
      // Өмнөх оролдлогод байршсан бөгөөд хавсралт нь алдаатай (409 …) байсан бол ижил файлыг дахин байршуулахгүй
      let dms = stored && stored.file === file ? stored.dms : null;
      if (!dms) {
        setPhase('uploading');
        dms = await uploadDmsFile(file);
        setStored({ file, dms });
      }
      const built = buildAttachRequest({ target, fileId: dms.id, borrowerId: values.borrowerId, note: values.note });
      if (!built.ok) {
        if (built.field === 'note') form.setFields([{ name: 'note', errors: [built.message] }]);
        else setFileError(built.message);
        return;
      }
      setPhase('attaching');
      await attach.mutateAsync(built.body);
      void message.success(t('document.toast.attached'));
      onClose();
    } catch (e) {
      setError(e); // байршуулалт эсвэл хавсралтын алдаа (409 APPLICATION_NOT_EDITABLE …) — сервер мессежтэй
    } finally {
      setPhase('idle');
    }
  };

  const busy = phase !== 'idle';
  return (
    <Form<FormValues> name="document-attach" form={form} layout="vertical" requiredMark="optional" onFinish={(v) => void submit(v)}>
      <Form.Item label={t('document.attach.file')} required validateStatus={fileError ? 'error' : undefined} help={fileError ?? t('document.attach.fileHint')}>
        <Flex gap={12} align="center" wrap>
          <FileUploadButton label={file ? t('document.attach.change') : t('document.attach.choose')} disabled={busy} onFile={(f) => { setFile(f); setFileError(null); }} />
          {file ? <Typography.Text data-testid="attach-file-name">{file.name} ({formatBytes(file.size)})</Typography.Text> : null}
        </Flex>
      </Form.Item>
      {target.kind === 'checklist' || borrowers.length > 0 ? (
        <Form.Item name="borrowerId" label={t('document.attach.borrower')} extra={t('document.attach.borrowerHint')}>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder={t('document.attach.borrowerNone')}
            options={borrowers.map((b) => ({ value: b.customerId, label: borrowerOptionLabel(b) }))}
            disabled={busy}
          />
        </Form.Item>
      ) : null}
      <Form.Item name="note" label={target.kind === 'extra' ? t('document.attach.noteExtra') : t('document.attach.note')} required={target.kind === 'extra'}>
        <Input.TextArea rows={2} maxLength={1000} showCount disabled={busy} />
      </Form.Item>
      <ApiErrorAlert error={error} scope="document" />
      <Flex justify="end" gap={8} style={{ marginTop: error ? 12 : 0 }}>
        <Button onClick={onClose} disabled={busy}>{t('document.action.cancel')}</Button>
        <Button type="primary" htmlType="submit" loading={busy}>{phase === 'uploading' ? t('document.attach.uploading') : t('document.attach.submit')}</Button>
      </Flex>
    </Form>
  );
}
