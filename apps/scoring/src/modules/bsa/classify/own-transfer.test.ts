// BSA-BR-5: өөрийн данс хоорондын шилжүүлэг. Бүх данс/нэр/дүн СИНТЕТИК.
import { describe, expect, it } from 'vitest';
import { OWN_TRANSFER_CONFIDENCE } from './classify.defaults';
import type { ClassifiableTxn } from './classify.types';
import {
  collectAccountsFromStatements, detectOwnTransfers, matchOwnAccount, normalizeOwnAccounts, ownAccountKeys,
} from './own-transfer';
import { expenseTxn, incomeTxn } from './testing/factories';

const OWN_IBAN = 'MN580050099123456789'; // синтетик
const noCtx: { ownAccounts: string[]; customerNames: string[] } = { ownAccounts: [], customerNames: [] };
const detect = (txns: ClassifiableTxn[], ctx: Partial<typeof noCtx> = {}) => detectOwnTransfers(txns, { ...noCtx, ...ctx });
const methods = (txns: ClassifiableTxn[], ctx: Partial<typeof noCtx> = {}) => detect(txns, ctx).findings.map((f) => f?.method ?? null);

/** Эсрэг чиглэлийн, өөр хуулгын хос: орлого KHAN хуулгад, зарлага TDB хуулгад */
const pair = (over: { inc?: Partial<ClassifiableTxn>; exp?: Partial<ClassifiableTxn> } = {}): ClassifiableTxn[] => [
  incomeTxn('i', 'орлого', { statementKey: 'S-KHAN', bank: 'KHAN', amount: 1_000_000, txnTime: '14:25', ...over.inc }),
  expenseTxn('e', 'зарлага', { statementKey: 'S-TDB', bank: 'TDB', amount: 1_000_000, txnTime: '14:25', ...over.exp }),
];

describe('(a) counterparty account vs the customer\'s own accounts', () => {
  it('exact match ignores formatting (spaces, dashes, case) and is flagged ACCOUNT 95', () => {
    const txns = [expenseTxn('a', 'x', { counterpartyAccount: '5011-234 567' }), incomeTxn('b', 'y', { counterpartyAccount: 'mn58 0050 0991 2345 6789' })];
    const { findings } = detect(txns, { ownAccounts: ['5011234567', OWN_IBAN] });
    expect(findings[0]).toMatchObject({ method: 'ACCOUNT', confidence: OWN_TRANSFER_CONFIDENCE.ACCOUNT_EXACT });
    expect(findings[1]).toMatchObject({ method: 'ACCOUNT', confidence: OWN_TRANSFER_CONFIDENCE.ACCOUNT_EXACT });
  });

  it('other people\'s accounts, missing accounts and substrings are not own accounts', () => {
    const txns = [
      expenseTxn('a', 'x', { counterpartyAccount: '5011234568' }),
      expenseTxn('b', 'x', { counterpartyAccount: null }),
      expenseTxn('c', 'x', { counterpartyAccount: '15011234567' }),
      expenseTxn('d', 'x', { counterpartyAccount: '' }),
    ];
    expect(methods(txns, { ownAccounts: ['5011234567'] })).toEqual([null, null, null, null]);
  });

  it('empty own-account list never flags anything', () => {
    expect(methods([expenseTxn('a', 'x', { counterpartyAccount: '5011234567' })])).toEqual([null]);
  });

  it('IBAN ↔ domestic account number: IBAN tail equals the plain number (≥ 8 digits)', () => {
    expect(matchOwnAccount('99123456789', [OWN_IBAN])).toBe('EXACT'); // IBAN-ы дотоодын хэсэг (тэг тайрагдсан)
    expect(matchOwnAccount(OWN_IBAN, ['99123456789'])).toBe('EXACT');
    expect(matchOwnAccount('3456789', [OWN_IBAN])).toBeNull(); // 8 цифрээс богино → таамаглахгүй
    expect(matchOwnAccount('11111111111', [OWN_IBAN])).toBeNull();
  });

  describe('masked accounts (suffix match)', () => {
    const own = normalizeOwnAccounts(['5011234567']);
    it('matches when the visible suffix (and prefix) agree → MASKED 80', () => {
      expect(matchOwnAccount('5011****4567', own)).toBe('MASKED');
      expect(matchOwnAccount('****4567', own)).toBe('MASKED');
      expect(matchOwnAccount('XXXXXX4567', own)).toBe('MASKED');
      expect(matchOwnAccount('50** **** 4567', own)).toBe('MASKED');
      expect(detect([expenseTxn('a', 'x', { counterpartyAccount: '****4567' })], { ownAccounts: ['5011234567'] }).findings[0])
        .toMatchObject({ method: 'ACCOUNT', confidence: OWN_TRANSFER_CONFIDENCE.ACCOUNT_MASKED });
    });
    it('does not match a different suffix, a different prefix or a too-short suffix', () => {
      expect(matchOwnAccount('5011****4568', own)).toBeNull();
      expect(matchOwnAccount('6011****4567', own)).toBeNull();
      expect(matchOwnAccount('*****567', own)).toBeNull(); // 3 цифр < minMaskedSuffixDigits
      expect(matchOwnAccount('****', own)).toBeNull();
    });
    it('a masked pattern is never an EXACT match, even when the stripped digits happen to equal an own number', () => {
      // '5011****4567' → цифрүүд '50114567': далдалсан дугаарыг бүтэн дугаар гэж үзэж болохгүй (MASKED л байж болно)
      expect(matchOwnAccount('5011****4567', ['50114567'])).toBe('MASKED');
      expect(matchOwnAccount('5011****4567', ['59994567'])).toBeNull();
    });
    it('the suffix can be configured', () => {
      expect(matchOwnAccount('*567', own, { minMaskedSuffixDigits: 3 })).toBe('MASKED');
    });
  });
});

