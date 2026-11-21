import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actors, hasTestDb } from '../../test-utils/factories';
import { bootReport, col, getReport, resetAndSeed, type ReportEnv } from './report.test-helpers';
import type { World } from './report.fixtures';

// F11-3 (бодит DB): хайлт нь үг тус бүрээр (AND) овог/нэр/гэрээ/хүсэлтийн дугаарт таарна — хүснэгтэд харагдсан бүтэн нэр олдоно.
// Хүснэгт HTML-д хоосон зайг нэгтгэдэг тул "Батсайхан Оюунчимэг" гэж харагдах нэр DB-д "Батсайхан " + "Оюунчимэг" (төгсгөлд зайтай) байж болно.
describe.skipIf(!hasTestDb)('report: хайлт үг тус бүрээр (HTTP, DB) — F11-3', () => {
  let env: ReportEnv;
  let w: World;
  const admin = actors.admin();

  beforeAll(async () => { env = await bootReport(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => {
    w = await resetAndSeed(env);
    await env.t.prisma.customer.update({ where: { id: w.LB.customer.id }, data: { lastName: 'Батсайхан ', firstName: 'Оюунчимэг' } });
    await env.t.prisma.customer.update({ where: { id: w.LE.customer.id }, data: { lastName: 'Эрдэнэ', firstName: 'Ганаа Цолмон' } });
  });

  const contracts = async (search: string, key = 'outstanding-balance'): Promise<unknown[]> => col(await getReport(env, admin, key, { search }), 'contractNo').sort();

  it('хүснэгтэд харагдсан бүтэн нэр (овог нэр) → тэр зээлдэгч олдоно', async () => {
    expect(await contracts('Батсайхан Оюунчимэг')).toEqual(['B10026LB']);
  });

  it('үгийн дараалал хамаарахгүй: "Нэр Овог"', async () => {
    expect(await contracts('Оюунчимэг Батсайхан')).toEqual(['B10026LB']);
  });

  it('үгийн хооронд олон зай / tab / мөр шилжилт', async () => {
    expect(await contracts('Батсайхан \t  Оюунчимэг')).toEqual(['B10026LB']);
    expect(await contracts(' Батсайхан\nОюунчимэг ')).toEqual(['B10026LB']);
  });

  it('үг бүр хэсэгчилсэн (substring) таарна: "Батсай Оюун"', async () => {
    expect(await contracts('Батсай Оюун')).toEqual(['B10026LB']);
  });

  it('гурван үгтэй нэр (нэр нь хоёр үгтэй) ямар ч дарааллаар', async () => {
    expect(await contracts('Цолмон Эрдэнэ Ганаа')).toEqual(['B10026LE']);
    expect(await contracts('Эрдэнэ Ганаа Цолмон')).toEqual(['B10026LE']);
  });

  it('AND, OR биш: өөр өөр хүний үгс хамт таарахгүй', async () => {
    expect(await contracts('Болд')).toEqual(['B10026LA']);
    expect(await contracts('Оюунчимэг')).toEqual(['B10026LB']);
    expect(await contracts('Болд Оюунчимэг')).toEqual([]);
  });

  it('нэрийн үг + гэрээний дугаар хамт (AND)', async () => {
    expect(await contracts('Болд B10026LA')).toEqual(['B10026LA']);
    expect(await contracts('Болд B10026LB')).toEqual([]);
  });

  it('аль хэдийн ажиллаж байсан хайлт хэвээр: нэг үг, гэрээний дугаар, регистр (том/жижиг, зайтай, тусгаарлагчтай)', async () => {
    expect(await contracts('B10026L')).toHaveLength(6);
    expect(await contracts('APP-LC')).toEqual(['B10026LC']);
    expect(await contracts(' уб90000003 ')).toEqual(['B10026LC']);
    expect(await contracts('УБ 90000003')).toEqual(['B10026LC']); // blind index зай/тусгаарлагчийг хасдаг тул бүтнээр нь таарна
    expect(await contracts('УБ9000000')).toEqual([]);
  });

  it('тусгай тэмдэгт үг бүрт escape хийгдэнэ, алдаагүй 0 мөр', async () => {
    for (const s of ['%', '_', 'Бат %', 'Бат _', "Бат O'Brien", '\\ Бат', '😀 Бат', "x'; DROP TABLE origination.loan_application; --"]) {
      expect(await contracts(s), s).toEqual([]);
    }
    expect(await env.t.prisma.loanApplication.count()).toBeGreaterThan(10);
  });

  it('зөвхөн хоосон зай = шүүлтгүй', async () => {
    expect(await contracts('   \t ')).toHaveLength(6);
  });

  it.each(['overdue-loans', 'upcoming-repayments', 'pipeline-progress'])('%s: бүтэн нэрээр хайх нь гэрээний дугаараар хайсантай ижил мөр', async (key) => {
    await env.t.prisma.customer.update({ where: { id: w.LA.customer.id }, data: { lastName: 'Бат ' } }); // "Бат Болд" гэж харагдана
    const byContract = await contracts('B10026LA', key);
    expect(byContract.length, `${key} fixture-д B10026LA байх ёстой`).toBeGreaterThan(0);
    expect(await contracts('Бат Болд', key)).toEqual(byContract);
  });
});
