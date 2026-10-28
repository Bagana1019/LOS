import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from '../components/Providers';
import { AppShell } from '../components/shell/AppShell';
import { brand } from '../theme/brand';

export const metadata: Metadata = { title: { default: brand.name, template: `%s · ${brand.name}` } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="mn">
      <body style={{ background: brand.colors.contentBg }}>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