describe('(b) opposite-direction pairs across different statements', () => {
  it('equal amount + same date + same minute → both sides flagged PAIR (verified, 90) with pairedKey', () => {
    const { findings } = detect(pair());
    expect(findings[0]).toMatchObject({ method: 'PAIR', confidence: OWN_TRANSFER_CONFIDENCE.PAIR_TIME_VERIFIED, pairedKey: 'e' });
    expect(findings[1]).toMatchObject({ method: 'PAIR', confidence: OWN_TRANSFER_CONFIDENCE.PAIR_TIME_VERIFIED, pairedKey: 'i' });
  });

  it('time differs by one minute between non-exempt banks → not paired', () => {
    expect(methods(pair({ exp: { txnTime: '14:26' } }))).toEqual([null, null]);
    expect(methods(pair({ exp: { txnTime: '14:25:59' } }))).toEqual(['PAIR', 'PAIR']); // минут хүртэл таарна (секунд үл тооно)
  });

  it.each([
    ['Голомт', 'GOLOMT'],
    ['Хас', 'XAC'],
    ['Капитрон', 'CAPITRON'],
  ])('time is ignored when either side is %s (no time on those statements)', (_n, bank) => {
    for (const side of ['inc', 'exp'] as const) {
      const txns = pair({ [side]: { bank, txnTime: '09:00' } });
      const { findings } = detect(txns);
      expect(findings.map((f) => f?.method)).toEqual(['PAIR', 'PAIR']);
      expect(findings[0]?.confidence).toBe(OWN_TRANSFER_CONFIDENCE.PAIR_TIME_UNVERIFIED);
    }
    expect(methods(pair({ inc: { bank, txnTime: null }, exp: { txnTime: null } }))).toEqual(['PAIR', 'PAIR']);
  });

  it('exempt-bank pair with equal minutes is still "verified"', () => {
    const { findings } = detect(pair({ inc: { bank: 'GOLOMT', txnTime: '14:25' } }));
    expect(findings[0]?.confidence).toBe(OWN_TRANSFER_CONFIDENCE.PAIR_TIME_VERIFIED);
  });

  it('when one side has no time the other cannot contradict it → paired, unverified', () => {
    const { findings } = detect(pair({ exp: { txnTime: null } }));
    expect(findings.map((f) => f?.method)).toEqual(['PAIR', 'PAIR']);
    expect(findings[0]?.confidence).toBe(OWN_TRANSFER_CONFIDENCE.PAIR_TIME_UNVERIFIED);
  });

  it('a garbage time string counts as "no time"', () => {
    expect(methods(pair({ exp: { txnTime: 'зарим нэг' } }))).toEqual(['PAIR', 'PAIR']);
  });

  it('negative cases: same statement, same direction, other date, other amount', () => {
    expect(methods(pair({ exp: { statementKey: 'S-KHAN' } }))).toEqual([null, null]);
    expect(methods(pair({ exp: { direction: 'INCOME' } }))).toEqual([null, null]);
    expect(methods(pair({ exp: { txnDate: '2026-03-11' } }))).toEqual([null, null]);
    expect(methods(pair({ exp: { amount: 999_999.99 } }))).toEqual([null, null]);
    expect(methods(pair({ exp: { amount: 1_000_000.01 } }))).toEqual([null, null]);
  });

  it('amounts are compared decimal-safely (float noise does not break or fake a pair)', () => {
    expect(methods(pair({ inc: { amount: 0.1 + 0.2 }, exp: { amount: 0.3 } }))).toEqual(['PAIR', 'PAIR']);
    expect(methods(pair({ inc: { amount: 1234.56 }, exp: { amount: 1234.5600000000002 } }))).toEqual(['PAIR', 'PAIR']);
    expect(methods(pair({ inc: { amount: 1234.56 }, exp: { amount: 1234.57 } }))).toEqual([null, null]);
  });

  it('zero, negative and non-finite amounts never pair', () => {
    for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1e300]) {
      expect(methods(pair({ inc: { amount }, exp: { amount } })), String(amount)).toEqual([null, null]);
    }
  });

  it('one-to-many: a single income is paired with at most ONE of several equal expenses (closest time, then input order)', () => {
    const txns = [
      incomeTxn('i', 'in', { statementKey: 'A', bank: 'KHAN', amount: 500, txnTime: '10:00' }),
      expenseTxn('e1', 'out', { statementKey: 'B', bank: 'TDB', amount: 500, txnTime: '10:00' }),
      expenseTxn('e2', 'out', { statementKey: 'C', bank: 'STATE', amount: 500, txnTime: '10:00' }),
    ];
    const { findings } = detect(txns);
    expect(findings.map((f) => f?.pairedKey ?? null)).toEqual(['e1', 'i', null]);
  });

  it('many-to-one the other way round, and each transaction is used at most once', () => {
    const txns = [
      incomeTxn('i1', 'in', { statementKey: 'A', amount: 500, txnTime: '10:00' }),
      incomeTxn('i2', 'in', { statementKey: 'A', amount: 500, txnTime: '10:00' }),
      expenseTxn('e', 'out', { statementKey: 'B', bank: 'TDB', amount: 500, txnTime: '10:00' }),
    ];
    const { findings } = detect(txns);
    expect(findings.map((f) => f?.pairedKey ?? null)).toEqual(['e', null, 'i1']);
    const paired = findings.filter(Boolean).length;
    expect(paired).toBe(2);
  });

  it('2 incomes + 2 expenses pair 1:1 by closest time, not by input order alone', () => {
    const txns = [
      incomeTxn('i1', 'in', { statementKey: 'A', bank: 'GOLOMT', amount: 500, txnTime: '10:00' }),
      incomeTxn('i2', 'in', { statementKey: 'A', bank: 'GOLOMT', amount: 500, txnTime: '10:05' }),
      expenseTxn('e1', 'out', { statementKey: 'B', bank: 'TDB', amount: 500, txnTime: '10:05' }),
      expenseTxn('e2', 'out', { statementKey: 'B', bank: 'TDB', amount: 500, txnTime: '10:00' }),
    ];
    const { findings } = detect(txns);
    expect(findings.map((f) => f?.pairedKey)).toEqual(['e2', 'e1', 'i2', 'i1']);
  });

  it('the closest-time pair wins globally: a later exact-minute pair is not stolen by an earlier looser one', () => {
    const txns = [
      incomeTxn('i1', 'in', { statementKey: 'A', bank: 'XAC', amount: 500, txnTime: '10:00' }),
      incomeTxn('i2', 'in', { statementKey: 'A', bank: 'XAC', amount: 500, txnTime: '10:05' }),
      expenseTxn('e', 'out', { statementKey: 'B', bank: 'GOLOMT', amount: 500, txnTime: '10:05' }),
    ];
    const { findings } = detect(txns);
    expect(findings.map((f) => f?.pairedKey ?? null)).toEqual([null, 'e', 'i2']);
  });

  it('is deterministic and independent of Map iteration: same input → same output', () => {
    const txns = [...pair(), ...pair({ inc: { amount: 7 }, exp: { amount: 7 } }).map((t) => ({ ...t, key: `${t.key}2` }))];
    expect(detect(txns)).toEqual(detect(txns));
  });

  it('truncates absurdly large same-day same-amount groups and reports it', () => {
    const txns: ClassifiableTxn[] = [];
    for (let i = 0; i < 6; i++) {
      txns.push(incomeTxn(`i${i}`, 'in', { statementKey: 'A', amount: 5, txnTime: '10:00' }));
      txns.push(expenseTxn(`e${i}`, 'out', { statementKey: 'B', bank: 'TDB', amount: 5, txnTime: '10:00' }));
    }
    const r = detectOwnTransfers(txns, noCtx, { maxPairGroupSide: 4 });
    expect(r.truncatedPairCandidates).toBe(4); // 2 + 2 хайгдаагүй
    expect(r.findings.filter(Boolean)).toHaveLength(8);
  });
});

