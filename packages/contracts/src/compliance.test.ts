import { describe, it, expect } from 'vitest';
import {
  AML_ID_MAX_LENGTH, AmlHitReviewRequest, AmlPolicy, AmlScreenRequest, AmlSubject, BlacklistEntryInput, BlacklistEntryUpdate, DEFAULT_AML_POLICY,
  isUsableRegisterNo, MAX_NAME_TOKENS, MAX_SUBJECT_NAME_TOKENS, nameTokenCount, normalizedRegisterNoLength,
} from './compliance';
import { BorrowerRole } from './enums';
import { AmlHitReviewed, AmlScreeningCompleted, BlacklistEntryChanged, DomainEvent } from './events';

describe('AmlPolicy', () => {
  it('parse({}) yields the documented defaults (BR-9: internal blacklist is a warning only)', () => {
    expect(AmlPolicy.parse({})).toEqual({
      reviewThreshold: 0.88,
      strongThreshold: 0.95,
      blockOnSanctionsHit: true,
      blockOnFatfCallForAction: false,
      blockOnInternalBlacklist: false,
      requireSeparateReviewer: true,
      maxStaleListHours: 72,
      risk: {
        weights: {
          pep: 25, relatedParty: 10, fatfIncreasedMonitoring: 15, fatfCallForAction: 40,
          internalBlacklist: 20, sanctionsPossible: 60, sanctionsConfirmed: 100,
        },
        mediumFrom: 30,
        highFrom: 60,
      },
    });
  });

  it('DEFAULT_AML_POLICY equals AmlPolicy.parse({})', () => {
    expect(DEFAULT_AML_POLICY).toEqual(AmlPolicy.parse({}));
  });

  it('keeps the defaults for fields that are not overridden', () => {
    const p = AmlPolicy.parse({ risk: { weights: { pep: 40 }, highFrom: 70 } });
    expect(p.risk.weights.pep).toBe(40);
    expect(p.risk.weights.relatedParty).toBe(10);
    expect(p.risk.weights.sanctionsConfirmed).toBe(100);
    expect(p.risk.mediumFrom).toBe(30);
    expect(p.risk.highFrom).toBe(70);
    expect(p.reviewThreshold).toBe(0.88);
  });

  it('applies top-level overrides', () => {
    const p = AmlPolicy.parse({ reviewThreshold: 0.9, blockOnFatfCallForAction: true, maxStaleListHours: 24 });
    expect(p).toMatchObject({ reviewThreshold: 0.9, blockOnFatfCallForAction: true, maxStaleListHours: 24, blockOnSanctionsHit: true });
  });

  it('rejects out-of-range values', () => {
    expect(AmlPolicy.safeParse({ reviewThreshold: 1.1 }).success).toBe(false);
    expect(AmlPolicy.safeParse({ strongThreshold: -0.1 }).success).toBe(false);
    expect(AmlPolicy.safeParse({ maxStaleListHours: 0 }).success).toBe(false);
    expect(AmlPolicy.safeParse({ risk: { weights: { pep: -1 } } }).success).toBe(false);
    expect(AmlPolicy.safeParse({ risk: { mediumFrom: 101 } }).success).toBe(false);
    expect(AmlPolicy.safeParse({ risk: { highFrom: -1 } }).success).toBe(false);
  });

  it('rejects strongThreshold < reviewThreshold (the "strong" rule would be looser than the normal one)', () => {
    const r = AmlPolicy.safeParse({ reviewThreshold: 0.9, strongThreshold: 0.85 });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].path).toEqual(['strongThreshold']);
    // анхдагч strong (0.95)-оос дээш review тавьсан ч мөн адил
    expect(AmlPolicy.safeParse({ reviewThreshold: 0.97 }).success).toBe(false);
    expect(AmlPolicy.safeParse({ reviewThreshold: 0.9, strongThreshold: 0.9 }).success).toBe(true);
    expect(AmlPolicy.safeParse({ reviewThreshold: 1, strongThreshold: 1 }).success).toBe(true);
  });

  it('rejects risk.mediumFrom >= risk.highFrom', () => {
    const r = AmlPolicy.safeParse({ risk: { mediumFrom: 70, highFrom: 60 } });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].path).toEqual(['risk', 'mediumFrom']);
    expect(AmlPolicy.safeParse({ risk: { mediumFrom: 60, highFrom: 60 } }).success).toBe(false);
    // зөвхөн нэгийг нь өөрчилбөл анхдагчтай харьцуулагдана (30 / 60)
    expect(AmlPolicy.safeParse({ risk: { mediumFrom: 60 } }).success).toBe(false);
    expect(AmlPolicy.safeParse({ risk: { highFrom: 30 } }).success).toBe(false);
    expect(AmlPolicy.safeParse({ risk: { mediumFrom: 59, highFrom: 60 } }).success).toBe(true);
  });
});

