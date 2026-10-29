import type { PosScreeningRequest, PosScreeningResponse } from '@los/contracts';
import { BuyerScreeningPort, Clock } from '../../ports';

// docs/05 §11.1 — deterministic fixture. Төрсөн огноо = регистрийн YYMMDD (сар > 20 → 2000-аад, сар − 20);
// сценарийг регистрийн СҮҮЛИЙН цифр сонгоно. DEMO/TEST: бодит лавлагаа биш.
export const MOCK_LAST_NAME = 'Тест';
export const MOCK_FIRST_NAME = 'Харилцагч';

const REGISTER_RE = /^[А-ЯӨҮЁ]{2}(\d{2})(\d{2})(\d{2})\d{2}$/u;

/** Регистрээс төрсөн огноо (YYYY-MM-DD); буруу бол null. */
export function birthDateFromRegister(register: string): string | null {
  const m = REGISTER_RE.exec(register.trim().toUpperCase());
  if (!m) return null;
  const yy = Number(m[1]);
  let month = Number(m[2]);
  const day = Number(m[3]);
  let year = 1900 + yy;
  if (month > 20) {
    year = 2000 + yy;
    month -= 20;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function mockScreeningFor(registerNo: string, fetchedAt: Date): PosScreeningResponse {
  const birthDate = birthDateFromRegister(registerNo);
  const scenario = registerNo.trim().slice(-1);
  const res: PosScreeningResponse = {
    identity: { found: birthDate !== null, lastName: MOCK_LAST_NAME, firstName: MOCK_FIRST_NAME, birthDate, phoneMatches: true },
    blacklist: { hit: false, reasonCode: null },
    pep: false,
    cib: { available: true, activeLoanCount: 1, monthlyDebtService: 150_000, maxDpdDays: 0, ficoScore: 700 },
    income: { monthlyAmount: 2_500_000, source: 'NDSH', months: 12 },
    fetchedAt: fetchedAt.toISOString(),
  };
  switch (scenario) {
    case '1': res.income.monthlyAmount = 700_000; break; // бага орлого → ӨОХ
    case '2': res.blacklist = { hit: true, reasonCode: 'MOCK_BLACKLIST' }; break;
    case '3': res.cib.maxDpdDays = 120; break;
    case '4': res.income = { monthlyAmount: null, source: 'NONE', months: 0 }; break;
    case '5': res.pep = true; break;
    case '6': res.cib = { available: false, activeLoanCount: 0, monthlyDebtService: 0, maxDpdDays: 0, ficoScore: null }; break;
    case '7': res.cib.ficoScore = 480; break;
    case '8': res.identity = { found: false, lastName: null, firstName: null, birthDate: null, phoneMatches: null }; break;
    default: break; // 0, 9 — хэвийн
  }
  if (birthDate === null) res.identity = { found: false, lastName: null, firstName: null, birthDate: null, phoneMatches: null };
  return res;
}

export class MockBuyerScreening extends BuyerScreeningPort {
  constructor(private readonly clock: Clock) { super(); }
  async screen(req: PosScreeningRequest): Promise<PosScreeningResponse> {
    return mockScreeningFor(req.registerNo, this.clock.now());
  }
}
