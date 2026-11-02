'use client';
import { Suspense } from 'react';
import { ApplicationListPage } from '../../../features/applications';

// FR-1: хүсэлтийн жагсаалт (9 таб). docs/01 §2.
export default function Page() {
  return (
    <Suspense>
      <ApplicationListPage />
    </Suspense>
  );
}