describe('AmlSubject', () => {
  const base = { subjectType: 'INDIVIDUAL', registerNo: 'УБ12345678', firstName: 'Болд' };

  it('applies defaults: aliases [], countries [], flags false', () => {
    const s = AmlSubject.parse(base);
    expect(s.aliases).toEqual([]);
    expect(s.countries).toEqual([]);
    expect(s.isPep).toBe(false);
    expect(s.isRelatedParty).toBe(false);
  });

  it('upper-cases country codes', () => {
    expect(AmlSubject.parse({ ...base, countries: ['mn', 'Ru'] }).countries).toEqual(['MN', 'RU']);
  });

  it('accepts a valid birthDate and rejects malformed ones', () => {
    expect(AmlSubject.parse({ ...base, birthDate: '1990-05-17' }).birthDate).toBe('1990-05-17');
    expect(AmlSubject.safeParse({ ...base, birthDate: '17/05/1990' }).success).toBe(false);
    expect(AmlSubject.safeParse({ ...base, birthDate: '1990-5-7' }).success).toBe(false);
  });

  it('rejects a 3-letter or non-alphabetic country code', () => {
    expect(AmlSubject.safeParse({ ...base, countries: ['MNG'] }).success).toBe(false);
    expect(AmlSubject.safeParse({ ...base, countries: ['M1'] }).success).toBe(false);
  });

  it('rejects an empty or whitespace-only firstName', () => {
    expect(AmlSubject.safeParse({ ...base, firstName: '' }).success).toBe(false);
    expect(AmlSubject.safeParse({ ...base, firstName: '   ' }).success).toBe(false);
  });

  it('rejects an empty registerNo and an unknown subjectType', () => {
    expect(AmlSubject.safeParse({ ...base, registerNo: ' ' }).success).toBe(false);
    expect(AmlSubject.safeParse({ ...base, subjectType: 'COMPANY' }).success).toBe(false);
  });

  it('trims names and rejects empty aliases', () => {
    expect(AmlSubject.parse({ ...base, firstName: '  Болд ', aliases: [' Bold '] })).toMatchObject({ firstName: 'Болд', aliases: ['Bold'] });
    expect(AmlSubject.safeParse({ ...base, aliases: [''] }).success).toBe(false);
  });

  describe('registerNo content', () => {
    // [7]/[16]: нормчилсны дараа хоосон болдог дугаар (зөвхөн тусгаарлагч/үл үзэгдэх тэмдэгт) REGISTER_EXACT-д хоосон утгаар таардаг байсан
    it.each([['--'], ['...'], ['\u200b'], ['\u200b\u200d'], ['\u00ad'], ['(/)'], ['\u02bc']])('rejects a registerNo with nothing left after normalisation: %j', (registerNo) => {
      const r = AmlSubject.safeParse({ ...base, registerNo });
      expect(r.success).toBe(false);
      expect(!r.success && r.error.issues[0].path).toEqual(['registerNo']);
    });

    it('accepts visually different spellings of a real register (invisible characters, fullwidth, dashes)', () => {
      for (const registerNo of ['УБ12345678', 'УБ-1234 5678', 'ＵＢ１２３４５６７８', 'УБ\u200b12345678', 'АО١٢٣٤٥٦٧٨']) {
        expect(AmlSubject.safeParse({ ...base, registerNo }).success, registerNo).toBe(true);
      }
    });

    it('limits the length AFTER normalisation (U+FDFA expands to 15 characters)', () => {
      expect(AmlSubject.safeParse({ ...base, registerNo: 'A'.repeat(32) }).success).toBe(true);
      // 32 тэмдэгт ба 2 зай → 30 тэмдэгт: зөвшөөрнө
      expect(AmlSubject.safeParse({ ...base, registerNo: `${'A'.repeat(15)} ${'A'.repeat(15)}` }).success).toBe(true);
      // 3 × U+FDFA = 3 тэмдэгт эх, 45 нормчилсон → хориглоно
      const r = AmlSubject.safeParse({ ...base, registerNo: '\ufdfa\ufdfa\ufdfa' });
      expect(r.success).toBe(false);
      expect(!r.success && r.error.issues[0].path).toEqual(['registerNo']);
      // 2 × U+FDFA = 30 нормчилсон: зөвшөөрнө
      expect(AmlSubject.safeParse({ ...base, registerNo: '\ufdfa\ufdfa' }).success).toBe(true);
    });

    it('exports the same check for other schemas', () => {
      expect(isUsableRegisterNo('УБ12345678')).toBe(true);
      expect(isUsableRegisterNo('\u200b-')).toBe(false);
      expect(isUsableRegisterNo('1'.repeat(33))).toBe(false);
      expect(normalizedRegisterNoLength('x y\u200b1')).toBe(3);
    });
  });

  describe('name token limits (DoS)', () => {
    const words = (n: number, prefix = 'a') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');

    it('pins the limits: 12 words per name field, 48 in total', () => {
      expect(MAX_NAME_TOKENS).toBe(12);
      expect(MAX_SUBJECT_NAME_TOKENS).toBe(48);
    });

    it('accepts up to 12 words per name field and 48 in total', () => {
      expect(AmlSubject.safeParse({ ...base, lastName: words(12, 'l'), firstName: words(12, 'f') }).success).toBe(true);
      const aliases = Array.from({ length: 4 }, (_, i) => words(12, `x${i}`));
      expect(AmlSubject.safeParse({ ...base, aliases }).success).toBe(false); // firstName ('Болд') + 48 = 49
      expect(AmlSubject.safeParse({ ...base, aliases: [...aliases.slice(0, 3), words(11, 'z')] }).success).toBe(true); // 1 + 36 + 11 = exactly 48
    });

    it('accepts the long genealogical and particle names of the review (9-12 words) as a name and as an alias', () => {
      const longNames = [
        'Abd al-Rahman bin Abd al-Aziz bin Faisal al-Saud', // 11
        'Mohammed bin Rashid bin Saeed bin Maktoum bin Butti al-Maktoum', // 11
        'Sheikh Hamad bin Khalifa bin Hamad bin Abdullah bin Jassim al-Thani', // 12
        'Gabriel José de la Concordia García Márquez de la Cruz', // 10
        'Ludwig Wittgenstein van der Berg von Hohenzollern zu Sigmaringen', // 9
      ];
      for (const name of longNames) {
        expect(AmlSubject.safeParse({ ...base, firstName: name }).success, name).toBe(true);
        expect(AmlSubject.safeParse({ ...base, aliases: [name] }).success, `alias ${name}`).toBe(true);
      }
      // 11 + 11 + 12 + 10 + 'Болд' = 45 нийт багтана; тавуулаа (53) багтахгүй
      expect(AmlSubject.safeParse({ ...base, aliases: longNames.slice(0, 4) }).success).toBe(true);
      expect(AmlSubject.safeParse({ ...base, aliases: longNames }).success).toBe(false);
    });

    it('rejects a name field with more than 12 words, with the field in the issue path and the limit in the message', () => {
      for (const [field, path] of [['firstName', ['firstName']], ['lastName', ['lastName']]] as const) {
        const r = AmlSubject.safeParse({ ...base, [field]: words(13) });
        expect(r.success, field).toBe(false);
        expect(!r.success && r.error.issues.map((i) => i.path)).toContainEqual(path);
        expect(!r.success && r.error.issues.map((i) => i.message)).toContain('name must have at most 12 words');
      }
      const alias = AmlSubject.safeParse({ ...base, aliases: ['ok', words(13)] });
      expect(alias.success).toBe(false);
      expect(!alias.success && alias.error.issues.map((i) => i.path)).toContainEqual(['aliases', 1]);
    });

    it('rejects more than 48 words across all names, with the limit in the message', () => {
      const aliases = Array.from({ length: 4 }, (_, i) => words(12, `x${i}`)); // 48
      const over = AmlSubject.safeParse({ ...base, firstName: 'Болд', aliases }); // 49
      expect(over.success).toBe(false);
      expect(!over.success && over.error.issues.map((i) => i.message)).toContain('subject names must have at most 48 words in total');
      expect(AmlSubject.safeParse({ ...base, firstName: 'Болд', aliases: aliases.slice(0, 3) }).success).toBe(true); // 37
    });

    it('counts words the way the matcher splits them: hyphens, dots, slashes and underscores separate words', () => {
      // 4.3 KB-ийн DoS бие: зайгүй, зөвхөн зураас/цэгээр тусгаарлагдсан 1 үсэгтэй токенууд
      const dashed = Array.from({ length: 100 }, () => 'a').join('-');
      expect(AmlSubject.safeParse({ ...base, firstName: dashed }).success).toBe(false);
      expect(AmlSubject.safeParse({ ...base, firstName: Array.from({ length: 100 }, () => 'a').join('.') }).success).toBe(false);
      expect(AmlSubject.safeParse({ ...base, firstName: Array.from({ length: 100 }, () => 'a').join('_') }).success).toBe(false);
      expect(AmlSubject.safeParse({ ...base, firstName: Array.from({ length: 100 }, () => 'a').join('\u2013') }).success).toBe(false);
      expect(AmlSubject.safeParse({ ...base, firstName: Array.from({ length: 100 }, () => 'a').join('/') }).success).toBe(false);
    });

    it('counts words after NFKC (one U+FDFA is four words) and ignores punctuation-only pieces', () => {
      expect(nameTokenCount('\ufdfa')).toBe(4);
      expect(AmlSubject.safeParse({ ...base, firstName: '\ufdfa \ufdfa \ufdfa' }).success).toBe(true); // 12: \u0445\u044f\u0437\u0433\u0430\u0430\u0440\u0442
      expect(AmlSubject.safeParse({ ...base, firstName: '\ufdfa \ufdfa \ufdfa \ufdfa' }).success).toBe(false); // 16
      expect(nameTokenCount('Бат - Эрдэнэ , ( ) !')).toBe(2);
      expect(nameTokenCount("O'Brien")).toBe(1);
      expect(nameTokenCount('   ')).toBe(0);
    });

    it('keeps real names comfortably inside the limits', () => {
      const r = AmlSubject.safeParse({
        ...base, lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ',
        aliases: ['Bat-Erdene Ganbold', 'Ganbold B.', 'Б. Ганболд', 'Abdul Rahman bin Haidar al Saud'],
      });
      expect(r.success).toBe(true);
    });
  });
});

