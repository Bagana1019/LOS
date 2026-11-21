'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { App as AntApp, Button, Card, Space, Typography } from 'antd';
import { t } from '@los/ui';
import { resumeHref } from '../../features/applications/applications.utils';
import { CreateApplicationModal } from '../../features/applications/CreateApplicationModal';
import type { HomeAction } from './home-actions';

/** F0-2: нүүр дээрх үндсэн үйлдэл. "Шинэ хүсэлт" нь жагсаалтаар тойрохгүй шууд ноорог үүсгээд wizard руу оруулна. */
export function HomePrimaryAction({ action }: { action: HomeAction }) {
  const router = useRouter();
  const { message } = AntApp.useApp();
  const [creating, setCreating] = useState(false);
  const label = t(action.labelKey);
  return (
    <Card data-testid="home-next-step" aria-labelledby="home-next-step-title">
      <Typography.Title level={5} id="home-next-step-title" style={{ marginTop: 0 }}>{t('shell.home.next_step')}</Typography.Title>
      <Space size="middle" align="center" wrap>
        {action.kind === 'create' ? (
          <Button type="primary" size="large" onClick={() => setCreating(true)}>{label}</Button>
        ) : (
          <Button type="primary" size="large" href={action.href} onClick={(e) => { e.preventDefault(); router.push(action.href); }}>{label}</Button>
        )}
        <Typography.Text type="secondary">{t(action.hintKey)}</Typography.Text>
      </Space>
      {action.kind === 'create' ? (
        <CreateApplicationModal
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(app) => { setCreating(false); void message.success(t('application.create.success', { appNo: app.appNo })); router.push(resumeHref(app.id)); }}
        />
      ) : null}
    </Card>
  );
}
