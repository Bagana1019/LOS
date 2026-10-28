// detectChannel: QPAY | POS | ATM | TRANSFER | OTHER (BSA-FR-3.1). Бүх текст синтетик.
import { describe, expect, it } from 'vitest';
import type { BsaChannel } from '@los/contracts';
import { CHANNEL_KEYWORDS, detectChannel } from './channel';

const d = (description: string, counterpartyAccount: string | null = null, counterpartyName: string | null = null) => ({
  description, counterpartyAccount, counterpartyName,
});

describe('detectChannel', () => {
  const table: Array<[string, ReturnType<typeof d>, BsaChannel]> = [
    ['QPay latin', d('QPay payment 123456'), 'QPAY'],
    ['QPAY upper', d('QPAY-ЭЭР ТӨЛСӨН'), 'QPAY'],
    ['Кюпэй cyrillic', d('Кюпэй төлбөр'), 'QPAY'],
    ['q pay spaced', d('Q Pay'), 'QPAY'],
    ['SocialPay → QPAY wallet', d('SocialPay transfer'), 'QPAY'],
    ['POS latin', d('POS 00123 худалдан авалт'), 'POS'],
    ['ПОС cyrillic', d('ПОС терминал'), 'POS'],
    ['терминал', d('Терминалаар төлсөн'), 'POS'],
    ['ATM latin', d('ATM 4501 cash withdrawal'), 'ATM'],
    ['АТМ cyrillic', d('АТМ-ээс бэлэн мөнгө авсан'), 'ATM'],
    ['бэлэн мөнгө авсан', d('Бэлэн мөнгө авсан'), 'ATM'],
    ['cash withdrawal', d('Cash withdrawal'), 'ATM'],
    ['шилжүүлэг word', d('Шилжүүлэг'), 'TRANSFER'],
    ['transfer word', d('Transfer to friend'), 'TRANSFER'],
    ['counterparty account → TRANSFER', d('ямар нэг утга', '5011234567'), 'TRANSFER'],
    ['no clue → OTHER', d('Цалин 2026-03'), 'OTHER'],
    ['empty → OTHER', d(''), 'OTHER'],
  ];
  it.each(table)('%s', (_name, txn, expected) => {
    expect(detectChannel(txn)).toBe(expected);
  });

  it('is whole-word aware: "pos" inside another word is not a POS', () => {
    expect(detectChannel(d('deposit 100'))).toBe('OTHER');
    expect(detectChannel(d('Position fee'))).toBe('OTHER');
    expect(detectChannel(d('Bratm'))).toBe('OTHER');
  });

  it('specific channel keywords beat the generic counterparty-account TRANSFER', () => {
    expect(detectChannel(d('ATM withdrawal', '5011234567'))).toBe('ATM');
    expect(detectChannel(d('QPay', '5011234567'))).toBe('QPAY');
    expect(detectChannel(d('POS', '5011234567'))).toBe('POS');
  });

  it('ATM wins over QPAY/POS when several words are present; QPAY over POS', () => {
    expect(detectChannel(d('ATM POS'))).toBe('ATM');
    expect(detectChannel(d('QPay POS'))).toBe('QPAY');
  });

  it('looks at the counterparty name too', () => {
    expect(detectChannel(d('төлбөр', null, 'QPay merchant'))).toBe('QPAY');
  });

  it('latin/cyrillic/mixed spellings of the same phrase give the same channel', () => {
    for (const variant of ['Шилжүүлэг', 'ШИЛЖҮҮЛЭГ', 'shilzhuuleg', 'Shiljuuleg']) {
      expect(detectChannel(d(variant))).toBe('TRANSFER');
    }
    for (const variant of ['АТМ', 'ATM', 'АTМ', 'atm']) expect(detectChannel(d(variant))).toBe('ATM'); // холимог look-alike
  });

  it('accepts a custom keyword table and ignores blank accounts', () => {
    const custom = { ...CHANNEL_KEYWORDS, POS: ['зөвхөн энэ'] };
    expect(detectChannel(d('POS'), custom)).toBe('OTHER');
    expect(detectChannel(d('Зөвхөн энэ'), custom)).toBe('POS');
    expect(detectChannel(d('x', '   '))).toBe('OTHER');
  });
});
