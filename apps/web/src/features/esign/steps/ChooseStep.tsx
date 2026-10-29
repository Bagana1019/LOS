import { useState } from 'react';
import type { ESignProvider, PublicSigningSession, SigningFailureReason } from '@los/contracts';
import { Alert, Button, Checkbox, Tag } from 'antd';
import { t } from '../i18n';
import { failureMessage, providerName } from '../messages';
import { card, heading, muted, tap } from '../styles';

export interface ChooseStepProps {
  session: PublicSigningSession;
  /** Өмнөх оролдлого амжилтгүй болсон бол шалтгаан (линк хүчинтэй хэвээр) */
  retryReason: SigningFailureReason | null;
  submitting: boolean;
  /** Start хүсэлтийн алдааны монгол текст */
  error: string | null;
  onSubmit: (provider: ESignProvider) => void;
}

export function ChooseStep({ session, retryReason, submitting, error, onSubmit }: ChooseStepProps) {
  const [consent, setConsent] = useState(false);
  // Нэг л сонголт байвал урьдчилан сонгоно
  const [selected, setSelected] = useState<ESignProvider | null>(session.providers.length === 1 ? session.providers[0].code : null);
  const canSubmit = consent && selected !== null && !submitting;

  return (
    <section style={card}>
      <h1 style={heading}>{t('esign.choose.title')}</h1>
      {retryReason !== null && (
        <Alert type="warning" showIcon message={t('esign.choose.retryTitle')} description={`${failureMessage(retryReason)} ${t('esign.choose.retryLead')}`} />
      )}
      <Checkbox
        checked={consent}
        onChange={(e) => setConsent(e.target.checked)}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 4, padding: 12, border: '1px solid #d9d9d9', borderRadius: 8, lineHeight: 1.5, fontSize: 15 }}
      >
        {t('esign.choose.consent')}
      </Checkbox>
      {session.providers.length === 0 ? (
        <Alert type="error" showIcon message={t('esign.choose.noProviders')} />
      ) : (
        <div role="radiogroup" aria-label={t('esign.choose.providers')} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {session.providers.map((p) => {
            const active = selected === p.code;
            return (
              <button
                key={p.code}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setSelected(p.code)}
                style={{
                  minHeight: 64,
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontSize: 18,
                  fontWeight: 600,
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderRadius: 10,
                  border: active ? '2px solid #1677ff' : '1px solid #d9d9d9',
                  background: active ? '#e6f4ff' : '#fff',
                  color: 'inherit',
                }}
              >
                <span>{p.displayName || providerName(p.code)}</span>
                {p.mock && <Tag color="orange" style={{ margin: 0 }}>{t('esign.provider.mockTag')}</Tag>}
              </button>
            );
          })}
        </div>
      )}
      {selected !== null && session.providers.find((p) => p.code === selected)?.mock === true && (
        <Alert type="warning" showIcon message={t('esign.provider.mockNotice')} />
      )}
      {!consent && <p style={{ ...muted, fontSize: 14 }}>{t('esign.choose.consentRequired')}</p>}
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Button type="primary" size="large" block style={tap} disabled={!canSubmit} loading={submitting} onClick={() => selected !== null && onSubmit(selected)}>
        {t('esign.choose.sign')}
      </Button>
    </section>
  );
}
