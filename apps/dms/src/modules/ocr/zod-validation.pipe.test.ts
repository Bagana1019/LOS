import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractBodySchema } from './ocr.dto';
import { ZodValidationPipe } from './zod-validation.pipe';

function catchBadRequest(fn: () => unknown): BadRequestException {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return e as BadRequestException;
  }
  throw new Error('BadRequestException хүлээсэн');
}

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(z.object({ n: z.number().int() }).strict());

  it('зөв утгыг parse хийж буцаана', () => {
    expect(pipe.transform({ n: 3 })).toEqual({ n: 3 });
  });

  it('буруу бол 400, зам+код л, ирсэн утгыг буцаахгүй', () => {
    const secret = 'ЖЮ85061512-нууц';
    const e = catchBadRequest(() => pipe.transform({ n: secret }));
    expect(e.getStatus()).toBe(400);
    const body = e.getResponse() as { code: string; issues: Array<{ path: string; code: string }> };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.issues).toEqual([{ path: 'n', code: 'invalid_type' }]);
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('үл мэдэгдэх талбарыг (strict) татгалзана', () => {
    const e = catchBadRequest(() => pipe.transform({ n: 1, extra: 'x' }));
    expect((e.getResponse() as { issues: Array<{ code: string }> }).issues[0].code).toBe('unrecognized_keys');
  });
});

describe('extractBodySchema', () => {
  const pipe = new ZodValidationPipe(extractBodySchema);

  it('анхдагч: docType=AUTO, includeText=false', () => {
    expect(pipe.transform({})).toEqual({ docType: 'AUTO', includeText: false });
  });

  it('хоосон мөрийг тохируулаагүй гэж үзнэ', () => {
    expect(pipe.transform({ docType: '', includeText: ' ' })).toEqual({ docType: 'AUTO', includeText: false });
  });

  it.each(['ID_CARD', 'SALARY_CERTIFICATE', 'GENERIC', 'AUTO'])('docType=%s зөвшөөрнө', (docType) => {
    expect(pipe.transform({ docType }).docType).toBe(docType);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('includeText=%s -> %s', (raw, expected) => {
    expect(pipe.transform({ includeText: raw }).includeText).toBe(expected);
  });

  it.each([
    [{ docType: 'PASSPORT' }, 'docType'],
    [{ docType: 'id_card' }, 'docType'],
    [{ includeText: 'yes' }, 'includeText'],
    [{ includeText: '2' }, 'includeText'],
  ])('%j буруу', (body, path) => {
    const e = catchBadRequest(() => pipe.transform(body));
    expect((e.getResponse() as { issues: Array<{ path: string }> }).issues.map((i) => i.path)).toContain(path);
  });

  it('үл мэдэгдэх талбарыг татгалзана', () => {
    catchBadRequest(() => pipe.transform({ docType: 'AUTO', file: 'x' }));
  });
});
