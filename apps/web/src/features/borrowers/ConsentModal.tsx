'use client';
import { App as AntApp, Button, Flex, Form, Input, Modal, Typography } from 'antd';
import type { BorrowerView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from './ApiErrorAlert';
import { useRecordConsent } from './useBorrowers';
import { fromUbInputValue, roleKey, toConsentRequest, toUbInputValue } from './borrowers.utils';

interface Props {
  /** null бол хаалттай. */
  borrower: BorrowerView | null;
  applicationId: string;
  onClose: () => void;
  onChanged?: () => void;
}

interface ConsentFormValues {
  fileId: string;
  /** <input type="datetime-local"> утга, Улаанбаатарын цагаар. */
  signedAt: string;
}

/** BR-9: гарын үсэгтэй зөвшөөрлийн баримт (DMS fileId) ба гарын үсэг зурсан огноо. */
export function ConsentModal({ borrower, ...rest }: Props) {
  return (
    <Modal open={borrower !== null} title={t('borrower.consentForm.title')} onCancel={rest.onClose} footer={null} width={520} destroyOnHidden maskClosable={false}>
      {borrower ? <ConsentForm key={borrower.id} borrower={borrower} {...rest} /> : null}
    </Modal>
  );
}

function ConsentForm({ borrower, applicationId, onClose, onChanged }: Omit<Props, 'borrower'> & { borrower: BorrowerView }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<ConsentFormValues>();
  const record = useRecordConsent(applicationId, onChanged);

  const onFinish = (values: ConsentFormValues) => {
    const signedAt = fromUbInputValue(values.signedAt);
    if (!signedAt) return;
    record.mutate(
      { borrowerId: borrower.id, body: toConsentRequest(values.fileId, signedAt) },
      {
        onSuccess: () => {
          void message.success(t('borrower.toast.consentSaved'));
          onClose();
        },
      },
    );
  };

  return (
    <Form<ConsentFormValues>
      form={form}
      layout="vertical"
      noValidate // datetime-local-ийн хөтчийн англи мессежийг хаагаад манай (монгол) validator-оор шалгана
      requiredMark="optional"
      initialValues={{ fileId: borrower.consentFileId ?? '', signedAt: borrower.consentSignedAt ? toUbInputValue(borrower.consentSignedAt) : '' }}
      onFinish={onFinish}
    >
      <Typography.Paragraph>
        {t('borrower.consentForm.intro', { name: borrower.customer.displayName, role: t(roleKey(borrower.role)) })}
      </Typography.Paragraph>

      <Form.Item
        name="fileId"
        label={t('borrower.consentForm.fileId')}
        extra={t('borrower.consentForm.fileIdHint')}
        rules={[{ required: true, whitespace: true, message: t('borrower.consentForm.fileIdRequired') }]}
      >
        <Input maxLength={128} autoFocus />
      </Form.Item>

      <Form.Item
        name="signedAt"
        label={t('borrower.consentForm.signedAt')}
        rules={[
          { required: true, message: t('borrower.consentForm.signedAtRequired') },
          {
            validator: (_rule, value: string | undefined) => {
              if (!value) return Promise.resolve();
              const date = fromUbInputValue(value);
              if (!date) return Promise.reject(new Error(t('borrower.consentForm.signedAtRequired')));
              if (date.getTime() > Date.now()) return Promise.reject(new Error(t('borrower.consentForm.signedAtFuture')));
              return Promise.resolve();
            },
          },
        ]}
      >
        <Input type="datetime-local" max={toUbInputValue(new Date().toISOString())} style={{ width: 260 }} />
      </Form.Item>

      {record.error ? (
        <div style={{ marginBottom: 16 }}>
          <ApiErrorAlert error={record.error} />
        </div>
      ) : null}
      <Flex justify="end" gap={8}>
        <Button onClick={onClose}>{t('borrower.action.cancel')}</Button>
        <Button type="primary" htmlType="submit" loading={record.isPending}>{t('borrower.consentForm.submit')}</Button>
      </Flex>
    </Form>
  );
}