describe('AmlScreenRequest', () => {
  const req = { orgId: 'org-1', customerId: 'cus-1', subject: { subjectType: 'INDIVIDUAL', registerNo: 'УБ12345678', firstName: 'Болд' } };

  it("defaults trigger to 'APPLICATION'", () => {
    expect(AmlScreenRequest.parse(req).trigger).toBe('APPLICATION');
  });

  it.each(BorrowerRole)('accepts borrowerRole %s', (role) => {
    expect(AmlScreenRequest.parse({ ...req, borrowerRole: role }).borrowerRole).toBe(role);
  });

  it('rejects an unknown borrowerRole or trigger', () => {
    expect(AmlScreenRequest.safeParse({ ...req, borrowerRole: 'WITNESS' }).success).toBe(false);
    expect(AmlScreenRequest.safeParse({ ...req, trigger: 'NIGHTLY' }).success).toBe(false);
  });

  it('accepts a nullable applicationId', () => {
    expect(AmlScreenRequest.parse({ ...req, applicationId: null }).applicationId).toBeNull();
  });

  it('has no list subset: a client-supplied `lists` is dropped so every screening covers all lists', () => {
    const r = AmlScreenRequest.parse({ ...req, lists: ['FATF'] });
    expect(r).not.toHaveProperty('lists');
    expect(Object.keys(AmlScreenRequest.shape)).not.toContain('lists');
  });

  it('normalises the nested subject (country upper-casing)', () => {
    expect(AmlScreenRequest.parse({ ...req, subject: { ...req.subject, countries: ['kz'] } }).subject.countries).toEqual(['KZ']);
  });
});

