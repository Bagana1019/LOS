import { ApplicationDetail, StepKey } from '@los/contracts';

// Wizard-ийн (`/los/loan-application/:id/*` layout) зүүн самбар хүсэлтийн дэлгэрэнгүйг (`GET /applications/:id`) уншдаг. Алхмын spec-үүд
// (score, collateral, documents) өөрсдийн алхмыг шалгадаг тул энэ дуудлагад анхдагч хариу өгнө (MockApi-ийн хамгийн сул тохируулга; spec дарж болно).
const STAGE2 = ['contract', 'official_documents', 'disburse'];
const REQUIRED = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score'];
const AT = '2026-11-02T03:00:00.000Z';

export function defaultApplicationDetail(id: string): ApplicationDetail {
  return ApplicationDetail.parse({
    id, appNo: 'LA-2026-000001', branchId: 'b1', officerId: 'u1', contractNo: null, primaryBorrower: null, productId: null, productName: null, currency: 'MNT', amount: null, interestRate: null,
    termMonths: null, decidedAt: null, status: 'DRAFT', stepsDone: 0, stepsRequired: 7, createdAt: AT, officerNote: null, purpose: null, version: 1, source: 'WEB', submittedAt: null, approvedAt: null,
    returnedAt: null, editable: true, transitions: [], stage1Completed: 0, stage1Total: 9,
    steps: StepKey.map((stepKey, i) => ({ stepKey, stage: STAGE2.includes(stepKey) ? 2 : 1, order: i + 1, status: STAGE2.includes(stepKey) ? 'LOCKED' : 'PENDING', required: REQUIRED.includes(stepKey), completedAt: null, staleReason: null })),
  });
}
