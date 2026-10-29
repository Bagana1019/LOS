import { describe, expect, it } from 'vitest';
import type { ZodIssue } from 'zod';
import { buildCreateRequest, buildUpdateRequest, cleanDescription, defaultDescription, formValuesOf, mapZodIssues, stableStringify, zodIssueMessage } from './collateral.form';
import { IDS, makeApartment, makeCollateral } from './collateral.fixtures';

const issue = (partial: Partial<ZodIssue> & { code: ZodIssue['code'] }, path: Array<string | number> = ['description', 'x']): ZodIssue => ({ path, message: 'Required', ...partial }) as ZodIssue;

describe('zodIssueMessage', () => {
  it('гэрээнд монголоор бичсэн мессежийг хэвээр үлдээнэ', () => {
    expect(zodIssueMessage(issue({ code: 'custom', message: 'Огноо YYYY-MM-DD хэлбэртэй байх ёстой' }))).toBe('Огноо YYYY-MM-DD хэлбэртэй байх ёстой');
  });
  it('кирилл жишээтэй англи мессежийг монгол гэж үзэхгүй', () => {
    const english = 'Plate number must be 4 digits and 2-3 Cyrillic letters, e.g. УЕН5246 or 1234УБА';
    expect(zodIssueMessage(issue({ code: 'invalid_string', validation: 'regex', message: english }, ['description', 'plateNo']))).toContain('Улсын дугаар');
  });
  it('invalid_type: дутуу бол «Заавал», төрөл зөрвөл «Буруу утга»', () => {
    expect(zodIssueMessage(issue({ code: 'invalid_type', expected: 'string', received: 'undefined' }))).toBe('Заавал бөглөнө');
    expect(zodIssueMessage(issue({ code: 'invalid_type', expected: 'number', received: 'string' }))).toBe('Буруу утга');
  });
  it('too_small / too_big', () => {
    expect(zodIssueMessage(issue({ code: 'too_small', type: 'string', minimum: 1, inclusive: true }))).toBe('Заавал бөглөнө');
    expect(zodIssueMessage(issue({ code: 'too_small', type: 'string', minimum: 3, inclusive: true }))).toBe('Хамгийн багадаа 3 тэмдэгт байна');
    expect(zodIssueMessage(issue({ code: 'too_small', type: 'number', minimum: 0, inclusive: true }))).toBe('0-аас багагүй байх ёстой');
    expect(zodIssueMessage(issue({ code: 'too_small', type: 'number', minimum: 0, inclusive: false }))).toBe('0-ээс их байх ёстой');
    expect(zodIssueMessage(issue({ code: 'too_big', type: 'string', maximum: 60, inclusive: true }))).toBe('Хамгийн ихдээ 60 тэмдэгт байна');
    expect(zodIssueMessage(issue({ code: 'too_big', type: 'number', maximum: 2000000, inclusive: true }))).toBe('2000000-аас ихгүй байх ёстой');
  });
  it('улсын дугаарын regexp, enum', () => {
    expect(zodIssueMessage(issue({ code: 'invalid_string', validation: 'regex' }, ['description', 'plateNo']))).toContain('Улсын дугаар');
    expect(zodIssueMessage(issue({ code: 'invalid_string', validation: 'uuid' }, ['ownerCustomerId']))).toBe('Заавал бөглөнө');
    expect(zodIssueMessage(issue({ code: 'invalid_string', validation: 'regex' }, ['description', 'vin']))).toBe('Буруу утга');
    expect(zodIssueMessage(issue({ code: 'invalid_enum_value', options: ['A'], received: 'B' }))).toBe('Сонгоно уу');
    expect(zodIssueMessage(issue({ code: 'unrecognized_keys', keys: ['q'] }))).toBe('Буруу утга');
  });
  it('mapZodIssues зам дээр угтвар залгана', () => {
    const [first] = mapZodIssues([issue({ code: 'invalid_type', expected: 'string', received: 'undefined' }, ['make'])], ['description']);
    expect(first).toEqual({ name: ['description', 'make'], message: 'Заавал бөглөнө' });
  });
});

