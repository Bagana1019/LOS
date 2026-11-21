import { AUDIT_ACTOR_LIMIT } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { containsInsensitive, matchActors, type ActorRow } from './audit-filter';

// F9-24 · DB-гүй unit: Postgres-гүй CI-д ч шүүлтийн дүрэм шалгагдана (DB-тэй хувилбар: test/audit-filters.e2e.test.ts).
describe('containsInsensitive', () => {
  it('том/жижиг үсэг үл ялгах contains болгоно', () => {
    expect(containsInsensitive('setting')).toEqual({ contains: 'setting', mode: 'insensitive' });
  });
  it('LIKE-ийн "%", "_" ба "\\"-г шууд тэмдэгт болгон escape хийнэ', () => {
    expect(containsInsensitive('a_b%c\\d').contains).toBe('a\\_b\\%c\\\\d');
  });
});

const u = (id: string, username: string, fullName: string): ActorRow => ({ id, username, fullName });
const USERS = [u('1', 'admin', 'Админ'), u('2', 'officer.a', 'ЗЭЗ А'), u('3', 'officer.b', 'ЗЭЗ Б'), u('4', 'approver', 'Батлагч')];

describe('matchActors', () => {
  it('нэвтрэх нэрээр, том/жижиг үсэг үл ялгана', () => {
    expect(matchActors(USERS, 'ADMIN').map((a) => a.id)).toEqual(['1']);
  });
  it('овог нэрээр, кирилл том/жижиг үсэг үл ялгана', () => {
    expect(matchActors(USERS, 'батл').map((a) => a.id)).toEqual(['4']);
    expect(matchActors(USERS, 'ЗЭЗ').map((a) => a.id)).toEqual(['2', '3']);
  });
  it('хайлтын эхэн/төгсгөлийн зайг үл тооно', () => {
    expect(matchActors(USERS, '  админ  ').map((a) => a.id)).toEqual(['1']);
  });
  it('хоосон, зөвхөн зай, undefined хайлт → бүгд (эрэмбэтэй)', () => {
    for (const q of [undefined, '', '   ']) expect(matchActors(USERS, q)).toHaveLength(USERS.length);
  });
  it('таарахгүй бол хоосон жагсаалт', () => {
    expect(matchActors(USERS, 'zzz')).toEqual([]);
  });
  it('хязгаараас хэтрэхгүй (анхдагч AUDIT_ACTOR_LIMIT)', () => {
    const many = Array.from({ length: AUDIT_ACTOR_LIMIT + 5 }, (_, i) => u(String(i), `user${i}`, `Нэр ${i}`));
    expect(matchActors(many, undefined)).toHaveLength(AUDIT_ACTOR_LIMIT);
    expect(matchActors(many, undefined, 3)).toHaveLength(3);
  });
  it('зөвхөн id, username, fullName буцаана; оролтыг өөрчлөхгүй', () => {
    const withSecret = [{ ...USERS[0]!, passwordHash: 'x', email: 'a@b.c' }];
    const before = JSON.stringify(withSecret);
    const out = matchActors(withSecret, 'admin');
    expect(Object.keys(out[0]!).sort()).toEqual(['fullName', 'id', 'username']);
    expect(JSON.stringify(withSecret)).toBe(before);
  });
});
