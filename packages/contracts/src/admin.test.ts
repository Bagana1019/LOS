import { describe, expect, it } from 'vitest';
import { UserRole } from './enums';
import { ADMIN_ASSIGNABLE_ROLES, ChangePasswordBody, CONTRACT_NUMBER_TOKENS, CreateBranchBody, CreateUserBody, ContractNumberTemplateBody, ReplaceApprovalLevelsBody, validateApprovalLevels } from './admin';

const L = (levelNo: number, amountFrom: number, amountTo: number | null) => ({ levelNo, amountFrom, amountTo });

describe('validateApprovalLevels (BR-13)', () => {
  it('зөв шатлал', () => {
    expect(validateApprovalLevels([L(1, 0, 5), L(2, 5, 30), L(3, 30, null)])).toBeNull();
    expect(validateApprovalLevels([L(1, 0, null)])).toBeNull();
  });
  it('эрэмбэ хамаарахгүй (levelNo-оор)', () => {
    expect(validateApprovalLevels([L(2, 5, null), L(1, 0, 5)])).toBeNull();
  });
  it.each([
    ['1-ээс эхлээгүй', [L(2, 0, null)]],
    ['0-ээс эхлээгүй', [L(1, 10, null)]],
    ['завсартай', [L(1, 0, 5), L(2, 6, null)]],
    ['давхцсан', [L(1, 0, 5), L(2, 4, null)]],
    ['дунд нь хязгааргүй', [L(1, 0, null), L(2, 5, null)]],
    ['дээд ≤ доод', [L(1, 0, 0), L(2, 0, null)]],
    ['сүүлийнх хязгаартай', [L(1, 0, 5)]],
    ['түвшний дугаар алгассан', [L(1, 0, 5), L(3, 5, null)]],
  ])('%s → алдаа', (_n, ls) => {
    expect(validateApprovalLevels(ls)).toEqual(expect.any(String));
  });

  describe('түвшин бүрд ≥1 батлагч (F9-9)', () => {
    const M = (levelNo: number, amountFrom: number, amountTo: number | null, members: string[], name = `Түвшин-${levelNo}-нэр`) => ({ levelNo, name, amountFrom, amountTo, members: members.map((userId) => ({ userId })) });

    it('бүх түвшинд батлагчтай бол зөв', () => {
      expect(validateApprovalLevels([M(1, 0, 5, ['u1']), M(2, 5, null, ['u2', 'u3'])])).toBeNull();
    });

    it('батлагчгүй түвшин → алдаа: түвшний дугаар ба нэрийг нэрлэнэ', () => {
      const err = validateApprovalLevels([M(1, 0, 5, ['u1']), M(2, 5, null, [], 'Төв')]);
      expect(err).toContain('Түвшин 2');
      expect(err).toContain('"Төв"');
      expect(err).toContain('батлагч');
    });

    it('1-р түвшний бүх батлагчийг хассан (finding F9-9) → алдаа', () => {
      expect(validateApprovalLevels([M(1, 0, 5, []), M(2, 5, null, ['u2'])])).toContain('Түвшин 1');
    });

    it('нэргүй (шинээр нэмсэн) мөр: нэрийн хоосон хашилт гаргахгүй', () => {
      const err = validateApprovalLevels([M(1, 0, null, [], '')]);
      expect(err).toContain('Түвшин 1');
      expect(err).not.toContain('""');
    });

    it('босгын алдаа нь батлагчийн алдаанаас өмнө мэдэгдэнэ (тухайн түвшинд)', () => {
      expect(validateApprovalLevels([M(1, 0, 5, []), M(2, 6, null, ['u2'])])).toContain('Түвшин 1');
      expect(validateApprovalLevels([M(1, 0, 5, ['u1']), M(2, 6, null, [])])).toContain('эхлэх дүн');
    });

    it('members өгөөгүй дуудлага (зөвхөн босго шалгах) батлагчийг шалгахгүй — хуучин зан төлөв хэвээр', () => {
      expect(validateApprovalLevels([L(1, 0, 5), L(2, 5, null)])).toBeNull();
    });
  });
});

