'use client';
import { useState } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Typography } from 'antd';
import { ChangePasswordBody } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ApiError } from '../../lib/api';
import { changeOwnPassword } from './admin.api';

const errorKey = (e: unknown) => (e instanceof ApiError && e.status === 401 ? t('admin.password.error.current') : e instanceof ApiError && e.code === 'PASSWORD_UNCHANGED' ? t('admin.password.error.same') : e instanceof Error ? e.message : t('admin.common.load_error'));

/** FR-13 · Түр нууц үгтэй хэрэглэгч: shell-ийн оронд заавал нууц үгээ солино. Амжилттай бол сесс бүгд хаагдана → дахин нэвтэрнэ. */
export function ForcedPasswordChange({ onDone }: { onDone: () => void | Promise<void> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = ChangePasswordBody.safeParse({ currentPassword: current, newPassword: next });
  const mismatch = again !== '' && again !== next;
  const ruleError = next !== '' && !parsed.success && parsed.error.issues.some((i) => i.path[0] === 'newPassword');
  const ready = parsed.success && again === next && !busy;

  const submit = async () => {
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      await changeOwnPassword(parsed.data);
      await onDone();
    } catch (e) {
      setError(errorKey(e));
      setBusy(false);
    }
  };

  return (
    <Flex justify="center" align="center" style={{ minHeight: '100vh', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 440 }}>
        <Flex vertical gap={12}>
          <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.password.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('admin.password.hint')}</Typography.Text>
          <Form layout="vertical" onFinish={() => void submit()} requiredMark={false}>
            <Form.Item label={t('admin.password.current')} htmlFor="pw-current"><Input.Password id="pw-current" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Form.Item>
            <Form.Item label={t('admin.password.new')} htmlFor="pw-new" extra={t('admin.password.rule')} validateStatus={ruleError ? 'error' : undefined}>
              <Input.Password id="pw-new" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </Form.Item>
            <Form.Item label={t('admin.password.confirm')} htmlFor="pw-again" validateStatus={mismatch ? 'error' : undefined} help={mismatch ? t('admin.password.mismatch') : undefined}>
              <Input.Password id="pw-again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </Form.Item>
            {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
            <Button type="primary" htmlType="submit" block loading={busy} disabled={!ready}>{t('admin.password.submit')}</Button>
          </Form>
        </Flex>
      </Card>
    </Flex>
  );
}
