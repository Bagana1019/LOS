'use client';
import { App as AntApp, Button, Flex, Form, Modal, Tag, Typography } from 'antd';
import type { BorrowerView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from './ApiErrorAlert';
import { BorrowerFormFields } from './BorrowerFormFields';
import { useUpdateBorrower } from './useBorrowers';
import { ROLE_COLOR, buildUpdateRequest, initialFormValues, remainingSharePercent, roleHintKey, roleKey, type BorrowerFormValues } from './borrowers.utils';

interface Props {
  /** null бол хаалттай. */
  borrower: BorrowerView | null;
  applicationId: string;
  items: readonly BorrowerView[];
  onClose: () => void;
  onChanged?: () => void;
}

/** PATCH: дүрийг солихгүй (устгаад дахин нэмнэ; үндсэнийг солих нь make-primary). Зөвхөн өөрчилсөн талбарыг явуулна. */
export function EditBorrowerModal({ borrower, ...rest }: Props) {
  return (
    <Modal open={borrower !== null} title={t('borrower.edit.title')} onCancel={rest.onClose} footer={null} width={560} destroyOnHidden maskClosable={false}>
      {borrower ? <EditBorrowerForm key={borrower.id} borrower={borrower} {...rest} /> : null}
    </Modal>
  );
}

function EditBorrowerForm({ borrower, applicationId, items, onClose, onChanged }: Omit<Props, 'borrower'> & { borrower: BorrowerView }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<BorrowerFormValues>();
  const guaranteeType = Form.useWatch('guaranteeType', form);
  const update = useUpdateBorrower(applicationId, onChanged);

  const onFinish = (values: BorrowerFormValues) => {
    const body = buildUpdateRequest(borrower, values);
    if (!body) {
      void message.info(t('borrower.edit.noChanges'));
      onClose();
      return;
    }
    update.mutate(
      { borrowerId: borrower.id, body },
      {
        onSuccess: () => {
          void message.success(t('borrower.toast.updated'));
          onClose();
        },
      },
    );
  };

  return (
    <Form<BorrowerFormValues> form={form} layout="vertical" requiredMark="optional" initialValues={initialFormValues(borrower)} onFinish={onFinish}>
      <Flex vertical gap={4} style={{ marginBottom: 16 }}>
        <Flex align="center" gap={8} wrap>
          <Typography.Text strong>{borrower.customer.displayName}</Typography.Text>
          <Tag color={ROLE_COLOR[borrower.role]}>{t(roleKey(borrower.role))}</Tag>
        </Flex>
        <Typography.Text type="secondary">{borrower.customer.registerNoMasked}</Typography.Text>
        <Typography.Text type="secondary">{t(roleHintKey(borrower.role))}</Typography.Text>
      </Flex>

      <BorrowerFormFields role={borrower.role} guaranteeType={guaranteeType} remainingPercent={remainingSharePercent(items, borrower.id)} />

      {update.error ? (
        <div style={{ marginBottom: 16 }}>
          <ApiErrorAlert error={update.error} />
        </div>
      ) : null}
      <Flex justify="end" gap={8}>
        <Button onClick={onClose}>{t('borrower.action.cancel')}</Button>
        <Button type="primary" htmlType="submit" loading={update.isPending}>{t('borrower.action.save')}</Button>
      </Flex>
    </Form>
  );
}
