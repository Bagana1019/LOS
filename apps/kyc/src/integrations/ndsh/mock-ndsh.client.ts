import { createHash } from 'node:crypto';
import type { NdshSalaryRow } from '@los/contracts';
import { NdshUnavailableError, type NdshClient } from './ndsh.client';

const EMPLOYERS = ['Монгол Шуудан ХХК', 'Оюу Толгой ХХК', 'Төв аймгийн ЗДТГ', 'Номин Холдинг', 'Улаанбаатар Банк ХК'];
/** Туршилтын тогтмол: цалингүй (НДШ-д бүртгэлгүй). */
export const NO_SALARY_REGISTER = /00000000$/;
export const NDSH_UNAVAILABLE_REGISTER = /99999999$/;

/** Төвийн огноо (Clock-оос үл хамаарна): fixture нь "сүүлийн 24 сар" гэж үзэж 2026-10 хүртэл тогтмол мөр өгнө. */
export const MOCK_LAST_YEAR = 2026;
export const MOCK_LAST_MONTH = 10;

/**
 * DEMO — бодит НДШ биш! Регистрийн hash-аас: ажил олгогч, үндсэн цалин 900,000–3,900,000 (тэгш 50,000), сар бүр ±5% хүртэл хэлбэлзэл,
 * ажил эхэлсэн сараас хойш л цалин орно (24 сарын эхний 0–6 сар хоосон байж болно). Deterministic.
 */
export class MockNdshClient implements NdshClient {
  readonly demo = true;

  async getSalaries(registerNo: string): Promise<NdshSalaryRow[]> {
    if (NDSH_UNAVAILABLE_REGISTER.test(registerNo)) throw new NdshUnavailableError();
    if (NO_SALARY_REGISTER.test(registerNo)) return [];
    const h = createHash('sha256').update(`ndsh-demo:${registerNo}`).digest();
    const employer = EMPLOYERS[h[0]! % EMPLOYERS.length]!;
    const base = 900_000 + (h[1]! % 61) * 50_000;
    const gap = h[2]! % 7; // эхний хоосон сар
    const rows: NdshSalaryRow[] = [];
    for (let back = 23; back >= 0; back--) {
      if (23 - back < gap) continue;
      const ord = MOCK_LAST_YEAR * 12 + (MOCK_LAST_MONTH - 1) - back;
      const salary = Math.round((base * (1 + ((h[3 + (back % 20)]! % 11) - 5) / 100)) / 1000) * 1000;
      rows.push({ employer, year: Math.floor(ord / 12), month: (ord % 12) + 1, salary, contributionPaid: Math.round(salary * 0.2) });
    }
    return rows;
  }
}
