'use client';
import { useParams } from 'next/navigation';
import { BorrowersStep } from '../../../../../features/borrowers';
import { CollateralStep } from '../../../../../features/collateral';
import { DocumentsStep } from '../../../../../features/documents';

// docs/01 §2.2: `/los/loan-application/:id/<step>`. Холбогдсон алхмууд: 1 `client` (Харилцагч), 5 `collateral` (Барьцаа), 8 `document` (Баримт);
// бусад алхмыг өөр stream нэмнэ.
export default function Page() {
  const { id, step } = useParams<{ id: string; step: string }>();
  if (step === 'client') {
    return (
      <div>
        <BorrowersStep applicationId={id} />
      </div>
    );
  }
  if (step === 'collateral') {
    return (
      <div>
        <CollateralStep applicationId={id} />
      </div>
    );
  }
  if (step === 'document') {
    return (
      <div>
        <DocumentsStep applicationId={id} />
      </div>
    );
  }
  return null;
}
