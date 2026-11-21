import { describe, expect, it } from 'vitest';
import { ApprovalLevelInput } from '@los/contracts';
import { firstLevelProblem, levelProblems, levelsFromRows, patchLevel, SLA_MAX_HOURS, type LevelRow } from './approval-levels-form';

// Батлах түвшний форм: дээд дүн (₮) ба SLA (цаг). antd InputNumber нь "5сая"→5, "-5"→1 гэж чимээгүй засдаг байсан; одоо текст хэвээр, буруу бол мессеж (F2-8, F9-2).
// Мөрийн төлөв: amountTo `null` = хоосон, `NaN` = тоо биш текст; slaHours `undefined` = хоосон, `NaN` = тоо биш текст.
const row = (over: Partial<LevelRow> = {}): LevelRow => ({ levelNo: 1, name: 'Салбар', amountFrom: 0, amountTo: 5_000_000, quorumType: 'MAJORITY', slaHours: 24, members: [{ userId: 'u1' }], ...over });

describe('levelProblems: дээд дүн', () => {
  it('зөв мөрөнд алдаа байхгүй', () => {
    expect(levelProblems(row(), false)).toEqual({});
  });

  it('"5сая" гэх мэт ойлгогдохгүй текст (NaN) → тоо биш; сөрөг → сөрөг дүн; 0 → 0-ээс их', () => {
    expect(levelProblems(row({ amountTo: Number.NaN }), false).amountTo).toBe('Зөвхөн тоо оруулна уу (жишээ: 1,500,000 эсвэл 5сая)');
    expect(levelProblems(row({ amountTo: -5 }), false).amountTo).toBe('Сөрөг дүн оруулах боломжгүй');
    expect(levelProblems(row({ amountTo: 0 }), false).amountTo).toBe('Дээд дүн 0-ээс их байх ёстой');
  });

  it('хоосон (null) нь чимээгүй 0/хязгааргүй биш: заавал бөглөнө', () => {
    expect(levelProblems(row({ amountTo: null }), false).amountTo).toBe('Дээд дүн оруулна уу');
  });

  it('1 их наяд (MAX_MONEY)-аас их → хэмжээний алдаа; 3 оронтой бутархай → бутархайн алдаа', () => {
    expect(levelProblems(row({ amountTo: 1_000_000_000_001 }), false).amountTo).toBe('Дээд дүн 1,000,000,000,000-аас ихгүй байх ёстой');
    expect(levelProblems(row({ amountTo: 1000.005 }), false).amountTo).toBe('Бутархай хэсэг 2 оронгоос ихгүй байх ёстой');
  });

  it('сүүлийн түвшин (хязгааргүй) дээд дүнгийн талбаргүй тул шалгагдахгүй', () => {
    expect(levelProblems(row({ amountTo: null }), true)).toEqual({});
  });
});

describe('levelProblems: SLA', () => {
  it('хүрээний хил: 1 ба 720 зөв; 0, -5, 721 → хүрээний алдаа (clamp хийхгүй)', () => {
    expect(levelProblems(row({ slaHours: 1 }), false)).toEqual({});
    expect(levelProblems(row({ slaHours: 720 }), false)).toEqual({});
    for (const bad of [0, -5, 721, 1000]) expect(levelProblems(row({ slaHours: bad }), false).slaHours, String(bad)).toBe('SLA хугацаа 1–720 хооронд байх ёстой');
  });

  it('"5сая" (NaN) → тоо биш; 2.5 → бүхэл биш; хоосон → заавал (24 болгож чимээгүй солихгүй)', () => {
    expect(levelProblems(row({ slaHours: Number.NaN }), false).slaHours).toBe('Зөвхөн тоо оруулна уу (жишээ: 12)');
    expect(levelProblems(row({ slaHours: 2.5 }), false).slaHours).toBe('SLA хугацаа бүхэл тоо байх ёстой');
    expect(levelProblems(row({ slaHours: undefined }), false).slaHours).toBe('SLA хугацаа оруулна уу');
  });

  it('SLA-ийн дээд хязгаар нь гэрээний (`ApprovalLevelInput.slaHours`) хязгаартай таарна', () => {
    const sla = ApprovalLevelInput.shape.slaHours;
    expect(sla.safeParse(SLA_MAX_HOURS).success).toBe(true);
    expect(sla.safeParse(SLA_MAX_HOURS + 1).success).toBe(false);
  });
});

describe('firstLevelProblem / levelsFromRows', () => {
  const rows = [row({ levelNo: 1 }), row({ levelNo: 2, amountFrom: 5_000_000, amountTo: Number.NaN }), row({ levelNo: 3, amountFrom: 9_000_000, amountTo: null, slaHours: 0 })];

  it('эхний алдаатай түвшний мессеж, түвшний дугаартай; сүүлийн мөрийн дээд дүн орхигдоно', () => {
    expect(firstLevelProblem(rows)).toBe('Түвшин 2: Зөвхөн тоо оруулна уу (жишээ: 1,500,000 эсвэл 5сая)');
    expect(firstLevelProblem([rows[0]!, rows[2]!])).toBe('Түвшин 3: SLA хугацаа 1–720 хооронд байх ёстой');
    expect(firstLevelProblem([row(), row({ levelNo: 2, amountTo: null })])).toBeNull();
  });

  it('зөв мөрүүдээс API-ийн түвшнүүдийг гаргана', () => {
    const ok = [row({ levelNo: 1 }), row({ levelNo: 2, amountFrom: 5_000_000, amountTo: null, slaHours: 48 })];
    expect(levelsFromRows(ok)).toEqual([
      { levelNo: 1, name: 'Салбар', amountFrom: 0, amountTo: 5_000_000, quorumType: 'MAJORITY', slaHours: 24, members: [{ userId: 'u1' }] },
      { levelNo: 2, name: 'Салбар', amountFrom: 5_000_000, amountTo: null, quorumType: 'MAJORITY', slaHours: 48, members: [{ userId: 'u1' }] },
    ]);
  });

  it('алдаатай мөртэй бол шидэнэ (дуудагч эхлээд firstLevelProblem шалгана)', () => {
    expect(() => levelsFromRows([row({ slaHours: undefined })])).toThrow();
    expect(() => levelsFromRows([row({ slaHours: Number.NaN })])).toThrow();
  });
});

describe('patchLevel', () => {
  const rows = [row({ levelNo: 1, amountTo: 5_000_000 }), row({ levelNo: 2, amountFrom: 5_000_000, amountTo: null })];

  it('дээд дүн солигдвол дараагийн түвшний доод дүн дагана (завсар үүсгэхгүй)', () => {
    const next = patchLevel(rows, 0, { amountTo: 8_000_000 });
    expect(next[0]!.amountTo).toBe(8_000_000);
    expect(next[1]!.amountFrom).toBe(8_000_000);
  });

  it('дээд дүн тоо биш / хоосон бол дараагийн доод дүн NaN болохгүй, хуучнаараа үлдэнэ', () => {
    expect(patchLevel(rows, 0, { amountTo: Number.NaN })[1]!.amountFrom).toBe(5_000_000);
    expect(patchLevel(rows, 0, { amountTo: null })[1]!.amountFrom).toBe(5_000_000);
  });

  it('оролтыг өөрчлөхгүй (immutable); бусад талбар (SLA) дагалдах нөлөөгүй', () => {
    const snapshot = JSON.stringify(rows);
    const next = patchLevel(rows, 1, { slaHours: 48 });
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(next[1]!.slaHours).toBe(48);
    expect(next[0]).toEqual(rows[0]);
  });
});
