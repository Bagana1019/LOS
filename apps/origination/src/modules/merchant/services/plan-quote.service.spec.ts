import { PlanCreate } from '@los/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PricingProvider } from '../ports';
import { laptopPlanInput, type Fixtures } from '../testing/fixtures';
import { toContext } from '../testing/personas';
import { TestApp } from '../testing/test-app';
import { backOfficeScope } from './access';

describe('PlanService / QuoteService / access (service level)', () => {
  let t: TestApp;
  let fx: Fixtures;
  const p = () => t.personas(fx.merchantA.id);
  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
  });
  afterAll(async () => { await t.close(); });

  it('PlanService.get returns a plan inside the scope and 404s for unknown ids', async () => {
    const plan = await t.services.plans.get(toContext(p().lenderAdmin()), fx.laptop.id);
    expect(plan.code).toBe('LAPTOP');
    await expect(t.services.plans.get(toContext(p().lenderAdmin()), '00000000-0000-4000-8000-0000000fffff')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a BRANCH_MANAGER sees global plans and plans of own-branch merchants only', async () => {
    const admin = toContext(p().lenderAdmin());
    const own = await t.services.plans.create(admin, PlanCreate.parse(laptopPlanInput({ code: 'A-ONLY', name: 'Мерчант A', merchantId: fx.merchantA.id })));
    const foreign = await t.services.plans.create(admin, PlanCreate.parse(laptopPlanInput({ code: 'B-ONLY', name: 'Мерчант B', merchantId: fx.merchantB.id })));
    const codesFor = async (branch: string) => (await t.services.plans.list(toContext(p().branchManager(branch)), {})).map((x) => x.code);
    const x = await codesFor('BR-X');
    expect(x).toEqual(expect.arrayContaining(['LAPTOP', own.code]));
    expect(x).not.toContain(foreign.code);
    const y = await codesFor('BR-Y');
    expect(y).toContain(foreign.code);
    expect(y).not.toContain(own.code);
    expect((await t.services.plans.list(admin, {})).map((q) => q.code)).toEqual(expect.arrayContaining([own.code, foreign.code]));
  });

  it('back-office scope rejects unlisted roles and branch managers without a branch', () => {
    expect(() => backOfficeScope({ ...toContext(p().lenderAdmin()), roles: ['OFFICER'] })).toThrowError(/Insufficient role/);
    expect(() => backOfficeScope({ ...toContext(p().branchManager('BR-X')), branchId: null })).toThrowError(/Branch scope required/);
  });
});

describe('QuoteService: calc range errors', () => {
  it('a pricing provider returning out-of-range rates becomes a 400, not a 500', async () => {
    const t = await TestApp.create({ overrides: [{ provide: PricingProvider, useValue: { resolve: () => ({ annualRate: -1, feeRate: 0 }) } }] });
    try {
      const fx = await t.fixtures();
      const res = await t.postJson('/merchant-portal/quotes', t.personas(fx.merchantA.id).merchantAdmin(), { planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Quote parameters are out of range' });
    } finally {
      await t.close();
    }
  });
});
