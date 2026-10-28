import type { Metadata } from 'next';
import { mn } from '@los/ui';
import { VerifyPage } from '../../../features/esign/VerifyPage';

// FR-11.4 — QR кодын цэг (нийтийн). Индексжүүлэхгүй; гадагш Referer илгээхгүй.
export const metadata: Metadata = {
  title: mn['verify.page.title'],
  robots: { index: false, follow: false, noarchive: true, nocache: true },
  referrer: 'no-referrer',
};

export default async function VerifyRoute({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <VerifyPage code={code} />;
}