describe('DTO schemas', () => {
  it('ReplaceApprovalLevelsBody: SLA > 0, нэр заавал', () => {
    const base = { levelNo: 1, name: 'A', amountFrom: 0, amountTo: null, slaHours: 24, members: [] };
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [base] }).success).toBe(true);
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [{ ...base, slaHours: 0 }] }).success).toBe(false);
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [{ ...base, name: ' ' }] }).success).toBe(false);
    expect(ReplaceApprovalLevelsBody.safeParse({ levels: [] }).success).toBe(false);
  });
  it('ContractNumberTemplateBody: {SEQ} заавал, угтвар зөвхөн үсэг/тоо', () => {
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{PREFIX}{SEQ:3}', prefix: 'B', seqScope: 'GLOBAL' }).success).toBe(true);
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{PREFIX}', prefix: 'B', seqScope: 'GLOBAL' }).success).toBe(false);
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{SEQ}', prefix: 'B-1', seqScope: 'GLOBAL' }).success).toBe(false);
  });
});

// F9-20 · Тоолуур шинэчлэгдэх хүрээ (seq_scope) бүр дугаарт өөрийн ялгагч хэсэгтэй байх ёстой, эс бөгөөс (orgId, contractNo) unique-тэй мөргөлдөнө.
describe('ContractNumberTemplateBody · seq scope needs a distinguishing token (F9-20)', () => {
  const parse = (pattern: string, seqScope: 'DAY' | 'BRANCH' | 'GLOBAL', prefix = 'B') => ContractNumberTemplateBody.safeParse({ pattern, prefix, seqScope });
  const messages = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i) => i.message));

  it('DAY scope without {YYMMDD} is rejected with a Mongolian message on the pattern field', () => {
    const r = parse('{PREFIX}{SEQ:2}', 'DAY');
    expect(r.success).toBe(false);
    expect(messages(r)).toEqual([expect.stringContaining('{YYMMDD}')]);
    expect(r.success ? [] : r.error.issues[0]!.path).toEqual(['pattern']);
  });
  it('DAY scope with {YYMMDD} anywhere in the pattern is accepted (the generator has no other date token, so {YYYYMMDD} does not count)', () => {
    expect(parse('{PREFIX}{YYMMDD}{SEQ:2}', 'DAY').success).toBe(true);
    expect(parse('{SEQ:3}-{YYMMDD}', 'DAY').success).toBe(true);
    expect(parse('{PREFIX}{YYYYMMDD}{SEQ:2}', 'DAY').success).toBe(false);
  });
  it('BRANCH scope without {BRANCH} is rejected; with {BRANCH} it is accepted (a date token is not required)', () => {
    const r = parse('{PREFIX}{SEQ:3}', 'BRANCH');
    expect(r.success).toBe(false);
    expect(messages(r)).toEqual([expect.stringContaining('{BRANCH}')]);
    expect(parse('{PREFIX}{BRANCH}{SEQ:3}', 'BRANCH').success).toBe(true);
  });
  it('a date token does not satisfy BRANCH scope and {BRANCH} does not satisfy DAY scope', () => {
    expect(parse('{PREFIX}{YYMMDD}{SEQ:2}', 'BRANCH').success).toBe(false);
    expect(parse('{PREFIX}{BRANCH}{SEQ:2}', 'DAY').success).toBe(false);
  });
  it('GLOBAL scope never resets, so {SEQ} alone is enough', () => {
    expect(parse('{SEQ}', 'GLOBAL').success).toBe(true);
    expect(parse('{PREFIX}{SEQ:4}', 'GLOBAL').success).toBe(true);
  });
  it('the seeded default template still validates', () => {
    expect(parse('{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', 'DAY').success).toBe(true);
  });
  it('a missing {SEQ} is still reported first, and an unknown scope is still rejected', () => {
    expect(messages(parse('{PREFIX}{YYMMDD}', 'DAY'))[0]).toContain('{SEQ}');
    expect(ContractNumberTemplateBody.safeParse({ pattern: '{SEQ}', prefix: 'B', seqScope: 'WEEK' }).success).toBe(false);
  });
  it('the parsed output keeps the { pattern, prefix, seqScope } shape', () => {
    const r = parse(' {PREFIX}{YYMMDD}{SEQ:2} ', 'DAY');
    expect(r.success && r.data).toEqual({ pattern: '{PREFIX}{YYMMDD}{SEQ:2}', prefix: 'B', seqScope: 'DAY' });
  });
});

