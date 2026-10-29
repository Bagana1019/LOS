// [20]: субъектийн нэрийн хувилбарыг screening бүрт НЭГ удаа нормчилно (өмнө нь UN-ийн нэр тутамд бүгдийг дахин нормчилдог байсан),
// UN snapshot-ийн нэрийг ч snapshot хугацаанд нэг удаа. Нормчлолын дуудлагыг тоолно.
import { describe, expect, it, vi } from 'vitest';
import { AmlSubject, DEFAULT_AML_POLICY } from '@los/contracts';
import { UN_SC_FIXTURE } from '../../../integrations/un-sc/un-sc.fixture';
import { prepareName } from '../matching';
import { runScreening } from './screening-engine';

vi.mock('../matching', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../matching')>();
  return { ...actual, prepareName: vi.fn(actual.prepareName) };
});

const subject = AmlSubject.parse({
  subjectType: 'INDIVIDUAL', registerNo: 'УБ12345678', lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', aliases: ['Bat Erdene Ganbold', 'Б. Ганболд'],
});
const run = (un: typeof UN_SC_FIXTURE) => runScreening({ subject, policy: DEFAULT_AML_POLICY, lists: ['UN_SC'], un });
// Хувь хүн зөвхөн INDIVIDUAL бүртгэлтэй харьцуулагдана (ENTITY-ийн нэр бэлтгэгдэхгүй)
const names = (un: typeof UN_SC_FIXTURE, type: 'INDIVIDUAL' | 'ENTITY' = 'INDIVIDUAL') =>
  un.entries.filter((e) => e.type === type).reduce((n, e) => n + e.names.length, 0);

describe('screening prepares names once', () => {
  it('normalises each subject variant once per screening and each list name once per snapshot', () => {
    const snapshot = structuredClone(UN_SC_FIXTURE);
    const prepare = vi.mocked(prepareName);
    prepare.mockClear();
    run(snapshot);
    // 3 хувилбар (овог нэр, 2 alias) + жагсаалтын нэр бүр. Өмнө нь: хувилбар × нэр = 3 × names дахин нормчлол.
    expect(prepare).toHaveBeenCalledTimes(3 + names(snapshot));
    expect(names(snapshot)).toBeGreaterThan(10);

    prepare.mockClear();
    run(snapshot);
    expect(prepare).toHaveBeenCalledTimes(3); // жагсаалтын нэр кэшээс
  });

  it('prepares a list name again when its value changes in place', () => {
    const snapshot = structuredClone(UN_SC_FIXTURE);
    run(snapshot);
    const prepare = vi.mocked(prepareName);
    prepare.mockClear();
    snapshot.entries[0].names[0].value = 'Changed In Place';
    run(snapshot);
    expect(prepare).toHaveBeenCalledTimes(3 + 1);
  });

  it('prepares ENTITY and INDIVIDUAL names separately (the legal form is only stripped for entities)', () => {
    const entity = AmlSubject.parse({ subjectType: 'LEGAL_ENTITY', registerNo: '1234567', firstName: 'Altanvex Trading ХХК' });
    const snapshot = structuredClone(UN_SC_FIXTURE);
    const prepare = vi.mocked(prepareName);
    prepare.mockClear();
    const hits = runScreening({ subject: entity, policy: DEFAULT_AML_POLICY, lists: ['UN_SC'], un: snapshot });
    expect(hits.map((h) => h.entryRef)).toEqual(['FIXTURE-UN-004']);
    // нэг хувилбар + ENTITY бүртгэлийн нэрс (INDIVIDUAL-тай харьцуулахгүй тул бэлтгэгдэхгүй)
    expect(prepare).toHaveBeenCalledTimes(1 + names(snapshot, 'ENTITY'));
  });
});
