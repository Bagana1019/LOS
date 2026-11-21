import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { describe, expect, it } from 'vitest';
import type { ApplicationDetail, ApprovalLevelApprover, ApprovalTimelineLevel, CannotVoteReason, DecisionRisk, DecisionView, OrgDirectory } from '@los/contracts';
import { applicationDetailKey, directoryKey } from '../applications/useApplications';
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
  approval: { currentLevel: 1, totalLevels: 1, levels: [] }, versions: [], decisionRecord: null, canVote: false, cannotVoteReason: 'NOT_LEVEL_APPROVER',
});

function render(d: DecisionView, wizard?: { stage1Completed: number; stage1Total: number }, directory?: OrgDirectory): string {
  const qc = new QueryClient();
  qc.setQueryData(decisionKey(ID), d);
  if (wizard) qc.setQueryData(applicationDetailKey(ID), wizard as ApplicationDetail);
  if (directory) qc.setQueryData(directoryKey, directory);
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

// F3-11: батлагч биш хүн товчгүй хуудсанд яагаад гэдгийг, түвшин бүрд хэн батлахыг харна (нэрээр; UUID, түүхий enum хэзээ ч биш).
describe('DecisionStep (F3-11)', () => {
  const USER_A = '00000000-0000-4000-8000-000000000a01';
  const USER_B = '00000000-0000-4000-8000-000000000b02';
  const GHOST = 'a3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const DIR: OrgDirectory = { branches: {}, users: { [USER_A]: 'Бат Болд', [USER_B]: 'Саруул' } };
  const level = (levelNo: number, name: string, state: ApprovalTimelineLevel['state'], approvers: ApprovalLevelApprover[]): ApprovalTimelineLevel => ({
    levelNo, name, state, startedAt: null, dueAt: null, overdue: false, quorum: { required: 1, total: approvers.length }, votes: [], approvers,
  });
  const decision = (o: { canVote?: boolean; reason?: CannotVoteReason | null; status?: DecisionView['status']; levels?: ApprovalTimelineLevel[] }): DecisionView => {
    const canVote = o.canVote ?? false;
    return {
      ...view(RISK), status: o.status ?? 'IN_APPROVAL', canVote, cannotVoteReason: canVote ? null : (o.reason === undefined ? 'NOT_LEVEL_APPROVER' : o.reason),
      approval: { currentLevel: 1, totalLevels: 2, levels: o.levels ?? [level(1, 'Салбар', 'PENDING', [{ userId: USER_A, role: null }]), level(2, 'Төв', 'WAITING', [{ userId: USER_B, role: null }, { userId: null, role: 'APPROVER' }])] },
    };
  };

  it('батлагч биш хүн: «Та энэ түвшний батлагч биш» мөр, vote товч байхгүй, түвшин бүрд «Батлах эрхтэй: нэр»', () => {
    const out = render(decision({}), undefined, DIR);
    expect(out).toContain('data-testid="cannot-vote-reason"');
    expect(out).toContain('Та энэ түвшний батлагч биш');
    expect(out).not.toContain('data-testid="vote-approve"');
    expect(out).not.toContain('data-testid="vote-return"');
    expect(out).toMatch(/data-testid="level-approvers-1"[^>]*>Батлах эрхтэй: Бат Болд</);
    expect(out).toMatch(/data-testid="level-approvers-2"[^>]*>Батлах эрхтэй: Саруул, Батлагч</); // хүлээгдэж буй түвшинд ч; дүрээр томилсон нь дүрийн шошгоор
  });

  it.each<[CannotVoteReason, string]>([
    ['ALREADY_VOTED', 'Та энэ түвшинд санал өгсөн байна'],
    ['OWN_APPLICATION', 'Өөрийн үүсгэсэн хүсэлтийг батлах боломжгүй'],
    ['NOT_LEVEL_APPROVER', 'Та энэ түвшний батлагч биш'],
    ['NOT_IN_APPROVAL', 'Энэ хүсэлт одоогоор санал авах шатанд биш байна'],
  ])('%s → «%s»; түүхий enum харагдахгүй', (reason, text) => {
    const out = render(decision({ reason }), undefined, DIR);
    expect(out).toContain(text);
    expect(out).not.toContain(reason);
  });

  it('санал өгч болох батлагч: vote товч харагдана, шалтгааны мөр байхгүй, «Батлах эрхтэй» хэвээр', () => {
    const out = render(decision({ canVote: true }), undefined, DIR);
    expect(out).toContain('data-testid="vote-approve"');
    expect(out).toContain('data-testid="vote-return"');
    expect(out).not.toContain('data-testid="cannot-vote-reason"');
    expect(out).toContain('Батлах эрхтэй: Бат Болд');
  });

  it('лавлахад байхгүй батлагч → «Тодорхойгүй», UUID харагдахгүй', () => {
    const out = render(decision({ levels: [level(1, 'Салбар', 'PENDING', [{ userId: GHOST, role: null }, { userId: USER_A, role: null }])] }), undefined, DIR);
    expect(out).toContain('Батлах эрхтэй: Тодорхойгүй, Бат Болд');
    expect(out).not.toContain(GHOST);
  });

  it('лавлах кэшэнд байхгүй үед ч UUID харагдахгүй', () => {
    const out = render(decision({}));
    expect(out).not.toContain(USER_A);
    expect(out).not.toContain(USER_B);
    expect(out).toContain('data-testid="level-approvers-1"');
  });

  it('батлагчгүй түвшин: «Батлах эрхтэй хүн томилоогүй байна»', () => {
    const out = render(decision({ levels: [level(1, 'Салбар', 'PENDING', [])] }), undefined, DIR);
    expect(out).toContain('Батлах эрхтэй хүн томилоогүй байна');
  });

  it.each<DecisionView['status']>(['DRAFT', 'APPROVED', 'RETURNED'])('%s төлөвт шалтгааны мөр давхардахгүй (хуудас төлвөө өөрөө хэлнэ)', (status) => {
    const out = render(decision({ status, reason: 'NOT_IN_APPROVAL', levels: [] }), undefined, DIR);
    expect(out).not.toContain('data-testid="cannot-vote-reason"');
  });
});
