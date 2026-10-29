import type { ReactNode } from 'react';
import type { SigningVerification } from '@los/contracts';
import { Alert, Typography } from 'antd';
import { formatUlaanbaatar } from './format';
import { t } from './i18n';
import { providerName } from './messages';
import { Panel } from './steps/ResultStep';
import { Shell } from './steps/Shell';
import { card, heading, mono, muted } from './styles';

/** Тушаалыг зайгаар таслана (үгийн дунд биш) */
const command = { ...mono, wordBreak: 'normal' } as const;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <dt style={{ ...muted, fontSize: 13 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 16, overflowWrap: 'anywhere' }}>{children}</dd>
    </div>
  );
}

function Hash({ value }: { value: string }) {
  return (
    <Typography.Text copyable style={{ ...mono, fontSize: 14 }}>
      {value}
    </Typography.Text>
  );
}

/** QR кодоор нээгдэх баталгаажуулалтын үр дүн. Гэрээний агуулга, регистр, утас байхгүй (серверийн DTO-д ч байхгүй). */
export function VerifyView({ verification: v }: { verification: SigningVerification }) {
  return (
    <Shell title={t('verify.page.title')}>
      {v.valid && !v.mock && <Alert type="success" showIcon message={t('verify.valid')} description={t('verify.validBody')} />}
      {v.valid && v.mock && <Alert type="warning" showIcon message={t('verify.mockBadge')} description={t('verify.mockBody')} />}
      {!v.valid && <Alert type="error" showIcon message={t('verify.invalid')} description={t('verify.invalidBody')} />}
      {!v.valid && v.mock && <Alert type="warning" showIcon message={t('verify.mockBadge')} description={t('verify.mockBody')} />}
      <section style={card}>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label={t('verify.field.contractNo')}>{v.contractNo}</Field>
          <Field label={t('verify.field.signer')}>{v.signerNameMasked}</Field>
          <Field label={t('verify.field.provider')}>{providerName(v.provider)}</Field>
          <Field label={t('verify.field.signedAt')}>
            {formatUlaanbaatar(v.signedAt)} ({t('verify.timezone')})
          </Field>
          <Field label={t('verify.field.certIssuer')}>{v.certificateIssuer}</Field>
          <Field label={t('verify.field.certSerial')}>
            <span style={mono}>{v.certificateSerial}</span>
          </Field>
          <Field label={t('verify.field.originalSha256')}>
            <Hash value={v.originalSha256} />
          </Field>
          <Field label={t('verify.field.signedSha256')}>
            <Hash value={v.signedSha256} />
          </Field>
        </dl>
      </section>
      <section style={card}>
        <h2 style={{ ...heading, fontSize: 17 }}>{t('verify.howTo.title')}</h2>
        <p style={muted}>{t('verify.howTo.intro')}</p>
        <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Field label={t('verify.howTo.windows')}>
            <code style={command}>{t('verify.howTo.windowsCmd')}</code>
          </Field>
          <Field label={t('verify.howTo.unix')}>
            <code style={command}>{t('verify.howTo.unixCmd')}</code>
          </Field>
        </dl>
        <p style={{ ...muted, fontSize: 14 }}>{t('verify.howTo.note')}</p>
      </section>
    </Shell>
  );
}

export function VerifyNotFound() {
  return (
    <Shell title={t('verify.page.title')}>
      <Panel status="warning" title={t('verify.notFound.title')} subTitle={t('verify.notFound.body')} />
    </Shell>
  );
}
