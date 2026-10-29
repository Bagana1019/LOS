import type { PublicSigningSession } from '@los/contracts';
import { Button, Typography } from 'antd';
import { t } from '../i18n';
import { card, heading, muted, tap } from '../styles';

export interface ReviewStepProps {
  session: PublicSigningSession;
  /** GET …/document — PDF stream; сервер нээгдсэн даруйд documentViewed болгоно */
  documentSrc: string;
  /** iframe ачаалагдлаа → session-ийг дахин авч documentViewed-ийг шинэчилнэ */
  onFrameLoad: () => void;
  /** "Бүтнээр нээх" дарагдлаа (шинэ tab) */
  onOpenFull: () => void;
  onContinue: () => void;
}

export function ReviewStep({ session, documentSrc, onFrameLoad, onOpenFull, onContinue }: ReviewStepProps) {
  const viewed = session.documentViewed;
  return (
    <section style={card}>
      <h1 style={heading}>{t('esign.review.title')}</h1>
      <p style={muted}>{t('esign.review.lead')}</p>
      {/* Гар утасны хөтөч нэг дотор PDF-ийг муу үзүүлдэг тул шинэ tab-д бүтнээр нээх нь үндсэн арга */}
      <Button type={viewed ? 'default' : 'primary'} size="large" block style={tap} href={documentSrc} target="_blank" rel="noopener noreferrer" onClick={onOpenFull}>
        {t('esign.review.openFull')}
      </Button>
      <p style={{ ...muted, fontSize: 14 }}>{t('esign.review.openFullHint')}</p>
      <iframe
        src={documentSrc}
        title={t('esign.review.frameTitle')}
        referrerPolicy="no-referrer"
        onLoad={onFrameLoad}
        style={{ width: '100%', height: '50vh', minHeight: 280, border: '1px solid #d9d9d9', borderRadius: 8, background: '#fff' }}
      />
      <p style={{ ...muted, fontSize: 13 }}>{t('esign.review.frameFallback')}</p>
      <Typography.Text type={viewed ? 'success' : 'secondary'} role="status">
        {viewed ? t('esign.review.viewedOk') : t('esign.review.viewedRequired')}
      </Typography.Text>
      <Button type={viewed ? 'primary' : 'default'} size="large" block style={tap} disabled={!viewed} onClick={onContinue}>
        {t('esign.review.continue')}
      </Button>
    </section>
  );
}
