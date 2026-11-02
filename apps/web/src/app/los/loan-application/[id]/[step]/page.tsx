'use client';
import { useParams } from 'next/navigation';
import { BorrowersStep } from '../../../../../features/borrowers';
import { ScoreStep } from '../../../../../features/score';

// docs/01 §2.2: `/los/loan-application/:id/<step>`. Энд холбогдсон алхмууд: `client` (1 — Харилцагч), `score` (7 — Тооцоолол); бусад алхмыг өөр stream нэмнэ.
export default function Page() {
  const { id, step } = useParams<{ id: string; step: string }>();
  if (step === 'client') {
    return (
      <div>
        <BorrowersStep applicationId={id} />
      </div>
    );
  }
  if (step === 'score') {
    return (
      <div>
        <ScoreStep applicationId={id} />
      </div>
    );
  }
  return null;
}