// F9-21 · Загварын хэсэг (токен) бүр `formatContractNo`-д (origination/approval.rules.ts) орлуулагддаг байх ёстой, эс бөгөөс `{...}` дугаарт шууд орно ("LN-{YYYY}-1").
describe('ContractNumberTemplateBody · token validation (F9-21)', () => {
  const parse = (pattern: unknown, seqScope: 'DAY' | 'BRANCH' | 'GLOBAL' = 'GLOBAL', prefix = 'B') => ContractNumberTemplateBody.safeParse({ pattern, prefix, seqScope });
  const messages = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i) => i.message));
  const first = (pattern: string, seqScope: 'DAY' | 'BRANCH' | 'GLOBAL' = 'GLOBAL') => messages(parse(pattern, seqScope))[0] ?? '';
  const TOKENS = ['{PREFIX}', '{BRANCH}', '{YYMMDD}', '{SEQ}', '{SEQ:n}'];

  it('exports the supported token list (the only place the UI and the validator read it from)', () => {
    expect(CONTRACT_NUMBER_TOKENS.map((x) => x.token)).toEqual(TOKENS);
  });

  describe('unsupported {...} parts', () => {
    it('the exact finding input {PREFIX}-{YYYY}-{SEQ} is rejected: the message names {YYYY} and lists every supported token', () => {
      const r = parse('{PREFIX}-{YYYY}-{SEQ}');
      expect(r.success).toBe(false);
      const m = first('{PREFIX}-{YYYY}-{SEQ}');
      expect(m).toContain('{YYYY}');
      for (const token of TOKENS) expect(m).toContain(token);
      expect(r.success ? [] : r.error.issues[0]!.path).toEqual(['pattern']);
    });
    it('{FOO}{SEQ} is rejected naming {FOO}', () => {
      expect(parse('{FOO}{SEQ}').success).toBe(false);
      expect(first('{FOO}{SEQ}')).toContain('{FOO}');
    });
    it('every distinct unsupported part is named, a repeated one only once', () => {
      const m = first('{AAA}{SEQ}{BBB}{AAA}');
      expect(m).toContain('{AAA}');
      expect(m).toContain('{BBB}');
      expect(m.split('{AAA}')).toHaveLength(2);
    });
    it('tokens are case-sensitive, like the generator: {seq} and {Prefix} are unsupported', () => {
      expect(first('{seq}{SEQ}')).toContain('{seq}');
      expect(first('{Prefix}{SEQ}')).toContain('{Prefix}');
      expect(parse('{prefix}{SEQ}').success).toBe(false);
    });
    it('an empty {} and a part with inner spaces are unsupported', () => {
      expect(first('{}{SEQ}')).toContain('{}');
      expect(first('{ SEQ }')).toContain('{ SEQ }');
      expect(parse('{SEQ}{ PREFIX }').success).toBe(false);
    });
    it('malformed {SEQ:n} variants are unsupported (no digits, non-digits, negative, decimal)', () => {
      for (const bad of ['{SEQ:}', '{SEQ:x}', '{SEQ:-1}', '{SEQ:2.5}', '{SEQ:+3}', '{SEQ:2:3}']) {
        expect(parse(`{PREFIX}${bad}`).success, bad).toBe(false);
        expect(first(`{PREFIX}${bad}`), bad).toContain(bad);
      }
    });
  });

  describe('stray braces', () => {
    it('an unmatched { or } cannot end up in the number', () => {
      for (const bad of ['{SEQ}{', '{SEQ}}', '{{SEQ}', 'A{B{SEQ}', '{SEQ}}{']) expect(parse(bad).success, bad).toBe(false);
    });
    it('the message says braces must wrap a whole part and still lists the supported tokens', () => {
      const m = first('{PREFIX}{SEQ}}');
      expect(m).toMatch(/хаалт/);
      for (const token of TOKENS) expect(m).toContain(token);
    });
  });

  describe('exactly one {SEQ}', () => {
    it('a missing {SEQ} keeps the existing message', () => {
      expect(first('{PREFIX}')).toBe('{SEQ} хэсэг заавал байх ёстой');
    });
    it('{PREFIX}{SEQ}{SEQ} is rejected (two sequence parts), also mixed {SEQ}+{SEQ:3}', () => {
      expect(parse('{PREFIX}{SEQ}{SEQ}').success).toBe(false);
      expect(first('{PREFIX}{SEQ}{SEQ}')).toContain('{SEQ}');
      expect(first('{PREFIX}{SEQ}{SEQ}')).toMatch(/нэг л удаа/);
      expect(parse('{SEQ}-{SEQ:3}').success).toBe(false);
      expect(parse('{SEQ:2}{SEQ:2}{SEQ:2}').success).toBe(false);
    });
    it('exactly one {SEQ} or one {SEQ:n} anywhere in the pattern is accepted', () => {
      expect(parse('{SEQ}').success).toBe(true);
      expect(parse('{PREFIX}{SEQ:4}').success).toBe(true);
      expect(parse('{PREFIX}-{SEQ}-{PREFIX}').success).toBe(true);
    });
  });

  describe('{SEQ:n} width boundary', () => {
    it('n up to 10 digits (the counter is an int32) is accepted, including 0 which means no padding', () => {
      expect(parse('{SEQ:0}').success).toBe(true);
      expect(parse('{SEQ:1}').success).toBe(true);
      expect(parse('{SEQ:10}').success).toBe(true);
    });
    it('n above 10 is rejected (padStart with a huge n throws RangeError at approval time)', () => {
      expect(parse('{SEQ:11}').success).toBe(false);
      expect(first('{SEQ:11}')).toContain('{SEQ:11}');
      expect(parse('{SEQ:99999999999999}').success).toBe(false);
      expect(parse(`{SEQ:${'9'.repeat(70)}}`).success).toBe(false);
    });
  });

  describe('characters that break file names', () => {
    it('"/" is rejected naming the character (the number is the DMS/web file name stem: LN/100/001 would be rewritten to LN_100_001)', () => {
      expect(parse('{PREFIX}/{SEQ}').success).toBe(false);
      expect(first('{PREFIX}/{SEQ}')).toContain('/');
    });
    it('each of \\ : * ? " < > | and a control character is rejected', () => {
      for (const c of ['\\', ':', '*', '?', '"', '<', '>', '|', '\n', '\t', '\u0000']) {
        expect(parse(`{PREFIX}${c}{SEQ}`).success, JSON.stringify(c)).toBe(false);
      }
    });
    it('the ":" inside {SEQ:n} is part of the token and is not flagged', () => {
      expect(parse('{PREFIX}{SEQ:3}').success).toBe(true);
    });
    it('common separators - _ . are accepted', () => {
      expect(parse('{PREFIX}-{SEQ:4}').success).toBe(true);
      expect(parse('{PREFIX}_{SEQ:4}').success).toBe(true);
      expect(parse('{PREFIX}.{SEQ:4}').success).toBe(true);
    });
  });

  describe('empty, oversized and non-string input', () => {
    it('an empty or blank pattern gets a Mongolian message, not the English zod default', () => {
      for (const p of ['', '   ']) {
        const r = parse(p);
        expect(r.success).toBe(false);
        expect(messages(r).join(' | ')).not.toMatch(/String must contain/);
        expect(messages(r)[0]).toMatch(/[А-Яа-яӨөҮү]/);
      }
    });
    it('boundary: 80 characters is accepted, 81 is rejected with a Mongolian message', () => {
      const pad = (n: number) => `{SEQ}${'A'.repeat(n - 5)}`;
      expect(parse(pad(80)).success).toBe(true);
      const r = parse(pad(81));
      expect(r.success).toBe(false);
      expect(messages(r).join(' | ')).not.toMatch(/String must contain/);
    });
    it('null, a number or a missing pattern are rejected without throwing', () => {
      expect(parse(null).success).toBe(false);
      expect(parse(42).success).toBe(false);
      expect(ContractNumberTemplateBody.safeParse({ prefix: 'B', seqScope: 'GLOBAL' }).success).toBe(false);
    });
    it('unicode and emoji literals do not break the validator', () => {
      expect(() => parse('Г-{SEQ}😀')).not.toThrow();
      expect(parse('{SEQ}😀').success).toBe(true);
    });
  });

  describe('interplay with the existing rules', () => {
    it('for the finding input under the default DAY scope the token message comes first (the page shows issues[0]); the scope message is still reported', () => {
      const r = parse('{PREFIX}-{YYYY}-{SEQ}', 'DAY');
      const m = messages(r);
      expect(m[0]).toContain('{YYYY}');
      expect(m.some((x) => x.includes('{YYMMDD}') && x.includes('өдөр бүр'))).toBe(true);
    });
    it('the supported tokens still pass together, for every scope that needs them', () => {
      expect(parse('{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', 'DAY').success).toBe(true); // seeded default
      expect(parse('{PREFIX}-{BRANCH}-{SEQ:4}', 'BRANCH').success).toBe(true);
      expect(parse('{PREFIX}-{SEQ:4}', 'GLOBAL').success).toBe(true);
    });
    it('every token the list advertises is accepted (the {SEQ:n} sample uses n = 3)', () => {
      for (const { token } of CONTRACT_NUMBER_TOKENS) {
        const used = token.replace(':n', ':3');
        const withSeq = used.startsWith('{SEQ') ? used : `${used}{SEQ}`;
        expect(parse(withSeq).success, token).toBe(true);
      }
    });
    it('the prefix rule and its message are unchanged', () => {
      const r = ContractNumberTemplateBody.safeParse({ pattern: '{SEQ}', prefix: 'B-1', seqScope: 'GLOBAL' });
      expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual(['Угтвар зөвхөн үсэг, тоо']);
    });
  });
});