describe('AmlHitReviewRequest', () => {
  it('requires a comment of at least 5 characters (audit)', () => {
    expect(AmlHitReviewRequest.safeParse({ decision: 'CONFIRMED' }).success).toBe(false);
    expect(AmlHitReviewRequest.safeParse({ decision: 'CONFIRMED', comment: 'abcd' }).success).toBe(false);
    expect(AmlHitReviewRequest.safeParse({ decision: 'CONFIRMED', comment: '  ab  ' }).success).toBe(false);
    expect(AmlHitReviewRequest.parse({ decision: 'FALSE_POSITIVE', comment: 'abcde' })).toEqual({ decision: 'FALSE_POSITIVE', comment: 'abcde' });
  });

  it('rejects an unknown decision', () => {
    expect(AmlHitReviewRequest.safeParse({ decision: 'OPEN', comment: 'long enough' }).success).toBe(false);
  });
});

// Баримтжуулсан хүсэлтийн хязгаарууд (docs/05 §3): n хүлээн авч, n+1 татгалзана. Хязгаарыг өөрчилбөл тест унаж, баримтыг хамт шинэчлүүлнэ.
describe('documented request limits', () => {
  const subject = { subjectType: 'INDIVIDUAL', registerNo: 'УБ12345678', firstName: 'Болд' };
  const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

  it('aliases: at most 20', () => {
    const aliases = (n: number) => Array.from({ length: n }, (_, i) => `Alias${i}`);
    expect(accepts(AmlSubject, { ...subject, aliases: aliases(20) })).toBe(true);
    expect(accepts(AmlSubject, { ...subject, aliases: aliases(21) })).toBe(false);
  });

  it('countries: at most 10', () => {
    const countries = (n: number) => Array.from({ length: n }, (_, i) => `A${String.fromCharCode(65 + i)}`);
    expect(accepts(AmlSubject, { ...subject, countries: countries(10) })).toBe(true);
    expect(accepts(AmlSubject, { ...subject, countries: countries(11) })).toBe(false);
  });

  it('raw registerNo: at most 32 characters as typed, separators included', () => {
    expect(accepts(AmlSubject, { ...subject, registerNo: '1'.repeat(32) })).toBe(true);
    expect(accepts(AmlSubject, { ...subject, registerNo: '1'.repeat(33) })).toBe(false);
    // 17 цифр зөвхөн тусгаарлагчтай бичигдсэн (34 тэмдэгт): нормчилсон урт нь жижиг ч түүхий урт нь хязгаараас хэтэрнэ.
    expect(accepts(AmlSubject, { ...subject, registerNo: '1-'.repeat(16) })).toBe(true);
    expect(accepts(AmlSubject, { ...subject, registerNo: '1-'.repeat(17) })).toBe(false);
  });

  it('review comment: 5 to 2000 characters', () => {
    expect(accepts(AmlHitReviewRequest, { decision: 'CONFIRMED', comment: 'a'.repeat(2000) })).toBe(true);
    expect(accepts(AmlHitReviewRequest, { decision: 'CONFIRMED', comment: 'a'.repeat(2001) })).toBe(false);
  });

  it('orgId, customerId and applicationId: at most 128 characters (indexed columns must stay under the btree row limit)', () => {
    const req = { orgId: 'o', customerId: 'c', subject };
    expect(AML_ID_MAX_LENGTH).toBe(128);
    for (const field of ['orgId', 'customerId', 'applicationId'] as const) {
      expect(accepts(AmlScreenRequest, { ...req, [field]: 'x'.repeat(128) })).toBe(true);
      expect(accepts(AmlScreenRequest, { ...req, [field]: 'x'.repeat(129) })).toBe(false);
    }
    expect(accepts(AmlScreenRequest, { ...req, customerId: '' })).toBe(false);
    expect(accepts(AmlScreenRequest, { ...req, applicationId: null })).toBe(true);
  });
});