describe('(c) Golomt: customer\'s full name in the description', () => {
  const names = ['Бат Болд']; // синтетик
  const golomt = (description: string, over: Partial<ClassifiableTxn> = {}) =>
    expenseTxn('g', description, { bank: 'GOLOMT', statementKey: 'S-GOL', ...over });

  it('ordered tokens (either order), any script, flagged NAME with the lower confidence', () => {
    for (const description of ['Шилжүүлэг БОЛД БАТ', 'Шилжүүлэг Бат Болд', 'shilzhuuleg bat bold', 'Орлого: Болд Бат 5011']) {
      const f = detect([golomt(description)], { customerNames: names }).findings[0];
      expect(f, description).toMatchObject({ method: 'NAME', confidence: OWN_TRANSFER_CONFIDENCE.NAME_IN_DESCRIPTION });
    }
    expect(OWN_TRANSFER_CONFIDENCE.NAME_IN_DESCRIPTION).toBeLessThan(OWN_TRANSFER_CONFIDENCE.PAIR_TIME_UNVERIFIED);
  });

  it('allows a small gap between the name words, not a large one', () => {
    expect(methods([golomt('Бат овог Болд')], { customerNames: names })).toEqual(['NAME']);
    expect(methods([golomt('Бат нэг хоёр гурав Болд')], { customerNames: names })).toEqual([null]);
  });

  it('only on a Golomt statement', () => {
    expect(methods([golomt('Шилжүүлэг Бат Болд', { bank: 'KHAN' })], { customerNames: names })).toEqual([null]);
    expect(methods([golomt('Шилжүүлэг Бат Болд', { bank: null })], { customerNames: names })).toEqual([null]);
  });

  it('needs the FULL name: one word, a different person, or initials only do not count', () => {
    expect(methods([golomt('Шилжүүлэг Болд')], { customerNames: names })).toEqual([null]);
    expect(methods([golomt('Шилжүүлэг Бат Дорж')], { customerNames: names })).toEqual([null]);
    expect(methods([golomt('Шилжүүлэг Б.Болд')], { customerNames: names })).toEqual([null]);
  });

  it('a single-word customer name is ignored (too ambiguous), empty names are ignored', () => {
    expect(methods([golomt('Шилжүүлэг Болд')], { customerNames: ['Болд'] })).toEqual([null]);
    expect(methods([golomt('Шилжүүлэг Болд')], { customerNames: ['', '  '] })).toEqual([null]);
  });

  it('checks the counterparty name field too, and ACCOUNT/PAIR take precedence over NAME', () => {
    expect(methods([golomt('x', { counterpartyName: 'Болд Бат' })], { customerNames: names })).toEqual(['NAME']);
    const f = detect([golomt('Бат Болд', { counterpartyAccount: '5011234567' })], { customerNames: names, ownAccounts: ['5011234567'] }).findings[0];
    expect(f?.method).toBe('ACCOUNT');
  });

  it('the bank list is configurable', () => {
    const txns = [golomt('Бат Болд', { bank: 'TDB' })];
    expect(detectOwnTransfers(txns, { ownAccounts: [], customerNames: names }, { nameInDescriptionBanks: ['TDB'] }).findings[0]?.method).toBe('NAME');
  });
});

