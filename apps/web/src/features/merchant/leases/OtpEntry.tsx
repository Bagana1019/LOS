'use client';
import { Button, Input } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';
import { formatCountdown } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { errorMessage } from '../errors';
import { useCountdown } from '../hooks';

interface Props {
  /** Гарчиг / тайлбар (хэнд хандсан). */
  title: string;
  description: string;
  /** Нэмэлт мөр: "Утас: 99****12". */
  phoneMasked: string;
  /** 6 дахь орон бичигдмэгц автоматаар дуудагдана. Алдаа throw хийвэл мессеж харагдаж талбар цэвэрлэгдэнэ. */
  onSubmit: (code: string) => Promise<unknown>;
  /** Кодыг дахин илгээх (хүлээлтийн тоологчтой). */
  onResend: () => Promise<unknown>;
  resendAvailableAt: string | null;
  /** Кодын хүчинтэй хугацаа (заавал биш). */
  expiresAt?: string | null;
  autoFocus?: boolean;
  children?: React.ReactNode;
}

/** 6 оронтой OTP оруулах: autofocus, 6 дахь оронд автомат submit, Enter-ээр дахин илгээхгүй, дахин илгээх тоологчтой. */
export function OtpEntry({ title, description, phoneMasked, onSubmit, onResend, resendAvailableAt, expiresAt, autoFocus = true, children }: Props) {
  const labelId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const resendLeft = useCountdown(resendAvailableAt);
  const expiresLeft = useCountdown(expiresAt);

  // antd Input.OTP нь орон бүрт англи aria-label тавьдаг — монгол болгоно.
  useEffect(() => {
    groupRef.current?.querySelectorAll('input').forEach((el, i) => el.setAttribute('aria-label', t('otp.digit', { n: i + 1 })));
  }, [resetKey]);

  const submit = async (code: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(code);
    } catch (e) {
      setError(errorMessage(e));
      setResetKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  };
  const resend = async () => {
    setResending(true);
    setError(null);
    try {
      await onResend();
      setResetKey((k) => k + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setResending(false);
    }
  };

  const waiting = resendLeft !== null && resendLeft > 0;
  return (
    <div className="mp-otp">
      <h2 className="mp-panel-title" id={labelId}>{title}</h2>
      <p className="mp-otp-text">{description}</p>
      <p className="mp-otp-phone"><span>{t('otp.sentTo')}</span> <strong>{phoneMasked}</strong></p>
      <div ref={groupRef} className="mp-otp-field">
        <Input.OTP key={resetKey} length={6} size="large" autoFocus={autoFocus} disabled={busy} status={error ? 'error' : undefined} inputMode="numeric" formatter={(s) => s.replace(/\D/g, '')} onChange={(code) => void submit(code)} aria-labelledby={labelId} />
      </div>
      <div className="mp-otp-status" aria-live="polite">
        {busy ? <span className="mp-muted">{t('otp.checking')}</span> : null}
        {error ? <span className="mp-otp-error" role="alert">{error}</span> : null}
      </div>
      <div className="mp-otp-actions">
        <Button size="large" onClick={() => void resend()} disabled={waiting || busy} loading={resending}>
          {waiting ? t('otp.resendIn', { time: formatCountdown(resendLeft ?? 0) }) : t('otp.resend')}
        </Button>
        {expiresLeft !== null ? <span className="mp-muted mp-otp-expiry">{expiresLeft > 0 ? t('otp.expiresIn', { time: formatCountdown(expiresLeft) }) : t('otp.expired')}</span> : null}
      </div>
      {children}
    </div>
  );
}
