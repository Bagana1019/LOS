'use client';
import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { Skeleton } from 'antd';
import { ReportPage } from '../../../../features/reports';

// FR-13.3: `/los/report/:key` — тайлан бүр (шүүлт, хуудаслалт, эрэмбэ, Excel). `useSearchParams` нь Suspense шаарддаг.
export default function Page() {
  const { key } = useParams<{ key: string }>();
  return (
    <main style={{ padding: 24 }}>
      <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
        <ReportPage key={key} reportKey={key} />
      </Suspense>
    </main>
  );
}
