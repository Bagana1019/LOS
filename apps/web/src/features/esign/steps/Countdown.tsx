import { useEffect, useRef, useState } from 'react';
import { formatCountdown, remainingMs } from '../flow';
import { t } from '../i18n';

export interface CountdownProps {
  /** ISO — provider session-ийн дуусах цаг */
  expiresAt: string;
  /** Анхны "одоо" (тестэд тогтмол цаг); үгүй бол Date.now() */
  initialNowMs?: number;
  /** Тоолуур 0 болоход нэг удаа — сервер дээрх бодит төлвийг шалгуулна */
  onElapsed?: () => void;
}

/** Утасны цаг буруу байж болох тул энэ нь зөвхөн харагдах тоолуур; шийдвэрийг сервер гаргана. */
export function Countdown({ expiresAt, initialNowMs, onElapsed }: CountdownProps) {
  const [now, setNow] = useState(() => initialNowMs ?? Date.now());
  const notified = useRef(false);
  const left = remainingMs(expiresAt, now);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (left === 0 && !notified.current) {
      notified.current = true;
      onElapsed?.();
    }
  }, [left, onElapsed]);

  if (left === 0) return <p role="timer" style={{ margin: 0, textAlign: 'center' }}>{t('esign.waiting.timeUp')}</p>;
  return (
    <p role="timer" style={{ margin: 0, textAlign: 'center', fontSize: 16 }}>
      {t('esign.waiting.remaining')}: <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCountdown(left)}</strong>
    </p>
  );
}
