'use client';
import { App as AntApp, Alert, Button, Card, Descriptions, Flex, Form, Input, Popconfirm, Typography } from 'antd';
import { EMPTY_VALUE, formatDate } from '../../lib/format';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { buildRegisterPledgeRequest } from './collateral.utils';
import { applyFieldErrors } from './form-errors';
import type { TabProps } from './TabProps';
import { useRegisterPledge, useReleaseCollateral } from './useCollateral';
import { canWriteBlocked } from './write-gates';

interface FormValues {
  registryNo?: string;
  registryDate?: string;
}

/**
 * FR-6.9 (S): ЭБ (барьцаа хөрөнгийн бүртгэл)-д бүртгэх, зээл хаагдсан үед чөлөөлөх.
 * Хүсэлтийн төлөв тохирохгүй бол API 409 (монгол мессежтэй) өгнө — UI мэдэхгүй төлвийг таамаглаж хаахгүй, мессежийг харуулна.
 */
export function RegistryTab({ applicationId, item, write, onChanged }: TabProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const register = useRegisterPledge(applicationId, onChanged);
  const release = useReleaseCollateral(applicationId, onChanged);
  const gate = canWriteBlocked(write);
  const released = item.releasedAt !== null;

  const onFinish = (values: FormValues) => {
    const built = buildRegisterPledgeRequest(values);
    if (!built.ok) {
      applyFieldErrors(form, built.errors);
      return;
    }
    register.mutate({ collateralId: item.id, body: built.body }, { onSuccess: () => void message.success(t('collateral.toast.pledgeRegistered')) });
  };

  return (
    <Flex vertical gap={16}>
      <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }}>
        <Descriptions.Item label={t('collateral.overview.registryNo')}>{item.registryNo ?? EMPTY_VALUE}</Descriptions.Item>
        <Descriptions.Item label={t('collateral.overview.registryDate')}>{item.registryDate ?? EMPTY_VALUE}</Descriptions.Item>
        {released ? <Descriptions.Item label={t('collateral.overview.releasedAt')}>{formatDate(item.releasedAt)}</Descriptions.Item> : null}
      </Descriptions>

      <Card size="small" title={t('collateral.registry.registerTitle')}>
        <Typography.Paragraph type="secondary">{t('collateral.registry.registerNote')}</Typography.Paragraph>
        <Form<FormValues> name={`collateral-registry-${item.id}`} form={form} layout="vertical" requiredMark="optional" onFinish={onFinish} initialValues={{ registryNo: item.registryNo ?? undefined, registryDate: item.registryDate ?? undefined }}>
          <Flex gap={16} wrap>
            <Form.Item name="registryNo" label={t('collateral.form.registryNo')} required style={{ flex: '1 1 240px' }}>
              <Input maxLength={100} autoComplete="off" disabled={released} />
            </Form.Item>
            <Form.Item name="registryDate" label={t('collateral.form.registryDate')} required style={{ flex: '1 1 180px' }}>
              <Input type="date" disabled={released} />
            </Form.Item>
          </Flex>
          <ApiErrorAlert error={register.error} scope="collateral" />
          <div style={{ marginTop: register.error ? 12 : 0 }}>
            <Button type="primary" htmlType="submit" loading={register.isPending} disabled={gate.disabled || released} title={gate.text}>{t('collateral.registry.register')}</Button>
          </div>
        </Form>
      </Card>

      <Card size="small" title={t('collateral.registry.releaseTitle')}>
        <Typography.Paragraph type="secondary">{t('collateral.registry.releaseNote')}</Typography.Paragraph>
        {released ? <Alert type="info" showIcon message={t('collateral.registry.released', { date: formatDate(item.releasedAt) })} style={{ marginBottom: 12 }} /> : null}
        <ApiErrorAlert error={release.error} scope="collateral" />
        <div style={{ marginTop: release.error ? 12 : 0 }}>
          <Popconfirm
            title={t('collateral.registry.releaseConfirmTitle')}
            description={t('collateral.registry.releaseConfirmText')}
            okText={t('collateral.registry.release')}
            cancelText={t('collateral.action.cancel')}
            disabled={gate.disabled || released}
            onConfirm={() => release.mutate({ collateralId: item.id }, { onSuccess: () => void message.success(t('collateral.toast.released')) })}
          >
            <Button danger loading={release.isPending} disabled={gate.disabled || released} title={gate.text}>{t('collateral.registry.release')}</Button>
          </Popconfirm>
        </div>
      </Card>
    </Flex>
  );
}
