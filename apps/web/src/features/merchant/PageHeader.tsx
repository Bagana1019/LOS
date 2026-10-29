import type { ReactNode } from 'react';

/** Хуудасны гарчиг. Нэг хуудсанд нэг h1. */
export function PageHeader({ title, subtitle, extra, back }: { title: ReactNode; subtitle?: ReactNode; extra?: ReactNode; back?: ReactNode }) {
  return (
    <header className="mp-page-header">
      <div className="mp-page-header-main">
        {back ? <div className="mp-page-back">{back}</div> : null}
        <h1 className="mp-page-title">{title}</h1>
        {subtitle ? <p className="mp-page-subtitle">{subtitle}</p> : null}
      </div>
      {extra ? <div className="mp-page-extra">{extra}</div> : null}
    </header>
  );
}
