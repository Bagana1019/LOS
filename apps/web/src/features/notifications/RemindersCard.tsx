'use client';
import { useState } from 'react';
import { Alert, Button, Card, Descriptions, Flex, Form, Input, Popconfirm, Switch, Tag, Typography } from 'antd';
import { t } from '../../lib/i18n';
import { NotificationErrorAlert } from './NotificationErrorAlert';
import { buildRunRequest, reminderResultLines, validateRunForm, type RunForm } from './notifications.utils';
import { useRunReminders } from './useNotificationAdmin';

/** Төлөлтийн сануулгыг гараар ажиллуулах (ADMIN). Анхдагч нь dry-run: юу ч үүсгэхгүй, хэдэн мэдэгдэл үүсэхийг тоолно. */
export function RemindersCard() {
  const run = useRunReminders();
  const [form, setForm] = useState<RunForm>({ asOf: '', dryRun: true });
  const errorKey = validateRunForm(form);

  const submit = () => run.mutate(buildRunRequest(form));
  const button = (
    <Button type="primary" loading={run.isPending} disabled={errorKey !== null} onClick={form.dryRun ? submit : undefined}>
      {t(form.dryRun ? 'notification.reminders.submitDry' : 'notification.reminders.submitReal')}
    </Button>
  );

  const result = run.data;
  return (
    <Card title={t('notification.reminders.title')}>
      <Typography.Paragraph type="secondary">{t('notification.reminders.hint')}</Typography.Paragraph>
      <Form layout="vertical" requiredMark={false} style={{ maxWidth: 520 }}>
        <Form.Item label={t('notification.reminders.field.asOf')} extra={t('notification.reminders.field.asOfHint')} validateStatus={errorKey ? 'error' : undefined} help={errorKey ? t(errorKey) : undefined}>
          <Input type="date" value={form.asOf} onChange={(e) => setForm((f) => ({ ...f, asOf: e.target.value }))} style={{ width: 200 }} aria-label={t('notification.reminders.field.asOf')} />
        </Form.Item>
        <Form.Item label={t('notification.reminders.field.dryRun')} extra={t('notification.reminders.field.dryRunHint')}>
          <Switch checked={form.dryRun} onChange={(dryRun) => setForm((f) => ({ ...f, dryRun }))} />
        </Form.Item>
        {form.dryRun ? (
          button
        ) : (
          <Popconfirm
            title={t('notification.reminders.confirm.title')}
            description={t('notification.reminders.confirm.body')}
            okText={t('notification.reminders.confirm.ok')}
            cancelText={t('notification.common.cancel')}
            disabled={errorKey !== null}
            onConfirm={submit}
          >
            {button}
          </Popconfirm>
        )}
      </Form>

      <Flex vertical gap={12} style={{ marginTop: 16 }}>
        {run.isError ? <NotificationErrorAlert error={run.error} title={t('notification.reminders.error.failed')} /> : null}
        {result ? (
          <>
            <Alert
              type={result.dryRun ? 'info' : 'success'}
              showIcon
              message={t(result.dryRun ? 'notification.reminders.result.titleDry' : 'notification.reminders.result.titleReal')}
              description={result.scheduledDeliveries === 0 ? t('notification.reminders.result.nothing') : undefined}
            />
            <Descriptions
              size="small"
              bordered
              column={1}
              extra={<Tag color={result.dryRun ? 'blue' : 'green'}>{t(result.dryRun ? 'notification.reminders.mode.dry' : 'notification.reminders.mode.real')}</Tag>}
              items={reminderResultLines(result, t).map((l) => ({ key: l.key, label: l.label, children: l.value }))}
              style={{ maxWidth: 520 }}
            />
          </>
        ) : null}
      </Flex>
    </Card>
  );
}
