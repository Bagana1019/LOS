import { describe, expect, it } from 'vitest';
import { cleanCellText, joinCells } from './cell-text';

describe('cleanCellText', () => {
  it('бүх төрлийн хоосон зайг нэг зай болгож trim хийнэ (NBSP, TAB, шинэ мөр, нарийн зай)', () => {
    expect(cleanCellText('  a \u00a0\t b\r\n c\u202f d  ')).toBe('a b c d');
  });

  it('удирдлагын ба тэг өргөнтэй тэмдэгтийг устгана; мянгатын таслал, цэг, кирилл хэвээр', () => {
    expect(cleanCellText('1\u200b,500\u0000,000.00')).toBe('1,500,000.00');
    expect(cleanCellText('\ufeffӨлзий\u2060 Үнэ')).toBe('Өлзий Үнэ');
  });

  it('хоосон / зөвхөн хоосон зай → ""', () => {
    expect(cleanCellText('')).toBe('');
    expect(cleanCellText(' \u00a0 \n')).toBe('');
  });
});

describe('joinCells', () => {
  it('хоосон нүдийг алгасч нэг зайгаар залгана', () => {
    expect(joinCells(['a', '', 'b', ''])).toBe('a b');
    expect(joinCells([])).toBe('');
  });
});
