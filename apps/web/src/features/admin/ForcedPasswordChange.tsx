'use client';
import { useRef, useState, type CSSProperties } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Typography, theme, type InputRef } from 'antd';
import { CheckCircleFilled, MinusCircleOutlined } from '@ant-design/icons';
import { ChangePasswordBody } from '@los/contracts';
import { t } from '../../lib/i18n';
import { changeOwnPassword } from './admin.api';
import { classifyPasswordError } from './password-error';
import { blockerText, checkText, passwordChecks, submitBlocker, type PasswordCheck } from './password-rules';

/** Зөвхөн screen reader-т уншигдах текст (өнгө/дүрсээс гадна "биелсэн/биелээгүй"-г текстээр хэлнэ). */
const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

/** F9-15: шинэ нууц үгийн шаардлагын чеклист — бичихэд бодит цагт ✓ болно. Эх сурвалж нь серверийн дүрэм (password-rules.ts). `max` зөвхөн хэтэрсэн үед харагдана. */
function PasswordChecklist({ checks }: { checks: PasswordCheck[] }) {
  const { token } = theme.useToken();
  return (
    <div id="pw-rules">
      <Typography.Text type="secondary" id="pw-rules-title">{t('admin.password.rules.title')}</Typography.Text>
      <ul aria-labelledby="pw-rules-title" style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>
        {checks.filter((c) => c.key !== 'max' || !c.ok).map((c) => (
          <li key={c.key} data-check={c.key} data-met={c.ok} style={{ display: 'flex', alignItems: 'center', gap: 8, color: c.ok ? token.colorSuccess : token.colorTextSecondary }}>
            {c.ok ? <CheckCircleFilled aria-hidden="true" /> : <MinusCircleOutlined aria-hidden="true" />}
            <span>{checkText(c)}</span>
            <span style={SR_ONLY}>{` — ${t(c.ok ? 'admin.password.rules.met' : 'admin.password.rules.unmet')}`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  // F9-15: товч яагаад идэвхгүйг хэлнэ (blocker нь null бол `parsed` амжилттай — `submit` дахь хамгаалалт хэзээ ч чимээгүй хаахгүй)
  const blocker = submitBlocker({ current, next, again });
  const blockedReason = busy ? '' : blockerText(blocker);
  const ready = blocker === null && !busy;

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
              <Input.Password id="pw-current" ref={currentRef} autoComplete="current-password" aria-invalid={currentError ? true : undefined} value={current} onChange={(e) => { setCurrent(e.target.value); setCurrentError(null); setError(null); }} />
            </Form.Item>
            <Form.Item label={t('admin.password.new')} htmlFor="pw-new" extra={<PasswordChecklist checks={passwordChecks(next)} />} validateStatus={ruleError ? 'error' : undefined}>
              <Input.Password id="pw-new" autoComplete="new-password" aria-describedby="pw-rules" value={next} onChange={(e) => { setNext(e.target.value); setError(null); }} />
            </Form.Item>
            <Form.Item label={t('admin.password.confirm')} htmlFor="pw-again" validateStatus={mismatch ? 'error' : undefined} help={mismatch ? t('admin.password.mismatch') : undefined}>
              <Input.Password id="pw-again" autoComplete="new-password" value={again} onChange={(e) => { setAgain(e.target.value); setError(null); }} />
            </Form.Item>
            {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
            {blockedReason ? <Typography.Text id="pw-blocked" role="status" style={{ display: 'block', marginBottom: 8 }}>{blockedReason}</Typography.Text> : null}
            <Button type="primary" htmlType="submit" block loading={busy} disabled={!ready} aria-describedby={blockedReason ? 'pw-blocked' : undefined}>{t('admin.password.submit')}</Button>
          </Form>
        </Flex>
      </Card>
    </Flex>
  );
}
