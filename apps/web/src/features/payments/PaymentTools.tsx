'use client';
import { Alert, Button, Card, Collapse, Flex, Form, Input, Typography } from 'antd';
import { t } from '../../lib/i18n';
import { PaymentErrorAlert } from './PaymentErrorAlert';
import { buildNameCheckRequest, describeReconcile, similarityPercent } from './payment.utils';
import { useNameCheck, useReconcile } from './usePayments';

interface NameCheckFormValues {
  bankCode: string;
  accountNo: string;
  holderName: string;
}

/** ADMIN: банкны орлогыг татаж, гүйлгээний утгаас invoice / гэрээний дугаар олж тулгана. Давтан дуудахад шинэ төлбөр үүсэхгүй. */
function ReconcileCard() {
  const reconcile = useReconcile();
  const result = reconcile.data;
  return (
    <Card size="small" title={t('payment.tools.reconcile.title')} style={{ flex: '1 1 320px' }}>
      <Flex vertical gap={12}>
        <Typography.Text type="secondary">{t('payment.tools.reconcile.description')}</Typography.Text>
        <Button style={{ width: 'fit-content' }} loading={reconcile.isPending} onClick={() => reconcile.mutate({})}>{t('payment.tools.reconcile.run')}</Button>
        {result ? <Alert type={result.unmatched > 0 || result.errors > 0 ? 'warning' : 'success'} showIcon message={describeReconcile(result, t)} /> : null}
        {reconcile.error ? <PaymentErrorAlert error={reconcile.error} /> : null}
      </Flex>
    </Card>
  );
}

/** FR-12.4: банкны дансны нэр-дугаар тулгалт (OFFICER, ADMIN). */
function NameCheckCard() {
  const [form] = Form.useForm<NameCheckFormValues>();
  const check = useNameCheck();
  const result = check.data;

  const onFinish = (values: NameCheckFormValues) => {
    const req = buildNameCheckRequest(values);
    if (req) check.mutate(req);
  };

  return (
    <Card size="small" title={t('payment.tools.nameCheck.title')} style={{ flex: '1 1 380px' }}>
      <Form<NameCheckFormValues> form={form} layout="vertical" requiredMark="optional" onFinish={onFinish}>
        <Flex gap={12} wrap>
          <Form.Item
            style={{ flex: '1 1 120px' }}
            name="bankCode"
            label={t('payment.tools.nameCheck.bankCode')}
            normalize={(v?: string) => (v ?? '').toUpperCase()}
            rules={[{ required: true, whitespace: true, message: t('payment.tools.nameCheck.bankCodeRequired') }]}
          >
            <Input placeholder={t('payment.tools.nameCheck.bankCodePlaceholder')} maxLength={16} />
          </Form.Item>
          <Form.Item
            style={{ flex: '2 1 180px' }}
            name="accountNo"
            label={t('payment.tools.nameCheck.accountNo')}
            rules={[
              { required: true, message: t('payment.tools.nameCheck.accountNoInvalid') },
              { validator: (_, v?: string) => ((v ?? '').replace(/\s+/g, '').length >= 4 ? Promise.resolve() : Promise.reject(new Error(t('payment.tools.nameCheck.accountNoInvalid')))) },
            ]}
          >
            <Input maxLength={34} inputMode="numeric" />
          </Form.Item>
        </Flex>
        <Form.Item name="holderName" label={t('payment.tools.nameCheck.holderName')} rules={[{ required: true, whitespace: true, message: t('payment.tools.nameCheck.holderNameRequired') }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={check.isPending}>{t('payment.tools.nameCheck.run')}</Button>
      </Form>
      {result ? (
        <Alert
          style={{ marginTop: 12 }}
          type={result.matched ? 'success' : 'warning'}
          showIcon
          message={result.matched ? t('payment.tools.nameCheck.matched') : t('payment.tools.nameCheck.notMatched')}
          description={
            <>
              <div>{t('payment.tools.nameCheck.registeredName', { name: result.registeredName ?? t('payment.tools.nameCheck.notFound') })}</div>
              <div>{t('payment.tools.nameCheck.similarity', { value: similarityPercent(result.similarity) })}</div>
            </>
          }
        />
      ) : null}
      {check.error ? <div style={{ marginTop: 12 }}><PaymentErrorAlert error={check.error} /></div> : null}
    </Card>
  );
}

/**
 * Туслах хэрэгслүүд (хаалттай). Эрхийг сервер шалгана — ADMIN биш бол 403 "Энэ үйлдэлд эрх хүрэхгүй" гэж харагдана.
 * "Туршилтын төлөлт" нь invoice дотор (mock горимд).
 */
export function PaymentTools() {
  return (
    <Collapse
      items={[
        {
          key: 'tools',
          label: t('payment.tools.title'),
          children: (
            <Flex vertical gap={12}>
              <Typography.Text type="secondary">{t('payment.tools.subtitle')}</Typography.Text>
              <Flex gap={16} wrap align="stretch">
                <ReconcileCard />
                <NameCheckCard />
              </Flex>
            </Flex>
          ),
        },
      ]}
    />
  );
}