describe('FR-13 user/branch management schemas', () => {
  const uuid = '00000000-0000-4000-8000-000000000a01';
  it('assignable roles = every UserRole', () => expect([...ADMIN_ASSIGNABLE_ROLES].sort()).toEqual([...UserRole].sort()));
  it('branch code is upper-cased and validated', () => {
    expect(CreateBranchBody.parse({ code: ' ub2 ', name: 'Улаанбаатар 2' }).code).toBe('UB2');
    expect(CreateBranchBody.safeParse({ code: 'bad code', name: 'Тест' }).success).toBe(false);
    expect(CreateBranchBody.safeParse({ code: '1234567890123', name: 'Тест' }).success).toBe(false);
  });
  it('username lower-cased; roles non-empty, unique, known', () => {
    const base = { fullName: 'Бат Болд', branchId: uuid };
    expect(CreateUserBody.parse({ ...base, username: ' Bat.Bold ', roles: ['OFFICER'] }).username).toBe('bat.bold');
    expect(CreateUserBody.safeParse({ ...base, username: 'ab', roles: ['OFFICER'] }).success).toBe(false);
    expect(CreateUserBody.safeParse({ ...base, username: 'bat.bold', roles: [] }).success).toBe(false);
    expect(CreateUserBody.safeParse({ ...base, username: 'bat.bold', roles: ['OFFICER', 'OFFICER'] }).success).toBe(false);
    expect(CreateUserBody.safeParse({ ...base, username: 'bat.bold', roles: ['ROOT'] }).success).toBe(false);
    expect(CreateUserBody.parse({ ...base, username: 'bat.bold', roles: ['OFFICER'], email: '' }).email).toBeNull();
  });
  it('password policy: >=12 chars with lower, upper and digit', () => {
    const ok = (p: string) => ChangePasswordBody.safeParse({ currentPassword: 'x', newPassword: p }).success;
    expect(ok('NewPassw0rd-ok')).toBe(true);
    expect(ok('Short1a')).toBe(false);
    expect(ok('alllowercase123')).toBe(false);
    expect(ok('NoDigitsHereAtAll')).toBe(false);
  });
});
