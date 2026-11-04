import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import './globals.css';
import { Providers } from '../components/Providers';
import { AppShell } from '../components/shell/AppShell';
import { brand, brandCssVars } from '../theme/brand';

export const metadata: Metadata = { title: { default: brand.name, template: `%s · ${brand.name}` } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="mn" style={brandCssVars}>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
