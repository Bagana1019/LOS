// BSA-FR-3.3 / 3.4 / 3.5: гар ангилал, ижил гүйлгээнд хэрэглэх, дүрэм санал болгох/хадгалах, дахин тооцоолол. SYNTHETIC өгөгдөл.
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { createHarness, ADMIN, OFFICER, ctxOf } from './testing/harness';
import { EXPECTED_AFTER_RENT_RECLASSIFY, EXPECTED_HAPPY, importHappy } from './testing/scenario';

async function setup() {
  const h = await createHarness();
  const { analysisId } = await importHappy(h);
  const rows = await h.memory.transactions.loadAll(analysisId);
  const rent = rows.filter((r) => r.description.startsWith('Түрээс')).sort((a, b) => a.txnDate.localeCompare(b.txnDate));
  return { h, analysisId, rows, rent };
}

describe('ReclassifyService.reclassify', () => {
  it('moves the selected row and the similar ones to the new category and recalculates the DTI exactly', async () => {
    const { h, analysisId, rent } = await setup();
    expect(rent).toHaveLength(3);

    const res = await h.reclassify.reclassify(OFFICER, analysisId, {
      transactionIds: [rent[0].id], categoryCode: 'IRREGULAR_INCOME', applyToSimilar: true, similarBy: 'DESCRIPTION',
    });
    expect(res).toMatchObject({ selected: 1, similar: 2, affected: 3, repushRequired: false });
    expect(res.suggestedRule).not.toBeNull();
    expect(res.summary).toMatchObject({
      verifiedMonthlyIncome: EXPECTED_AFTER_RENT_RECLASSIFY.verifiedMonthlyIncome,
      dtiIncome: EXPECTED_AFTER_RENT_RECLASSIFY.dtiIncome,
      dtiPercent: EXPECTED_AFTER_RENT_RECLASSIFY.dtiPercent,
      dtiLevel: 'MEDIUM',
      // Нийт орлого өөрчлөгдөхгүй: тогтмол бус орлого мөн «орлого»
      totalMonthlyIncome: EXPECTED_HAPPY.totalMonthlyIncome,
    });

    const after = await h.memory.transactions.loadAll(analysisId);
    const changed = after.filter((r) => r.description.startsWith('Түрээс'));
    expect(changed.every((r) => r.categoryCode === 'IRREGULAR_INCOME' && r.manualOverride && r.confidence === 100 && r.overrideBy === OFFICER.userId)).toBe(true);
    // Бусад мөр хөндөгдөөгүй
    expect(after.filter((r) => r.manualOverride)).toHaveLength(3);

    // Санал болгосон дүрэм хадгалагдаагүй (хувийн нэр орсон байж болно ⇒ зөвхөн ADMIN баталгаажуулна)
    const rules = await h.reclassify.listRules(ADMIN);
    expect(rules.some((r) => r.categoryCode === 'IRREGULAR_INCOME' && r.source === 'FEEDBACK')).toBe(false);

    const events = (await h.analysis.listEvents(OFFICER, analysisId)).items.filter((e) => e.action === 'RECLASSIFIED');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ category: 'IRREGULAR_INCOME', selected: 1, similar: 2, affected: 3, similarBy: 'DESCRIPTION', ruleSuggested: true });
    expect(events[0].actorId).toBe(OFFICER.userId);
  });

  it('changes only the selected row when applyToSimilar is false', async () => {
    const { h, analysisId, rent } = await setup();
    const res = await h.reclassify.reclassify(OFFICER, analysisId, { transactionIds: [rent[1].id], categoryCode: 'IRREGULAR_INCOME' });
    expect(res).toMatchObject({ selected: 1, similar: 0, affected: 1 });
    // 600,000 нэг сард тогтмол бус болов ⇒ сарын дундаж 400,000-аар бууна
    expect(res.summary?.verifiedMonthlyIncome).toBe(EXPECTED_HAPPY.verifiedMonthlyIncome - 200_000);
  });

  it('a manual override survives recalculation and a newly created ADMIN rule', async () => {
    const { h, analysisId, rent } = await setup();
    await h.reclassify.reclassify(OFFICER, analysisId, {
      transactionIds: [rent[0].id], categoryCode: 'IRREGULAR_INCOME', applyToSimilar: true,
    });

    const again = await h.recalc.recalculate(OFFICER, analysisId);
    expect(again.summary?.verifiedMonthlyIncome).toBe(EXPECTED_AFTER_RENT_RECLASSIFY.verifiedMonthlyIncome);
    expect(again.reclassified).toBe(0);

    // Өндөр эрэмбийн дүрэм «түрээс»-ийг буцаан PASSIVE_INCOME болгохыг оролдоно — гар засвар ялна
    const created = await h.reclassify.createRule(ADMIN, {
      direction: 'INCOME', matchType: 'KEYWORD', pattern: 'түрээс', categoryCode: 'CASH_INCOME', priority: 99_000,
    }, { analysisId });
    expect(created.summary?.verifiedMonthlyIncome).toBe(EXPECTED_AFTER_RENT_RECLASSIFY.verifiedMonthlyIncome);
    const rows = await h.memory.transactions.loadAll(analysisId);
    expect(rows.filter((r) => r.description.startsWith('Түрээс')).every((r) => r.categoryCode === 'IRREGULAR_INCOME')).toBe(true);
  });

  it('rejects a category of the wrong direction, an unknown category and an unknown transaction without changing anything', async () => {
    const { h, analysisId, rent, rows } = await setup();
    const before = JSON.stringify(await h.memory.transactions.loadAll(analysisId));
    const eventsBefore = (await h.analysis.listEvents(OFFICER, analysisId)).items.length;

    await expect(h.reclassify.reclassify(OFFICER, analysisId, { transactionIds: [rent[0].id], categoryCode: 'LOAN_PAYMENT' }))
      .rejects.toMatchObject({ bsaCode: 'CATEGORY_INVALID', status: 400 });
    await expect(h.reclassify.reclassify(OFFICER, analysisId, { transactionIds: [rent[0].id], categoryCode: 'NO_SUCH_CATEGORY' }))
      .rejects.toMatchObject({ bsaCode: 'CATEGORY_INVALID' });
    await expect(h.reclassify.reclassify(OFFICER, analysisId, { transactionIds: ['11111111-1111-4111-8111-111111111111'], categoryCode: 'IRREGULAR_INCOME' }))
      .rejects.toMatchObject({ bsaCode: 'TRANSACTION_NOT_FOUND', status: 404 });
    // Өөр шинжилгээний мөр биш: ижил id-г өөр шинжилгээнд ашиглах боломжгүй
    const other = await h.createAnalysis({ loanApplicationId: 'app-2' });
    await expect(h.reclassify.reclassify(OFFICER, other.id, { transactionIds: [rows[0].id], categoryCode: 'OTHER_INCOME' }))
      .rejects.toMatchObject({ bsaCode: 'TRANSACTION_NOT_FOUND' });
    await expect(h.reclassify.reclassify(OFFICER, analysisId, { transactionIds: [], categoryCode: 'OTHER_INCOME' }))
      .rejects.toMatchObject({ bsaCode: 'INVALID_REQUEST', status: 400 });

    expect(JSON.stringify(await h.memory.transactions.loadAll(analysisId))).toBe(before);
    expect((await h.analysis.listEvents(OFFICER, analysisId)).items).toHaveLength(eventsBefore);
  });

  it('after the push to LOS a reclassification asks for a re-push', async () => {
    const { h, analysisId, rent } = await setup();
    await h.finalize.finalize(OFFICER, analysisId);
    const res = await h.reclassify.reclassify(OFFICER, analysisId, { transactionIds: [rent[0].id], categoryCode: 'IRREGULAR_INCOME', applyToSimilar: true });
    expect(res.repushRequired).toBe(true);
    expect(res.summary?.status).toBe('ANALYZED');
  });

  it('is rolled back as a whole when the recalculation fails', async () => {
    const { h, analysisId, rent } = await setup();
    const real = h.recalc.run.bind(h.recalc);
    h.recalc.run = async () => {
      throw new Error('recalc unavailable');
    };
    await expect(h.reclassify.reclassify(OFFICER, analysisId, { transactionIds: [rent[0].id], categoryCode: 'IRREGULAR_INCOME' })).rejects.toThrow('recalc unavailable');
    h.recalc.run = real;
    // Гар ангилал ба түүхийн бичлэг хоёулаа буцсан (нэг транзакц)
    const rows = await h.memory.transactions.loadAll(analysisId);
    expect(rows.some((r) => r.manualOverride)).toBe(false);
    expect((await h.analysis.listEvents(OFFICER, analysisId)).items.some((e) => e.action === 'RECLASSIFIED')).toBe(false);
  });
});

