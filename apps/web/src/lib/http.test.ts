import { describe, expect, it } from 'vitest';
import { ApiError, readError } from './http';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// F9-7: домэйн алдаа `{ code, message, details }` — `details` (жишээ INVALID_TIER_SET-ийн issue-үүд) UI хүртэл дамжих ёстой.
describe('readError: details', () => {
  it('домэйн алдааны `details`-ийг ApiError.details-д хадгална', async () => {
    const details = [{ code: 'DUPLICATE_CODE', tiers: ['A'] }];
    const err = await readError(reply(422, { code: 'INVALID_TIER_SET', message: 'Шатлал буруу байна', details }), 'cid-1');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('INVALID_TIER_SET');
    expect(err.details).toEqual(details);
  });

  it('VALIDATION_FAILED: issues хэвээр, details-д мөн ижил жагсаалт', async () => {
    const details = [{ path: 'tiers.0.name', message: 'Required' }];
    const err = await readError(reply(400, { code: 'VALIDATION_FAILED', message: 'Оруулсан өгөгдөл буруу', details }), 'cid-2');
    expect(err.issues).toEqual(details);
    expect(err.details).toEqual(details);
  });

  it('details байхгүй бол undefined', async () => {
    const err = await readError(reply(409, { code: 'CONFLICT', message: 'x' }), 'cid-3');
    expect(err.details).toBeUndefined();
  });
});
