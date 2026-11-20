'use client';
import { useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Typography, type InputRef } from 'antd';
import { ChangePasswordBody } from '@los/contracts';
import { t } from '../../lib/i18n';
import { changeOwnPassword } from './admin.api';
import { classifyPasswordError } from './password-error';

/** FR-13 · Түр нууц үгтэй хэрэглэгч: shell-ийн оронд заавал нууц үгээ солино. Амжилттай бол сесс бүгд хаагдана → дахин нэвтэрнэ. */
export function ForcedPasswordChange({ onDone }: { onDone: () => void | Promise<void> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // F9-14: одоогийн нууц үг буруу бол алдаа ТЭР талбарт; шинэ нууц үг, сесс хэвээр
  const [currentError, setCurrentError] = useState<string | null>(null);
  const currentRef = useRef<InputRef>(null);

  const parsed = ChangePasswordBody.safeParse({ currentPassword: current, newPassword: next });
  const mismatch = again !== '' && again !== next;
  const ruleError = next !== '' && !parsed.success && parsed.error.issues.some((i) => i.path[0] === 'newPassword');
  const ready = parsed.success && again === next && !busy;

  const submit = async () => {
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    setCurrentError(null);
    try {
      await changeOwnPassword(parsed.data);
      await onDone();
    } catch (e) {
      const failure = classifyPasswordError(e);
      const onCurrent = failure.field === 'current';
      setCurrentError(onCurrent ? failure.message : null);
      setError(onCurrent ? null : failure.message);
      setBusy(false);
      if (onCurrent) currentRef.current?.focus({ cursor: 'all' }); // дахин бичихэд бэлэн; шинэ нууц үг хэвээр
    }
  };

  return (
    <Flex justify="center" align="center" style={{ minHeight: '100vh', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 440 }}>
        <Flex vertical gap={12}>
          <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.password.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('admin.password.hint')}</Typography.Text>
          <Form layout="vertical" onFinish={() => void submit()} requiredMark={false}>
            <Form.Item label={t('admin.password.current')} htmlFor="pw-current" validateStatus={currentError ? 'error' : undefined} help={currentError ?? undefined}>
              <Input.Password id="pw-current" ref={currentRef} autoComplete="current-password" aria-invalid={currentError ? true : undefined} value={current} onChange={(e) => { setCurrent(e.target.value); setCurrentError(null); }} />
            </Form.Item>
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
