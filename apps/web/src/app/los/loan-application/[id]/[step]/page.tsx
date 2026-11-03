'use client';
import { useParams } from 'next/navigation';
import { Empty } from 'antd';
import { useRefreshApplication } from '../../../../../features/applications';
import { BorrowersStep } from '../../../../../features/borrowers';
import { CollateralStep } from '../../../../../features/collateral';
import { DocumentsStep } from '../../../../../features/documents';
import { IncomeStep } from '../../../../../features/income';
import { InquiryStep } from '../../../../../features/inquiry';
import { ScoreStep } from '../../../../../features/score';
import { t } from '../../../../../lib/i18n';

// docs/01 §2.2: `/los/loan-application/:id/<step>`. Холбогдсон алхмууд: 1 `client` (Харилцагч), 2 `inquiry` (Лавлагаа), 3 `income` (Орлого), 5 `collateral` (Барьцаа), 7 `score` (Тооцоолол), 8 `document` (Баримт);
// бусад алхмыг өөр модуль нэмнэ (одоогоор "бэлэн болоогүй" харуулна). Алхам өөрчлөгдөх бүрт wizard-ийн зүүн самбарыг шинэчилнэ (`onChanged`).
export default function Page() {
  const { id, step } = useParams<{ id: string; step: string }>();
  const refresh = useRefreshApplication(id);
  if (step === 'client') return <BorrowersStep applicationId={id} onChanged={refresh} />;
  if (step === 'inquiry') return <InquiryStep applicationId={id} onChanged={refresh} />;
  if (step === 'income') return <IncomeStep applicationId={id} onChanged={refresh} />;
  if (step === 'collateral') return <CollateralStep applicationId={id} />;
  if (step === 'score') return <ScoreStep applicationId={id} onChanged={refresh} />;
  if (step === 'document') return <DocumentsStep applicationId={id} />;
  return <Empty description={t('application.wizard.notReady')} />;
}
