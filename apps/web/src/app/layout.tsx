import type { Metadata } from 'next';
import type { CSSProperties, ReactNode } from 'react';
import './globals.css';
import { Providers } from '../components/Providers';
import { AppShell } from '../components/shell/AppShell';
import { brand } from '../theme/brand';

export const metadata: Metadata = { title: { default: brand.name, template: `%s · ${brand.name}` } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="mn">
      <body style={{ background: brand.colors.contentBg, '--los-primary': brand.colors.primary, '--los-surface': brand.colors.headerBg } as CSSProperties}>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
