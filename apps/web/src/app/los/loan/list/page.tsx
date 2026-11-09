'use client';
import { Suspense } from 'react';
import { LoanListPage } from '../../../../features/loans';

// docs/01 §2 — `/los/loan/list`: олгогдсон зээлүүд.
export default function Page() {
  return (
    <Suspense>
      <LoanListPage />
    </Suspense>
  );
}
