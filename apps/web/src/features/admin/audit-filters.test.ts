import { describe, expect, it } from 'vitest';
import { actorDisplayName, actorSelectOptions, distinctAuditValues, matchesText, toTextOptions } from './audit-filters';

// F9-24 · Аудитын шүүлтийн цэвэр дүрэм: сонголт нь API-ийн бодит утгаас, хайлт том/жижиг үсэг үл ялгах + хэсэгчилсэн.
const row = (entity: string, action: string) => ({ entity, action });

describe('distinctAuditValues', () => {
  it('давхардлыг арилгаж, цагаан толгойн дарааллаар буцаана', () => {
    const out = distinctAuditValues([row('SETTING', 'SETTING_UPDATED'), row('BRANCH', 'BRANCH_CREATED'), row('SETTING', 'SETTING_UPDATED'), row('BRANCH', 'BRANCH_UPDATED')]);
    expect(out.entities).toEqual(['BRANCH', 'SETTING']);
    expect(out.actions).toEqual(['BRANCH_CREATED', 'BRANCH_UPDATED', 'SETTING_UPDATED']);
  });
  it('хоосон жагсаалт → хоёулаа хоосон', () => {
    expect(distinctAuditValues([])).toEqual({ entities: [], actions: [] });
  });
  it('утгыг яг хэвээр нь хадгална (том/жижиг үсгийг нэгтгэхгүй: сервер яг таарахыг шаардаж болно)', () => {
    expect(distinctAuditValues([row('blacklist', 'CREATE'), row('BLACKLIST', 'CREATE')]).entities).toEqual(['blacklist', 'BLACKLIST']);
  });
});

describe('matchesText', () => {
  it('том/жижиг үсэг үл ялгана: "sett" → SETTING_UPDATED', () => {
    expect(matchesText('sett', 'SETTING_UPDATED')).toBe(true);
    expect(matchesText('UPDATED', 'setting_updated')).toBe(true);
  });
  it('хэсэгчилсэн: дунд нь байсан ч таарна', () => {
    expect(matchesText('ING_UP', 'SETTING_UPDATED')).toBe(true);
  });
  it('эхэн/төгсгөлийн зайг үл тооно; хоосон бол бүгдэд таарна', () => {
    expect(matchesText('  sett  ', 'SETTING')).toBe(true);
    expect(matchesText('', 'SETTING')).toBe(true);
    expect(matchesText('   ', 'SETTING')).toBe(true);
  });
  it('таарахгүй бол false; кирилл ч адил', () => {
    expect(matchesText('zzz', 'SETTING')).toBe(false);
    expect(matchesText('БАТ', 'Батлагч')).toBe(true);
  });
});

describe('toTextOptions', () => {
  it('утга бүрийг { value } болгоно', () => {
    expect(toTextOptions(['A', 'B'])).toEqual([{ value: 'A' }, { value: 'B' }]);
    expect(toTextOptions([])).toEqual([]);
  });
});

const UUID = '00000000-0000-4000-8000-000000000205';
const ADMIN = { id: UUID, username: 'admin', fullName: 'Админ' };

describe('actorSelectOptions', () => {
  it('"Овог нэр (нэвтрэх нэр)" шошготой, утга нь id', () => {
    expect(actorSelectOptions([ADMIN], 'адм')).toEqual([{ value: UUID, label: 'Админ (admin)' }]);
  });
  it('таарсан хэрэглэгч байхгүй, энгийн бичвэр → хоосон', () => {
    expect(actorSelectOptions([], 'zzz')).toEqual([]);
  });
  it('буулгасан UUID олдоогүй бол өөрөө сонголт болно (id-аар шүүх хуучин боломж хадгалагдана)', () => {
    const other = '11111111-1111-4111-8111-111111111111';
    expect(actorSelectOptions([], ` ${other} `)).toEqual([{ value: other, label: other }]);
  });
  it('UUID аль хэдийн үр дүнд байвал давхардуулахгүй', () => {
    expect(actorSelectOptions([ADMIN], UUID)).toHaveLength(1);
  });
});

describe('actorDisplayName', () => {
  it('лавлахад байвал нэрийг, байхгүй бол id-г, null бол null буцаана', () => {
    expect(actorDisplayName({ [UUID]: 'Админ' }, UUID)).toBe('Админ');
    expect(actorDisplayName({}, UUID)).toBe(UUID);
    expect(actorDisplayName(undefined, UUID)).toBe(UUID);
    expect(actorDisplayName({ [UUID]: 'Админ' }, null)).toBeNull();
  });
});
