import type { Metadata } from 'next';
import { mn } from '@los/ui';
import { SigningFlow } from '../../../features/esign/SigningFlow';

// FR-11.4 — зээлдэгчийн утсан дээрх гарын үсгийн хуудас (JWT-гүй, токеноор).
// Токен URL-д байдаг тул: индексжүүлэхгүй, Referer-ээр гадагш гаргахгүй, гарчигт оруулахгүй (статик).
export const metadata: Metadata = {
  title: mn['esign.page.title'],
  robots: { index: false, follow: false, noarchive: true, nocache: true, nosnippet: true, noimageindex: true },
  referrer: 'no-referrer',
};

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SigningFlow token={token} />;
}
