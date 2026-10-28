import { useState } from 'react';
import type { PublicSigningSession } from '@los/contracts';
import { Alert, Button, Modal, Spin, Tag } from 'antd';
import { safeDeepLink } from '../flow';
import { t } from '../i18n';
import { sessionProviderName } from '../messages';
import { card, heading, muted, tap } from '../styles';
import { Countdown } from './Countdown';

export interface WaitingStepProps {
  session: PublicSigningSession;
  phase: 'approve' | 'finalizing';
  /** Polling сүлжээний алдаатай байна (хуучин өгөгдөл харагдаж байгаа) */
  connectionLost: boolean;
  declining: boolean;
  /** Татгалзах хүсэлтийн алдааны монгол текст */
  error: string | null;
  initialNowMs?: number;
  onDecline: () => void;
  onCountdownElapsed: () => void;
}

export function WaitingStep({ session, phase, connectionLost, declining, error, initialNowMs, onDecline, onCountdownElapsed }: WaitingStepProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (phase === 'finalizing') {
    return (
      <section style={{ ...card, alignItems: 'center', textAlign: 'center' }} aria-live="polite">
        <Spin size="large" />
        <h1 style={heading}>{t('esign.waiting.finalizingTitle')}</h1>
        <p style={muted}>{t('esign.waiting.finalizingBody')}</p>
        {connectionLost && <Alert type="warning" showIcon message={t('esign.waiting.connectionLost')} />}
      </section>
    );
  }

  const provider = sessionProviderName(session);
  const deepLink = safeDeepLink(session.deepLink);
  const mock = session.providers.find((p) => p.code === session.provider)?.mock === true;

  return (
    <section style={card} aria-live="polite">
      <h1 style={heading}>{t('esign.waiting.title')}</h1>
      {mock && <Alert type="warning" showIcon message={t('esign.provider.mockNotice')} />}
      {session.challengeCode === null ? (
        <p style={{ ...muted, textAlign: 'center' }}>
          <Spin size="small" /> {t('esign.waiting.preparing')}
        </p>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <p style={{ ...muted, marginBottom: 8 }}>{t('esign.waiting.codeLabel')}</p>
          <div
            aria-label={t('esign.waiting.codeLabel')}
            style={{ fontSize: 56, fontWeight: 700, letterSpacing: '0.18em', paddingLeft: '0.18em', lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}
          >
            {session.challengeCode}
          </div>
          {provider !== '' && <Tag style={{ marginTop: 8 }}>{provider}</Tag>}
          <p style={{ ...muted, fontSize: 14, marginTop: 8 }}>{t('esign.waiting.codeHelp', { provider })}</p>
        </div>
      )}
      {deepLink !== null ? (
        <Button type="primary" size="large" block style={tap} href={deepLink} rel="noopener noreferrer">
          {t('esign.waiting.openApp')}
        </Button>
      ) : (
        session.challengeCode !== null && <p style={{ ...muted, textAlign: 'center' }}>{t('esign.waiting.openAppHint', { provider })}</p>
      )}
      {session.sessionExpiresAt !== null && <Countdown expiresAt={session.sessionExpiresAt} initialNowMs={initialNowMs} onElapsed={onCountdownElapsed} />}
      <p style={{ ...muted, fontSize: 14, textAlign: 'center' }}>
        <Spin size="small" /> {t('esign.waiting.polling')}
      </p>
      {connectionLost && <Alert type="warning" showIcon message={t('esign.waiting.connectionLost')} />}
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Button size="large" block danger style={tap} onClick={() => setConfirmOpen(true)}>
        {t('esign.waiting.cancel')}
      </Button>
      <Modal
        open={confirmOpen}
        centered
        title={t('esign.decline.title')}
        okText={t('esign.decline.confirm')}
        cancelText={t('esign.decline.keep')}
        okButtonProps={{ danger: true, loading: declining }}
        cancelButtonProps={{ disabled: declining }}
        onOk={() => {
          setConfirmOpen(false);
          onDecline();
        }}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>{t('esign.decline.body')}</p>
      </Modal>
    </section>
  );
}
