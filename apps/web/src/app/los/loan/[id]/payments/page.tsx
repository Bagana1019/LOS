'use client';
import { useParams } from 'next/navigation';
import { PaymentsPage } from '../../../../../features/payments';

// docs/01 §2: `/los/loan/:id/payments` — зээлийн эргэн төлөлт (ЭТХ, QPay / SocialPay / банкны шилжүүлэг). `:id` нь LoanApplication.id.
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return (
    <main style={{ padding: 24 }}>
      <PaymentsPage applicationId={id} />
    </main>
  );
}