describe('ReclassifyService rules and catalog', () => {
  it('only ADMIN may create or list rules; ordinary users may list categories', async () => {
    const { h } = await setup();
    const rule = { direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'хүнс', categoryCode: 'DISCRETIONARY_EXPENSE', priority: 99_000 } as const;
    await expect(h.reclassify.createRule(OFFICER, rule)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.reclassify.createRule(ctxOf(['BRANCH_MANAGER']), rule)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.reclassify.listRules(OFFICER)).rejects.toBeInstanceOf(ForbiddenException);
    const categories = await h.reclassify.listCategories(OFFICER);
    expect(categories.map((c) => c.code)).toEqual(expect.arrayContaining(['SALARY', 'OTHER_EXPENSE', 'OWN_TRANSFER_IN']));
    expect((await h.reclassify.listRules(ADMIN)).length).toBeGreaterThan(10);
  });

  it('a new rule is validated (unknown category, direction mismatch, unsafe regex) without echoing the pattern', async () => {
    const { h } = await setup();
    const secret = '(zxq-secret+)+$';
    await expect(h.reclassify.createRule(ADMIN, { direction: 'EXPENSE', matchType: 'REGEX', pattern: secret, categoryCode: 'OTHER_EXPENSE', priority: 1000 }))
      .rejects.toMatchObject({ bsaCode: 'RULE_INVALID', status: 400 });
    await expect(h.reclassify.createRule(ADMIN, { direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'abc', categoryCode: 'SALARY', priority: 1000 }))
      .rejects.toMatchObject({ bsaCode: 'RULE_INVALID' });
    await expect(h.reclassify.createRule(ADMIN, { direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'abc', categoryCode: 'NO_SUCH', priority: 1000 }))
      .rejects.toMatchObject({ bsaCode: 'RULE_INVALID' });
    try {
      await h.reclassify.createRule(ADMIN, { direction: 'EXPENSE', matchType: 'REGEX', pattern: secret, categoryCode: 'OTHER_EXPENSE', priority: 1000 });
    } catch (e) {
      expect(JSON.stringify((e as { getResponse(): unknown }).getResponse())).not.toContain('zxq-secret');
    }
  });

  it('creates a rule once, rejects the duplicate, and reclassifies the analysis with it', async () => {
    const { h, analysisId } = await setup();
    const rule = { direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'хүнс', categoryCode: 'DISCRETIONARY_EXPENSE', priority: 99_000 } as const;
    const first = await h.reclassify.createRule(ADMIN, rule, { analysisId });
    expect(first.rule.id).toBeTruthy();
    // Хүнс (100,000/сар) өрхийн зардлаас гарч, зөвхөн Unitel (80,000) үлдэнэ
    const report = await h.recalc.report(OFFICER, analysisId);
    expect(report.details?.dti.householdExpenseMonthly).toBe(80_000);
    expect(report.summaryStale).toBe(false);
    await expect(h.reclassify.createRule(ADMIN, rule)).rejects.toMatchObject({ bsaCode: 'RULE_DUPLICATE', status: 409 });
    const actions = (await h.analysis.listEvents(OFFICER, analysisId)).items.map((e) => e.action);
    expect(actions).toContain('RULE_CREATED');
  });

  it('a rule for another org user cannot be attached to an analysis of this org', async () => {
    const { h, analysisId } = await setup();
    const foreignAdmin = ctxOf(['ADMIN'], { orgId: 'org-2', userId: 'u-x', branchId: null });
    await expect(h.reclassify.createRule(foreignAdmin, {
      direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'хүнс', categoryCode: 'DISCRETIONARY_EXPENSE', priority: 1000,
    }, { analysisId })).rejects.toMatchObject({ status: 404 });
  });
});
