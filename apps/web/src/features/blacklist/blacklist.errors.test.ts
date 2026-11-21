import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import { describeBlacklistError, isStaleBlacklistError } from './blacklist.errors';

// F8-4: серверийн (англи) алдааг хар жагсаалтын маягтад монгол, талбар заасан мессеж болгоно.
const validation = (issues: unknown[]) => new ApiError(400, null, 'Validation failed', issues as never);
const only = (e: unknown, ctx?: { listType?: string }) => describeBlacklistError(e, ctx);
const REJECTED = 'Хүсэлтийг хүлээн авсангүй. Оруулсан мэдээллээ шалгаад дахин оролдоно уу.';

describe('describeBlacklistError: zod validation issues', () => {
  it('maps a missing field to the field with the Mongolian required text', () => {
    const d = only(validation([{ code: 'invalid_type', path: ['registerNo'], message: 'Required' }]));
    expect(d.fields).toEqual([{ name: 'registerNo', message: 'Заавал бөглөнө' }]);
    expect(d.message).toBe('Оруулсан мэдээлэлд алдаа байна. Улаанаар тэмдэглэсэн талбарыг засна уу.');
  });

  it('reads the gateway shape where path is a string and there is no zod code', () => {
    const d = only(new ApiError(400, 'VALIDATION_FAILED', 'Validation failed', [{ path: 'reasonCode', message: "Invalid enum value. Expected 'OTHER' | 'WATCH'" }]));
    expect(d.fields).toEqual([{ name: 'reasonCode', message: 'Жагсаалтаас зөвшөөрөгдсөн утгыг сонгоно уу' }]);
  });

  it('maps an unknown reason code (enum issue by zod code) to the field', () => {
    const d = only(validation([{ code: 'invalid_enum_value', path: ['reasonCode'], message: "Invalid enum value. Expected 'A' | 'B'" }]));
    expect(d.fields).toEqual([{ name: 'reasonCode', message: 'Жагсаалтаас зөвшөөрөгдсөн утгыг сонгоно уу' }]);
  });

  it('names the limit for an over-long value', () => {
    const d = only(validation([{ code: 'too_big', path: ['name'], message: 'String must contain at most 200 character(s)' }]));
    expect(d.fields).toEqual([{ name: 'name', message: 'Хамгийн ихдээ 200 тэмдэгт байж болно' }]);
  });

  it('handles an over-long value without a parsable limit and a too-short value', () => {
    expect(only(validation([{ code: 'too_big', path: ['reasonText'], message: 'Too big' }])).fields).toEqual([{ name: 'reasonText', message: 'Хэт урт байна' }]);
    expect(only(validation([{ code: 'too_small', path: ['name'], message: 'String must contain at least 2 character(s)' }])).fields).toEqual([{ name: 'name', message: 'Хэт богино байна' }]);
  });

  it('explains the register character rules for "---" / emoji / "+976" style input', () => {
    const chars = 'Регистрт зөвхөн үсэг, цифр байна (жишээ нь УБ12345678)';
    expect(only(validation([{ code: 'custom', path: ['registerNo'], message: 'registerNo contains unsupported characters' }])).fields).toEqual([{ name: 'registerNo', message: chars }]);
    expect(only(validation([{ code: 'custom', path: ['registerNo'], message: 'registerNo must contain letters or digits' }])).fields).toEqual([{ name: 'registerNo', message: chars }]);
  });

  it('maps forbidden text (NUL, U+FFFD, lone surrogate) to a Mongolian message on the field', () => {
    for (const message of ['NUL (U+0000) characters are not allowed', 'U+FFFD replacement characters are not allowed (the text was not valid UTF-8)', 'invalid Unicode (lone surrogate) is not allowed']) {
      expect(only(validation([{ code: 'custom', path: ['name'], message }])).fields).toEqual([{ name: 'name', message: 'Зөвшөөрөгдөөгүй тэмдэгт байна — текстээ шалгана уу' }]);
    }
  });

  it('keeps one message per field (first wins) and several fields in order', () => {
    const d = only(validation([
      { code: 'invalid_type', path: ['name'], message: 'Required' },
      { code: 'too_big', path: ['name'], message: 'String must contain at most 200 character(s)' },
      { code: 'invalid_type', path: ['listType'], message: 'Required' },
    ]));
    expect(d.fields).toEqual([{ name: 'name', message: 'Заавал бөглөнө' }, { name: 'listType', message: 'Заавал бөглөнө' }]);
  });

  it('falls back to a Mongolian generic text for an unclassified issue on a known field', () => {
    expect(only(validation([{ code: 'custom', path: ['source'], message: 'something odd' }])).fields).toEqual([{ name: 'source', message: 'Буруу утга байна' }]);
  });

  it('never leaks English: issues on unknown fields give only the Mongolian form message', () => {
    const d = only(validation([{ code: 'unrecognized_keys', path: [], message: 'Unrecognized key(s) in object (1)' }]));
    expect(d.fields).toEqual([]);
    expect(d.message).toBe(REJECTED);
  });

  it('does not mutate the error it reads', () => {
    const issues = [{ code: 'invalid_type', path: ['name'], message: 'Required' }];
    const snapshot = JSON.stringify(issues);
    only(validation(issues));
    expect(JSON.stringify(issues)).toBe(snapshot);
  });
});

