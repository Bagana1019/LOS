import { describe, expect, it } from 'vitest';
import type { AmlHit } from '@los/contracts';
import type { StoredScreening, SubjectSnapshot } from './aml.ports';
import { carryOverDecisions } from './carry-over';
import { subjectIdentityKey } from './subject-identity';

const decided = { reviewedBy: 'reviewer-1', reviewedAt: '2026-10-28T09:00:00.000Z', reviewComment: 'Different person entirely' };
const SUBJECT: SubjectSnapshot = { subjectType: 'INDIVIDUAL', firstName: 'X', lastName: 'Y', aliases: [], countries: ['MN'], isPep: false, isRelatedParty: false };
const KEY = subjectIdentityKey(SUBJECT);

const hit = (id: string, over: Partial<AmlHit> = {}, digest: string | null = 'digest-1'): AmlHit => ({
  id, list: 'UN_SC', matchType: 'NAME_EXACT', score: 1, severity: 'BLOCKING', status: 'OPEN', entryRef: 'T-1', entryName: 'Entry One', matchedValue: 'Entry One',
  details: { programme: 'TEST', ...(digest ? { evidenceDigest: digest } : {}) }, listVersion: 'v1', reviewedBy: null, reviewedAt: null, reviewComment: null, ...over,
});
const screening = (hits: AmlHit[], over: Partial<StoredScreening> = {}): StoredScreening => ({
  id: 's-1', orgId: 'org-1', customerId: 'cust-1', applicationId: null, trigger: 'APPLICATION', status: 'CLEARED_AFTER_REVIEW', blocking: false,
  riskScore: 0, riskLevel: 'LOW', riskFactors: [], subjectName: 'X', registerNoMasked: 'XX****', registerNoHash: 'hash-1', registerNoEncrypted: 'enc',
  subject: SUBJECT, listVersions: {}, screenedAt: new Date('2026-10-28T09:00:00.000Z'), screenedBy: 'maker', correlationId: 'c', hits, ...over,
});
const fp = (id: string, over: Partial<AmlHit> = {}, digest: string | null = 'digest-1') => hit(id, { status: 'FALSE_POSITIVE', ...decided, ...over }, digest);
const confirmed = (id: string, over: Partial<AmlHit> = {}, digest: string | null = 'digest-1') => hit(id, { status: 'CONFIRMED', ...decided, ...over }, digest);
const carry = (previous: StoredScreening | null, fresh: AmlHit[], hash = 'hash-1', key = KEY) => carryOverDecisions(previous, hash, key, fresh);
const noMarkers = (h: AmlHit) => {
  expect(h).toMatchObject({ status: 'OPEN', reviewedBy: null, reviewedAt: null, reviewComment: null });
  expect(h.details).not.toHaveProperty('carriedOverFrom');
  expect(h.details).not.toHaveProperty('reopenedBecause');
};

describe('carryOverDecisions: FALSE_POSITIVE', () => {
  it('is inherited when the identity, matchType and evidence are unchanged (a list version bump alone changes nothing), and links the old hit', () => {
    const [out] = carry(screening([fp('old-1')]), [hit('new-1', { listVersion: 'v2' })]);
    expect(out).toEqual(hit('new-1', { listVersion: 'v2', status: 'FALSE_POSITIVE', ...decided, details: { programme: 'TEST', evidenceDigest: 'digest-1', carriedOverFrom: 'old-1' } }));
  });

  it('re-opens the hit with reopenedBecause when the evidence digest differs (DOB now matches, FATF category escalated, ...)', () => {
    const [out] = carry(screening([fp('old-1')]), [hit('new-1', {}, 'digest-2')]);
    expect(out).toMatchObject({ status: 'OPEN', reviewedBy: null, reviewedAt: null, reviewComment: null, details: { evidenceDigest: 'digest-2', reopenedBecause: 'EVIDENCE_CHANGED' } });
    expect(out?.details).not.toHaveProperty('carriedOverFrom');
  });

  it('re-opens when the matchType differs, even with an equal digest', () => {
    const [out] = carry(screening([fp('old-1')]), [hit('new-1', { matchType: 'NAME_FUZZY' })]);
    expect(out).toMatchObject({ status: 'OPEN', details: { reopenedBecause: 'EVIDENCE_CHANGED' } });
  });

  it('re-opens when the subject identity changed (same register, other name / birth date), even with an equal digest', () => {
    const edited = subjectIdentityKey({ ...SUBJECT, birthDate: '1960-01-01' });
    const [out] = carry(screening([fp('old-1')]), [hit('new-1')], 'hash-1', edited);
    expect(out).toMatchObject({ status: 'OPEN', details: { reopenedBecause: 'EVIDENCE_CHANGED' } });
  });

  it('re-opens a decision made before digests existed (no stored digest) rather than trusting it', () => {
    const [out] = carry(screening([fp('old-1', {}, null)]), [hit('new-1')]);
    expect(out).toMatchObject({ status: 'OPEN', details: { reopenedBecause: 'EVIDENCE_CHANGED' } });
  });

  it('re-opens when the new hit carries no digest at all', () => {
    expect(carry(screening([fp('old-1', {}, null)]), [hit('new-1', {}, null)])[0]).toMatchObject({ status: 'OPEN', details: { reopenedBecause: 'EVIDENCE_CHANGED' } });
  });
});

