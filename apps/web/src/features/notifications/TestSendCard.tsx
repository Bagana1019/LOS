'use client';
import { useState } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Radio, Select, Typography } from 'antd';
import type { NotificationType } from '@los/contracts';
import { t } from '../../lib/i18n';
import { NotificationErrorAlert } from './NotificationErrorAlert';
import {
  CUSTOMER_CHANNELS, buildTestRequest, channelKey, testSendOutcome, typeKey, typesForChannel, validateTestAddress, type CustomerChannel,
} from './notifications.utils';
import { useSendTest, useTemplates } from './useNotificationAdmin';

/** Туршилтын мессеж (ADMIN): сонгосон сувгаар ганц мессеж илгээж, хүргэлтийн үр дүнг шууд харуулна. */
export function TestSendCard() {
  const templates = useTemplates();
  const send = useSendTest();
  const [channel, setChannel] = useState<CustomerChannel>('SMS');
  const [to, setTo] = useState('');
  const [type, setType] = useState<NotificationType>('PAYMENT_DUE');
  const [attempted, setAttempted] = useState(false);

  const typeOptions = typesForChannel(templates.data, channel);
  const effectiveType = typeOptions.includes(type) ? type : (typeOptions[0] ?? 'PAYMENT_DUE');
  const check = validateTestAddress(channel, to);
  const addressError = attempted && !check.ok ? t(check.key) : undefined;

  const onSubmit = () => {
    setAttempted(true);
    if (!check.ok) return;
    send.mutate(buildTestRequest(channel, check.value, effectiveType));
  };

  const outcome = send.data ? testSendOutcome(send.data, t) : null;

  return (
    <Card title={t('notification.test.title')}>
      <Typography.Paragraph type="secondary">{t('notification.test.hint')}</Typography.Paragraph>
      <Form layout="vertical" requiredMark={false} style={{ maxWidth: 520 }}>
        <Form.Item label={t('notification.test.field.channel')}>
          <Radio.Group
            optionType="button"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as CustomerChannel);
              setAttempted(false);
              send.reset();
            }}
            options={CUSTOMER_CHANNELS.map((c) => ({ value: c, label: t(channelKey(c)) }))}
          />
        </Form.Item>
        <Form.Item label={t('notification.test.field.to')} required validateStatus={addressError ? 'error' : undefined} help={addressError}>
          <Input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onPressEnter={onSubmit}
            placeholder={t(`notification.test.toPlaceholder.${channel}`)}
            autoComplete="off"
            aria-label={t('notification.test.field.to')}
          />
        </Form.Item>
        <Form.Item label={t('notification.test.field.type')}>
          <Select<NotificationType> value={effectiveType} onChange={setType} options={typeOptions.map((o) => ({ value: o, label: t(typeKey(o)) }))} />
        </Form.Item>
        <Button type="primary" loading={send.isPending} onClick={onSubmit}>{t('notification.test.submit')}</Button>
      </Form>

      <Flex vertical gap={12} style={{ marginTop: 16 }}>
        {send.isError ? <NotificationErrorAlert error={send.error} title={t('notification.test.error.failed')} /> : null}
        {outcome ? <Alert type={outcome.level} showIcon message={outcome.message} /> : null}
      </Flex>
    </Card>
  );
}
