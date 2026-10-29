'use client';
import { ReportsIndexPage } from '../../../features/reports';

// docs/01 §2.1: `/los/report` — Тайлан цэс (9 тайлан + Dashboard).
export default function Page() {
  return (
    <main style={{ padding: 24 }}>
      <ReportsIndexPage />
    </main>
  );
}