describe('precedence, manual overrides and pair partners', () => {
  it('manual overrides take no part (neither flagged nor used as a partner)', () => {
    const txns = pair({ inc: { manualCategoryCode: 'SALARY' } });
    expect(methods(txns)).toEqual([null, null]);
    expect(methods([expenseTxn('a', 'x', { counterpartyAccount: '5011234567', manualCategoryCode: 'BANK_FEE' })], { ownAccounts: ['5011234567'] })).toEqual([null]);
  });

  it('the counterpart of an account-flagged transaction is flagged by pairing; the account finding keeps its method and gets pairedKey', () => {
    const txns = pair({ inc: { counterpartyAccount: '5011234567' } });
    const { findings } = detect(txns, { ownAccounts: ['5011234567'] });
    expect(findings[0]).toMatchObject({ method: 'ACCOUNT', confidence: OWN_TRANSFER_CONFIDENCE.ACCOUNT_EXACT, pairedKey: 'e' });
    expect(findings[1]).toMatchObject({ method: 'PAIR', pairedKey: 'i' });
  });

  it('empty input and tolerance of missing context fields', () => {
    expect(detect([])).toEqual({ findings: [], truncatedPairCandidates: 0 });
    expect(detectOwnTransfers([incomeTxn('a', 'x')], {} as never).findings).toEqual([null]);
  });
});