describe('cleanDescription / defaultDescription', () => {
  it('зөвхөн тухайн төрлийн талбар, trim, хоосон/NaN-гүй', () => {
    const cleaned = cleanDescription('VEHICLE', { plateNo: ' 1234УБА ', make: 'Toyota', model: '', vin: '   ', manufactureYear: 2012, mileageKm: Number.NaN, unknown: 'x' });
    expect(cleaned).toEqual({ plateNo: '1234УБА', make: 'Toyota', manufactureYear: 2012 });
  });
  it('гүн талбар', () => {
    expect(cleanDescription('HOUSE', { address: { province: ' УБ ', district: 'Баянзүрх', khoroo: '' }, areaM2: 80 })).toEqual({ address: { province: 'УБ', district: 'Баянзүрх' }, areaM2: 80 });
  });
  it('анхдагч утгууд схемтэй нийцнэ', () => {
    expect(defaultDescription('APARTMENT')).toEqual({ purpose: 'RESIDENTIAL' });
    expect(defaultDescription('HOUSE')).toEqual({ purpose: 'RESIDENTIAL' });
    expect(defaultDescription('LAND')).toEqual({ landUse: 'RESIDENTIAL' });
    expect(defaultDescription('LIVESTOCK')).toEqual({ ageGroup: 'ADULT' });
    expect(defaultDescription('VEHICLE')).toEqual({});
  });
});

