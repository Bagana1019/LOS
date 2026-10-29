import { Suspense } from 'react';
import { PosLeasesAdmin } from '../../../features/merchant/backoffice/PosLeasesAdmin';

export default function PosLeasesAdminPage() {
  return (
    <Suspense fallback={null}>
      <PosLeasesAdmin />
    </Suspense>
  );
}