describe('BlacklistEntryInput / BlacklistEntryUpdate', () => {
  const entry = { registerNo: 'УБ12345678', customerType: 'INDIVIDUAL', name: 'Болд', reasonCode: 'OVERDUE_90' };

  it("defaults listType to 'DELINQUENT'", () => {
    expect(BlacklistEntryInput.parse(entry).listType).toBe('DELINQUENT');
  });

  it('rejects a lower-case or malformed reasonCode', () => {
    expect(BlacklistEntryInput.safeParse({ ...entry, reasonCode: 'overdue_90' }).success).toBe(false);
    expect(BlacklistEntryInput.safeParse({ ...entry, reasonCode: 'OVERDUE 90' }).success).toBe(false);
    expect(BlacklistEntryInput.safeParse({ ...entry, reasonCode: '' }).success).toBe(false);
  });

  it('requires reasonCode, name and customerType on create', () => {
    expect(BlacklistEntryInput.safeParse({ ...entry, reasonCode: undefined }).success).toBe(false);
    expect(BlacklistEntryInput.safeParse({ ...entry, name: '' }).success).toBe(false);
    expect(BlacklistEntryInput.safeParse({ ...entry, customerType: 'PERSON' }).success).toBe(false);
  });

  it('Update is fully partial: an empty object is valid and no default leaks in', () => {
    expect(BlacklistEntryUpdate.parse({})).toEqual({});
  });

  it('Update accepts any single field, including isActive, and still validates it', () => {
    expect(BlacklistEntryUpdate.parse({ isActive: false })).toEqual({ isActive: false });
    expect(BlacklistEntryUpdate.parse({ reasonText: 'late payment' })).toEqual({ reasonText: 'late payment' });
    expect(BlacklistEntryUpdate.safeParse({ reasonCode: 'lower' }).success).toBe(false);
    expect(BlacklistEntryUpdate.safeParse({ name: '' }).success).toBe(false);
  });

  it('Update accepts reasonText null (clear) so a GET response can be sent back, and still bounds the text', () => {
    expect(BlacklistEntryUpdate.parse({ reasonText: null })).toEqual({ reasonText: null });
    expect(BlacklistEntryUpdate.parse({ reasonText: '' })).toEqual({ reasonText: '' });
    expect(BlacklistEntryUpdate.safeParse({ reasonText: 'x'.repeat(2001) }).success).toBe(false);
    expect(BlacklistEntryUpdate.safeParse({ reasonText: 5 }).success).toBe(false);
    // Create-д null зөвшөөрөгдөхгүй хэвээр (зөвхөн засварт арилгана).
    expect(BlacklistEntryInput.safeParse({ ...entry, reasonText: null }).success).toBe(false);
  });
});

