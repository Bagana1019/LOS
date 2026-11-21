// F8-1: хар жагсаалтын бичих бүх зам (POST, PATCH, импорт) `check`-тэй ижил регистрийн шалгалт хэрэглэнэ.
// Хадгалагдсан идэвхтэй бүртгэл бүр `check`-ээр олдож чадах ёстой: Латин (UB…), 9 орон, "УБ1234", төрөл таарахгүй бол няцаана.
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { customerTypeOfRegister } from '@los/contracts';
import { hashRegisterNo } from '@los/database';
import { adminCtx, entryInput, FixedClock, fakeCipher, makeService, REGISTER, SequentialIds } from './test-support';
import { BlacklistCreateBody, BlacklistPatchBody } from './blacklist.schemas';
import type { BlacklistService, ImportItem } from './blacklist.service';
import { InMemoryBlacklistRepository } from './in-memory-blacklist.repository';

const input = (over: Record<string, unknown> = {}) => BlacklistCreateBody.parse(entryInput(over));
const patch = (body: Record<string, unknown>) => BlacklistPatchBody.parse(body);
const rows = (...data: Record<string, unknown>[]): ImportItem[] => data.map((d, i) => ({ row: i + 1, data: d }));

/** Няцаасан алдааг буцаана (хүлээгдсэн алдаа гарахгүй бол тест унана). */
async function rejection(p: Promise<unknown>): Promise<BadRequestException> {
  try { await p; } catch (e) { return e as BadRequestException; }
  throw new Error('expected the call to be rejected');
}
const codeOf = (e: BadRequestException) => (e.getResponse() as { code?: string }).code;
/** Мессежийн тогтмол жишээ (УБ12345678) хэрэглэгчийн утга биш: түүнийг хассаны дараа оруулсан регистр үлдвэл эхo хийсэн гэсэн үг. */
const echoes = (text: string, registerNo: string) => text.replaceAll('УБ12345678', '').includes(registerNo);

const INVALID = 'INVALID_REGISTER_NO';
const MISMATCH = 'REGISTER_TYPE_MISMATCH';
/** [тайлбар, регистр, төрөл, код] */
const BAD: ReadonlyArray<readonly [string, string, 'INDIVIDUAL' | 'LEGAL_ENTITY', string]> = [
  ['Latin look-alike letters', 'UB98765432', 'INDIVIDUAL', INVALID],
  ['Latin letters that would fold onto Cyrillic', 'AO12345678', 'INDIVIDUAL', INVALID],
  ['mixed Latin and Cyrillic', 'УB12345678', 'INDIVIDUAL', INVALID],
  ['9 digits (individual type)', '123456789', 'INDIVIDUAL', INVALID],
  ['9 digits (legal type)', '123456789', 'LEGAL_ENTITY', INVALID],
  ['too short individual register', 'УБ1234', 'INDIVIDUAL', INVALID],
  ['letters with 9 digits', 'УБ123456789', 'INDIVIDUAL', INVALID],
  ['an individual register on a legal entity', 'УБ30000001', 'LEGAL_ENTITY', MISMATCH],
  ['a legal register on an individual', '1234567', 'INDIVIDUAL', MISMATCH],
];

