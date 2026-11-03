'use client';
import { useParams } from 'next/navigation';
import { AnalysisPage } from '../../../../../features/bsa';

// M12c: нэг шинжилгээ — хуулга, сэжигтэй дохио, тайлан
export default function Page() {
  const { id, analysisId } = useParams<{ id: string; analysisId: string }>();
  return <AnalysisPage applicationId={id} analysisId={analysisId} />;
}
