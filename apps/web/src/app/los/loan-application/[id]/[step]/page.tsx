'use client';
import { useParams } from 'next/navigation';
import { BorrowersStep } from '../../../../../features/borrowers';

// docs/01 §2.2: `/los/loan-application/:id/<step>`. Зөвхөн 1-р алхам (`client` — Харилцагч) энд холбогдсон; бусад алхмыг өөр stream нэмнэ.
export default function Page() {
  const { id, step } = useParams<{ id: string; step: string }>();
  if (step === 'client') {
    return (
      <main style={{ padding: 24 }}>
        <BorrowersStep applicationId={id} />
      </main>
    );
  }
  return null;
}
