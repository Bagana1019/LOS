import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { describe, expect, it } from 'vitest';
import type { ApplicationDetail, DecisionRisk, DecisionView } from '@los/contracts';
import { applicationDetailKey } from '../applications/useApplications';
import { decisionKey } from './decision.api';
import { DecisionStep } from './DecisionStep';

// F3-1: шийдвэрийн хуудсыг (DecisionStep) кэшлэгдсэн серверийн хариугаар бүтнээр нь render хийж шалгана (query кэшийг урьдчилан бөглөнө; сүлжээ, schema parse байхгүй).
const ID = '00000000-0000-4000-8000-0000000000e3';
const RISK: DecisionRisk = {
  method: 'A_SALARY', selection: 'AUTO', computedAt: '2026-11-20T03:00:00.000Z', stale: false,
  ratio: { kind: 'DTI', value: 0.4321, limit: 0.55, pass: true }, ltv: { value: 0.0625, limit: 0.7, pass: true }, sosco: { score: 712, grade: 'B' },
  collateral: { count: 2, totalValue: 80_000_000, required: true },
  income: { salaryMonthly: 2_500_000, businessNcfMonthly: 300_000, householdExpenseMonthly: 400_000 }, flags: [],
};
const view = (risk: DecisionRisk | null | undefined): DecisionView => ({
  applicationId: ID, appNo: 'LA-2026-000001', status: 'IN_APPROVAL', version: 1,
  summary: { borrowerName: 'Бат Болд', registerNoMasked: null, productName: 'Хэрэглээний', currency: 'MNT', amount: 5_000_000, termMonths: 12, interestRate: 28, monthlyPayment: 482_529.94, collateralCount: 2, selectedMethod: 'A_SALARY', ...(risk === undefined ? {} : { risk }) },
  progress: { completed: 8, total: 8, missing: [], reasons: {} }, canSubmit: false,
  approval: { currentLevel: 1, totalLevels: 1, levels: [] }, versions: [], decisionRecord: null, canVote: false,
});

function render(d: DecisionView, wizard?: { stage1Completed: number; stage1Total: number }): string {
  const qc = new QueryClient();
  qc.setQueryData(decisionKey(ID), d);
  if (wizard) qc.setQueryData(applicationDetailKey(ID), wizard as ApplicationDetail);
  return renderToString(<QueryClientProvider client={qc}><AntApp><DecisionStep applicationId={ID} /></AntApp></QueryClientProvider>);
}

describe('DecisionStep (F3-1)', () => {
  it('батлагч эрсдэлийн карт, монгол аргын шошго, сарын төлбөрийг харна; түүхий enum байхгүй', () => {
    const out = render(view(RISK), { stage1Completed: 9, stage1Total: 9 });
    expect(out).toContain('data-testid="risk-card"');
    expect(out).toContain('43.21%');
    expect(out).toContain('80,000,000₮');
    expect(out).toContain('A · Цалин');
    expect(out).not.toContain('A_SALARY');
    expect(out).toContain('482,529.94₮');
  });

  it('шугам нь wizard-ийн «Бүрдсэн» тоолуурын тоог (9/9) харуулж, заавал бүрдэх 8/8-ийг тусад нь нэрлэнэ', () => {
    const out = render(view(RISK), { stage1Completed: 9, stage1Total: 9 });
    expect(out).toContain('9/9');
    expect(out).toContain('Бүрдсэн алхам (1-р үе шат): 9/9');
    expect(out).toContain('Заавал бүрдэх алхам: 8/8');
  });

  it('wizard-ийн тоолуур кэшэнд байхгүй бол заавал бүрдэх алхмаар (8/8) — нэг л мөр', () => {
    const out = render(view(RISK));
    expect(out).toContain('8/8');
    expect(out).toContain('Заавал бүрдэх алхам: 8/8');
    expect(out).not.toContain('1-р үе шат');
  });

  it('тооцоолол хадгалагдаагүй (risk=null) ба хуучин хариу (risk байхгүй) → тодорхой мэдээлэл, хоосон карт биш', () => {
    for (const risk of [null, undefined]) {
      const out = render(view(risk), { stage1Completed: 9, stage1Total: 9 });
      expect(out).toContain('data-testid="risk-missing"');
      expect(out).not.toContain('data-testid="risk-card"');
    }
  });
});
