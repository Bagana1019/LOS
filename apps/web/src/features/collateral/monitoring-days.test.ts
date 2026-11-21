import { describe, expect, it } from 'vitest';
import { CollateralMonitoringQuery } from '@los/contracts';
import { MONITORING_DAYS_MAX, withinDaysProblem } from './monitoring-days';

// Барьцааны мониторингийн "Хэдэн хоногийн дотор" талбар: antd InputNumber нь "5сая"→5, "-5"→0, хоосон→30 гэж чимээгүй засдаг байсан (F2-8).
// Одоо текст хэвээр, буруу бол мессеж; жагсаалт зөвхөн зөв утгаар шинэчлэгдэнэ.
describe('withinDaysProblem', () => {
  it('хил: 0 ба 3650 зөв; ердийн 30 зөв', () => {
    for (const ok of [0, 1, 30, 3650]) expect(withinDaysProblem(ok), String(ok)).toBeNull();
  });

  it('"5сая" / "есөн" гэх мэт ойлгогдохгүй текст (NaN) → тоо биш (5 болгохгүй)', () => {
    expect(withinDaysProblem(Number.NaN)).toBe('Зөвхөн тоо оруулна уу (жишээ: 12)');
  });

  it('сөрөг, хэт том → хүрээний алдаа (0 / 3650 болгож clamp хийхгүй)', () => {
    for (const bad of [-5, -1, 3651, 99_999]) expect(withinDaysProblem(bad), String(bad)).toBe('Хэдэн хоногийн дотор 0–3650 хооронд байх ёстой');
  });

  it('бутархай → бүхэл биш (дугуйлахгүй)', () => {
    expect(withinDaysProblem(2.5)).toBe('Хэдэн хоногийн дотор бүхэл тоо байх ёстой');
  });

  it('хоосон → заавал (30 болгож чимээгүй солихгүй)', () => {
    expect(withinDaysProblem(undefined)).toBe('Хэдэн хоногийн дотор оруулна уу');
  });

  it('дээд хязгаар нь API-ийн (`CollateralMonitoringQuery.withinDays`) хязгаартай таарна', () => {
    expect(CollateralMonitoringQuery.safeParse({ withinDays: MONITORING_DAYS_MAX }).success).toBe(true);
    expect(CollateralMonitoringQuery.safeParse({ withinDays: MONITORING_DAYS_MAX + 1 }).success).toBe(false);
  });
});
