import { describe, expect, it } from 'vitest';
import { describeAsset } from './asset-description';

describe('describeAsset', () => {
  it('автомашин: дугаар, марк, загвар, он', () => {
    expect(describeAsset('VEHICLE', { plate: '1234УБА', make: 'Toyota', model: 'Prius', year: 2018 })).toBe('1234УБА Toyota Prius 2018');
    expect(describeAsset('VEHICLE', { plate: '1234УБА' })).toBe('1234УБА');
  });

  it('үл хөдлөх: хаяг, талбай, давхар, гэрчилгээ', () => {
    expect(describeAsset('APARTMENT', { address: 'БЗД, 3-р хороо', area_m2: 54, floor: 5, certificate_no: 'Ү-123' })).toBe('БЗД, 3-р хороо 54 м² 5-р давхар Гэрчилгээ Ү-123');
    expect(describeAsset('LAND', { address: 'Налайх' })).toBe('Налайх');
    expect(describeAsset('HOUSE', { area_m2: 80 })).toBe('80 м²');
  });

  it('мал: төрөл, толгой', () => {
    expect(describeAsset('LIVESTOCK', { livestock_type: 'Үхэр', head_count: 20 })).toBe('Үхэр 20 толгой');
    expect(describeAsset('LIVESTOCK', { type: 'Хонь' })).toBe('Хонь');
  });

  it('бусад төрөл: description / name', () => {
    expect(describeAsset('EQUIPMENT', { description: 'Трактор' })).toBe('Трактор');
    expect(describeAsset('OTHER', { name: 'Тавилга' })).toBe('Тавилга');
  });

  it('хоосон / буруу хэлбэр → null; 200 тэмдэгтэд таслана', () => {
    for (const v of [null, undefined, 'text', 5, [], [1], {}]) expect(describeAsset('VEHICLE', v), JSON.stringify(v)).toBeNull();
    expect(describeAsset('OTHER', { description: 'x'.repeat(500) })).toHaveLength(200);
    expect(describeAsset('VEHICLE', { plate: '  ' })).toBeNull();
  });
});
