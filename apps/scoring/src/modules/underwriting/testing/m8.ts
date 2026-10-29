// Модуль 8 (underwriting + sosco) тестийн нийтлэг туслах: ScoreRequest fixture, gateway толгой, DB цэвэрлэгээ, app boot.
// src/-д байна: `nest build` rootDir=src бөгөөд src доторх тест файлууд ч компайлагддаг (src-ээс гадуур импорт хийвэл build унана).
// АНХААР: resetM8Tables нь calculation, sosco_*, outbox хүснэгтийг TRUNCATE хийнэ → DB-ийн нэр `test`-ээр төгссөн байх ёстой.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SystemClock } from '@los/nest-common';
import { SEED } from '@los/database';
import type { RequestContext, ScoreRequest, SoscoInput } from '@los/contracts';
import { AppModule } from '../../../app.module';
import { PrismaService } from '../../../prisma.service';
import { configureBsaApp } from '../../bsa/import/http';
import { SoscoModelService } from '../../sosco/sosco-model.service';

export const ORG = SEED.org.id;
export const OTHER_ORG = '00000000-0000-4000-8000-0000000000ff';

/** Gateway-ийн дамжуулах толгой (CLAUDE.md §3.2.9) */
const headers = (userId: string, roles: string, orgId: string = ORG) => ({ 'x-user-id': userId, 'x-roles': roles, 'x-branch-id': SEED.branches.head.id, 'x-org-id': orgId });
export const ACTORS = {
  officer: headers(SEED.users.officerA.id, 'OFFICER'),
  officerB: headers(SEED.users.officerB.id, 'OFFICER'),
  manager: headers(SEED.users.manager.id, 'BRANCH_MANAGER'),
  approver: headers(SEED.users.approver.id, 'APPROVER'),
  admin: headers(SEED.users.admin.id, 'ADMIN'),
  otherOrgOfficer: headers('00000000-0000-4000-8000-0000000002ff', 'OFFICER', OTHER_ORG),
  otherOrgAdmin: headers('00000000-0000-4000-8000-0000000002fe', 'ADMIN', OTHER_ORG),
} as const;

export const ctxOf = (actor: keyof typeof ACTORS, correlationId = 'corr-test-1'): RequestContext => {
  const h = ACTORS[actor];
  return { userId: h['x-user-id'], roles: h['x-roles'].split(','), branchId: h['x-branch-id'], orgId: h['x-org-id'], customerId: null, correlationId };
};

export const POLICY = { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 } as const;
export const STRESS = { rateDeltaPoints: 5, incomeChange: -0.2 } as const;

/** Цалингийн орлоготой энгийн хүсэлт: A (ӨОХ 41.7%), барьцаа LTV 50%. Автомат = A_SALARY */
export function scoreRequest(over: Partial<ScoreRequest> = {}): ScoreRequest {
  return {
    applicationId: 'app-m8-1', amount: 20_000_000, termMonths: 24, interestRate: 23.99, monthlyPayment: 1_050_000,
    salaryMonthly: 3_000_000, businessNcfMonthly: 0, householdExpenseMonthly: 800_000, existingDebtServiceMonthly: 200_000,
    collateralValueTotal: 40_000_000, collateralRequired: true, policy: { ...POLICY }, stress: { ...STRESS }, ...over,
  };
}
/** Зөвхөн бизнесийн ЦМУ: B автомат, A хэрэглэгдэхгүй */
export const businessRequest = (over: Partial<ScoreRequest> = {}): ScoreRequest => scoreRequest({ salaryMonthly: 0, businessNcfMonthly: 5_000_000, ...over });
/** Цалин ба ЦМУ тэнцүү орчим: C автомат (MIXED) */
export const mixedRequest = (over: Partial<ScoreRequest> = {}): ScoreRequest => scoreRequest({ salaryMonthly: 2_000_000, businessNcfMonthly: 2_000_000, ...over });
/** Орлого огт байхгүй: автомат сонголтгүй */
export const noIncomeRequest = (over: Partial<ScoreRequest> = {}): ScoreRequest => scoreRequest({ salaryMonthly: 0, businessNcfMonthly: 0, ...over });

export const FULL_SOSCO_INPUT: SoscoInput = { ficoScore: 720, dtiPercent: 40, incomeReliability: 80, pendingSuspiciousCount: 0, activeLoanCount: 1, overdueHistoryMonths: 0, ltv: 0.5 };
/** Бүх бүрэлдэхүүн мэдэгдэхгүй: coverage 0 → INSUFFICIENT_DATA */
export const EMPTY_SOSCO_INPUT: SoscoInput = { ficoScore: null, dtiPercent: null, incomeReliability: null, pendingSuspiciousCount: null, activeLoanCount: null, overdueHistoryMonths: null, ltv: null };

function assertTestDb(): void {
  const url = process.env.TEST_DATABASE_URL;
  const name = url ? decodeURIComponent(new URL(url).pathname.slice(1)) : '';
  if (!/test$/i.test(name)) throw new Error(`Refusing to TRUNCATE "${name}": the database name must end with "test"`);
}

const M8_TABLES = ['calculation', 'sosco_result', 'sosco_model', 'outbox'] as const;

/** Модуль 8-ийн хүснэгтийг цэвэрлэнэ (sosco_model-ийг ч — seed-ийг `restoreSeed`-ээр сэргээнэ) */
export async function resetM8Tables(db: PrismaService): Promise<void> {
  assertTestDb();
  await db.$executeRawUnsafe(`TRUNCATE ${M8_TABLES.map((t) => `"scoring"."${t}"`).join(', ')} CASCADE`);
}

/** Файл дуусахад: бусад тест файлд Sosco загвар (DEMO v1 — seed-тэй ижил `@los/calc` анхдагч) байхаар */
export async function restoreSeed(db: PrismaService): Promise<void> {
  await resetM8Tables(db);
  await new SoscoModelService(db, new SystemClock()).ensureActiveModel(ORG);
}

export async function bootApp(): Promise<{ app: INestApplication; db: PrismaService }> {
  const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  configureBsaApp(app); // main.ts-тэй ижил (global /api угтвар + BsaExceptionFilter): controller-ийн filter түүнээс түрүүлдгийг баталгаажуулна
  await app.init();
  return { app, db: app.get(PrismaService) };
}

/** `scoring.outbox`-ийн event-үүд (шинэ нь сүүлд) */
export async function outboxEvents(db: PrismaService, type?: string) {
  const rows = await db.outbox.findMany({ where: type ? { type } : {}, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return rows.map((r) => r.payload as Record<string, unknown>);
}

/** outbox INSERT-ийг DB түвшинд унагана (бизнес мөр бичигдсэний ДАРАА алдаа гаргах — атомик байдлын тест). Буцаах функц нь устгана */
export async function failOutboxInserts(db: PrismaService): Promise<() => Promise<void>> {
  await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "scoring"."m8_fail_outbox"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'm8 forced outbox failure'; END; $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER "m8_fail_outbox" BEFORE INSERT ON "scoring"."outbox" FOR EACH ROW EXECUTE FUNCTION "scoring"."m8_fail_outbox"()`);
  return async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "m8_fail_outbox" ON "scoring"."outbox"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "scoring"."m8_fail_outbox"()`);
  };
}
