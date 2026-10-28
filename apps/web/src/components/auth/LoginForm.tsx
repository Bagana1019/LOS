'use client';

import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import type { LoginRequest } from '@los/contracts';
import { t } from '@los/ui';
import { useAuth } from '../../lib/auth/auth-context';
import { loginErrorKey } from '../../lib/auth/login-error';
import { brand, BrandLogo } from '../../theme/brand';

/** Амжилттай нэвтэрсний дараах шилжилтийг AppShell хийнэ (`next` параметрийг шалгаад). */
export function LoginForm() {
  const { login, reason } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFinish = async (values: LoginRequest) => {
    setBusy(true);
    setError(null);
    try {
      await login({ username: values.username.trim(), password: values.password });
    } catch (e) {
      setError(t(loginErrorKey(e)));
      setBusy(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 400 }} styles={{ body: { padding: 32 } }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <BrandLogo size={40} />
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>{brand.name}</Typography.Title>
            <Typography.Text type="secondary">{t('auth.login.subtitle')}</Typography.Text>
          </div>
        </div>
        {reason === 'expired' && !error && <Alert type="info" showIcon message={t('auth.session.expired')} style={{ marginBottom: 16 }} />}
        {error && <Alert type="error" showIcon role="alert" message={error} style={{ marginBottom: 16 }} />}
        <Form<LoginRequest> layout="vertical" requiredMark={false} onFinish={onFinish} disabled={busy}>
          <Form.Item name="username" label={t('auth.username')} rules={[{ required: true, whitespace: true, message: t('auth.username.required') }]}>
            <Input prefix={<UserOutlined aria-hidden />} autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item name="password" label={t('auth.password')} rules={[{ required: true, message: t('auth.password.required') }]}>
            <Input.Password prefix={<LockOutlined aria-hidden />} autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>{t('auth.submit')}</Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ margin: '16px 0 0', textAlign: 'center', fontSize: 12 }}>{t('auth.help')}</Typography.Paragraph>
      </Card>
    </main>
  );
}
