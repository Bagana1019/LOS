import type { ReactNode } from 'react';
import { t } from '../i18n';
import { GLOBAL_CSS, column, muted, page } from '../styles';

export interface ShellProps {
  /** Хуудасны гарчиг (header-ийн дээд мөр); үгүй бол "Цахим гарын үсэг" */
  title?: string;
  /** Гэрээний дугаар — session ачаалагдсаны дараа */
  contractNo?: string;
  signerNameMasked?: string;
  /** 0 унших · 1 сонгох · 2 баталгаажуулах; үгүй бол алхамын заагч харуулахгүй */
  progress?: 0 | 1 | 2;
  children: ReactNode;
}

/** Зээлдэгчийн хуудасны хүрээ: гарчиг, гэрээний дугаар, алхамын заагч, тусламжийн тэмдэглэл. */
export function Shell({ title = t('esign.page.title'), contractNo, signerNameMasked, progress, children }: ShellProps) {
  return (
    <div style={page}>
      <style>{GLOBAL_CSS}</style>
      <main style={column}>
        <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p style={{ ...muted, fontSize: 14 }}>{title}</p>
          {contractNo !== undefined && (
            <p style={{ margin: 0, fontSize: 18, fontWeight: 600, overflowWrap: 'anywhere' }}>
              {t('esign.header.contractNo')}: {contractNo}
            </p>
          )}
          {signerNameMasked !== undefined && (
            <p style={{ ...muted, fontSize: 14 }}>
              {t('esign.header.signer')}: {signerNameMasked}
            </p>
          )}
        </header>
        {progress !== undefined && <StepIndicator current={progress} />}
        {children}
        <footer>
          <p style={{ ...muted, fontSize: 13, textAlign: 'center' }}>{t('esign.footer.help')}</p>
        </footer>
      </main>
    </div>
  );
}

const STEP_LABELS = [t('esign.steps.review'), t('esign.steps.choose'), t('esign.steps.confirm')] as const;

/** 3 тэнцүү багана — antd Steps нь 360 px дээр хэвтээ тэнхлэгт хальдаг тул өөрийн энгийн заагч */
function StepIndicator({ current }: { current: number }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: 8 }}>
      {STEP_LABELS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} aria-current={active ? 'step' : undefined} style={{ flex: '1 1 0', minWidth: 0, textAlign: 'center' }}>
            <div style={{ height: 4, borderRadius: 2, background: done || active ? '#1677ff' : '#d9d9d9', marginBottom: 6 }} />
            <span style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: active ? 'rgba(0,0,0,0.88)' : 'rgba(0,0,0,0.55)', overflowWrap: 'anywhere' }}>
              {index + 1}. {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
