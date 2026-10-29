import { describe, expect, it } from 'vitest';
import { MockUnScClient } from './mock-un-sc.client';
import { UN_SC_FIXTURE } from './un-sc.fixture';

describe('MockUnScClient', () => {
  it('returns the fixture deterministically', async () => {
    const client = new MockUnScClient();
    expect(await client.fetchSnapshot()).toEqual(UN_SC_FIXTURE);
    expect(await client.fetchSnapshot()).toEqual(await client.fetchSnapshot());
  });

  it('returns a fresh copy so callers cannot corrupt the fixture', async () => {
    const client = new MockUnScClient();
    const first = await client.fetchSnapshot();
    expect(first).not.toBe(UN_SC_FIXTURE);
    first.entries.length = 0;
    first.version = 'tampered';
    expect(await client.fetchSnapshot()).toEqual(UN_SC_FIXTURE);
  });
});
