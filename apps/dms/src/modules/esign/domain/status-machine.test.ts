import { SigningStatus } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { ACTIVE_STATUSES, canTransition, isActive, isTerminal } from './status-machine';

/** ESIGN_DESIGN.md-ийн "Status machine" хэсгийн зөвшөөрөгдсөн бүх шилжилт */
const ALLOWED = new Set([
  'PENDING>IN_PROGRESS', 'PENDING>EXPIRED', 'PENDING>CANCELLED',
  'IN_PROGRESS>FINALIZING', 'IN_PROGRESS>PENDING', 'IN_PROGRESS>DECLINED', 'IN_PROGRESS>EXPIRED', 'IN_PROGRESS>CANCELLED', 'IN_PROGRESS>FAILED',
  'FINALIZING>SIGNED', 'FINALIZING>FAILED', 'FINALIZING>IN_PROGRESS',
]);

describe('status machine', () => {
  it('8×8 бүх хосын хувьд canTransition нь зөвшөөрөгдсөн шилжилттэй яг таарна', () => {
    for (const from of SigningStatus) {
      for (const to of SigningStatus) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(ALLOWED.has(`${from}>${to}`));
      }
    }
  });

  it('төлөв өөрөө руугаа шилжихгүй', () => {
    for (const status of SigningStatus) expect(canTransition(status, status)).toBe(false);
  });

  it('төгсгөлийн төлвөөс юу ч руу шилжихгүй; isTerminal нь зөвхөн тэдгээрт true', () => {
    const terminal = ['SIGNED', 'DECLINED', 'EXPIRED', 'FAILED', 'CANCELLED'];
    for (const status of SigningStatus) {
      expect(isTerminal(status)).toBe(terminal.includes(status));
      if (isTerminal(status)) expect(SigningStatus.some((to) => canTransition(status, to))).toBe(false);
    }
  });

  it('isActive нь PENDING | IN_PROGRESS | FINALIZING; идэвхтэй ба төгсгөл нь бие биенээ нөхнө', () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual(['FINALIZING', 'IN_PROGRESS', 'PENDING']);
    for (const status of SigningStatus) expect(isActive(status)).toBe(!isTerminal(status));
  });

  it('SIGNED рүү зөвхөн FINALIZING-ээс орно (finalization алхмуудыг алгасах боломжгүй)', () => {
    expect(SigningStatus.filter((from) => canTransition(from, 'SIGNED'))).toEqual(['FINALIZING']);
  });
});
