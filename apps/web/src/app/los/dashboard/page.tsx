'use client';
import { Suspense } from 'react';
import { Skeleton } from 'antd';
import { DashboardPage } from '../../../features/reports';

// FR-13.3: `/los/dashboard` — KPI самбар (удирдлагын тайлан). `useSearchParams` нь Suspense шаарддаг.
export default function Page() {
  return (
    <div>
      <Suspense fallback={<Skeleton active paragraph={{ rows: 12 }} />}>
        <DashboardPage />
      </Suspense>
    </div>
  );
}