describe('collectAccountsFromStatements (auto-add statement IBANs to the customer account list)', () => {
  const st = (over: Partial<Parameters<typeof collectAccountsFromStatements>[0][number]>) => ({
    bank: 'KHAN' as const, accountNo: null, iban: null, holderName: null, ...over,
  });

  it('normalizes account numbers/IBANs and keeps bank + holder', () => {
    const out = collectAccountsFromStatements([st({ accountNo: '5011-234 567', iban: 'mn58 0050 0991 2345 6789', holderName: 'Бат Болд' })]);
    expect(out).toEqual([{ bank: 'KHAN', accountNo: '5011234567', iban: OWN_IBAN, holderName: 'Бат Болд' }]);
  });

  it('skips statements with neither an account number nor an IBAN', () => {
    expect(collectAccountsFromStatements([st({}), st({ accountNo: '   ', iban: '' })])).toEqual([]);
  });

  it('de-duplicates the same account across statements and merges a missing IBAN / account number', () => {
    const out = collectAccountsFromStatements([
      st({ accountNo: '5011234567' }),
      st({ accountNo: '5011 234 567', holderName: 'Бат Болд' }),
      st({ bank: 'TDB', iban: OWN_IBAN }),
      st({ bank: 'TDB', accountNo: '99123456789', iban: OWN_IBAN }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ accountNo: '5011234567', holderName: 'Бат Болд' });
    expect(out[1]).toMatchObject({ bank: 'TDB', accountNo: '99123456789', iban: OWN_IBAN });
  });

  it('puts an IBAN given in the accountNo field (or a plain number in iban) into the right slot', () => {
    expect(collectAccountsFromStatements([st({ accountNo: OWN_IBAN })])[0]).toMatchObject({ accountNo: null, iban: OWN_IBAN });
    expect(collectAccountsFromStatements([st({ iban: '5011234567' })])[0]).toMatchObject({ accountNo: '5011234567', iban: null });
  });

  it('ownAccountKeys flattens to unique normalized strings usable as ClassificationContext.ownAccounts', () => {
    const keys = ownAccountKeys(collectAccountsFromStatements([st({ accountNo: '5011234567', iban: OWN_IBAN }), st({ accountNo: '5011234567' })]));
    expect(keys.sort()).toEqual(['5011234567', OWN_IBAN].sort());
    expect(matchOwnAccount('5011234567', keys)).toBe('EXACT');
  });
});
