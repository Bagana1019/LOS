'use client';
import { useParams } from 'next/navigation';
import { Empty } from 'antd';
import { useRefreshApplication } from '../../../../../features/applications';
import { BorrowersStep } from '../../../../../features/borrowers';
import { CollateralStep } from '../../../../../features/collateral';
import { DocumentsStep } from '../../../../../features/documents';
import { ContractStep, OfficialDocumentsStep } from '../../../../../features/contract';
import { DecisionStep } from '../../../../../features/decision';
import { DisbursementStep } from '../../../../../features/disbursement';
import { IncomeStep } from '../../../../../features/income';
import { InquiryStep } from '../../../../../features/inquiry';
import { LoanTermsStep } from '../../../../../features/loan-terms';
import { ScheduleStep } from '../../../../../features/schedule';
import { ScoreStep } from '../../../../../features/score';
import { t } from '../../../../../lib/i18n';

// docs/01 §2.2: `/los/loan-application/:id/<step>`. Бүх 12 алхам холбогдсон (docs/01 §2.2); үл мэдэгдэх түлхүүр "бэлэн болоогүй" харуулна. Алхам өөрчлөгдөх бүрт wizard-ийн зүүн самбарыг шинэчилнэ (`onChanged`).
export default function Page() {
  const { id, step } = useParams<{ id: string; step: string }>();
  const refresh = useRefreshApplication(id);
  if (step === 'client') return <BorrowersStep applicationId={id} onChanged={refresh} />;
  if (step === 'inquiry') return <InquiryStep applicationId={id} onChanged={refresh} />;
  if (step === 'income') return <IncomeStep applicationId={id} onChanged={refresh} />;
  if (step === 'collateral') return <CollateralStep applicationId={id} />;
  if (step === 'score') return <ScoreStep applicationId={id} onChanged={refresh} />;
  if (step === 'document') return <DocumentsStep applicationId={id} />;
  if (step === 'loan') return <LoanTermsStep applicationId={id} onChanged={refresh} />;
  if (step === 'installment') return <ScheduleStep applicationId={id} onChanged={refresh} />;
  if (step === 'decision') return <DecisionStep applicationId={id} onChanged={refresh} />;
  if (step === 'contract') return <ContractStep applicationId={id} onChanged={refresh} />;
  if (step === 'official_documents') return <OfficialDocumentsStep applicationId={id} onChanged={refresh} />;
  if (step === 'disburse') return <DisbursementStep applicationId={id} onChanged={refresh} />;
  return <Empty description={t('application.wizard.notReady')} />;
}