describe('carryOverDecisions: CONFIRMED', () => {
  it('is inherited with the original reviewer, time and comment, and links the old hit', () => {
    const [out] = carry(screening([confirmed('old-1')]), [hit('new-1')]);
    expect(out).toMatchObject({ status: 'CONFIRMED', ...decided, details: { evidenceDigest: 'digest-1', carriedOverFrom: 'old-1' } });
  });

  it('is inherited whatever the matchType or the evidence digest (a name match that became a register match is still the same listed party)', () => {
    const prior = screening([confirmed('old-1', { matchType: 'NAME_EXACT' })]);
    expect(carry(prior, [hit('a', { matchType: 'REGISTER_EXACT' }, 'other')])[0]).toMatchObject({ status: 'CONFIRMED', details: { carriedOverFrom: 'old-1' } });
    expect(carry(prior, [hit('b', { matchType: 'NAME_FUZZY', score: 0.8889 }, 'other-2')])[0]).toMatchObject({ status: 'CONFIRMED', details: { carriedOverFrom: 'old-1' } });
  });

  it('is inherited even when the identity key changed (the register still identifies the party)', () => {
    const edited = subjectIdentityKey({ ...SUBJECT, firstName: 'Z' });
    expect(carry(screening([confirmed('old-1')]), [hit('new-1')], 'hash-1', edited)[0]).toMatchObject({ status: 'CONFIRMED' });
  });

  it('wins over a FALSE_POSITIVE for the same entry', () => {
    const prior = screening([fp('old-fp'), confirmed('old-cf', { reviewedBy: 'reviewer-2' })]);
    expect(carry(prior, [hit('n1')])[0]).toMatchObject({ status: 'CONFIRMED', reviewedBy: 'reviewer-2', details: { carriedOverFrom: 'old-cf' } });
  });

  it('is not inherited by a hit of another entry or list, and a disappeared entry is not re-added (delisting)', () => {
    const prior = screening([confirmed('old-1')]);
    for (const h of carry(prior, [hit('a', { list: 'FATF' }), hit('b', { entryRef: 'T-2' })])) noMarkers(h);
    expect(carry(prior, [])).toEqual([]);
  });
});

describe('carryOverDecisions: scope', () => {
  it('only reads the previous screening of the same register (registerNoHash), and only decided hits', () => {
    for (const prior of [screening([fp('old-1')], { registerNoHash: 'hash-OTHER' }), screening([hit('old-2')]), null]) noMarkers(carry(prior, [hit('n')])[0] as AmlHit);
    expect(carry(screening([fp('old-1')]), [hit('n')], 'hash-OTHER')[0]).toMatchObject({ status: 'OPEN' });
    noMarkers(carry(screening([fp('old-1')]), [hit('n')], 'hash-OTHER')[0] as AmlHit);
  });

  it('leaves an entry without any decision untouched (no reopenedBecause marker)', () => {
    const out = carry(screening([fp('old-1')]), [hit('n1'), hit('n2', { entryRef: 'T-9' })]);
    expect(out[0]?.status).toBe('FALSE_POSITIVE');
    noMarkers(out[1] as AmlHit);
  });

  it('does not mutate its inputs', () => {
    const fresh = [hit('n'), hit('m', {}, 'changed')];
    const prior = screening([fp('old')]);
    const before = structuredClone({ fresh, prior });
    carry(prior, fresh);
    expect({ fresh, prior }).toEqual(before);
  });
});
