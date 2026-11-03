'use client';
import { useParams } from 'next/navigation';
import { BsaOverview } from '../../../../features/bsa';

// M12c: хүсэлтийн BSA тойм (docs/02 BSA-FR-6)
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <BsaOverview applicationId={id} />;
}
