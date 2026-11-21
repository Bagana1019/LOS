'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Flex, Input, Space } from 'antd';
import { t } from '../../lib/i18n';
import { isValidXypOtp, normalizeOtpInput, otpResendRemainingSec } from './customers.utils';

export interface XypOtpStepProps {
  /** Код ХУР-аас илгээгдсэн агшин (ISO). «Дахин авах» товчийн хүлээлтийг үүнээс тоолно. */
  requestedAt: string | null;
  /** Тестэд цагийг тогтооно; үгүй бол 1 секунд тутам шинэчлэгдэнэ. */
  nowMs?: number;
  errorMessage: string | null;
  /** F1-7: оролдлого дууссан / код хүчингүй — энэ кодоор баталгаажуулахгүй, шинэ код авна. */
  exhausted?: boolean;
  submitting: boolean;
  resending: boolean;
  onSubmit: (code: string) => void;
  onResend: () => void;
  onManual: () => void;
  onCancel: () => void;
}

/**
 * FR-2.2 · иргэний зөвшөөрөл: ХУР иргэний БҮРТГЭЛТЭЙ утсанд нэг удаагийн код илгээсний дараах алхам. Ажилтан утас сонгохгүй (код зөвхөн иргэний утсанд очно),
 * иргэнээс кодыг асууж оруулна. Код ирэхгүй / ХУР унасан үед «Гараар бөглөх» гарц үргэлж байна. Код нууц: энд зөвхөн оруулна, хадгалахгүй, логлохгүй.
 */
export function XypOtpStep({ requestedAt, nowMs, errorMessage, exhausted = false, submitting, resending, onSubmit, onResend, onManual, onCancel }: XypOtpStepProps) {
  const [code, setCode] = useState('');
  const [clock, setClock] = useState(() => nowMs ?? Date.now());
  const now = nowMs ?? clock;
  const remaining = otpResendRemainingSec(requestedAt, now);
  const valid = isValidXypOtp(code);

  useEffect(() => {
    if (nowMs !== undefined || remaining <= 0) return undefined;
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nowMs, remaining]);

  const submit = () => { if (valid && !submitting && !exhausted) onSubmit(code); };

  return (
    <Card size="small" style={{ margin: '16px 0' }} title={t('customer.new.otp.title')} data-testid="xyp-otp-step">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert type="info" showIcon message={t('customer.new.otp.hint')} />
        {errorMessage ? <Alert type="error" showIcon message={errorMessage} data-testid="xyp-otp-error" /> : null}
        <Flex gap={8} wrap align="center">
          <Input
            data-testid="xyp-otp-input" aria-label={t('customer.new.otp.label')} value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={8}
            placeholder="123456" style={{ maxWidth: 200 }} autoFocus disabled={exhausted} onChange={(e) => setCode(normalizeOtpInput(e.target.value))} onPressEnter={submit}
          />
          <Button type="primary" data-testid="xyp-otp-submit" disabled={!valid || exhausted} loading={submitting} onClick={submit}>{t('customer.new.otp.submit')}</Button>
          <Button data-testid="xyp-otp-resend" disabled={remaining > 0} loading={resending} onClick={onResend}>
            {remaining > 0 ? t('customer.new.otp.resendIn', { seconds: remaining }) : t('customer.new.otp.resend')}
          </Button>
        </Flex>
        <Flex gap={8} wrap>
          <Button type="link" size="small" data-testid="xyp-otp-manual" onClick={onManual}>{t('customer.new.manual')}</Button>
          <Button type="link" size="small" data-testid="xyp-otp-cancel" onClick={onCancel}>{t('customer.new.reset')}</Button>
        </Flex>
      </Space>
    </Card>
  );
}