describe('compliance events in the DomainEvent union', () => {
  const base = {
    eventId: '0b4f5e0e-5a4b-4c52-9d5e-0e6d0f3c2a11',
    occurredAt: '2026-10-28T09:30:00.000Z',
    version: 1,
    orgId: 'org-1',
    actorId: 'user-1',
    correlationId: 'corr-1',
  };
  const samples = {
    AmlScreeningCompleted: {
      ...base, type: 'AmlScreeningCompleted', screeningId: 'scr-1', customerId: 'cus-1', applicationId: 'app-1',
      status: 'REVIEW_REQUIRED', blocking: true, riskScore: 60, riskLevel: 'HIGH', hitCount: 1,
    },
    AmlHitReviewed: {
      ...base, type: 'AmlHitReviewed', screeningId: 'scr-1', hitId: 'hit-1', customerId: 'cus-1', applicationId: null,
      list: 'UN_SC', decision: 'FALSE_POSITIVE', screeningStatus: 'CLEARED_AFTER_REVIEW', blocking: false, riskScore: 0, riskLevel: 'LOW',
    },
    BlacklistEntryChanged: {
      ...base, type: 'BlacklistEntryChanged', entryId: 'bl-1', registerNoHash: 'a'.repeat(64), customerType: 'INDIVIDUAL',
      name: 'Болд', listType: 'DELINQUENT', reasonCode: 'OVERDUE_90', isActive: true, changedAt: '2026-10-28T09:29:59.000Z',
    },
  } as const;
  const schemas = { AmlScreeningCompleted, AmlHitReviewed, BlacklistEntryChanged };
  const required: Record<keyof typeof samples, string[]> = {
    AmlScreeningCompleted: ['screeningId', 'customerId', 'applicationId', 'status', 'blocking', 'riskScore', 'riskLevel', 'hitCount'],
    AmlHitReviewed: ['screeningId', 'hitId', 'customerId', 'applicationId', 'list', 'decision', 'screeningStatus', 'blocking', 'riskScore', 'riskLevel'],
    BlacklistEntryChanged: ['entryId', 'registerNoHash', 'customerType', 'name', 'listType', 'reasonCode', 'isActive', 'changedAt'],
  };
  const envelope = ['eventId', 'occurredAt', 'version', 'orgId', 'actorId', 'correlationId'];

  it.each(Object.keys(samples) as (keyof typeof samples)[])('%s parses through DomainEvent and keeps its type', (type) => {
    const parsed = DomainEvent.parse(samples[type]);
    expect(parsed.type).toBe(type);
    expect(parsed).toEqual(samples[type]);
    expect(schemas[type].safeParse(samples[type]).success).toBe(true);
  });

  it.each(Object.keys(samples) as (keyof typeof samples)[])('%s is rejected when a required field is missing', (type) => {
    for (const field of [...envelope, ...required[type]]) {
      const { [field]: _omitted, ...rest } = samples[type] as Record<string, unknown>;
      expect(DomainEvent.safeParse(rest).success, `${type} without ${field}`).toBe(false);
    }
  });

  it('accepts a null actorId (system-initiated, e.g. periodic re-screening)', () => {
    expect(DomainEvent.safeParse({ ...samples.AmlScreeningCompleted, actorId: null }).success).toBe(true);
  });

  it('rejects a wrong version, a non-uuid eventId and a non-ISO occurredAt', () => {
    expect(DomainEvent.safeParse({ ...samples.AmlHitReviewed, version: 2 }).success).toBe(false);
    expect(DomainEvent.safeParse({ ...samples.AmlHitReviewed, eventId: 'not-a-uuid' }).success).toBe(false);
    expect(DomainEvent.safeParse({ ...samples.AmlHitReviewed, occurredAt: '28/10/2026' }).success).toBe(false);
  });

  it('rejects out-of-enum payload values', () => {
    expect(DomainEvent.safeParse({ ...samples.AmlScreeningCompleted, status: 'DONE' }).success).toBe(false);
    expect(DomainEvent.safeParse({ ...samples.AmlScreeningCompleted, riskLevel: 'CRITICAL' }).success).toBe(false);
    expect(DomainEvent.safeParse({ ...samples.AmlHitReviewed, decision: 'OPEN' }).success).toBe(false);
    expect(DomainEvent.safeParse({ ...samples.BlacklistEntryChanged, customerType: 'PERSON' }).success).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(DomainEvent.safeParse({ ...samples.AmlHitReviewed, type: 'AmlHitDeleted' }).success).toBe(false);
  });

  // kyc нь changedAt-аар new Date(...) үүсгэж дарааллаа шалгадаг тул буруу хэлбэр event-ийг няцаах ёстой.
  it.each(['28/10/2026', '2026-10-28', '2026-10-28 09:30:00', '2026-10-28T09:30:00+08:00', '', 'not a date'])(
    'BlacklistEntryChanged rejects a malformed changedAt %j', (changedAt) => {
      expect(DomainEvent.safeParse({ ...samples.BlacklistEntryChanged, changedAt }).success).toBe(false);
      expect(BlacklistEntryChanged.safeParse({ ...samples.BlacklistEntryChanged, changedAt }).success).toBe(false);
    },
  );

  it('BlacklistEntryChanged accepts only a 64-char lower-case hex registerNoHash, never a plain register', () => {
    const withHash = (registerNoHash: string) => DomainEvent.safeParse({ ...samples.BlacklistEntryChanged, registerNoHash }).success;
    expect(withHash('0123456789abcdef'.repeat(4))).toBe(true);
    expect(withHash('УБ12345678')).toBe(false);
    expect(withHash('YB12345678')).toBe(false);
    expect(withHash('')).toBe(false);
    expect(withHash('a'.repeat(63))).toBe(false);
    expect(withHash('a'.repeat(65))).toBe(false);
    expect(withHash('A'.repeat(64))).toBe(false);
    expect(withHash('g'.repeat(64))).toBe(false);
    expect(withHash(` ${'a'.repeat(63)}`)).toBe(false);
    expect(withHash(`${'a'.repeat(64)}\n`)).toBe(false);
  });
});
