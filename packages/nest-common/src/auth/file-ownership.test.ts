import { describe, expect, it } from 'vitest';
import { assertFileUploadedByCaller, isFileUploadedByCaller } from './file-ownership';

const as = (userId: string | null) => ({ userId });

describe('isFileUploadedByCaller (NFR-3: хавсаргахдаа файлыг өөрөө байршуулсан байх)', () => {
  it('байршуулсан хүн өөрөө бол зөвшөөрнө', () => {
    expect(isFileUploadedByCaller(as('officer-1'), 'officer-1')).toBe(true);
  });

  it('өөр хүний байршуулсан файл бол татгалзана', () => {
    expect(isFileUploadedByCaller(as('officer-2'), 'officer-1')).toBe(false);
  });

  it('байршуулагч тодорхойгүй (null/undefined) бол татгалзана — эзэмшил батлагдаагүй', () => {
    expect(isFileUploadedByCaller(as('officer-1'), null)).toBe(false);
    expect(isFileUploadedByCaller(as('officer-1'), undefined)).toBe(false);
  });

  it('дуудагч тодорхойгүй бол татгалзана (хоёулаа null байсан ч таарахгүй)', () => {
    expect(isFileUploadedByCaller(as(null), null)).toBe(false);
    expect(isFileUploadedByCaller(as(null), 'officer-1')).toBe(false);
  });

  it('сервисийн хэрэглэгч (svc:) чөлөөлөгдөнө', () => {
    expect(isFileUploadedByCaller(as('svc:origination-files'), 'officer-1')).toBe(true);
    expect(isFileUploadedByCaller(as('svc:origination-files'), null)).toBe(true);
  });

  it('"svc" угтвар шиг харагдах боловч бодит угтвар биш хэрэглэгчийг чөлөөлөхгүй', () => {
    expect(isFileUploadedByCaller(as('svc-user'), 'officer-1')).toBe(false);
    expect(isFileUploadedByCaller(as('SVC:x'), 'officer-1')).toBe(false);
  });
});

describe('assertFileUploadedByCaller', () => {
  it('эзэмшигч бол юу ч шидэхгүй', () => {
    expect(() => assertFileUploadedByCaller(as('officer-1'), 'officer-1')).not.toThrow();
  });

  it('эзэмшигч биш бол 403 FILE_NOT_OWNED', () => {
    try {
      assertFileUploadedByCaller(as('officer-2'), 'officer-1');
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as { getStatus(): number }).getStatus()).toBe(403);
      expect((e as { getResponse(): { code: string } }).getResponse()).toMatchObject({ code: 'FILE_NOT_OWNED' });
    }
  });
});