describe('blacklist register validation on every write path (F8-1)', () => {
  let repo: InMemoryBlacklistRepository;
  let service: BlacklistService;
  beforeEach(() => {
    repo = new InMemoryBlacklistRepository();
    service = makeService(repo, new FixedClock(), new SequentialIds());
  });
  const writes = () => repo.events.length;

  describe('create', () => {
    it.each(BAD)('rejects %s with 400, a stable code and a Mongolian message that does not echo the register', async (_label, registerNo, customerType, code) => {
      const e = await rejection(service.create(adminCtx(), input({ registerNo, customerType })));

      expect(e).toBeInstanceOf(BadRequestException);
      expect(codeOf(e)).toBe(code);
      expect(e.message).toMatch(/[А-Яа-яӨөҮү]{4}/);
      expect(echoes(JSON.stringify(e.getResponse()), registerNo)).toBe(false);
      expect(writes()).toBe(0);
      expect((await service.list(adminCtx(), { limit: 20, offset: 0 })).total).toBe(0);
    });

    it('tells the operator to use Cyrillic when the register contains Latin letters', async () => {
      const e = await rejection(service.create(adminCtx(), input({ registerNo: 'UB98765432' })));
      expect(e.message).toContain('кирилл');
    });

    it.each([
      ['an individual register', REGISTER, 'INDIVIDUAL', REGISTER],
      ['lowercase with spaces', ' уб 12345678 ', 'INDIVIDUAL', 'УБ12345678'],
      ['separators (existing behaviour)', 'уб-1234 5678', 'INDIVIDUAL', 'УБ12345678'],
      ['Ө/Ү letters', 'өү12345678', 'INDIVIDUAL', 'ӨҮ12345678'],
      ['a 7-digit legal register', '1234567', 'LEGAL_ENTITY', '1234567'],
      ['a spaced legal register', '123 4567', 'LEGAL_ENTITY', '1234567'],
    ] as const)('accepts %s and stores the form that check can find', async (_label, registerNo, customerType, stored) => {
      const entry = await service.create(adminCtx(), input({ registerNo, customerType }));

      expect(entry.registerNo).toBe(stored);
      expect(customerTypeOfRegister(entry.registerNo)).toBe(customerType);
      expect(await repo.findByKey('org-1', hashRegisterNo(stored), 'DELINQUENT')).toMatchObject({ id: entry.id });
    });
  });

  describe('update', () => {
    const seed = () => service.create(adminCtx(), input());

    it.each(BAD)('rejects PATCH registerNo/customerType that is %s and leaves the entry untouched', async (_label, registerNo, customerType, code) => {
      const { id } = await seed();
      // Төрлийг тусад нь өөрчилнө (INDIVIDUAL бол өөрчлөлтгүй): PATCH нь зөвхөн өөрчлөгдсөн талбарыг авч болно
      const body = customerType === 'INDIVIDUAL' ? { registerNo } : { registerNo, customerType };
      const e = await rejection(service.update(adminCtx(), id, patch(body)));

      expect(codeOf(e)).toBe(code);
      expect(await service.get(adminCtx(), id)).toMatchObject({ registerNo: REGISTER, customerType: 'INDIVIDUAL' });
      expect(writes()).toBe(1);
    });

    it('rejects a PATCH that only changes customerType onto an individual register (pairs with the stored register)', async () => {
      const { id } = await seed();
      const e = await rejection(service.update(adminCtx(), id, patch({ customerType: 'LEGAL_ENTITY' })));
      expect(codeOf(e)).toBe(MISMATCH);
      expect(writes()).toBe(1);
    });

    it('accepts registerNo and customerType changed together to a matching pair', async () => {
      const { id } = await seed();
      const updated = await service.update(adminCtx(), id, patch({ registerNo: '1234567', customerType: 'LEGAL_ENTITY' }));
      expect(updated).toMatchObject({ registerNo: '1234567', customerType: 'LEGAL_ENTITY' });
      expect(writes()).toBe(2);
    });

    it('does not block edits that leave register and type alone, even on a legacy row saved before the rule', async () => {
      const { id } = await seed();
      const row = (await repo.findById('org-1', id))!;
      const legacyRegister = 'UB98765432';
      await repo.saveWithEvent(
        { ...row, registerNoEncrypted: fakeCipher.encrypt(legacyRegister), registerNoHash: hashRegisterNo(legacyRegister), updatedAt: new Date(row.updatedAt.getTime() + 1) },
        repo.events[0]!, row.updatedAt,
      );

      expect(await service.update(adminCtx(), id, patch({ name: 'Засагдсан нэр' }))).toMatchObject({ name: 'Засагдсан нэр' });
      expect(await service.deactivate(adminCtx(), id, 'Буруу бүртгэл')).toMatchObject({ isActive: false });
      // харин төрлийг өөрчлөх нь хуучин (буруу) регистртэй хослуулагдаж няцаагдана: регистрийг хамт засах ёстой
      expect(codeOf(await rejection(service.update(adminCtx(), id, patch({ customerType: 'LEGAL_ENTITY' }))))).toBe(INVALID);
      expect(await service.update(adminCtx(), id, patch({ customerType: 'LEGAL_ENTITY', registerNo: '1234567' }))).toMatchObject({ registerNo: '1234567' });
    });
  });

  describe('importRows', () => {
    it('reports a per-row error for each invalid register, saves the valid rows, and never echoes the register', async () => {
      const result = await service.importRows(adminCtx(), rows(
        entryInput({ registerNo: 'УБ11111111' }),
        entryInput({ registerNo: 'UB98765432' }),
        entryInput({ registerNo: '123456789' }),
        entryInput({ registerNo: 'УБ1234' }),
        entryInput({ registerNo: 'УБ30000001', customerType: 'LEGAL_ENTITY' }),
        entryInput({ registerNo: '1234567', customerType: 'LEGAL_ENTITY' }),
      ));

      expect(result).toMatchObject({ created: 2, updated: 0, skipped: 0 });
      expect(result.errors.map((e) => e.row)).toEqual([2, 3, 4, 5]);
      expect(result.errors[0]!.message).toContain('registerNo');
      expect(result.errors[0]!.message).toContain('кирилл');
      expect(result.errors[3]!.message).toContain('customerType');
      const json = JSON.stringify(result);
      for (const secret of ['UB98765432', '123456789', 'УБ1234', 'УБ30000001']) expect(echoes(json, secret)).toBe(false);
      expect(writes()).toBe(2);
      expect((await service.list(adminCtx(), { limit: 20, offset: 0 })).total).toBe(2);
    });

    it('does not report a rejected register as an internal error', async () => {
      const result = await service.importRows(adminCtx(), rows(entryInput({ registerNo: 'UB98765432' })));
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.message).not.toMatch(/internal error/i);
    });
  });
});