describe('buildCreateRequest', () => {
  const valid = { assetType: 'VEHICLE' as const, ownerCustomerId: IDS.owner, description: { plateNo: '1234УБА', make: 'Toyota', model: 'Prius', manufactureYear: 2012, mileageKm: 150000 } };

  it('автомашин: хүчинтэй хүсэлт гарна, хоосон нэмэлт талбаргүй', () => {
    const r = buildCreateRequest({ ...valid, registryNo: '  ', note: null }, { source: 'MANUAL' });
    expect(r).toEqual({ ok: true, body: expect.objectContaining({ assetType: 'VEHICLE', ownerCustomerId: IDS.owner, source: 'MANUAL' }) });
    if (r.ok) {
      const sent = JSON.parse(JSON.stringify(r.body)) as Record<string, unknown>; // сүлжээгээр явах хэлбэр
      expect(sent).not.toHaveProperty('registryNo');
      expect(sent).not.toHaveProperty('note');
      expect(r.body.description).toMatchObject({ plateNo: '1234УБА', make: 'Toyota' });
    }
  });

  it('ХУР-аас: xypRef дамжина; гараар үед дамжихгүй', () => {
    const xyp = buildCreateRequest(valid, { source: 'XYP', xypRef: 'xyp-1' });
    expect(xyp.ok && xyp.body.source === 'XYP' && (xyp.body as { xypRef?: string }).xypRef).toBe('xyp-1');
    const manual = buildCreateRequest(valid, { source: 'MANUAL', xypRef: 'xyp-1' });
    expect(manual.ok && 'xypRef' in manual.body).toBe(false);
  });

  it('төрөл, өмчлөгч сонгоогүй бол талбарт алдаа', () => {
    const r = buildCreateRequest({ description: {} }, { source: 'MANUAL' });
    expect(r).toEqual({ ok: false, errors: [{ name: ['assetType'], message: 'Сонгоно уу' }, { name: ['ownerCustomerId'], message: 'Өмчлөгчийг сонгоно уу' }] });
  });

  it('өмчлөгч дутуу: зөвхөн нэг алдаа (давхардахгүй)', () => {
    const r = buildCreateRequest({ ...valid, ownerCustomerId: undefined }, { source: 'MANUAL' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.filter((e) => e.name[0] === 'ownerCustomerId')).toHaveLength(1);
  });

  it('буруу улсын дугаар → description.plateNo дээр монгол алдаа', () => {
    const r = buildCreateRequest({ ...valid, description: { ...valid.description, plateNo: 'abc' } }, { source: 'MANUAL' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ name: ['description', 'plateNo'], message: expect.stringContaining('Улсын дугаар') });
  });

  it('дутуу заавал талбар → «Заавал бөглөнө»', () => {
    const r = buildCreateRequest({ ...valid, description: { plateNo: '1234УБА' } }, { source: 'MANUAL' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const names = r.errors.map((e) => e.name.join('.'));
      expect(names).toEqual(expect.arrayContaining(['description.make', 'description.model', 'description.manufactureYear']));
      expect(r.errors.every((e) => /[Ѐ-ӿ]/.test(e.message))).toBe(true);
    }
  });

  it('үл хөдлөх: дугаар аль нэг нь заавал (гэрээний монгол мессеж)', () => {
    const r = buildCreateRequest(
      { assetType: 'APARTMENT', ownerCustomerId: IDS.owner, description: { address: { province: 'Улаанбаатар', district: 'Хан-Уул' }, areaM2: 50 } },
      { source: 'MANUAL' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.includes('Үл хөдлөх хөрөнгийн дугаар'))).toBe(true);
    const ok = buildCreateRequest(
      { assetType: 'APARTMENT', ownerCustomerId: IDS.owner, description: { propertyId: 'Ү-1', address: { province: 'Улаанбаатар', district: 'Хан-Уул' }, areaM2: 50, purpose: 'RESIDENTIAL' } },
      { source: 'MANUAL' },
    );
    expect(ok.ok).toBe(true);
  });

  it('ЭБ-ийн огноо буруу формат → монгол алдаа', () => {
    const r = buildCreateRequest({ ...valid, registryNo: 'EB-1', registryDate: '29/10/2026' }, { source: 'MANUAL' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.name[0] === 'registryDate')).toBe(true);
  });
});

describe('formValuesOf / buildUpdateRequest', () => {
  const vehicle = makeCollateral({ registryNo: 'EB-1', note: 'тэмдэглэл' });

  it('формын утга барьцаанаас', () => {
    expect(formValuesOf(vehicle)).toMatchObject({ assetType: 'VEHICLE', ownerCustomerId: IDS.owner, registryNo: 'EB-1', note: 'тэмдэглэл' });
  });

  it('өөрчлөлтгүй бол body = null', () => {
    expect(buildUpdateRequest(vehicle, formValuesOf(vehicle))).toEqual({ ok: true, body: null });
  });

  it('зөвхөн өөрчлөгдсөн талбарыг илгээнэ', () => {
    const values = { ...formValuesOf(vehicle), note: 'шинэ' };
    expect(buildUpdateRequest(vehicle, values)).toEqual({ ok: true, body: { note: 'шинэ' } });
  });

  it('өмчлөгч солих', () => {
    const r = buildUpdateRequest(vehicle, { ...formValuesOf(vehicle), ownerCustomerId: IDS.pledgor });
    expect(r).toEqual({ ok: true, body: { ownerCustomerId: IDS.pledgor } });
  });

  it('тодорхойлолт өөрчлөгдвөл бүтнээрээ илгээнэ', () => {
    const values = formValuesOf(vehicle);
    const r = buildUpdateRequest(vehicle, { ...values, description: { ...values.description, mileageKm: 160000 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body?.description).toMatchObject({ plateNo: '1234УБА', make: 'Toyota', mileageKm: 160000 });
  });

  it('ЭБ-ийн дугаарыг цэвэрлэвэл null илгээнэ', () => {
    const r = buildUpdateRequest(vehicle, { ...formValuesOf(vehicle), registryNo: '' });
    expect(r).toEqual({ ok: true, body: { registryNo: null } });
  });

  it('буруу утга → description дотор алдаа', () => {
    const values = formValuesOf(vehicle);
    const r = buildUpdateRequest(vehicle, { ...values, description: { ...values.description, plateNo: 'x' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.name).toEqual(['description', 'plateNo']);
  });

  it('үл хөдлөх: гүн талбар өөрчлөлт', () => {
    const apt = makeApartment();
    const values = formValuesOf(apt);
    expect(buildUpdateRequest(apt, values)).toEqual({ ok: true, body: null });
    const r = buildUpdateRequest(apt, { ...values, description: { ...values.description, address: { ...(values.description?.address as object), detail: 'Шинэ хаяг' } } });
    expect(r.ok && r.body && 'description' in r.body).toBe(true);
  });
});

describe('stableStringify', () => {
  it('түлхүүрийн дарааллаас үл хамаарна, undefined-ыг алгасна', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: undefined } })).toBe(stableStringify({ a: { d: 1 }, b: 1 }));
    expect(stableStringify([1, { z: 1, y: 2 }])).toBe('[1,{"y":2,"z":1}]');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
  });
});
