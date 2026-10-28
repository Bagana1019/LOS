import type { PublicSigningSession } from '@los/contracts';
import { Alert, Button, Result } from 'antd';
import { formatUlaanbaatar } from '../format';
import { formatVerificationCode } from '../flow';
import { t } from '../i18n';
import { card, mono, muted, tap } from '../styles';

export interface SignedStepProps {
  session: PublicSigningSession;
  /** GET …/signed-document */
  signedDocumentHref: string;
  /** Лавлагааны хуудас: /verify/{code}; код байхгүй бол null */
  verifyHref: string | null;
  /** Тестэд "одоо"-г тогтмол болгоно */
  nowMs?: number;
}

export function SignedStep({ session, signedDocumentHref, verifyHref, nowMs = Date.now() }: SignedStepProps) {
  const copyExpired = session.signedCopyExpiresAt !== null && Date.parse(session.signedCopyExpiresAt) <= nowMs;
  return (
    <section style={card}>
      <Result status="success" title={t('esign.signed.title')} subTitle={t('esign.signed.subtitle')} style={{ padding: '8px 0' }} />
      {session.verificationCode !== null && (
        <div style={{ textAlign: 'center' }}>
          <p style={muted}>{t('esign.signed.verificationCode')}</p>
          <div style={{ ...mono, fontSize: 26, fontWeight: 700, letterSpacing: '0.04em' }}>{formatVerificationCode(session.verificationCode)}</div>
          <p style={{ ...muted, fontSize: 14 }}>{t('esign.signed.keepCode')}</p>
        </div>
      )}
      {session.signedAt !== null && (
        <p style={{ ...muted, textAlign: 'center' }}>
          {t('esign.signed.signedAt')}: {formatUlaanbaatar(session.signedAt)}
        </p>
      )}
      {session.providerMock && <Alert type="warning" showIcon message={t('esign.provider.mockNotice')} />}
      {session.signedDocumentAvailable ? (
        <Button type="primary" size="large" block style={tap} href={signedDocumentHref} target="_blank" rel="noopener noreferrer">
          {t('esign.signed.download')}
        </Button>
      ) : (
        <Alert type="info" showIcon message={copyExpired ? t('esign.signed.copyExpired') : t('esign.signed.notReady')} />
      )}
      {session.signedDocumentAvailable && session.signedCopyExpiresAt !== null && (
        <p style={{ ...muted, fontSize: 14, textAlign: 'center' }}>{t('esign.signed.copyUntil', { date: formatUlaanbaatar(session.signedCopyExpiresAt) })}</p>
      )}
      {verifyHref !== null && (
        <Button size="large" block style={tap} href={verifyHref}>
          {t('esign.signed.verify')}
        </Button>
      )}
    </section>
  );
}
