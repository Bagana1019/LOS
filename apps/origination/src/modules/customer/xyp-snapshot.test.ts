import { SEED, encryptedField } from '@los/database';
import { describe, expect, it } from 'vitest';
import { XYP_SNAPSHOT_TTL_MS, openXypSnapshot, sealXypSnapshot, xypSnapshotAad } from './xyp-snapshot';

// ХУР-аас иргэний кодоор (нэг удаагийн) татсан мэдээллийг `POST /customers` хүртэл хадгалах тэмдэг. Код дахин ашиглагдахгүй тул үүсгэх үед ХУР-ыг дахин
// дуудахгүй: сервер өөрийн битүүмжилсэн (AES-GCM) тэмдгийг нээж ХУР-ын талбаруудыг нөхнө. Тэмдэг нь хэн, аль байгууллага, аль регистрт зориулагдсанаа AAD-аар баталгаажуулна.
const scope = { orgId: SEED.org.id, userId: SEED.users.officerA.id };
const REG = 'УБ90010112';
const NOW = 1_800_000_000_000;
const citizen = {
  registerNo: REG, customerType: 'INDIVIDUAL' as const, lastName: 'Цэрэн', firstName: 'Сарнай', clanName: 'Хиад', civilId: '1234567890', gender: 'FEMALE' as const, birthDate: '1990-01-01',
  maritalStatus: 'MARRIED' as const, familySize: 3, activitySector: null, address: { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'Хан-Уул хотхон 12-45' },
  fetchedAt: '2026-11-19T10:00:00.000Z',
};
const invalid = (fn: () => unknown) => { try { fn(); } catch (e) { return e as { code: string; getStatus(): number; message: string }; } throw new Error('expected a throw'); };

describe('XYP snapshot token', () => {
  it('нээхэд ХУР-аас татсан иргэнийг яг өөрчлөлтгүй буцаана', () => {
    expect(openXypSnapshot(scope, REG, sealXypSnapshot(scope, REG, citizen, NOW), NOW + 1000)).toEqual(citizen);
  });

  it('тэмдэг нь тунгалаг: нэр, регистр, хаяг ил биш, нэг иргэнд дахин битүүмжлэхэд өөр утга (санамсаргүй IV)', () => {
    const a = sealXypSnapshot(scope, REG, citizen, NOW);
    const b = sealXypSnapshot(scope, REG, citizen, NOW);
    expect(a).not.toBe(b);
    const decodedParts = a.split('.').map((p) => { try { return Buffer.from(p, 'base64url').toString('utf8'); } catch { return ''; } }).join('|');
    for (const secret of ['Сарнай', 'Цэрэн', REG, '1234567890', 'Хан-Уул']) {
      expect(a).not.toContain(secret);
      expect(decodedParts).not.toContain(secret);
    }
  });

  it('хугацаа: XYP_SNAPSHOT_TTL_MS (30 мин) дотор хүчинтэй, дараа нь XYP_SNAPSHOT_INVALID', () => {
    expect(XYP_SNAPSHOT_TTL_MS).toBe(30 * 60_000);
    const token = sealXypSnapshot(scope, REG, citizen, NOW);
    expect(openXypSnapshot(scope, REG, token, NOW + XYP_SNAPSHOT_TTL_MS)).toEqual(citizen);
    const e = invalid(() => openXypSnapshot(scope, REG, token, NOW + XYP_SNAPSHOT_TTL_MS + 1));
    expect([e.code, e.getStatus()]).toEqual(['XYP_SNAPSHOT_INVALID', 400]);
  });

  it.each([
    ['өөр ажилтан', { ...scope, userId: SEED.users.officerB.id }, REG],
    ['өөр байгууллага', { ...scope, orgId: '00000000-0000-4000-8000-0000000000ff' }, REG],
    ['өөр регистр', scope, 'УБ90010113'],
  ])('%s нээж чадахгүй (AAD) → XYP_SNAPSHOT_INVALID', (_label, otherScope, register) => {
    const token = sealXypSnapshot(scope, REG, citizen, NOW);
    expect(invalid(() => openXypSnapshot(otherScope, register, token, NOW)).code).toBe('XYP_SNAPSHOT_INVALID');
  });

  it('засварласан / тасарсан / хоосон / буруу хувилбарын / үгүй тэмдэг → XYP_SNAPSHOT_INVALID, мессеж дотоод мэдээлэл дурдахгүй', () => {
    const token = sealXypSnapshot(scope, REG, citizen, NOW);
    const parts = token.split('.');
    const flipped = [...parts.slice(0, 4), parts[4]!.slice(0, -2) + (parts[4]!.endsWith('A') ? 'B' : 'A') + parts[4]!.slice(-1)].join('.');
    for (const bad of [flipped, token.slice(0, -8), '', 'garbage', 'v9.t1.x.y.z', undefined]) {
      const e = invalid(() => openXypSnapshot(scope, REG, bad, NOW));
      expect(e.code, String(bad)).toBe('XYP_SNAPSHOT_INVALID');
      expect(e.message).not.toMatch(/aes|gcm|decrypt|key/i);
    }
  });

  it('зөв AAD-аар битүүмжилсэн ч агуулга иргэний бүтэцтэй биш бол татгалзана (хуурамч бэлтгэсэн тэмдэг ХУР-ын мэдээлэл болохгүй)', () => {
    const forged = encryptedField(JSON.stringify({ exp: NOW + 1000, citizen: { firstName: 'Хуурамч' } }), xypSnapshotAad(scope, REG));
    expect(invalid(() => openXypSnapshot(scope, REG, forged, NOW)).code).toBe('XYP_SNAPSHOT_INVALID');
    const noExp = encryptedField(JSON.stringify({ citizen }), xypSnapshotAad(scope, REG));
    expect(invalid(() => openXypSnapshot(scope, REG, noExp, NOW)).code).toBe('XYP_SNAPSHOT_INVALID');
  });
});