describe('describeBlacklistError: 4xx business errors', () => {
  it('turns the 409 duplicate into a Mongolian message that names the list and points at "Засах"', () => {
    const d = only(new ApiError(409, null, 'An entry with the same register number and list type already exists'), { listType: 'FRAUD' });
    expect(d.message).toBe('Энэ регистр «Залилан» жагсаалтад аль хэдийн бүртгэлтэй байна. Хүснэгтээс хайж олоод «Засах» товчоор өөрчилнө үү.');
    expect(d.fields).toEqual([{ name: 'registerNo', message: '«Залилан» жагсаалтад бүртгэлтэй' }]);
  });

  it('treats any other 409 (concurrent edit) as a Mongolian refresh-and-retry message', () => {
    const d = only(new ApiError(409, null, 'Blacklist entry was modified concurrently, retry'));
    expect(d.message).toBe('Бүртгэлийг өөр хэрэглэгч саяхан өөрчилсөн байна. Хүснэгтийг шинэчлээд дахин оролдоно уу.');
    expect(d.fields).toEqual([]);
  });

  // F8-9: хуучирсан маягт — сервер 409 { code: 'BLACKLIST_STALE' } өгнө; UI өөрийн монгол мессеж + "Шинэчлэх" үйлдэл
  it('F8-9: BLACKLIST_STALE gets the dedicated refresh-the-page message (not the generic conflict text) and no field errors', () => {
    const d = only(new ApiError(409, 'BLACKLIST_STALE', 'Бичлэг өөр хэрэглэгчээр өөрчлөгдсөн байна. Хуудсаа шинэчлээд дахин оролдоно уу'));
    expect(d.message).toBe('Бичлэг өөр хэрэглэгчээр өөрчлөгдсөн байна. Хуудсаа шинэчлээд дахин оролдоно уу');
    expect(d.fields).toEqual([]);
  });

  it('F8-9: isStaleBlacklistError is true only for a 409 carrying the BLACKLIST_STALE code', () => {
    expect(isStaleBlacklistError(new ApiError(409, 'BLACKLIST_STALE', 'x'))).toBe(true);
    expect(isStaleBlacklistError(new ApiError(409, null, 'Blacklist entry was modified concurrently, retry'))).toBe(false);
    expect(isStaleBlacklistError(new ApiError(409, 'CONFLICT', 'An entry with the same register number and list type already exists'))).toBe(false);
    expect(isStaleBlacklistError(new ApiError(400, 'BLACKLIST_STALE', 'x'))).toBe(false);
    expect(isStaleBlacklistError(new Error('BLACKLIST_STALE'))).toBe(false);
    expect(isStaleBlacklistError(null)).toBe(false);
    expect(isStaleBlacklistError(undefined)).toBe(false);
  });

  it('puts the past-date error on the validUntil field', () => {
    const d = only(new ApiError(400, null, 'validUntil must be in the future'));
    expect(d.fields).toEqual([{ name: 'validUntil', message: 'Дуусах огноо өнгөрсөн байна — ирээдүйн огноо сонгоно уу' }]);
  });

  it('attaches the register errors (code + Mongolian server text) to registerNo / customerType', () => {
    const reg = only(new ApiError(400, 'INVALID_REGISTER_NO', 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)'));
    expect(reg.fields).toEqual([{ name: 'registerNo', message: 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)' }]);
    const mismatch = only(new ApiError(400, 'REGISTER_TYPE_MISMATCH', 'Регистр иргэний (УБ12345678) хэлбэртэй, харин сонгосон төрөл "Байгууллага" байна — төрлөө зөв сонгоно уу'));
    expect(mismatch.fields.map((f) => f.name)).toEqual(['customerType']);
  });

  it('shows an unmapped Mongolian server message as is, but replaces an unmapped English one', () => {
    expect(only(new ApiError(400, null, 'Бүртгэл идэвхгүй байна')).message).toBe('Бүртгэл идэвхгүй байна');
    expect(only(new ApiError(400, null, 'deactivationReason is required to deactivate an entry')).message).toBe(REJECTED);
    expect(only(new ApiError(404, null, 'Not Found')).message).toBe(REJECTED);
  });
});

describe('describeBlacklistError: non-validation failures keep the shared customer-error text', () => {
  it('maps 403, network and server errors to the shared Mongolian messages', () => {
    // customer-error-ийн 403 текст нь "харилцагч бүртгэх эрх" тул хар жагсаалтад төөрөгдүүлнэ: blacklist.readOnly ашиглана.
    expect(only(new ApiError(403, null, 'Forbidden')).message).toBe('Та зөвхөн харах эрхтэй. Бүртгэл нэмэх, засах, идэвхгүй болгох — Админ, Комплаенс.');
    expect(only(new ApiError(0, 'NETWORK_ERROR', 'fetch failed')).message).toBe('Сүлжээний холболт тасарлаа. Интернэтээ шалгаад дахин оролдоно уу.');
    expect(only(new ApiError(500, null, 'boom')).fields).toEqual([]);
  });
  it('copes with non-Error input', () => {
    expect(only(undefined).fields).toEqual([]);
    expect(only('x').message.length).toBeGreaterThan(0);
  });
});
